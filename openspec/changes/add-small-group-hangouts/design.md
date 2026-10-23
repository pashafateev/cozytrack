# Design

## Context

See `proposal.md` for motivation and scope and [issue #201](https://github.com/pashafateev/cozytrack/issues/201) for the full research record. The user selected an explicit host **Move to hangout** button. This document proposes implementation choices for review; it does not authorize deployment.

Inspection baseline: `850d93f337738c7e7e5bf2e576e3d2cae0a5f957`.

| Existing boundary | Consequence |
|---|---|
| `src/app/studio/[id]/page.tsx` owns microphone streams, recorder/controller, upload tracker, and a cleanup effect that stops capture tracks | Switching a provider by unmounting the current room can destroy recording/upload ownership |
| LiveKit React hooks provide roster, playback, mute, and connection presentation | Adding another imperative transport adapter alone is insufficient |
| `src/lib/transport/livekit-transport.ts` does not disconnect an externally owned LiveKit room | The owning provider must explicitly disconnect |
| `src/app/api/sessions/[id]/recording-state/route.ts` serializes recording starts through `withSessionLock` | Use the same lock to prevent recording-start/transition races |
| `Session.status` and `RecordingTake.status` describe recording/finalization | Introduce separate conversation state; do not overload either |
| `/api/livekit-token` currently grants admission without a conversation-mode check | Gate token issuance, automatic reconnect, and recording catch-up on current mode |
| Recording uses local RecordRTC and direct browser uploads | Preserve those mechanisms and their recovery semantics |

## Goals / Non-Goals

**Goals**

- Establish a provider boundary that preserves capture and uploads while replacing conversational audio.
- Make explicit transitions recoverable and observable, including partial failure and cleanup.
- Measure whether the small-room approach is reliable and inexpensive on actual user networks.
- Keep the existing recording workflow as the default and permit a controlled pilot.

**Non-goals**

- Recording over P2P, automatic service fallback, retiring LiveKit, video, or expanding mesh beyond four participants.
- A new identity system, recording lifecycle rewrite, storage redesign, or claim that finalized means safely uploaded.
- Automatic idle shutdown/warnings. The earlier 25/30-minute warning-and-extension idea stays in #201.
- Perfectly simultaneous playback switching, zero downtime during failures, or forcibly stopping modified direct peers.

## Decisions

### 1. Preserve a stable session owner and replace conversation providers beneath it

Move ownership of microphone streams, capture processing, recorder/controller, backup state, upload tracker, and navigation protection above provider-specific rendering. The owner survives both directions of a transition and remains mounted after Leave or End conversation while upload/recovery UI is needed.

Define a small conversation-provider interface for membership, local audio publication, remote playback, mute, connection health, and disconnect. Keep the existing recording-control behavior on the LiveKit side during this pilot. Do not introduce generic plugin infrastructure or move unrelated studio logic.

Transport teardown releases its connections and borrowed media references; it does not call `stop()` on caller-owned capture tracks. Hangout mute controls conversational publication, not saved audio settings. Returning to the studio restores existing publication/meter behavior before enabling Record.

Preserve conversational mute on both prepared and active publications. A muted target must not transmit microphone audio merely because its remote playback is muted. Recording capture/DSP settings remain independent.

**Alternative:** unmount the existing room and build a separate hangout page. Rejected because ongoing uploads, local backups, and microphone lifetime are currently owned inside that room.

### 2. Use the application database for committed mode and a Durable Object for signaling

Add an optional session-associated conversation record, defaulting existing sessions to studio. It stores committed mode (`studio`, `hangout`, or `ended`), monotonically increasing generation, pending operation identity/target/deadline, participant snapshot, current provider room identity, and cleanup records keyed to retired provider rooms. The exact Prisma names can follow repository conventions.

Give each newly prepared studio generation a fresh LiveKit room name, separate from the immutable application session ID. Legacy sessions initially resolve to their existing session-named room. `/api/livekit-token` continues authorizing the application session and derives the provider room from server state, never from an arbitrary client-selected provider name. Recording takes retain their provider room identity so delayed guest recovery queries the correct historical room; legacy takes default to the session-named room. Update the existing `listParticipants(sessionId)` recovery call accordingly. Generation-specific room names isolate delayed remove/delete operations from later studio returns.

A session-scoped API starts, commits, cancels, and reads operations. Start/commit/cancel and recording-start admission all use the existing session advisory lock with generation comparisons. Persist preparation before releasing the lock; never hold a transaction while awaiting a browser, network handshake, or provider API.

One Cloudflare Durable Object per session maintains authenticated sockets, routes offers/answers/ICE, collects readiness, and projects committed state. Pilot clients register while in studio as well as hangout. Before a transition, reconcile that roster with LiveKit participants; an incompatible/unregistered participant blocks preparation with an update/rejoin explanation. The object cannot independently commit a mode. Signed service requests authenticate readiness reports and callbacks. On restart or conflicting events, it reloads the application state.

Use WebSocket hibernation, socket attachments, and event-driven updates. Persist only small coordination data; do not store media or SDP/ICE history. Normal idle WebSockets, continuous timers, and Postgres heartbeat polling would undermine the cost model.

**Alternatives:** DO-only authority cannot atomically fence the existing Postgres recording start. Vercel WebSocket functions need cross-instance coordination and reconnection at function-duration limits. Self-hosted signaling adds an always-on deployment and operational maintenance. The proposed split keeps recording admission consistent while limiting signaling costs.

### 3. Use an explicit preparation/commit protocol

Initial operational defaults are a 30-second preparation deadline and a 30-second cleanup deadline. They are configurable connection-operation limits, not call-duration limits.

1. The host requests a transition. Under the session lock, reject an active/starting take, another operation, ended state, or a hangout roster over four. Reserve the next generation and persist the operation.
2. Snapshot the admitted connection identities. A new join waits; a required participant leaving, refreshing, replacing a duplicate connection, or losing contact cancels preparation. There is one active conversation socket per participant identity; replacing it closes the prior socket.
3. Each participant confirms its local recorder has stopped. Pending network uploads do not block preparation because their owner remains mounted.
4. Prepare the target transport while leaving source playback active. Target playback stays muted. Readiness requires the target tracks/playback path and every required peer connection, not merely a signaling socket or nonzero audio energy.
5. The server compares operation/generation, confirms all snapshot members ready, and commits the mode under the session lock. The DO publishes the committed result.
6. Each client reconciles to that generation, switches its single audible output path, and releases the source transport. Brief duplicate network transmission during preparation is included in usage measurement; duplicate audible playback is prohibited.
7. Track cleanup separately. A committed mode never silently rolls back after a missed message. Reconnects, focus/resume, and operation retries read the authoritative state.

Before commit, failure closes prepared resources and leaves the source mode selected. After commit, failure produces a visible reconnect/cleanup state and retries against the committed generation. The host can request the opposite transition as a new operation; the pilot does not automatically bounce between providers.

An operation deadline is recorded in the database. A Durable Object alarm requests idempotent reconciliation; the session API also reconciles overdue operations on reads or mutations so a lost alarm is not permanent. The same recovery handles a database commit followed by a server crash before notification.

End conversation uses the same reservation, membership snapshot, recorder-stopped acknowledgements, and deadline, without preparing a target media transport. If any required acknowledgement is missing, cancel the operation instead of stranding a guest recorder. Once committed, clients close audio and retain the stable upload/recovery owner.

### 4. Make leaving LiveKit a verified operation

Commit to hangout fences new application-issued LiveKit tokens. First-party clients suppress SDK auto-reconnect and disconnect their old room. Server cleanup covers the admitted snapshot, issued identities for the retiring connection, and participants still reported by LiveKit.

For the cloud deployment, remove participants with an explicit `revoke_token_ts` and then delete the retired provider room. Default removal has a token-revocation buffer and is insufficient; deleting a room alone also permits later recreation by a valid token. Record the cutoff and require it to cover original and SDK-refreshed tokens, including same-second issuance. Respect the provider's allowed clock window. Cleanup carries the immutable retired provider room name and generation, never a lookup of whatever room is current when the retry runs.

Persist pending/confirmed cleanup separately from committed mode. Retry provider failures with backoff and bounded foreground attempts; a Durable Object alarm schedules further reconciliation. Surface persistent failure to the operator and show **Hangout active; studio cleanup pending** instead of claiming minutes stopped. Confirm removal/revocation operations and an empty/absent room before marking cleanup complete.

Cloud-specific revocation must be exercised in an authorized cloud test environment before pilot enablement. Local self-hosted LiveKit tests cannot prove this guarantee; they cover application admission and cleanup orchestration. Verify the installed server SDK's support during implementation; use a typed supported API integration if the pinned SDK lacks the explicit field.

Sources: [participant removal](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/), [token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/), [room lifecycle](https://docs.livekit.io/intro/basics/rooms-participants-tracks/rooms/).

### 5. Return to studio is connectivity preparation, not Record

For an unfinalized session, **Return to studio** uses the same protocol in reverse, preparing LiveKit with muted playback while hangout remains audible. Commit only after participant readiness, then release peer connections. Recording remains idle until a separate Record action.

The recording-start endpoint rejects hangout, pending transitions, ended state, and finalized sessions. Client reconnect catch-up must also respect conversation mode rather than starting capture from an old event. Preserve the existing finalized-session guard; after Finish, new recording still requires a new session. Do not move participants automatically into a new session.

Quota/auth/provider failure during preparation keeps hangout selected with the specific failure shown. This is a manual recovery path, not a promise of automatic LiveKit fallback. Return uses a fresh provider room, so it can restore conversation while old-room cleanup continues. The old cleanup warning remains visible until resolved; new admission never cancels it. Tests must prove that delayed old-room cleanup cannot affect the new studio.

### 6. Scope credentials and handle call lifetime explicitly

The existing application resolves host/guest identity. It issues short-lived signaling capabilities bound to session, participant, role, connection identity, generation, expiry, and audience. The signaling service validates these claims, strips client-supplied sender identities, and enforces the four-person capacity. Credentials must not be placed in logged URL query strings.

Issue temporary TURN credentials only to an admitted participant; retain long-term keys on the server. Rate-limit admission and credential issuance. Renew credentials before expiry and perform ICE recovery when needed. Cloudflare credentials have a 48-hour maximum; choose shorter operational TTLs and test renewal rather than making that maximum a product call limit.

Existing authenticated calls are not deliberately torn down merely because app authentication expires. If renewal or a host operation is denied, preserve current media where possible, show the existing sign-in/new-invite recovery path, and keep uploads/backups intact. Provider credential expiry can still interrupt media if authorization cannot be restored; do not promise indefinite unauthenticated use.

End conversation persists terminal state, closes first-party signaling and audio, cleans up any LiveKit resources, and refuses fresh conversation credentials. It does not revoke recording-upload authority or delete any asset. A client that misses the end event closes on its next successful state reconciliation. This is cooperative client termination: already connected modified direct peers cannot be physically disconnected by the server.

Individual Leave disconnects only that participant. The host leaving a stable room does not end it or transfer host authority. Last-participant departure cleans up network resources while retaining committed mode for an authorized later rejoin, unless the host explicitly ended the conversation.

Sources: [WebRTC signaling](https://webrtc.org/getting-started/peer-connections), [TURN credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/), [peer IP visibility](https://www.rfc-editor.org/rfc/rfc8827.html#section-6.4).

### 7. Keep costs measurable and pilot enablement reversible

Ship disabled by default with operator-controlled session enablement. Disabling new admissions does not abruptly kill existing calls or remove recovery controls. Do not provision a paid plan as a side effect of application startup.

Use the 2026-10-19 research as a dated estimate, not an approved budget:

| Component | Planning assumption |
|---|---|
| Signaling | Free may fit a prototype; Workers Paid was $5/account/month with shared included allowances |
| TURN | 1,000 GB/month shared free allowance; then $0.05/GB delivered to TURN clients |
| Four-person audio | At an assumed 128 kbps total per directed stream, all-relayed traffic is 0.6912 GB/room-hour |
| 100 / 1,000 four-person room-hours | 69.12 / 691.2 GB; $0 relay charge if the full free allowance is unused |
| Existing infrastructure | Vercel, Postgres, recording uploads/storage, and diagnostics remain separate |
| LiveKit | Recording usage remains; any paid fallback plan remains an independent cost |

Instrument direct/relay selection, room/participant hours, bytes, connection setup/recovery, preparation failures, and cleanup completion. Aggregate and sample diagnostics; exclude credentials, raw SDP/ICE, and IP addresses. Distinguish media payload statistics from billable network traffic. Reconcile with provider dashboards during the pilot.

Test a four-person forced-relay session, not only ideal direct connections. No direct-success rate or fixed total monthly ceiling is claimed. Provider account ownership, alert recipients, and live budget limits are deployment configuration to select before enabling the pilot.

Sources: [TURN billing](https://developers.cloudflare.com/realtime/turn/faq/), [relay pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Risks / Trade-offs

- **More client/network complexity** → Pilot only 2–4-person audio; test real browsers, devices, and guest networks before considering primary transport.
- **No atomic transaction across browser, database, DO, and LiveKit** → Persist operations/generations; make callbacks idempotent; separate commit from cleanup; reconcile after crashes.
- **Capture teardown or stale recording catch-up** → Keep a stable owner; fence both server recording start and client catch-up; test late stop acknowledgements and uploads across handoffs.
- **Muted participants mistaken for unready** → Readiness uses transport/track state, not speech energy.
- **Direct peer IP visibility** → Disclose it in the pilot entry explanation; relay-only product privacy mode is separate scope, while forced relay remains a test facility.
- **Cloud provider reachability and mobile suspension** → Test target ISPs and background/lock behavior; do not advertise uninterrupted background support without evidence.
- **Credential and LiveKit revocation differences** → Test long-call renewal and cloud stale-token rejection; keep cleanup pending when proof fails.
- **Signaling or logging cost growth** → Use hibernation, rate limits, sampled diagnostics, and actual usage reconciliation.
- **Unused LiveKit quota cannot serve as guaranteed fallback capacity** → Keep manual Return errors actionable; paid fallback/primary migration is outside this pilot.

## Migration Plan

1. Land additive conversation state, admission guards, and stable recording-owner extraction with the pilot off. Existing sessions read as studio.
2. Land signaling, managed-relay integration, and direct audio behind the pilot flag; exercise local/browser tests and mocked external failures.
3. Deploy only to an explicitly selected test environment with real provider configuration and budget alerts. Verify cloud revocation and forced-relay traffic.
4. Enable a small number of operator sessions. Run 2/3/4-person calls, transitions, return, end, upload recovery, and long-call tests.
5. Review connection outcomes and provider usage before expanding enablement. Capture primary-transport or retirement proposals separately in #201.

Rollback first disables new hangout admissions while preserving recovery routes for existing calls. Drain active hangouts through manual return or explicit end before removing their infrastructure or guards. Retain additive conversation records and upload/capture compatibility; a blind rollback to code that ignores committed hangout/ended state is unsafe.
