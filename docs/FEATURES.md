# Cozytrack Roadmap

This roadmap was reconciled against every GitHub issue that was open on June 25, 2026 (45 open issues).

- Every currently open issue appears exactly once as a primary roadmap entry below.
- No open issues are explicitly excluded right now.
- Items with unresolved product or architecture choices are grouped under `Needs Clarification`.

## Ready To Run In Parallel

### Recording quality and recording-risk UX

- #5 Soundcheck mode: add a preflight recording flow that records a short clip, runs it through the production-style pipeline, and lets the user compare raw vs processed audio before the real take.
- #6 Chunk-upload failure observability: surface a lightweight failure count or warning signal from the client into upload completion so chunk-loss events become debuggable without changing final-artifact authority.
- #15 Direct-monitor recommendation: detect likely audio interfaces, default software monitoring off for those users, and steer them toward hardware direct monitoring.
- #20 Mobile recording investigation: gather real iOS and Android samples, inspect container/codec behavior, and decide whether mobile should be gated, downgraded, or given a separate path.
- #41 Host-visible accurate meters: give hosts real live audio levels for every participant without showing misleading receiver-side data as source truth.
- #43 Live meter calibration: tune meter scale, smoothing, and clipping thresholds so valid loud input does not look broken while true clipping remains obvious.
- #44 Guest meter simplification: show non-host participants only their own mic meter until remote metering is accurate enough to be useful.
- #47 Remote level monitoring reliability: reconcile the remaining bug scope with the shipped Option A meter and the longer-term `#59` data-channel source-meter path.
- #59 Source-side audio levels over LiveKit data channel: publish each participant's local RMS/peak values as the long-term accurate remote-meter signal, with the current stats-based meter as fallback.
- #84 Output-device visibility: show the selected playback device alongside the microphone wherever browser support makes that trustworthy, and fall back cleanly when it does not.
- #106 Host-visible recording-risk alerts: elevate participant or storage failures into obvious in-studio alerts so the host can react before the take ends.

### Session detail, dashboard, and studio polish

- #22 Session notes persistence: store the session-detail notes textarea on `Session` and autosave it with a visible saved state.
- #24 Real waveform extraction and per-track playback: replace decorative waveform placeholders with real audio-derived peaks and track-level playback controls.
- #25 Track peak and size metadata: persist `bytes` and `peakDbFS`, capture them during recording/finalization, and expose them in the session UI and dashboard rollups.
- #26 Bulk session download: stream a zip of complete session tracks with stable filenames and a small manifest.
- #28 Remote mic metadata propagation: send `micLabel` and `isBuiltInMic` over LiveKit so remote participant strips and host warnings reflect real device state.
- #30 Remote meter responsiveness: replace smoothed speaking-state visuals with more direct audio-level data for remote participants.
- #34 Button pending states: add visible in-flight feedback for the slowest primary actions, starting with home create-session and studio record.
- #42 Recording countdown and start indicator: make the transition into active recording obvious enough that hosts and guests know exactly when the take begins.
- #51 In-app recordings browser: make recorded sessions discoverable through Cozytrack metadata and downloads instead of requiring S3-console folder spelunking.
- #53 Ambient audio-only session visual: explore a calm screen presence that can coexist with trustworthy meters and later respond subtly to room audio.
- #81 Recovery-state badges in the dashboard: surface partial and failed recovery outcomes clearly enough that hosts can see which tracks need attention.

### Delivery and repo operations

- #87 Dependency and Actions update automation: add Dependabot coverage for npm and GitHub Actions with a cadence and PR volume that stays reviewable.
- #97 Required merge checks: configure branch protection or rulesets so baseline validation and service integration checks must pass before merging to `main`.

## Sequenced Work

### Follow the explicit dependency chain

- #29 Dashboard session totals and accurate duration: land this after `#25`, because total size depends on persisted `Track.bytes` and duration should move off the current per-track max heuristic.
- #36 Podflow JWT auth replacement: replace interim host-password auth with podflow-signed JWT verification, JIT user provisioning, and owner-scoped route authorization.
- #37 Service-token flow for podline: start this after `#36`, because the service principal path should extend the same auth boundary rather than reintroducing a parallel interim model.
- #108 Integration-coverage audit: keep this as the umbrella audit for remaining high-risk coverage gaps, and use it to drive narrow follow-up issues instead of broad test churn.
- #114 Route-level auth and invite tests: prioritize this as a direct `#108` follow-up for the auth-, invite-, and LiveKit-token routes.
- #115 Upload and recovery boundary tests: add targeted input-contract and property-style checks as another `#108` follow-up for storage-path and recovery invariants.
- #116 Ingest download and purge integration tests: add service-backed coverage for Podline-facing ingest lifecycle behavior as another `#108` follow-up.
- #117 Finalize/recovery/completion race integration tests: add a small real-service race suite as another `#108` follow-up for the highest-risk lifecycle ordering cases.
- #63 Deferred multi-participant browser E2E harness: promote this after the narrower integration coverage and reconnect stack stabilize, or sooner if a real LiveKit/multi-participant regression demands it.
- #109 Simplify recording and recovery code after the recent safety work: do this after the current safety path and its coverage work stabilize so cleanup is guided by proven invariants instead of guesswork.
- #148 Durable `RecordingTake` terminal state and stop retry flow: land this before more reconnect auto-resume work, because `#111`, `#134`, and later reconnect follow-ons need a server-authoritative stopped-vs-recording lifecycle instead of inference from missing stop writes.
- #140 Generate aligned stem artifacts for recording takes: do this after `#7` settles the alignment metadata strategy and after the existing logical-track materialization path, because aligned stems need authoritative marker offsets and a stable cross-track export step.
- #141 Serve aligned stems by default while preserving raw downloads: land this after `#140`, because the UI and download routes need aligned derived artifacts before they can switch user-facing defaults safely.
- #142 Optional drift analysis and correction for long takes: keep this after `#140`, because the first aligned-export path should ship with fixed-offset alignment before drift measurement and time-stretch logic add more moving parts.
- #134 Automated release-readiness gate for live reconnect recording: run this after the active reconnect/materialization work is ready to validate, and before merging or shipping that stack, so recording, reconnect, upload, recovery, and materialization all pass in one repeatable command and CI path.
- #75 Participant reconnect and resume: pursue this after `#111` locks the reconnect-safe recording model and the active materialization path is stable, so reconnect behavior extends a defined logical-track boundary instead of exposing raw browser blobs downstream.

## Needs Clarification

### Resolve the ambiguity before implementation scope hardens

- #7 Cross-track conversation latency design: clarify which timing metadata is authoritative, where alignment logic should live, and what sync quality threshold is acceptable for MVP versus later export polish.
- #68 Transcript-driven in-browser audio editor: keep this future-facing until recording reliability, session browsing, and export basics are stable enough to support an editor roadmap.
- #72 Role-aware guest and cohost studio view: decide whether cohosts ever get dashboard access from inside an active session, or whether non-host participants should always stay inside a simplified studio shell.
- #111 Reconnect-safe recording architecture plan: settle the remaining architecture choices around participant identity semantics, materialization timing, and how reconnect gaps should be represented after the `#148` lifecycle hardening removes the current stop-state inference gap.
- #135 Local multichannel recording alongside a remote participant: clarify whether local tracks should appear as separate local participants, host-owned track slots, or a multi-channel capture mode, and how that choice should interact with `#111`, `#72`, and `#75`.
