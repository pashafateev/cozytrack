"use client";

// UI components from @livekit/components-react are intentionally not wrapped
// by the Transport abstraction. If migrating off LiveKit, these components
// (LiveKitRoom, RoomAudioRenderer, useLocalParticipant, useRemoteParticipants,
// useSpeakingParticipants, etc.) would be replaced entirely, not adapted.
// See src/lib/transport/ for the imperative transport wrapper.
//
// Invariant: this file MUST NOT import from "livekit-client". All imperative
// LiveKit operations (data channel sends, DataReceived subscriptions, etc.)
// go through the Transport abstraction via useTransport().

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRemoteParticipants,
  useLocalParticipant,
  useSpeakingParticipants,
} from "@livekit/components-react";
import { v4 as uuidv4 } from "uuid";
import { CozyRecorder } from "@/lib/recorder";
import { getPresignedUploadUrl, uploadChunk, completeUpload } from "@/lib/upload";
import { getToken, LIVEKIT_URL } from "@/lib/livekit";
import { useTransport } from "@/lib/transport";
import { isBuiltInMic } from "@/lib/devices";
import { BuiltInMicWarningModal } from "@/components/BuiltInMicWarningModal";
import {
  MicMonitorToggle,
  getStoredMonitorEnabled,
  getStoredMonitorVolume,
} from "@/components/MicMonitorToggle";
import { useMicMonitor } from "@/hooks/useMicMonitor";
import { FinishRecordingButton } from "@/components/FinishRecordingButton";

import { Topbar } from "@/components/ui/Topbar";
import { VUMeter, DbScale } from "@/components/ui/VUMeter";
import { StatusDot, type Status } from "@/components/ui/StatusDot";
import {
  IcoAlert,
  IcoLink,
  IcoMic,
  IcoPlus,
} from "@/components/ui/Icon";

// ---------- Types ----------

type StudioState = "prejoin" | "connected" | "recording";
type AudioQualityMode = "full" | "bandwidth-saving";

// ---------- Audio Quality Presets ----------

const FULL_QUALITY_PUBLISH = {
  audioPreset: { maxBitrate: 128_000 },
  dtx: false,
} as const;

const BANDWIDTH_SAVING_PUBLISH = {
  audioPreset: { maxBitrate: 48_000 },
  dtx: true,
} as const;

// ---------- Helpers ----------

function formatElapsed(totalMs: number): string {
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600).toString().padStart(2, "0");
  const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// ---------- Participant Strip ----------

interface ParticipantStripProps {
  name: string;
  role: "host" | "guest";
  micLabel: string | undefined;
  isBuiltIn: boolean;
  level: number; // 0..255
  status: Status;
}

function ParticipantStrip({
  name,
  role,
  micLabel,
  isBuiltIn,
  level,
  status,
}: ParticipantStripProps) {
  const normalized = Math.max(0, Math.min(1, level / 255));
  return (
    <div
      className="rounded-lg px-4 py-3.5 border flex flex-col gap-2.5"
      style={{
        background: "var(--card)",
        borderColor: "var(--border)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 border"
          style={{
            background: "var(--card-hi)",
            borderColor: "var(--border-hi)",
          }}
        >
          <span className="text-xs font-semibold text-text-2">
            {name.charAt(0).toUpperCase()}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-text truncate">{name}</span>
            {role === "host" && (
              <span
                className="inline-flex items-center font-mono text-[11px] font-semibold px-2 py-0.5 rounded-[4px]"
                style={{
                  background: "rgba(200,120,64,0.09)",
                  color: "var(--amber)",
                  border: "1px solid rgba(200,120,64,0.16)",
                  letterSpacing: "0.03em",
                }}
              >
                host
              </span>
            )}
            {isBuiltIn && (
              <span
                title="Using built-in laptop mic"
                aria-label="Using built-in laptop mic"
                className="inline-flex"
              >
                <IcoAlert size={11} color="var(--warn)" />
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[11px] text-text-3 mt-0.5">
            <IcoMic size={10} color="currentColor" />
            <span className="font-mono truncate">{micLabel ?? "—"}</span>
          </div>
        </div>
        <StatusDot status={status} />
      </div>
      <VUMeter level={normalized} active={status !== "idle"} segments={32} height={52} />
      <DbScale />
    </div>
  );
}

// ---------- Invite Cohost Tile ----------

// Host-only tile. Clicking mints a fresh invite URL via the session's invite
// endpoint, copies it to the clipboard, and shows a modal so the host can
// re-copy or see the expiry. Each click mints a new token — we don't persist
// the last one; it's cheap and keeps the UI stateless across reloads.
function InviteCohostTile({ sessionId }: { sessionId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{
    url: string;
    expiresInSeconds: number;
  } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  async function onClick() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/invite`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to create invite");
        return;
      }
      const body: { url: string; expiresInSeconds: number } = await res.json();
      setInvite(body);
      try {
        await navigator.clipboard.writeText(body.url);
        setCopyState("copied");
      } catch {
        setCopyState("idle");
      }
    } catch {
      setError("Network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-lg px-4 py-3.5 flex items-center gap-3 border border-dashed hover:bg-card/40 focus:outline-none focus:ring-1 focus:ring-[var(--border-hi)] transition-colors disabled:opacity-60 disabled:cursor-wait text-left"
        style={{ borderColor: "var(--border)" }}
        title="Generate a shareable invite link for a cohost"
      >
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center border border-dashed"
          style={{ borderColor: "var(--border-hi)" }}
        >
          <IcoPlus size={14} color="var(--text-3)" />
        </div>
        <span className="text-[13px] text-text-2">
          {pending ? "Generating invite…" : "Invite a cohost…"}
        </span>
        <div className="ml-auto">
          <IcoLink size={13} color="var(--text-3)" />
        </div>
      </button>
      {error && (
        <div className="text-[11px] text-red-400 px-1" role="alert">
          {error}
        </div>
      )}
      {invite && (
        <InviteLinkModal
          url={invite.url}
          expiresInSeconds={invite.expiresInSeconds}
          initialCopyState={copyState}
          onClose={() => {
            setInvite(null);
            setCopyState("idle");
          }}
        />
      )}
    </>
  );
}

function InviteLinkModal({
  url,
  expiresInSeconds,
  initialCopyState,
  onClose,
}: {
  url: string;
  expiresInSeconds: number;
  initialCopyState: "idle" | "copied";
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied">(
    initialCopyState,
  );
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const container = dialogRef.current;
      if (!container) return;

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>("button, input, a[href]"),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Focus the first focusable element on open so keyboard users start inside
  // the dialog rather than on whatever was focused on the page behind it.
  useEffect(() => {
    const container = dialogRef.current;
    if (!container) return;
    const first = container.querySelector<HTMLElement>(
      "button, input, a[href]",
    );
    first?.focus();
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      // Clipboard can fail on insecure origins; the URL is still visible.
    }
  }

  // Use ceil so we never overstate validity. The token may expire sooner than
  // the rounded hour figure would suggest, hence "up to".
  const hours = Math.max(1, Math.ceil(expiresInSeconds / 3600));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-link-title"
        onClick={(e) => e.stopPropagation()}
        className="max-w-md w-full rounded-xl border p-6 shadow-2xl space-y-5"
        style={{ background: "var(--card)", borderColor: "var(--border-hi)" }}
      >
        <div>
          <h2
            id="invite-link-title"
            className="text-lg font-semibold text-text"
          >
            Invite a cohost
          </h2>
          <p className="text-sm text-text-2 mt-1.5">
            Share this link. Anyone who opens it can join this session; it
            expires in up to {hours}h.
          </p>
        </div>
        <div
          className="rounded-md border px-3 py-2 text-[11px] font-mono text-text-2 break-all select-all"
          style={{ background: "var(--bg)", borderColor: "var(--border)" }}
        >
          {url}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-text-3">
            {copyState === "copied" ? "Copied to clipboard" : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-[12px] px-3 py-1.5 rounded-md border hover:bg-card/50"
              style={{ borderColor: "var(--border)", color: "var(--text-2)" }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={copy}
              className="text-[12px] px-3 py-1.5 rounded-md font-medium"
              style={{ background: "var(--amber)", color: "var(--bg)" }}
            >
              {copyState === "copied" ? "Copy again" : "Copy link"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Room Content (inside LiveKitRoom) ----------

function RoomContent({
  sessionId,
  participantName,
  selectedMic,
  selectedMicLabel,
  selectedMicIsBuiltIn,
  studioState,
  setStudioState,
  monitorEnabled,
  monitorVolume,
  onMonitorEnabledChange,
  onMonitorVolumeChange,
  isHost,
}: {
  sessionId: string;
  participantName: string;
  selectedMic: string;
  selectedMicLabel: string | undefined;
  selectedMicIsBuiltIn: boolean;
  studioState: StudioState;
  setStudioState: (state: StudioState) => void;
  monitorEnabled: boolean;
  monitorVolume: number;
  onMonitorEnabledChange: (enabled: boolean) => void;
  onMonitorVolumeChange: (volume: number) => void;
  isHost: boolean;
}) {
  const remoteParticipants = useRemoteParticipants();
  const speakingParticipants = useSpeakingParticipants();
  const { localParticipant } = useLocalParticipant();
  const transport = useTransport();
  const recorderRef = useRef<CozyRecorder | null>(null);
  const trackIdRef = useRef<string>("");
  const streamRef = useRef<MediaStream | null>(null);
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(null);
  // Mirror of studioState so callbacks invoked from transport subscriptions
  // (which close over the value at subscription time) can check current state
  // without re-subscribing on every render.
  //
  // The ref is updated *synchronously* via setStudioStateSync at every
  // recording-state transition below. Relying on a useEffect alone to sync
  // would run after paint, so a freshly-rendered button could re-fire a
  // handler that reads a stale ref and early-returns. The useEffect is kept
  // as a fallback for any external setStudioState updates we don't control.
  const studioStateRef = useRef<StudioState>(studioState);
  useEffect(() => {
    studioStateRef.current = studioState;
  }, [studioState]);
  const setStudioStateSync = useCallback(
    (next: StudioState) => {
      studioStateRef.current = next;
      setStudioState(next);
    },
    [setStudioState],
  );

  // Sidetone: let the user hear themselves without affecting the recording
  useMicMonitor({ stream: recordingStream, enabled: monitorEnabled, volume: monitorVolume });

  const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map());
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const recordingStartRef = useRef<number>(0);
  const localLevelRef = useRef(0);
  const chunkUploadPromisesRef = useRef(new Set<Promise<void>>());

  const [audioQualityMode, setAudioQualityMode] = useState<AudioQualityMode>("full");
  const [notification, setNotification] = useState<string | null>(null);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasRecorded, setHasRecorded] = useState(false);

  // Elapsed recording timer
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showNotification = useCallback((message: string) => {
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    setNotification(message);
    notificationTimerRef.current = setTimeout(() => {
      setNotification(null);
      notificationTimerRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    };
  }, []);

  const switchAudioQuality = useCallback(
    async (mode: AudioQualityMode): Promise<boolean> => {
      const opts = mode === "full" ? FULL_QUALITY_PUBLISH : BANDWIDTH_SAVING_PUBLISH;
      try {
        await localParticipant.republishAllTracks(opts, false);
        setAudioQualityMode(mode);
        return true;
      } catch (err) {
        console.error("Failed to switch audio quality:", err);
        return false;
      }
    },
    [localParticipant],
  );

  const trackChunkUpload = useCallback((uploadPromise: Promise<void>) => {
    chunkUploadPromisesRef.current.add(uploadPromise);
    uploadPromise.finally(() => {
      chunkUploadPromisesRef.current.delete(uploadPromise);
    });
  }, []);

  const waitForChunkUploads = useCallback(async () => {
    while (chunkUploadPromisesRef.current.size > 0) {
      await Promise.allSettled(Array.from(chunkUploadPromisesRef.current));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function getRecordingStream() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: selectedMic ? { exact: selectedMic } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
          },
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = stream;
        setRecordingStream(stream);
      } catch (err) {
        console.error("Failed to get recording stream:", err);
      }
    }

    void getRecordingStream();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setRecordingStream(null);
    };
  }, [selectedMic]);

  // Monitor local audio levels
  useEffect(() => {
    if (!recordingStream) return;

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(recordingStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.85;
    source.connect(analyser);
    analyserRef.current = analyser;

    const dataArray = new Uint8Array(analyser.fftSize);

    function tick() {
      if (!analyserRef.current) return;
      analyserRef.current.getByteTimeDomainData(dataArray);

      let sumSquares = 0;
      for (const value of dataArray) {
        const centeredSample = (value - 128) / 128;
        sumSquares += centeredSample * centeredSample;
      }

      const rms = Math.sqrt(sumSquares / dataArray.length);
      const normalized = Math.min(1, Math.max(0, (rms - 0.01) / 0.12));
      const targetLevel = Math.round(Math.pow(normalized, 0.6) * 255);
      const smoothedLevel = Math.round(
        localLevelRef.current * 0.7 + targetLevel * 0.3
      );
      localLevelRef.current = smoothedLevel;

      setAudioLevels((prev) => {
        const next = new Map(prev);
        next.set(participantName, smoothedLevel);
        return next;
      });
      animFrameRef.current = requestAnimationFrame(tick);
    }

    tick();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      localLevelRef.current = 0;
      audioCtx.close();
    };
  }, [participantName, recordingStream]);

  // Track remote audio levels via the speaking-participants hook
  useEffect(() => {
    setAudioLevels((prev) => {
      const next = new Map(prev);
      for (const s of speakingParticipants) {
        next.set(
          s.identity ?? "unknown",
          Math.round((s.audioLevel ?? 0) * 255),
        );
      }
      return next;
    });
  }, [speakingParticipants]);

  // Tick the elapsed-time display while recording. The interval is bound to
  // studioState — when stop is initiated (locally OR via a received
  // recording_stop control message), studioState transitions to "connected"
  // and this effect tears the interval down. The display is left frozen at
  // the stop-moment value rather than reset to zero, and only reinitialized
  // when a new recording begins.
  useEffect(() => {
    if (studioState !== "recording") return;
    setElapsedMs(0);
    const started = Date.now();
    const id = setInterval(() => {
      setElapsedMs(Date.now() - started);
    }, 250);
    elapsedTimerRef.current = id;
    return () => {
      clearInterval(id);
      elapsedTimerRef.current = null;
    };
  }, [studioState]);

  // Core recording start. Idempotent against double-invocation: if we're
  // already recording (our own click echoed via a later remote message, or the
  // button pressed twice), this is a no-op.
  const startRecordingLocal = useCallback(
    async (sessionStartedAtIso: string) => {
      if (studioStateRef.current === "recording" || recorderRef.current) return;
      if (!streamRef.current) return;

      trackIdRef.current = uuidv4();
      const trackId = trackIdRef.current;

      try {
        await getPresignedUploadUrl(sessionId, trackId, 0, participantName, {
          deviceInfo: {
            deviceLabel: selectedMicLabel,
            deviceId: selectedMic,
            isBuiltInMic: selectedMicIsBuiltIn,
          },
          sessionStartedAt: sessionStartedAtIso,
        });
      } catch (err) {
        console.error("Failed to initialize upload:", err);
        return;
      }

      const recorder = new CozyRecorder(streamRef.current);

      recorder.onChunk((chunk, index) => {
        const uploadPromise = (async () => {
          try {
            const url = await getPresignedUploadUrl(sessionId, trackId, index);
            await uploadChunk(url, chunk);
          } catch (err) {
            console.error("Failed to upload chunk:", err);
          }
        })();

        trackChunkUpload(uploadPromise);
      });

      recorderRef.current = recorder;
      recordingStartRef.current = Date.now();

      try {
        await recorder.start(5000);
      } catch (err) {
        console.error("Failed to start recorder:", err);
        recorderRef.current = null;
        return;
      }

      setStudioStateSync("recording");

      // Auto-switch to bandwidth-saving mode for the LiveKit preview
      const switched = await switchAudioQuality("bandwidth-saving");
      if (switched) {
        showNotification("Preview quality reduced — local recording is unaffected");
      } else {
        showNotification("Couldn't switch audio quality — check console");
      }
    },
    [
      sessionId,
      participantName,
      selectedMic,
      selectedMicLabel,
      selectedMicIsBuiltIn,
      setStudioStateSync,
      showNotification,
      switchAudioQuality,
      trackChunkUpload,
    ],
  );

  // Core recording stop. Idempotent: no-op when we have no active recorder.
  // Transitions studioState out of "recording" up front so UI elements bound
  // to it (notably the elapsed-time ticker) tear down even if the async
  // upload finalization below throws. Without this, a network blip on the
  // co-host during finalize would leave the timer running forever (#48).
  const stopRecordingLocal = useCallback(async () => {
    if (!recorderRef.current) return;

    const recorder = recorderRef.current;
    recorderRef.current = null;
    setStudioStateSync("connected");
    setHasRecorded(true);

    try {
      const blob = await recorder.stop();
      const trackId = trackIdRef.current;
      const durationMs = Date.now() - recordingStartRef.current;

      const url = await getPresignedUploadUrl(sessionId, trackId, 9999);
      await uploadChunk(url, blob);
      await waitForChunkUploads();
      await completeUpload(sessionId, trackId, durationMs);

      await switchAudioQuality("full");
    } catch (err) {
      console.error("Failed to stop recording:", err);
    }
  }, [sessionId, setStudioStateSync, switchAudioQuality, waitForChunkUploads]);

  // Button handler: broadcast first so remote participants start close to our
  // own start time, then start locally. sessionStartedAt uses our local clock
  // so all participants share a single reference timestamp on the Track row.
  const handleStartRecording = useCallback(async () => {
    if (studioStateRef.current === "recording" || recorderRef.current) return;
    const sessionStartedAt = new Date().toISOString();
    try {
      await transport.sendControlMessage({ type: "recording_start", sessionStartedAt });
    } catch (err) {
      console.error("Failed to broadcast recording_start:", err);
    }
    await startRecordingLocal(sessionStartedAt);
  }, [transport, startRecordingLocal]);

  const handleStopRecording = useCallback(async () => {
    try {
      await transport.sendControlMessage({ type: "recording_stop" });
    } catch (err) {
      console.error("Failed to broadcast recording_stop:", err);
    }
    await stopRecordingLocal();
  }, [transport, stopRecordingLocal]);

  // Subscribe to remote control messages. LiveKit does not echo the sender's
  // own messages back, but startRecordingLocal/stopRecordingLocal are
  // idempotent anyway as a belt-and-braces guard.
  useEffect(() => {
    const unsub = transport.onControlMessage((msg, fromParticipant) => {
      if (msg.type === "recording_start") {
        showNotification(
          `Recording started by ${fromParticipant || "another participant"}`,
        );
        void startRecordingLocal(msg.sessionStartedAt);
      } else if (msg.type === "recording_stop") {
        showNotification(
          `Recording stopped by ${fromParticipant || "another participant"}`,
        );
        void stopRecordingLocal();
      }
    });
    return unsub;
  }, [transport, startRecordingLocal, stopRecordingLocal, showNotification]);


  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // Dismissable warning banner — surfaces when the local mic is built-in.
  // Remote-participant warnings will reuse this banner once #28 propagates
  // isBuiltInMic via LiveKit metadata.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const showLocalMicWarning = selectedMicIsBuiltIn && !bannerDismissed;

  const isRecording = studioState === "recording";

  const localStatus: Status = isRecording ? "recording" : "connected";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Notification toast */}
      {notification && (
        <div
          className="fixed top-[68px] left-1/2 -translate-x-1/2 z-50 px-3.5 py-2 rounded-lg text-[12px] text-text-2 shadow-lg animate-toast-fade-in border"
          style={{
            background: "var(--card-hi)",
            borderColor: "var(--border-hi)",
          }}
        >
          {notification}
        </div>
      )}

      {/* Local built-in mic warning banner */}
      {showLocalMicWarning && (
        <div
          className="flex items-center gap-2.5 py-2.5 px-5 border-b"
          style={{
            background: "rgba(232,168,48,0.07)",
            borderBottomColor: "rgba(232,168,48,0.18)",
          }}
        >
          <IcoAlert size={14} color="var(--warn)" />
          <span className="text-[12px] text-warn flex-1">
            You&apos;re using a built-in laptop mic — audio quality may be lower than expected
          </span>
          <button
            onClick={() => setBannerDismissed(true)}
            className="text-[11px] text-warn/70 hover:text-warn underline font-sans"
          >
            dismiss
          </button>
        </div>
      )}

      {/* Audio quality pill (preview) */}
      <div className="flex items-center justify-center gap-3 px-5 py-3 border-b" style={{ borderBottomColor: "var(--border)" }}>
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium border font-mono"
          style={{
            color: audioQualityMode === "full" ? "var(--ok)" : "var(--warn)",
            borderColor: audioQualityMode === "full" ? "rgba(82,201,122,0.3)" : "rgba(232,168,48,0.3)",
            background: audioQualityMode === "full" ? "rgba(82,201,122,0.08)" : "rgba(232,168,48,0.08)",
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: audioQualityMode === "full" ? "var(--ok)" : "var(--warn)",
            }}
          />
          {audioQualityMode === "full" ? "Full Quality Preview" : "Bandwidth-Saving Mode"}
        </span>
        {isRecording && (
          <button
            onClick={() =>
              switchAudioQuality(
                audioQualityMode === "full" ? "bandwidth-saving" : "full",
              )
            }
            className="text-[11px] text-text-3 hover:text-text-2 underline underline-offset-2 font-sans"
          >
            {audioQualityMode === "full"
              ? "Switch to bandwidth-saving"
              : "Switch to full quality"}
          </button>
        )}
      </div>

      {/* Main layout: strips + right sidebar */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 p-5 flex flex-col gap-2.5 overflow-y-auto">
          <ParticipantStrip
            name={participantName}
            role="host"
            micLabel={selectedMicLabel ?? "Unknown mic"}
            isBuiltIn={selectedMicIsBuiltIn}
            level={audioLevels.get(participantName) ?? 0}
            status={localStatus}
          />

          {remoteParticipants.map((p) => (
            <ParticipantStrip
              key={p.identity}
              name={p.identity}
              role="guest"
              micLabel={undefined /* Remote mic label — needs #28 (LiveKit metadata propagation). */}
              isBuiltIn={false /* Remote built-in detection — needs #28. */}
              level={audioLevels.get(p.identity) ?? 0}
              // studioState is local-only, so showing localStatus on remote
              // strips was misleading (guests appeared to be "Recording" whenever
              // the host hit record). Remote per-participant status is tracked
              // in #30; until then we show a stable "connected" for remotes.
              status="connected"
            />
          ))}

          {/* Invite tile — host-only. Guests don't see the affordance; the
              underlying API also rejects non-host callers. */}
          {isHost && <InviteCohostTile sessionId={sessionId} />}

          {/* Monitor toggle kept below the strips so it doesn't crowd the meters */}
          <div className="mt-2">
            <MicMonitorToggle
              enabled={monitorEnabled}
              volume={monitorVolume}
              onEnabledChange={onMonitorEnabledChange}
              onVolumeChange={onMonitorVolumeChange}
            />
          </div>

          {/* Finish recording (post-stop) — surfaces after the local recorder
              has produced at least one track and the studio is no longer in
              the recording state. Drives the /api/sessions/:id/finalize flow. */}
          {studioState === "connected" && hasRecorded && (
            <div className="flex justify-center mt-3">
              <FinishRecordingButton
                sessionId={sessionId}
                waitForUploads={waitForChunkUploads}
              />
            </div>
          )}
        </div>

        {/* Right sidebar: record button + upload */}
        <div
          className="w-[120px] flex flex-col items-center py-7 border-l"
          style={{
            background: "var(--surface)",
            borderLeftColor: "var(--border)",
          }}
        >
          <div className="flex flex-col items-center gap-3 flex-1 justify-center">
            <div className="relative">
              <button
                type="button"
                onClick={() => (isRecording ? handleStopRecording() : handleStartRecording())}
                className={`w-[60px] h-[60px] rounded-full flex items-center justify-center cursor-pointer border-2 ${
                  isRecording ? "rec-ring" : ""
                }`}
                style={{
                  background: isRecording ? "rgba(232,80,80,0.1)" : "var(--card)",
                  borderColor: isRecording ? "var(--rec)" : "var(--border-hi)",
                  transition: "all 200ms ease",
                }}
                aria-label={isRecording ? "Stop recording" : "Start recording"}
              >
                {isRecording ? (
                  <div
                    className="w-5 h-5 rounded-[3px]"
                    style={{ background: "var(--rec)" }}
                  />
                ) : (
                  <div
                    className="w-6 h-6 rounded-full"
                    style={{ background: "var(--rec)" }}
                  />
                )}
              </button>
            </div>
            <span
              className="font-mono text-[10px] font-medium tracking-[0.08em]"
              style={{
                color: isRecording ? "var(--rec)" : "var(--text-3)",
              }}
            >
              {isRecording ? "STOP" : "REC"}
            </span>
            <div
              className="font-mono text-[13px] tracking-[0.06em]"
              style={{
                color: isRecording ? "var(--text-2)" : "var(--text-3)",
              }}
            >
              {formatElapsed(elapsedMs)}
            </div>
          </div>

          <div className="w-10 h-px my-3" style={{ background: "var(--border)" }} />

          {/* Upload indicator — real progress plumbing tracked in #27. */}
          <div className="w-full px-3 flex flex-col gap-1.5 items-center mb-5">
            <span className="font-mono text-[9px] text-text-3 tracking-[0.08em]">UPLOAD</span>
            <div className="w-full h-0.5 rounded-[1px]" style={{ background: "var(--border)" }}>
              <div
                className="h-full rounded-[1px]"
                style={{
                  width: isRecording ? "30%" : "0%",
                  background: "var(--amber)",
                  transition: "width 600ms ease",
                }}
              />
            </div>
            <span className="font-mono text-[9px] text-text-3">
              {isRecording ? "in flight" : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Studio Page ----------

export default function StudioPage() {
  const params = useParams();
  const sessionId = params.id as string;

  const [studioState, setStudioState] = useState<StudioState>("prejoin");
  const [participantName, setParticipantName] = useState("");
  const [selectedMic, setSelectedMic] = useState("");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [monitorEnabled, setMonitorEnabled] = useState(false);
  const [monitorVolume, setMonitorVolume] = useState(70);
  // Role drives host-only affordances (e.g. the cohost invite tile). Guests
  // arriving via /join have their display name recorded in the cookie; we
  // use it to prefill the prejoin form.
  const [isHost, setIsHost] = useState(false);

  useEffect(() => {
    setMonitorEnabled(getStoredMonitorEnabled());
    setMonitorVolume(getStoredMonitorVolume());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadPrincipal() {
      try {
        const res = await fetch(
          `/api/auth/me?sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok) return;
        const body: { role?: string; name?: string } = await res.json();
        if (cancelled) return;
        if (body.role === "host") {
          setIsHost(true);
        } else if (body.role === "guest" && typeof body.name === "string") {
          setParticipantName((prev) => (prev ? prev : body.name ?? ""));
        }
      } catch {
        // Leave defaults — the studio still works, just without host UI.
      }
    }
    void loadPrincipal();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const [showMicWarning, setShowMicWarning] = useState(false);
  const [acknowledgedDevices, setAcknowledgedDevices] = useState<Set<string>>(
    () => new Set(),
  );
  const micSelectRef = useRef<HTMLSelectElement>(null);
  const prejoinStreamRef = useRef<MediaStream | null>(null);
  const [prejoinStream, setPrejoinStream] = useState<MediaStream | null>(null);
  const selectedMicDevice = useMemo(
    () => mics.find((m) => m.deviceId === selectedMic),
    [mics, selectedMic],
  );

  // Enumerate mic devices
  useEffect(() => {
    async function getMics() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
          },
        });
        stream.getTracks().forEach((t) => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        setMics(audioInputs);
        if (audioInputs.length > 0) {
          setSelectedMic(audioInputs[0].deviceId);
        }
      } catch (err) {
        console.error("Failed to enumerate devices:", err);
      }
    }

    getMics();
  }, []);

  useEffect(() => {
    if (studioState !== "prejoin" || !selectedMic || !monitorEnabled) return;

    let cancelled = false;

    async function acquire() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: selectedMic },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        prejoinStreamRef.current?.getTracks().forEach((t) => t.stop());
        prejoinStreamRef.current = stream;
        setPrejoinStream(stream);
      } catch {
        // Ignore — mic permission may not be granted yet
      }
    }

    void acquire();

    return () => {
      cancelled = true;
      prejoinStreamRef.current?.getTracks().forEach((t) => t.stop());
      prejoinStreamRef.current = null;
      setPrejoinStream(null);
    };
  }, [studioState, selectedMic, monitorEnabled]);

  useMicMonitor({
    stream: studioState === "prejoin" ? prejoinStream : null,
    enabled: monitorEnabled,
    volume: monitorVolume,
  });

  async function proceedToJoin() {
    setConnecting(true);
    try {
      const jwt = await getToken(sessionId, participantName.trim());
      setToken(jwt);
      setStudioState("connected");
    } catch (err) {
      console.error("Failed to get token:", err);
      setConnecting(false);
    }
  }

  function handleJoin() {
    if (!participantName.trim()) return;

    if (
      selectedMicDevice &&
      isBuiltInMic(selectedMicDevice.label) &&
      !acknowledgedDevices.has(selectedMic)
    ) {
      setShowMicWarning(true);
      return;
    }

    proceedToJoin();
  }

  // ---------- Pre-join screen ----------

  if (studioState === "prejoin") {
    return (
      <div className="animate-page-enter min-h-screen bg-bg flex flex-col">
        <Topbar />
        {showMicWarning && (
          <BuiltInMicWarningModal
            onAcknowledge={() => {
              setAcknowledgedDevices((prev) => new Set(prev).add(selectedMic));
              setShowMicWarning(false);
              proceedToJoin();
            }}
            onSwitchMic={() => {
              setShowMicWarning(false);
              micSelectRef.current?.focus();
            }}
          />
        )}
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="w-full max-w-[360px] flex flex-col items-center">
            <div className="mb-6 opacity-40">
              <IcoMic size={32} color="var(--text)" />
            </div>
            <h1 className="text-[22px] font-bold text-text tracking-[-0.03em]">Join Studio</h1>
            <p className="font-mono text-[11px] text-text-3 mt-1.5">
              Session {sessionId.slice(0, 8)}…
            </p>

            <div className="w-full mt-7 space-y-4">
              <div>
                <label className="block font-sans text-[11px] font-medium text-text-3 uppercase tracking-[0.08em] mb-2">
                  Your Name
                </label>
                <input
                  type="text"
                  value={participantName}
                  onChange={(e) => setParticipantName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                  placeholder="Enter your name"
                  className="w-full px-3.5 py-2.5 text-sm rounded-md outline-none border font-sans text-text"
                  style={{
                    background: "var(--card)",
                    borderColor: "var(--border)",
                  }}
                />
              </div>

              <div>
                <label className="block font-sans text-[11px] font-medium text-text-3 uppercase tracking-[0.08em] mb-2">
                  Microphone
                </label>
                <select
                  ref={micSelectRef}
                  value={selectedMic}
                  onChange={(e) => setSelectedMic(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm rounded-md outline-none border font-sans text-text"
                  style={{
                    background: "var(--card)",
                    borderColor: "var(--border)",
                  }}
                >
                  {mics.map((mic) => (
                    <option key={mic.deviceId} value={mic.deviceId}>
                      {mic.label || `Microphone ${mic.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
              </div>

              <MicMonitorToggle
                enabled={monitorEnabled}
                volume={monitorVolume}
                onEnabledChange={setMonitorEnabled}
                onVolumeChange={setMonitorVolume}
              />

              <button
                onClick={handleJoin}
                disabled={!participantName.trim() || connecting}
                className="w-full py-[11px] text-[15px] font-semibold font-sans rounded-md border disabled:cursor-not-allowed"
                style={{
                  background: !participantName.trim() || connecting ? "var(--card)" : "var(--amber)",
                  color: !participantName.trim() || connecting ? "var(--text-3)" : "var(--bg)",
                  borderColor: !participantName.trim() || connecting ? "var(--border)" : "var(--amber)",
                  opacity: !participantName.trim() || connecting ? 0.8 : 1,
                }}
              >
                {connecting ? "Connecting…" : "Join Studio"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Connected / Recording ----------

  return (
    <div className="animate-page-enter min-h-screen bg-bg flex flex-col">
      <Topbar session={`Session ${sessionId.slice(0, 8)}…`} />
      <LiveKitRoom
        serverUrl={LIVEKIT_URL}
        token={token}
        audio={{
          deviceId: selectedMic ? { exact: selectedMic } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 1,
        }}
        options={{
          publishDefaults: {
            audioPreset: { maxBitrate: 128_000 },
            dtx: false,
          },
        }}
        connect={true}
        className="flex flex-col flex-1 min-h-0"
      >
        <RoomAudioRenderer />
        <RoomContent
          sessionId={sessionId}
          participantName={participantName}
          selectedMic={selectedMic}
          selectedMicLabel={selectedMicDevice?.label || undefined}
          selectedMicIsBuiltIn={selectedMicDevice ? isBuiltInMic(selectedMicDevice.label) : false}
          studioState={studioState}
          setStudioState={setStudioState}
          monitorEnabled={monitorEnabled}
          monitorVolume={monitorVolume}
          onMonitorEnabledChange={setMonitorEnabled}
          onMonitorVolumeChange={setMonitorVolume}
          isHost={isHost}
        />
      </LiveKitRoom>
    </div>
  );
}
