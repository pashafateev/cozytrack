# Tasks

Implementation checklist for a future apply step. All tasks are intentionally unchecked. Use failing behavioral tests before nontrivial changes, then verify them green. Provisioning and pilot enablement require the selected environment and operator configuration; this proposal creates neither.

## 1. Authoritative conversation state and admission

- [ ] 1.1 Add failing route/service tests for host-only transitions, Record-versus-transition races, ended/finalized admission, generation retries, and legacy sessions defaulting to studio; verify the failures exercise absent behavior rather than test setup.
- [ ] 1.2 Add the conversation/operation/retired-room records and recording-take provider-room mapping with an additive migration; implement session-lock admission and verify 1.1 plus existing finalized-session and recording-take tests pass.
- [ ] 1.3 Resolve application session identity separately from LiveKit provider room identity in token issuance and guest recovery; verify generation-specific rooms, historical-take recovery, legacy mappings, and cross-session denial in route tests.
- [ ] 1.4 Document the state model and API errors in a focused conversation architecture document; verify its transition table matches the service tests and includes upgrade/rollback behavior.

## 2. Stable capture and upload ownership

- [ ] 2.1 Add failing studio lifecycle tests proving provider changes preserve capture ownership, pending uploads, recovery copies, conversational mute, and navigation guards; include a guest still stopping after the server take stopped.
- [ ] 2.2 Extract the stable session owner and provider-neutral conversation boundary with LiveKit still the only enabled provider; verify 2.1 and existing studio mute, monitor, two-channel, reconnect, and recording-lifecycle tests pass.
- [ ] 2.3 Fence recording-control/catch-up paths by authoritative conversation mode and keep Return idle until a separate Record; verify stale start events and transitions cannot start capture and document provider ownership responsibilities.

## 3. Authenticated signaling and relay credentials

- [ ] 3.1 Add tests for session/identity/generation authorization, spoofed host or sender fields, duplicate connections, capacity, and late joins during preparation; verify the new admission/coordination cases fail before implementation.
- [ ] 3.2 Add the Worker and per-room Durable Object with hibernating sockets, restored attachments, authenticated callbacks, frozen readiness snapshots, deadlines, and idempotent reconciliation; verify 3.1 plus restart/missed-event tests in a local Worker harness.
- [ ] 3.3 Add temporary TURN credential issuance, renewal, and rate limits without exposing long-term secrets; verify wrong-room/stale-generation denial, expiry/reauth behavior, and secret-free logs using mocked provider responses.
- [ ] 3.4 Add example configuration and local signaling/relay test commands; verify they run without production credentials and document the separate app, signaling, and relay responsibilities and costs.

## 4. Small-group WebRTC audio

- [ ] 4.1 Add peer-transport contract tests for deterministic negotiation, candidate ordering, duplicate messages, mute preservation, leave/rejoin, and borrowed-track teardown; verify meaningful failures before adding the adapter.
- [ ] 4.2 Implement the audio-only mesh adapter and shared conversation UI; verify 4.1 and browser calls with two, three, and four participants, including one waiting participant and a rejected fifth participant.
- [ ] 4.3 Implement network recovery and credential refresh; verify forced relay, ICE restart, exhausted recovery, and long-call renewal without clearing upload/recovery state, and document connection limitations and peer-IP disclosure.

## 5. Room-wide transitions, return, and end

- [ ] 5.1 Add failure-injection tests for partial readiness, muted peers, membership changes, host loss, deadline expiry, and crashes before/after commit; verify failed preparation preserves the source conversation and committed mode survives missed notifications.
- [ ] 5.2 Implement Move to hangout and Return to studio using the persisted operation protocol and one audible playback path; verify 5.1, no implicit recording on return, preserved uploads/mute, and a larger existing studio rejected without eviction.
- [ ] 5.3 Add failing cleanup tests for original/refreshed token reuse, same-second revocation boundaries, failed provider calls, and delayed old-room cleanup after Return; implement cloud revocation, immutable retired-room cleanup, retry alarms, and cleanup status until those tests pass.
- [ ] 5.4 Implement End conversation with recorder-stopped acknowledgements, terminal admission, and preserved upload/recovery UI; verify a slow-stopping guest cannot be stranded, host Leave does not end others' call, and late clients reconcile to ended state.
- [ ] 5.5 Add user-facing guidance for Move, Return, End, failed handoff, pending cleanup, quota failures, and finalized sessions; verify rendered controls/status in studio tests and keep implementation details out of normal user copy.

## 6. Pilot controls and operating evidence

- [ ] 6.1 Add disabled-by-default session enablement and a stop-new-admissions control; verify nonpilot recording behavior is unchanged and existing hangouts retain renewal and recovery controls when new admissions are disabled.
- [ ] 6.2 Add sampled metrics for connection/relay outcomes, room/participant hours, byte estimates, transitions, and cleanup; verify diagnostic tests exclude credentials/raw SDP/ICE/IPs and keep estimated usage distinct from provider bills.
- [ ] 6.3 Document an operator runbook with environment setup, provider account selection, budget/alert configuration, usage reconciliation, and drain-before-rollback steps; verify local commands and identify cloud-only checks explicitly.

## 7. Integration and pilot acceptance

- [ ] 7.1 Run the relevant targeted tests, then `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:integration`; run the extended `npm run test:browser` harness against local services and record exact outcomes and any environment blockers.
- [ ] 7.2 In an explicitly selected cloud test environment, verify cached original and SDK-refreshed LiveKit tokens are rejected after cleanup, retired cleanup cannot affect a returned studio, and measured forced-relay traffic reconciles with provider usage; record evidence before enabling operator sessions.
- [ ] 7.3 Exercise the selected browser/device/ISP matrix with 2/3/4 participants, Bluetooth, VPNs, Wi-Fi/cellular changes, background/lock behavior, long calls, failed handoffs, and pending uploads; publish measured results and limitations without claiming automatic fallback or primary-transport readiness.
