# Cozytrack Roadmap

This roadmap reconciles the open Cozytrack issue backlog against the current product plan.

- Source of truth: GitHub open issues plus this file.
- Audit note: `gh issue list` to `api.github.com` was unavailable in this environment, so this pass used the GitHub connector plus the previously audited open-issue set and then rewrote the roadmap for explicit issue coverage.
- Status note: PR #118 is already implementing stack 2 from #111, so the roadmap below focuses on the remaining issue work rather than restating shipped items as future work.

## Ready To Run In Parallel

### Recording hardening and test coverage

#### #108 Audit repository for missing integration coverage

- Keep this as the umbrella audit until the concrete follow-up coverage gaps below are either shipped or explicitly deferred.
- The audit itself is no longer a generic TODO; it now routes work into focused follow-ups.

#### #114 Add route-level tests for auth, invite, and LiveKit token flows

- Fast route-level confidence for auth and invite boundaries.
- Can run independently of the service-backed integration work.

#### #115 Add targeted input-contract and property tests for upload and recovery boundaries

- Tighten request-body, identifier, and S3-key invariants around upload and recovery.
- Can run independently of #114 and in parallel with the service-backed suites.

#### #116 Add service integration coverage for ingest download and purge lifecycle

- Add real Postgres + S3-compatible coverage for the Podline-facing ingest contract.
- Independent of #114 and #115.

#### #117 Add real-service race tests for finalize, recovery, and upload completion

- Add small, high-value race coverage around finalize, recovery, and upload completion ordering.
- Independent of #114 and complementary to #116.

#### #97 Require baseline and service integration checks before merge

- Once the test coverage above is where we want it, lock the existing GitHub checks behind branch protection.
- This is mostly repo-settings work and can proceed separately from application code changes.

### Product polish and UI backlog

#### #22 Persist session notes (textarea on session detail page)

- Add persistent session notes with a small save indicator.
- Independent of the recording architecture work.

#### #24 Real waveform extraction + per-track audio playback

- Replace decorative waveforms with real extracted peaks and track playback.
- Independent of the recording safety stack, but likely large enough to stay scoped to session detail UX.

#### #25 Capture and display per-track peak dBFS and file size

- Add `Track.bytes` and `Track.peakDbFS`, then surface them in the session detail UI.
- Unblocks the dashboard metadata follow-up in #29.

#### #26 Bulk download - zip all tracks in a session

- Add a session-level zip download endpoint and manifest.
- Independent of waveform and notes work.

#### #28 Propagate per-participant mic metadata (label + built-in flag) over LiveKit

- Surface remote participant mic labels and built-in-mic warnings in the studio.
- Independent of the reconnect-safe track model work.

#### #30 Remote participant audio meters feel underresponsive

- Replace the smoothed speaking-indicator path with rawer remote audio level data.
- Best treated as a self-contained studio UX fix.

#### #34 Buttons need clearer in-flight feedback (loading/pending states)

- Tighten pending/loading affordances across the UI.
- Independent polish work with no clear upstream dependency.

#### #15 Recommend hardware direct-monitor when audio interface is detected

- Detect likely interfaces and steer users toward direct monitoring instead of browser sidetone.
- Independent of the larger recording lifecycle and recovery work.

#### #68 Future: transcript-driven in-browser audio editor

- Keep this explicitly future-facing.
- It does not block onboarding or recording reliability and can stay separate from current recording-safety priorities.

### Observability and cleanup

#### #6 Add observability for chunk upload failures

- Persist lightweight upload-failure signals without changing the canonical completion model.
- Parallel to the larger recovery and test-coverage work.

## Sequenced Work

### Reconnect-safe recording architecture

#### #111 Plan reconnect-safe recording architecture

- This remains the umbrella for the stacked recording architecture.
- Stack 1 is already landed.
- Stack 2 is currently represented by open PR #118.
- The remaining planned sequence is:
  1. Logical track and internal segment model.
  2. Media-aware stitching/materialization before downstream consumers see the track.
  3. Reconnect auto-resume after the abstractions above exist.
- This sequencing is explicit in the issue itself and should remain the roadmap anchor for reconnect-safe recording work.

#### #75 Resume or recover participant recordings safely across reconnects

- Sequence this behind the remaining #111 stack work rather than treating it as a standalone patch.
- The roadmap intent is one logical downstream-facing track per participant/take, not user-facing segment rows.

#### #7 Investigate and design for cross-track conversation latency

- This becomes more durable after the reconnect-safe track/take model settles.
- Recording alignment work should target the logical-track model from #111 rather than the superseded segment experiment.

### Recording-risk awareness and operational readiness

#### #106 Surface recording-risk alerts to the host

- Surface host-visible alerts when uploads, recovery, or recording state become risky.
- This should follow enough backend/client status clarity that alerts can distinguish recoverable vs high-risk cases.

#### #20 Investigate mobile recording quality (iOS/Android)

- Keep this as a dedicated investigation and decision thread.
- It likely informs whether mobile stays warned-only, becomes explicitly unsupported, or needs a different recording/export path.

#### #5 Soundcheck mode: test record + process + preview before committing

- Keep the soundcheck flow separate from core recording-safety fixes.
- The likely sequence is:
  1. Basic test-record and preview path.
  2. Optional processing pipeline and quality metrics later.

### Deliberately later or after-current-batch work

#### #63 [Deferred] e2e test harness with Playwright (multi-participant, real LiveKit, real S3)

- Leave this deferred until the issue's trigger conditions fire.
- The issue already states the promotion conditions clearly; do not pull it forward without one of those triggers.

#### #109 Audit recording and recovery code for simplification after recent safety work

- This should happen after the current recording hardening batch settles.
- The purpose is cleanup after recent safety work, not active redesign during the architecture transition.

#### #29 Dashboard session metadata - total size and accurate duration

- Depends on #25 for `Track.bytes`.
- Keep the dashboard duration accuracy pass behind the per-track metadata foundation.

## Needs Clarification

#### #72

- This issue was present in the previously audited open-issue set, but the current environment could not recover its full body through the live fetch path.
- Clarify whether its scope is still distinct from the current recording-safety, onboarding, or reconnect architecture threads before assigning it a stronger roadmap slot.

#### #81

- This issue was present in the previously audited open-issue set, but the current environment could not recover its full body through the live fetch path.
- Clarify whether it is still an active standalone workstream or has effectively been superseded by newer recording-safety and test-hardening issues.

#### #84

- This issue was present in the previously audited open-issue set, but the current environment could not recover its full body through the live fetch path.
- Clarify whether it belongs under current onboarding/reliability priorities or should stay explicitly deferred.

#### #87

- This issue was present in the previously audited open-issue set, but the current environment could not recover its full body through the live fetch path.
- Clarify whether it remains an independent roadmap item after the newer CI, service integration, and browser smoke work.

## Coverage Checklist

The following open issues are explicitly accounted for in this roadmap pass:

- Represented in roadmap sections: #5, #6, #7, #15, #20, #22, #24, #25, #26, #28, #29, #30, #34, #63, #68, #75, #97, #106, #108, #109, #111, #114, #115, #116, #117
- Accounted for in `Needs Clarification`: #72, #81, #84, #87

Excluded with reason:

- None in this pass.
