"use client";

import { useEffect, useRef } from "react";

interface UseMicMonitorOptions {
  stream: MediaStream | null;
  enabled: boolean;
  /** 0–100, default 70 */
  volume: number;
}

/**
 * Routes a mic MediaStream to speakers via Web Audio so the user can hear
 * themselves (sidetone). Does NOT touch the recorded file — it creates a
 * separate AudioContext ➜ GainNode ➜ destination graph.
 *
 * On toggle-off, unmount, or stream change the graph is torn down cleanly.
 */
export function useMicMonitor({ stream, enabled, volume }: UseMicMonitorOptions) {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  // Build / tear-down the audio graph
  useEffect(() => {
    if (!enabled || !stream) return;

    const ctx = new AudioContext({
      latencyHint: "interactive",
      sampleRate: 48000,
    });
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = volume / 100;

    source.connect(gain);
    gain.connect(ctx.destination);

    ctxRef.current = ctx;
    sourceRef.current = source;
    gainRef.current = gain;

    return () => {
      source.disconnect();
      gain.disconnect();
      ctx.close();
      ctxRef.current = null;
      sourceRef.current = null;
      gainRef.current = null;
    };
    // Rebuild when stream or enabled changes; volume is handled separately
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, enabled]);

  // Update gain in real time without rebuilding the graph
  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = volume / 100;
    }
  }, [volume]);
}
