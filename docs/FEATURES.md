# Cozytrack — Feature Spec & Roadmap

## Origin Story

These features are driven by a real pain point with Riverside.fm: during level-setting, Riverside plays degraded/compressed audio to save bandwidth. This made it impossible to tell that the final local recording quality was poor (e.g., recording from a laptop mic instead of an external mic). The problem was only discovered after processing — too late to fix.

Cozytrack's philosophy: **never let someone record without knowing exactly what they're going to get.**

---

## Feature 1: Built-In Microphone Warning

### Problem
If a participant is using their laptop's built-in mic (MacBook Pro, etc.) instead of a proper external mic/interface, the recording quality will be noticeably worse. Most people don't realize which mic is active.

### Spec
- On the pre-join screen, after the user selects their mic, detect whether it's a built-in device
- Detection heuristic: check `MediaDeviceInfo.label` for keywords like "Built-in", "Internal", "MacBook", "Default" — and cross-reference with known built-in device patterns
- If built-in mic is detected, show a **prominent warning banner** (not a dismissable toast — a blocking modal or persistent banner):
  
  > ⚠️ You're using your built-in microphone
  > 
  > Built-in laptop mics produce significantly lower audio quality. For best results, connect an external microphone or audio interface.
  >
  > [ ] I understand — continue with built-in mic
  > [Switch Microphone]

- Require the user to explicitly acknowledge before proceeding (checkbox + confirm)
- Log which mic was used per track in the database (device label + deviceId) so you can trace quality issues later
- In the session detail view, show a small indicator if a track was recorded on a built-in mic

### Database Change
Add to `Track` model:
```prisma
deviceLabel   String?
deviceId      String?
isBuiltInMic  Boolean @default(false)
```

---

## Feature 2: Full-Quality Audio During Level-Setting

### Problem
Riverside (and similar tools) degrade WebRTC audio to save bandwidth during the entire session. This means when participants are checking levels before recording, they're hearing a compressed version — not what the local recording will actually capture. You can't make meaningful level or quality judgments on degraded audio.

### Spec
- **Pre-record phase** (level-setting): Stream full-quality audio between participants via LiveKit
  - Set LiveKit audio publish options to max quality: `audioBitrate: 128_000` (128kbps Opus), `dtx: false` (no discontinuous transmission — always send audio), `audioPreset: AudioPresets.musicHighQualityStereo` if available
  - This phase is short (1-3 minutes typically) so the bandwidth cost is acceptable
- **Recording phase**: After hitting Record, optionally downgrade the WebRTC preview stream to save bandwidth since the local recording is what matters now
  - Drop to `audioBitrate: 32_000` or `48_000` for the preview
  - The local RecordRTC recording remains full quality regardless
- Expose a toggle in the studio UI: "Full quality preview" (on by default during level-setting, can be toggled during recording if someone has good bandwidth)

### LiveKit Configuration
```typescript
// Pre-record: full quality preview
room.localParticipant.setMicrophoneEnabled(true, {
  audioBitrate: 128_000,
  dtx: false,
});

// Recording phase: drop preview quality (local recording unaffected)
room.localParticipant.setMicrophoneEnabled(true, {
  audioBitrate: 48_000,
  dtx: true,
});
```

### UI Indicator
- Show a small badge in the studio: "🎧 Full Quality Preview" or "🎧 Bandwidth-Saving Mode"
- Auto-switch happens when Record is pressed, with a brief notification: "Preview quality reduced — local recording is unaffected"

---

## Feature 3: Pre-Record Preview / Soundcheck Mode

### Problem
Even with full-quality preview audio, you still can't hear exactly what the *final processed output* will sound like until after the full recording session is done and you've run it through your production pipeline. If something is wrong (wrong mic, bad gain, room echo), you don't find out until it's too late.

### Spec
A "Soundcheck" mode that lets you do a quick test recording, run it through the full production pipeline, and preview the result — all before committing to the real session.

#### Flow
1. In the pre-join / level-setting screen, add a **"Run Soundcheck"** button
2. Clicking it starts a **10-15 second test recording** (local RecordRTC, same settings as real recording)
3. After the test recording stops:
   - Upload the clip to S3 (same chunked upload flow)
   - Kick off the production pipeline (see below) on the test clip
   - Show a loading state: "Processing your soundcheck..."
4. When processing completes:
   - Show a **side-by-side player**: "Raw" vs "Processed" audio
   - Show a **quality summary**: detected mic type, estimated noise floor, clipping detection, loudness (LUFS)
   - If issues detected, show specific warnings: "High background noise detected", "Audio is clipping", "Low input level"
5. User can then:
   - **Re-do soundcheck** (switch mic, adjust levels, try again)
   - **Approve and start recording** (transitions to the real recording session)

#### Production Pipeline Integration
- The soundcheck should run the exact same processing chain as the final production
- Initially this could be a simple pipeline: normalize loudness (target -16 LUFS for podcasts), noise gate, basic EQ
- The pipeline should be pluggable — define an interface so you can swap in different processors later (e.g., Auphonic API, custom ffmpeg chain, AI denoising)

```typescript
interface AudioProcessor {
  name: string;
  process(input: Buffer, options?: Record<string, unknown>): Promise<ProcessedResult>;
}

interface ProcessedResult {
  audio: Buffer;
  format: string;
  metrics: {
    loudnessLUFS: number;
    peakDbFS: number;
    noiseFloorDb: number;
    clippingDetected: boolean;
    duration: number;
  };
}
```

#### Quality Metrics to Surface
| Metric | What it tells you | Warning threshold |
|--------|------------------|-------------------|
| Loudness (LUFS) | Overall level | Below -24 LUFS or above -12 LUFS |
| Peak (dBFS) | Clipping risk | Above -1 dBFS |
| Noise floor (dB) | Background noise | Above -40 dB |
| Mic type | Built-in vs external | Built-in = warning |

#### API Endpoints Needed
- `POST /api/soundcheck/start` — Creates a temporary soundcheck session
- `POST /api/soundcheck/process` — Triggers the processing pipeline on the uploaded clip
- `GET /api/soundcheck/[id]/status` — Poll for processing completion
- `GET /api/soundcheck/[id]/result` — Get processed audio URL + quality metrics

#### Database
Add a `Soundcheck` model:
```prisma
model Soundcheck {
  id            String   @id @default(uuid())
  sessionId     String
  session       Session  @relation(fields: [sessionId], references: [id])
  rawS3Key      String
  processedS3Key String?
  metrics       Json?    // { loudnessLUFS, peakDbFS, noiseFloorDb, clippingDetected }
  deviceLabel   String?
  isBuiltInMic  Boolean  @default(false)
  status        String   @default("recording") // recording | processing | complete | failed
  createdAt     DateTime @default(now())
}
```

---

## Implementation Priority

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| **P0** | Mic warning (built-in detection) | Small (1-2 days) | Prevents the most common quality mistake |
| **P0** | Full-quality audio during level-setting | Small (1 day) | Config change + UI toggle |
| **P1** | Soundcheck mode (basic — record + playback) | Medium (3-5 days) | Lets you hear yourself before committing |
| **P2** | Soundcheck with full pipeline processing | Large (1-2 weeks) | Requires building the processing pipeline |
| **P2** | Quality metrics dashboard | Medium (3-5 days) | Nice-to-have, makes soundcheck more actionable |

---

## Notes

- The soundcheck clips should auto-delete after 24 hours (S3 lifecycle rule) to avoid storage bloat
- Consider making the soundcheck available as a standalone tool (no session needed) — useful for guests to test their setup before the scheduled recording time
- The production pipeline is its own major subsystem — start with a simple ffmpeg normalization pass and iterate
