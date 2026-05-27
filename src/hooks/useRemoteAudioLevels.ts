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
import {
  advanceClipHold,
  shapeLevel,
  smoothLevel,
} from "@/lib/audio-meter";

const POLL_INTERVAL_MS = 100; // ~10 Hz, per the issue.

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

      function applyClipState(identity: string, audioLevel: number | undefined) {
        const step = advanceClipHold(
          {
            consecutiveClipFrames:
              consecutiveClipFramesRef.current.get(identity) ?? 0,
            holdFrames: clipHoldFramesRef.current.get(identity) ?? 0,
          },
          audioLevel,
          CLIP_HOLD_FRAMES,
        );

        if (step.state.consecutiveClipFrames > 0) {
          consecutiveClipFramesRef.current.set(
            identity,
            step.state.consecutiveClipFrames,
          );
        } else {
          consecutiveClipFramesRef.current.delete(identity);
        }

        if (step.state.holdFrames > 0) {
          clipHoldFramesRef.current.set(identity, step.state.holdFrames);
        } else {
          clipHoldFramesRef.current.delete(identity);
        }

        if (step.isClipping) {
          nextClipping.add(identity);
        }
      }

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

          // Bail out before any ref mutation if the effect was cleaned up
          // mid-poll (e.g. participants prop changed). Otherwise this stale
          // poll would race with the new effect's loop on the same refs.
          if (cancelled) return;

          if (typeof audioLevel !== "number") {
            // No fresh stat — fade existing smoothed value toward zero so the
            // meter doesn't appear stuck if a participant goes silent.
            const prev = smoothedRef.current.get(identity) ?? 0;
            const decayed = Math.max(0, prev * 0.85);
            smoothedRef.current.set(identity, decayed);
            nextLevels.set(identity, Math.round(decayed));
            applyClipState(identity, undefined);
            return;
          }

          // Match the local meter's perceptual curve so both look identical.
          const target = shapeLevel(audioLevel) * 255;
          const prev = smoothedRef.current.get(identity) ?? 0;
          const smoothed = smoothLevel(prev, target);
          smoothedRef.current.set(identity, smoothed);
          nextLevels.set(identity, Math.round(smoothed));

          applyClipState(identity, audioLevel);
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
