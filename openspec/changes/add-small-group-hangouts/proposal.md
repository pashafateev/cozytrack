# Proposal

## Why

Participants intentionally keep talking after recording, consuming LiveKit connection minutes even when no take is active. This proposal turns the research in [issue #201](https://github.com/pashafateev/cozytrack/issues/201) into a small, measurable hangout pilot for the expected 2–4-person use case; implementation and deployment remain separate decisions.

## What Changes

- Add an opt-in, audio-only hangout mode using browser WebRTC connections with managed TURN relay fallback.
- Let the host explicitly press **Move to hangout**. Stop and Finish retain their existing recording meanings and do not automatically switch or end the conversation.
- Coordinate the room-wide switch, preserve microphone and upload ownership, and disconnect all first-party clients from LiveKit after a successful handoff.
- Let the host explicitly **Return to studio**. Reconnect and check readiness before allowing a separate Record action; finalized sessions retain their existing restrictions.
- Provide individual Leave and host **End conversation** controls without deleting recordings, cancelling uploads, or revoking recovery access.
- Preserve long conversations and recordings. This pilot adds neither a recording-duration cap nor a mandatory 30-minute hangout cutoff.
- Measure connection outcomes, relay traffic, provider cleanup, and actual incremental infrastructure costs before expanding usage.
- Keep LiveKit as the studio conversation/control transport; saved audio remains locally recorded and uploaded separately. Making WebRTC primary, automatic LiveKit service fallback, LiveKit retirement, video, and larger rooms remain later work in #201.

The explicit host-triggered transition is the user's selected behavior. Cloudflare signaling/TURN, a disabled-by-default pilot flag, a four-person hangout capacity, and the detailed failure behavior are proposed implementation choices for review.

## Capabilities

### New Capabilities

- `hangout-audio`: Authenticated small-group conversational audio, direct and relayed connections, reconnects, and cost/quality measurement.
- `conversation-mode`: Host-controlled transitions between studio and hangout, authoritative room membership/mode, recording protection, and ending the conversation.

### Modified Capabilities

None. This repository has no existing OpenSpec capability specifications.

## Impact

- Studio UI and provider-dependent presentation in `src/app/studio/[id]/page.tsx`; stable recording/capture/upload ownership must survive provider changes.
- The current transport abstraction and LiveKit adapter under `src/lib/transport/`, plus a WebRTC hangout adapter and provider-neutral conversation UI.
- Session-scoped APIs, LiveKit token admission, recording-start guards, and an additive conversation-state model coordinated through the existing session lock.
- A separate signaling Worker/Durable Object and managed TURN credentials; no audio relay through Next.js or Postgres.
- Focused route, lifecycle, transport, and real-browser coverage, including forced relay and provider failures.
- New infrastructure configuration and operating documentation. No vendor resources or paid plans are created by this planning change.
