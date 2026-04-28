"use client";

// Polls each remote participant's subscribed audio track for inbound-rtp
// level stats and exposes a per-identity level (0..255) plus a clipping flag.
//
// This is the Option A fix from issue #47: audio levels here are POST-network
// (decoded receiver side, after the jitter buffer and any browser gain), not
// the co-host's true pre-network signal. It's the pragmatic version that
// works on existing clients without any data-channel coordination. Option B
// (each client publishes its own pre-network level) is tracked separately.

import { useEffect, useRef, useState } from "react";
import type { RemoteParticipant } from "livekit-client";

const POLL_INTERVAL_MS = 100; // ~10 Hz, per the issue.

// "Clipping" here means the receiver-side audioLevel is essentially full-scale.
// `audioLevel` from inbound-rtp is normalized 0..1; -1 dBFS ≈ 0.891.
const CLIP_THRESHOLD = 0.891;
const CLIP_MIN_FRAMES = 2;
// How many polls we hold the clip indicator after it stops triggering, so a
// single transient peak still flashes visibly (~400ms at 10Hz).
const CLIP_HOLD_FRAMES = 4;

interface RemoteLevels {
  /** Level in [0, 255], matched to the local meter's scale. */
  levels: Map<string, number>;
  /** Identities currently flagged as clipping. */
  clipping: Set<string>;
}

/**
 * Returns the live audio level (0..255) and clipping flag for each remote
 * participant. Reads from `RTCRtpReceiver.getStats()` via the LiveKit
 * RemoteTrack's `getRTCStatsReport()` ~10 times per second.
 */
export function useRemoteAudioLevels(
  participants: ReadonlyArray<RemoteParticipant>,
): RemoteLevels {
  const [state, setState] = useState<RemoteLevels>(() => ({
    levels: new Map(),
    clipping: new Set(),
  }));

  // Per-identity rolling state used between polls. Lives in a ref so the
  // poll loop doesn't churn React state on every tick.
  const consecutiveClipFramesRef = useRef<Map<string, number>>(new Map());
  const clipHoldFramesRef = useRef<Map<string, number>>(new Map());
  const smoothedRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pollOnce() {
      const nextLevels = new Map<string, number>();
      const nextClipping = new Set<string>();

      // Snapshot the participants so a disconnect mid-poll doesn't blow up.
      const snapshot = participants.slice();

      await Promise.all(
        snapshot.map(async (participant) => {
          const identity = participant.identity;
          if (!identity) return;

          // Use the first subscribed audio publication. CozyTrack publishes
          // a single mic track per participant, so this is unambiguous.
          let audioLevel: number | undefined;
          for (const pub of participant.audioTrackPublications.values()) {
            const track = pub.track;
            if (!track) continue;
            try {
              const report = await track.getRTCStatsReport();
              if (!report) continue;
              report.forEach((entry) => {
                if (
                  entry.type === "inbound-rtp" &&
                  (entry as { kind?: string }).kind === "audio"
                ) {
                  const lvl = (entry as { audioLevel?: number }).audioLevel;
                  if (typeof lvl === "number" && Number.isFinite(lvl)) {
                    audioLevel = lvl;
                  }
                }
              });
            } catch {
              // getStats can throw if the receiver is mid-teardown; ignore.
            }
            if (typeof audioLevel === "number") break;
          }

          if (typeof audioLevel !== "number") {
            // No fresh stat — fade existing smoothed value toward zero so the
            // meter doesn't appear stuck if a participant goes silent.
            const prev = smoothedRef.current.get(identity) ?? 0;
            const decayed = Math.max(0, prev * 0.85);
            smoothedRef.current.set(identity, decayed);
            nextLevels.set(identity, Math.round(decayed));
            // Drain any clip-hold counter without retriggering.
            const hold = (clipHoldFramesRef.current.get(identity) ?? 0) - 1;
            if (hold > 0) {
              clipHoldFramesRef.current.set(identity, hold);
              nextClipping.add(identity);
            } else {
              clipHoldFramesRef.current.delete(identity);
            }
            consecutiveClipFramesRef.current.delete(identity);
            return;
          }

          // Match the local meter's perceptual curve so both look identical:
          // raise to ~0.6 (compander) then scale to 0..255 like the host side.
          const shaped = Math.pow(Math.max(0, Math.min(1, audioLevel)), 0.6);
          const target = shaped * 255;
          const prev = smoothedRef.current.get(identity) ?? 0;
          const smoothed = prev * 0.7 + target * 0.3;
          smoothedRef.current.set(identity, smoothed);
          nextLevels.set(identity, Math.round(smoothed));

          // Clipping: count consecutive frames at/over threshold; latch the
          // visible flag for a few extra frames so single peaks register.
          if (audioLevel >= CLIP_THRESHOLD) {
            const n =
              (consecutiveClipFramesRef.current.get(identity) ?? 0) + 1;
            consecutiveClipFramesRef.current.set(identity, n);
            if (n >= CLIP_MIN_FRAMES) {
              clipHoldFramesRef.current.set(identity, CLIP_HOLD_FRAMES);
            }
          } else {
            consecutiveClipFramesRef.current.set(identity, 0);
          }

          const hold = clipHoldFramesRef.current.get(identity) ?? 0;
          if (hold > 0) {
            nextClipping.add(identity);
            clipHoldFramesRef.current.set(identity, hold - 1);
          }
        }),
      );

      if (cancelled) return;

      // Drop entries for participants that have left.
      const liveIdentities = new Set(snapshot.map((p) => p.identity));
      for (const id of smoothedRef.current.keys()) {
        if (!liveIdentities.has(id)) {
          smoothedRef.current.delete(id);
          consecutiveClipFramesRef.current.delete(id);
          clipHoldFramesRef.current.delete(id);
        }
      }

      setState((prev) => {
        // Skip the React update if nothing changed — the poll fires 10x/sec
        // and most ticks for a quiet talker produce identical integer values.
        if (
          mapsEqual(prev.levels, nextLevels) &&
          setsEqual(prev.clipping, nextClipping)
        ) {
          return prev;
        }
        return { levels: nextLevels, clipping: nextClipping };
      });
    }

    function loop() {
      if (cancelled) return;
      void pollOnce().finally(() => {
        if (cancelled) return;
        timer = setTimeout(loop, POLL_INTERVAL_MS);
      });
    }

    loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [participants]);

  return state;
}

function mapsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) {
    if (!b.has(k)) return false;
  }
  return true;
}
