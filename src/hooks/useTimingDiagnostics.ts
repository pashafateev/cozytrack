"use client";

// Diagnostic hook for issue #7: cross-track conversation latency.
//
// When `enabled`, polls getStats every 5s and emits one JSON line per snapshot
// to console under the `[TIMING]` tag. Captures the WebRTC fields needed to
// reconstruct cross-participant clock drift after a test recording:
//   - estimatedPlayoutTimestamp (NTP via RTCP SR) → shared time reference
//   - totalSamples{Received,Duration} → encoder/decoder wall vs media time
//   - concealedSamples / silentConcealedSamples → packet-loss compensation
//   - insertedSamplesForDeceleration / removedSamplesForAcceleration →
//     jitter-buffer's measurement of sender↔receiver clock skew
//   - jitterBufferDelay / jitterBufferEmittedCount → buffer pressure
//   - packetsReceived / packetsLost / jitter → network conditions
//
// Disabled (default): one boolean check, no effect, no listeners.

import { useEffect } from "react";
import type { LocalParticipant, RemoteParticipant } from "livekit-client";

const POLL_INTERVAL_MS = 5000;

type StatField = string | number | undefined;

interface InboundSnapshot {
  identity: string;
  ssrc?: StatField;
  estimatedPlayoutTimestamp?: StatField;
  lastPacketReceivedTimestamp?: StatField;
  totalSamplesReceived?: StatField;
  totalSamplesDuration?: StatField;
  concealedSamples?: StatField;
  silentConcealedSamples?: StatField;
  insertedSamplesForDeceleration?: StatField;
  removedSamplesForAcceleration?: StatField;
  jitterBufferDelay?: StatField;
  jitterBufferEmittedCount?: StatField;
  jitter?: StatField;
  packetsReceived?: StatField;
  packetsLost?: StatField;
}

interface OutboundSnapshot {
  ssrc?: StatField;
  packetsSent?: StatField;
  bytesSent?: StatField;
  totalSamplesDuration?: StatField;
  audioLevel?: StatField;
}

export function useTimingDiagnostics(opts: {
  enabled: boolean;
  localParticipant: LocalParticipant | undefined;
  remoteParticipants: ReadonlyArray<RemoteParticipant>;
}): void {
  const { enabled, localParticipant, remoteParticipants } = opts;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function snapshot() {
      const inbound: InboundSnapshot[] = [];
      const outbound: OutboundSnapshot[] = [];

      await Promise.all(
        remoteParticipants.map(async (p) => {
          const identity = p.identity;
          if (!identity) return;
          for (const pub of p.audioTrackPublications.values()) {
            const track = pub.track;
            if (!track) continue;
            try {
              const report = await track.getRTCStatsReport();
              if (!report) continue;
              report.forEach((entry) => {
                const e = entry as Record<string, unknown>;
                if (e.type === "inbound-rtp" && e.kind === "audio") {
                  inbound.push({
                    identity,
                    ssrc: e.ssrc as StatField,
                    estimatedPlayoutTimestamp: e.estimatedPlayoutTimestamp as StatField,
                    lastPacketReceivedTimestamp: e.lastPacketReceivedTimestamp as StatField,
                    totalSamplesReceived: e.totalSamplesReceived as StatField,
                    totalSamplesDuration: e.totalSamplesDuration as StatField,
                    concealedSamples: e.concealedSamples as StatField,
                    silentConcealedSamples: e.silentConcealedSamples as StatField,
                    insertedSamplesForDeceleration: e.insertedSamplesForDeceleration as StatField,
                    removedSamplesForAcceleration: e.removedSamplesForAcceleration as StatField,
                    jitterBufferDelay: e.jitterBufferDelay as StatField,
                    jitterBufferEmittedCount: e.jitterBufferEmittedCount as StatField,
                    jitter: e.jitter as StatField,
                    packetsReceived: e.packetsReceived as StatField,
                    packetsLost: e.packetsLost as StatField,
                  });
                }
              });
            } catch {
              // Receiver mid-teardown — ignore.
            }
          }
        }),
      );

      if (localParticipant) {
        for (const pub of localParticipant.audioTrackPublications.values()) {
          const track = pub.track;
          if (!track) continue;
          try {
            const report = await track.getRTCStatsReport();
            if (!report) continue;
            const mediaSourceLevels = new Map<string, StatField>();
            const mediaSourceDurations = new Map<string, StatField>();
            report.forEach((entry) => {
              const e = entry as Record<string, unknown>;
              if (e.type === "media-source" && e.kind === "audio") {
                const id = String(e.id ?? "");
                mediaSourceLevels.set(id, e.audioLevel as StatField);
                mediaSourceDurations.set(id, e.totalSamplesDuration as StatField);
              }
            });
            report.forEach((entry) => {
              const e = entry as Record<string, unknown>;
              if (e.type === "outbound-rtp" && e.kind === "audio") {
                const sourceId = String(e.mediaSourceId ?? "");
                outbound.push({
                  ssrc: e.ssrc as StatField,
                  packetsSent: e.packetsSent as StatField,
                  bytesSent: e.bytesSent as StatField,
                  totalSamplesDuration: mediaSourceDurations.get(sourceId),
                  audioLevel: mediaSourceLevels.get(sourceId),
                });
              }
            });
          } catch {
            // Sender mid-teardown — ignore.
          }
        }
      }

      if (cancelled) return;

      console.log(
        "[TIMING]",
        JSON.stringify({
          event: "stats",
          t: Date.now(),
          perfNow: performance.now(),
          inbound,
          outbound,
        }),
      );
    }

    function loop() {
      if (cancelled) return;
      void snapshot().finally(() => {
        if (cancelled) return;
        timer = setTimeout(loop, POLL_INTERVAL_MS);
      });
    }

    console.log(
      "[TIMING]",
      JSON.stringify({
        event: "diagnostics-enabled",
        t: Date.now(),
        perfNow: performance.now(),
        localIdentity: localParticipant?.identity,
        remoteIdentities: remoteParticipants.map((p) => p.identity),
        pollIntervalMs: POLL_INTERVAL_MS,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      }),
    );

    loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, localParticipant, remoteParticipants]);
}
