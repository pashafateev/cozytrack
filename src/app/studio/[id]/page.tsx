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

import {
  type ReactNode,
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useParams } from "next/navigation";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRemoteParticipants,
  useLocalParticipant,
} from "@livekit/components-react";
import { v4 as uuidv4 } from "uuid";
import { CozyRecorder } from "@/lib/recorder";
import { forceMonoStream, getTrackChannelCount } from "@/lib/audio-downmix";
import { getPresignedUploadUrl, uploadChunk, completeUpload } from "@/lib/upload";
import { getToken, LIVEKIT_URL } from "@/lib/livekit";
import { useTransport, type RecordingStatusState } from "@/lib/transport";
import { isSelectedMicBuiltIn } from "@/lib/devices";
import { BuiltInMicWarningModal } from "@/components/BuiltInMicWarningModal";
import {
  MicMonitorToggle,
  getStoredMonitorEnabled,
  getStoredMonitorVolume,
} from "@/components/MicMonitorToggle";
import { useMicMonitor } from "@/hooks/useMicMonitor";
import { useRemoteAudioLevels } from "@/hooks/useRemoteAudioLevels";
import {
  CLIP_MIN_FRAMES,
  CLIP_THRESHOLD,
  SHAPING_EXPONENT,
  smoothLevel,
} from "@/lib/audio-meter";
import { FinishRecordingButton } from "@/components/FinishRecordingButton";
import { useUploadProgress } from "@/hooks/useUploadProgress";
import { UploadProgressBar } from "@/components/UploadProgressBar";

import { Topbar } from "@/components/ui/Topbar";
import { VUMeter, DbScale } from "@/components/ui/VUMeter";
import { StatusDot, type Status } from "@/components/ui/StatusDot";
import {
  IcoAlert,
  IcoLink,
  IcoMic,
  IcoPlus,
  IcoX,
} from "@/components/ui/Icon";

// ---------- Types ----------

type StudioState = "prejoin" | "connected" | "recording" | "finalizing";
type AudioQualityMode = "full" | "bandwidth-saving";
type RemoteRecordingStatus = {
  state: RecordingStatusState;
  sessionStartedAt?: string;
  reason?: string;
  updatedAt: number;
};

// ---------- Audio Quality Presets ----------

const FULL_QUALITY_PUBLISH = {
  audioPreset: { maxBitrate: 128_000 },
  dtx: false,
} as const;

const BANDWIDTH_SAVING_PUBLISH = {
  audioPreset: { maxBitrate: 48_000 },
  dtx: true,
} as const;

const RECORDING_CONFIRMATION_TIMEOUT_MS = 4000;

// ---------- Helpers ----------

function formatElapsed(totalMs: number): string {
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600).toString().padStart(2, "0");
  const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatParticipantList(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function isMobileBrowser(navigatorInfo: Navigator): boolean {
  const ua = navigatorInfo.userAgent;
  const looksLikeModernIpad =
    navigatorInfo.platform === "MacIntel" && navigatorInfo.maxTouchPoints > 1;

  return /iPhone|iPad|iPod|Android/i.test(ua) || looksLikeModernIpad;
}

function MobileBrowserWarningBanner({
  onDismiss,
}: {
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-[var(--topbar-height)] z-40 flex items-start gap-3 px-5 py-3 border-b"
      style={{
        background: "rgba(232,168,48,0.09)",
        borderBottomColor: "rgba(232,168,48,0.22)",
      }}
    >
      <span className="mt-0.5 flex-shrink-0">
        <IcoAlert size={15} color="var(--warn)" />
      </span>
      <p className="flex-1 text-[12px] leading-5 text-warn">
        <span className="font-semibold">Mobile browser detected.</span>{" "}
        Audio quality may be reduced and recording may fail if you switch apps
        or your screen locks. For best results, join from a laptop or desktop
        browser.
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss mobile browser warning"
        className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[4px] text-warn/70 hover:bg-warn/10 hover:text-warn"
      >
        <IcoX size={14} color="currentColor" />
      </button>
    </div>
  );
}

function StudioFrame({
  children,
  session,
  showMobileWarning,
  onDismissMobileWarning,
}: {
  children: ReactNode;
  session?: string;
  showMobileWarning: boolean;
  onDismissMobileWarning: () => void;
}) {
  return (
    <div className="animate-page-enter min-h-screen bg-bg flex flex-col">
      <Topbar session={session} />
      {showMobileWarning && (
        <MobileBrowserWarningBanner onDismiss={onDismissMobileWarning} />
      )}
      {children}
    </div>
  );
}

// ---------- Participant Strip ----------

interface ParticipantStripProps {
  name: string;
  role: "host" | "guest";
  micLabel: string | undefined;
  isBuiltIn: boolean;
  level: number; // 0..255
  status: Status;
  clipping?: boolean;
}

function ParticipantStrip({
  name,
  role,
  micLabel,
  isBuiltIn,
  level,
  status,
  clipping = false,
}: ParticipantStripProps) {
  const normalized = Math.max(0, Math.min(1, level / 255));
  return (
    <div
      className="rounded-lg px-4 py-3.5 border flex flex-col gap-2.5"
      style={{
        background: "var(--card)",
        borderColor: clipping ? "var(--rec)" : "var(--border)",
        boxShadow: clipping ? "0 0 0 1px var(--rec), 0 0 12px rgba(232,80,80,0.45)" : undefined,
        transition: "border-color 80ms ease, box-shadow 80ms ease",
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
            {clipping && (
              <span
                title="Audio is clipping — ask the talker to back off the mic or lower input gain"
                aria-label="Audio is clipping"
                className="inline-flex items-center font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-[4px]"
                style={{
                  background: "rgba(232,80,80,0.16)",
                  color: "var(--rec)",
                  border: "1px solid rgba(232,80,80,0.3)",
                  letterSpacing: "0.04em",
                }}
              >
                CLIP
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

/**
 * Recording state machine
 * -----------------------
 *
 *   connected  →  recording  →  finalizing  →  connected
 *                                   ↑
 *                            start blocked here
 *
 * Hard invariant: cannot start a new recording while in `finalizing`.
 *
 * - connected:  no active recording. Record button enabled.
 * - recording:  actively capturing. Elapsed timer ticks. Record button shows Stop.
 * - finalizing: capture stopped, draining/uploading remaining chunks. Timer frozen
 *               at stop value. Record button disabled.
 *               Transitions to `connected` when uploads drain (success or error).
 *
 * This is the client-side projection of the server's recording lifecycle
 * (see issue #60 for the broader server-owned-lifecycle plan; #61 for this
 * specific design).
 */
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
  const { localParticipant } = useLocalParticipant();
  const transport = useTransport();
  const recorderRef = useRef<CozyRecorder | null>(null);
  const trackIdRef = useRef<string>("");
  // Raw stream straight from getUserMedia — retained so we can stop the
  // underlying device tracks on teardown.
  const rawStreamRef = useRef<MediaStream | null>(null);
  // Mono-forced stream (post-downmix) — what the recorder, level meter, and
  // sidetone monitor actually consume. See `forceMonoStream` in
  // `@/lib/audio-downmix` for why we always downmix instead of trusting
  // `getUserMedia` constraints.
  const streamRef = useRef<MediaStream | null>(null);
  const downmixDisposeRef = useRef<(() => void) | null>(null);
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
  const [localClipping, setLocalClipping] = useState(false);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const recordingStartRef = useRef<number>(0);
  const localLevelRef = useRef(0);
  // Tracks consecutive clip frames + remaining hold ticks for the local meter,
  // so a transient peak still flashes instead of vanishing in one rAF.
  const localClipFramesRef = useRef(0);
  const localClipHoldRef = useRef(0);
  const uploadTracker = useUploadProgress();
  // Destructure stable callbacks so they can be listed individually in
  // dependency arrays. `uploadTracker` itself is a fresh object each render,
  // so depending on the whole tracker would recreate callbacks every render
  // and force downstream effects to re-subscribe.
  const {
    onChunkRecorded: trackerOnChunkRecorded,
    trackUpload: trackerTrackUpload,
    freezeRecorded: trackerFreezeRecorded,
    reset: trackerReset,
    waitForUploads: trackerWaitForUploads,
  } = uploadTracker;

  const [audioQualityMode, setAudioQualityMode] = useState<AudioQualityMode>("full");
  const [notification, setNotification] = useState<string | null>(null);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasRecorded, setHasRecorded] = useState(false);

  // Elapsed recording timer
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [recordingSessionStartedAt, setRecordingSessionStartedAt] =
    useState<string | null>(null);
  const recordingSessionStartedAtRef = useRef<string | null>(null);
  const setRecordingSessionStartedAtSync = useCallback((next: string | null) => {
    recordingSessionStartedAtRef.current = next;
    setRecordingSessionStartedAt(next);
  }, []);
  const [remoteRecordingStatuses, setRemoteRecordingStatuses] = useState<
    Map<string, RemoteRecordingStatus>
  >(() => new Map());
  const remoteRecordingStatusesRef = useRef(remoteRecordingStatuses);
  const [expectedRecordingParticipants, setExpectedRecordingParticipants] =
    useState<Set<string>>(() => new Set());
  const expectedRecordingParticipantsRef = useRef<Set<string>>(new Set());
  const [
    unconfirmedRecordingParticipants,
    setUnconfirmedRecordingParticipants,
  ] = useState<Set<string>>(() => new Set());
  const recordingConfirmationTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    remoteRecordingStatusesRef.current = remoteRecordingStatuses;
  }, [remoteRecordingStatuses]);

  const clearRecordingConfirmationTimer = useCallback(() => {
    if (!recordingConfirmationTimerRef.current) return;
    clearTimeout(recordingConfirmationTimerRef.current);
    recordingConfirmationTimerRef.current = null;
  }, []);

  const clearRecordingConfirmationState = useCallback(
    (clearSession = true) => {
      clearRecordingConfirmationTimer();
      expectedRecordingParticipantsRef.current = new Set();
      setExpectedRecordingParticipants(new Set());
      setUnconfirmedRecordingParticipants(new Set());
      if (clearSession) setRecordingSessionStartedAtSync(null);
    },
    [clearRecordingConfirmationTimer, setRecordingSessionStartedAtSync],
  );

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

  useEffect(() => clearRecordingConfirmationTimer, [
    clearRecordingConfirmationTimer,
  ]);

  const updateRemoteRecordingStatus = useCallback(
    (identity: string, status: RemoteRecordingStatus) => {
      setRemoteRecordingStatuses((prev) => {
        const next = new Map(prev);
        next.set(identity, status);
        remoteRecordingStatusesRef.current = next;
        return next;
      });
    },
    [],
  );

  const scheduleRecordingConfirmationCheck = useCallback(
    (sessionStartedAt: string) => {
      const expected = new Set(
        remoteParticipants.map((p) => p.identity).filter(Boolean),
      );
      expectedRecordingParticipantsRef.current = expected;
      setExpectedRecordingParticipants(expected);
      setUnconfirmedRecordingParticipants(new Set());
      clearRecordingConfirmationTimer();

      if (expected.size === 0) return;

      recordingConfirmationTimerRef.current = setTimeout(() => {
        if (recordingSessionStartedAtRef.current !== sessionStartedAt) return;

        const statuses = remoteRecordingStatusesRef.current;
        const currentExpected = expectedRecordingParticipantsRef.current;
        const unconfirmed = Array.from(currentExpected).filter((identity) => {
          const status = statuses.get(identity);
          if (status?.sessionStartedAt !== sessionStartedAt) return true;
          return status.state !== "recording" && status.state !== "failed";
        });

        if (unconfirmed.length === 0) return;

        setUnconfirmedRecordingParticipants(new Set(unconfirmed));
        showNotification(
          `Recording not confirmed by ${formatParticipantList(unconfirmed)}`,
        );
      }, RECORDING_CONFIRMATION_TIMEOUT_MS);
    },
    [clearRecordingConfirmationTimer, remoteParticipants, showNotification],
  );

  const broadcastRecordingStatus = useCallback(
    async (
      state: RecordingStatusState,
      sessionStartedAt?: string,
      reason?: string,
    ) => {
      try {
        await transport.sendControlMessage({
          type: "recording_status",
          state,
          ...(sessionStartedAt !== undefined ? { sessionStartedAt } : {}),
          ...(reason !== undefined ? { reason } : {}),
        });
      } catch (err) {
        console.error("Failed to broadcast recording_status:", err);
      }
    },
    [transport],
  );

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


  useEffect(() => {
    let cancelled = false;

    async function getRecordingStream() {
      try {
        const rawStream = await navigator.mediaDevices.getUserMedia({
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
          rawStream.getTracks().forEach((track) => track.stop());
          return;
        }

        // Tear down any prior stream/downmix before installing the new one.
        // Both raw and mono streams must be stopped: AudioContext.close() does
        // not reliably end the destination track on every browser, so the
        // previous mono MediaStreamTrack can otherwise outlive the switch.
        // The guard prevents a double-stop in the fallback path where
        // forceMonoStream failed and monoStream === rawStream.
        const previousRawStream = rawStreamRef.current;
        const previousStream = streamRef.current;
        downmixDisposeRef.current?.();
        downmixDisposeRef.current = null;
        previousRawStream?.getTracks().forEach((track) => track.stop());
        if (previousStream && previousStream !== previousRawStream) {
          previousStream.getTracks().forEach((track) => track.stop());
        }

        // Force the recording stream to a single channel even when the
        // browser hands back a 2-channel track despite our `channelCount: 1`
        // constraint (issue #46). Logs a warning when we observe the mismatch
        // so we can spot affected devices in the field.
        const [rawTrack] = rawStream.getAudioTracks();
        const reportedChannels = rawTrack ? getTrackChannelCount(rawTrack) : undefined;
        if (reportedChannels !== undefined && reportedChannels > 1) {
          console.warn(
            `Recording: device returned ${reportedChannels}-channel track despite mono request; downmixing to mono.`,
          );
        }

        let monoStream: MediaStream;
        let dispose: (() => void) | null = null;
        try {
          const result = forceMonoStream(rawStream);
          monoStream = result.stream;
          dispose = result.dispose;
        } catch (err) {
          // Web Audio unavailable — fall back to the raw stream. The
          // recorder will still encode whatever the device returned, but at
          // least the rest of the UI keeps working.
          console.error("Recording: forceMonoStream failed; using raw stream.", err);
          monoStream = rawStream;
        }

        rawStreamRef.current = rawStream;
        streamRef.current = monoStream;
        downmixDisposeRef.current = dispose;
        setRecordingStream(monoStream);
      } catch (err) {
        console.error("Failed to get recording stream:", err);
      }
    }

    void getRecordingStream();

    return () => {
      cancelled = true;
      // Mirror the on-switch teardown: stop both raw and mono tracks. The
      // guard avoids a double-stop in the fallback path where
      // forceMonoStream failed and streamRef === rawStreamRef.
      const previousRawStream = rawStreamRef.current;
      const previousStream = streamRef.current;
      downmixDisposeRef.current?.();
      downmixDisposeRef.current = null;
      previousRawStream?.getTracks().forEach((track) => track.stop());
      if (previousStream && previousStream !== previousRawStream) {
        previousStream.getTracks().forEach((track) => track.stop());
      }
      rawStreamRef.current = null;
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
      let peak = 0;
      for (const value of dataArray) {
        const centeredSample = (value - 128) / 128;
        sumSquares += centeredSample * centeredSample;
        const abs = Math.abs(centeredSample);
        if (abs > peak) peak = abs;
      }

      const rms = Math.sqrt(sumSquares / dataArray.length);
      const normalized = Math.min(1, Math.max(0, (rms - 0.01) / 0.12));
      const targetLevel = Math.round(Math.pow(normalized, SHAPING_EXPONENT) * 255);
      const smoothedLevel = Math.round(
        smoothLevel(localLevelRef.current, targetLevel)
      );
      localLevelRef.current = smoothedLevel;

      // Clipping flag: peak >= -1 dBFS for CLIP_MIN_FRAMES consecutive frames,
      // then hold the visible flag briefly so a single transient peak still
      // registers. The hold count here is in RAF frames (~60Hz), giving ~500ms.
      if (peak >= CLIP_THRESHOLD) {
        localClipFramesRef.current += 1;
        if (localClipFramesRef.current >= CLIP_MIN_FRAMES) {
          localClipHoldRef.current = 30;
        }
      } else {
        localClipFramesRef.current = 0;
      }
      // Compute visibility from the CURRENT hold first, then decrement, so a
      // hold of N yields N visible frames (not N-1).
      const isClipping = localClipHoldRef.current > 0;
      if (isClipping) localClipHoldRef.current -= 1;
      // Avoid setState every frame when nothing changed.
      setLocalClipping((prev) => (prev === isClipping ? prev : isClipping));

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

  // Track remote audio levels via getStats() polling on each remote audio
  // track's RTCRtpReceiver. Replaces the prior `useSpeakingParticipants`
  // approach, which only emitted while the LiveKit voice-activity heuristic
  // flagged a participant as "speaking" — fine for grid highlights but useless
  // for level monitoring (silent talkers + no clipping signal). See #47.
  const remoteAudio = useRemoteAudioLevels(remoteParticipants);
  // Merge remote levels into the same audioLevels map the local meter feeds.
  useEffect(() => {
    setAudioLevels((prev) => {
      const next = new Map(prev);
      // Wipe any identities that vanished so stale bars don't linger.
      for (const id of next.keys()) {
        if (id !== participantName && !remoteAudio.levels.has(id)) {
          next.delete(id);
        }
      }
      for (const [id, lvl] of remoteAudio.levels) {
        next.set(id, lvl);
      }
      return next;
    });
  }, [remoteAudio.levels, participantName]);

  useEffect(() => {
    const liveIdentities = new Set(remoteParticipants.map((p) => p.identity));

    setRemoteRecordingStatuses((prev) => {
      let next = prev;
      for (const identity of prev.keys()) {
        if (!liveIdentities.has(identity)) {
          if (next === prev) next = new Map(prev);
          next.delete(identity);
        }
      }
      remoteRecordingStatusesRef.current = next;
      return next;
    });

    setExpectedRecordingParticipants((prev) => {
      const next = new Set(
        Array.from(prev).filter((identity) => liveIdentities.has(identity)),
      );
      expectedRecordingParticipantsRef.current = next;
      return next;
    });

    setUnconfirmedRecordingParticipants(
      (prev) =>
        new Set(
          Array.from(prev).filter((identity) => liveIdentities.has(identity)),
        ),
    );
  }, [remoteParticipants]);

  // Tick the elapsed-time display while recording. The interval is bound to
  // `recording`, NOT `finalizing` — once we enter `finalizing` the timer tears
  // down and the displayed value freezes at the stop-moment value. If we
  // tear it down only when the upload pipeline settles, a wedged upload
  // (issue #48) would let the timer keep ticking indefinitely.
  useEffect(() => {
    if (studioState === "recording") {
      setElapsedMs(0);
      const started = Date.now();
      elapsedTimerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - started);
      }, 250);
    } else {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      // Keep the displayed elapsed value frozen during `finalizing` so the
      // user sees the duration they actually recorded. Reset only on full
      // return to idle.
      if (studioState !== "finalizing") {
        setElapsedMs(0);
      }
    }
    return () => {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    };
  }, [studioState]);

  // Core recording start. Idempotent against double-invocation: if we're
  // already recording (our own click echoed via a later remote message, or the
  // button pressed twice), this is a no-op.
  const startRecordingLocal = useCallback(
    async (sessionStartedAtIso: string) => {
      // Hard invariant from issue #61: cannot start a new recording while a
      // previous one is finalizing. Enforced here so both local and remote
      // (control-message) start paths honor the invariant.
      if (studioStateRef.current === "finalizing") {
        console.warn("Ignoring recording_start: currently finalizing previous recording");
        void broadcastRecordingStatus(
          "failed",
          sessionStartedAtIso,
          "still finalizing previous recording",
        );
        return false;
      }
      if (studioStateRef.current === "recording" || recorderRef.current) {
        void broadcastRecordingStatus(
          "recording",
          recordingSessionStartedAtRef.current ?? sessionStartedAtIso,
        );
        return true;
      }

      if (!streamRef.current) {
        console.warn("Cannot start recording: microphone stream unavailable");
        clearRecordingConfirmationState();
        void broadcastRecordingStatus(
          "failed",
          sessionStartedAtIso,
          "microphone stream unavailable",
        );
        return false;
      }

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
        clearRecordingConfirmationState();
        void broadcastRecordingStatus(
          "failed",
          sessionStartedAtIso,
          "upload initialization failed",
        );
        return false;
      }

      trackerReset();

      const recorder = new CozyRecorder(streamRef.current);

      recorder.onChunk((chunk, index) => {
        const byteLength = chunk.size;
        trackerOnChunkRecorded(byteLength);

        const uploadPromise = (async () => {
          const url = await getPresignedUploadUrl(sessionId, trackId, index);
          await uploadChunk(url, chunk);
        })();

        void trackerTrackUpload(byteLength, uploadPromise);
      });

      recorderRef.current = recorder;
      recordingStartRef.current = Date.now();

      try {
        await recorder.start(5000);
      } catch (err) {
        console.error("Failed to start recorder:", err);
        recorderRef.current = null;
        clearRecordingConfirmationState();
        void broadcastRecordingStatus(
          "failed",
          sessionStartedAtIso,
          "recorder failed to start",
        );
        return false;
      }

      setRecordingSessionStartedAtSync(sessionStartedAtIso);
      scheduleRecordingConfirmationCheck(sessionStartedAtIso);
      setStudioStateSync("recording");
      void broadcastRecordingStatus("recording", sessionStartedAtIso);

      // Auto-switch to bandwidth-saving mode for the LiveKit preview
      const switched = await switchAudioQuality("bandwidth-saving");
      if (switched) {
        showNotification("Preview quality reduced — local recording is unaffected");
      } else {
        showNotification("Couldn't switch audio quality — check console");
      }
      return true;
    },
    [
      broadcastRecordingStatus,
      clearRecordingConfirmationState,
      participantName,
      scheduleRecordingConfirmationCheck,
      selectedMic,
      selectedMicIsBuiltIn,
      selectedMicLabel,
      sessionId,
      setRecordingSessionStartedAtSync,
      setStudioStateSync,
      showNotification,
      switchAudioQuality,
      trackerOnChunkRecorded,
      trackerReset,
      trackerTrackUpload,
    ],
  );

  // Core recording stop. Idempotent: no-op when we have no active recorder or
  // we're already finalizing.
  const stopRecordingLocal = useCallback(async () => {
    const sessionStartedAtForStatus =
      recordingSessionStartedAtRef.current ?? undefined;
    if (studioStateRef.current === "finalizing") return;
    clearRecordingConfirmationState(false);

    if (!recorderRef.current) {
      setRecordingSessionStartedAtSync(null);
      void broadcastRecordingStatus("connected", sessionStartedAtForStatus);
      return;
    }

    // Snapshot per-recording state into local consts BEFORE any await so a
    // hypothetical concurrent attempt to re-record (blocked by the
    // finalizing-state gate, but defended in depth here) cannot overwrite the
    // values mid-finalize. Also transition synchronously so the elapsed timer
    // tears down immediately — even if the upload pipeline below hangs.
    const recorder = recorderRef.current;
    const trackId = trackIdRef.current;
    const startedAt = recordingStartRef.current;
    setStudioStateSync("finalizing");
    void broadcastRecordingStatus("finalizing", sessionStartedAtForStatus);

    try {
      const blob = await recorder.stop();
      const durationMs = Date.now() - startedAt;

      // Freeze denominator — recording is done, no more chunks will arrive.
      trackerFreezeRecorded();

      // The final recording.webm upload is critical: if it fails, we must
      // NOT call completeUpload (which marks the track complete and lets
      // the server delete chunk files). Use rethrow so a failure surfaces
      // here, lastError is set in the tracker (visible in the UI), and
      // completeUpload is skipped.
      const finalBytes = blob.size;
      trackerOnChunkRecorded(finalBytes);
      const finalUpload = (async () => {
        const url = await getPresignedUploadUrl(sessionId, trackId, 9999);
        await uploadChunk(url, blob);
      })();
      await trackerTrackUpload(finalBytes, finalUpload, { rethrow: true });

      // Wait for any background chunk uploads still settling.
      await trackerWaitForUploads();
      await completeUpload(sessionId, trackId, durationMs);

      setHasRecorded(true);
    } catch (err) {
      // Final upload (or stop()) failed. lastError is already populated by
      // trackUpload's rethrow path; the recording stays incomplete.
      console.error("Failed to stop recording:", err);
    } finally {
      recorderRef.current = null;
      // Hard invariant from issue #61: do not leave `finalizing` until the
      // chunk-upload promise set is drained, regardless of error path. If the
      // happy path above already drained, this is effectively a no-op.
      try {
        await trackerWaitForUploads();
      } catch (drainErr) {
        console.error("Failed while draining chunk uploads:", drainErr);
      }
      setStudioStateSync("connected");
      setRecordingSessionStartedAtSync(null);
      void broadcastRecordingStatus("connected", sessionStartedAtForStatus);
      // Best-effort restoration of full-quality preview. Fire-and-forget —
      // a failure here must not keep us stuck in `finalizing`.
      void switchAudioQuality("full").catch((err) => {
        console.error("Failed to restore audio quality:", err);
      });
    }
  }, [
    broadcastRecordingStatus,
    clearRecordingConfirmationState,
    sessionId,
    setRecordingSessionStartedAtSync,
    setStudioStateSync,
    switchAudioQuality,
    trackerFreezeRecorded,
    trackerOnChunkRecorded,
    trackerTrackUpload,
    trackerWaitForUploads,
  ]);

  // Button handler: broadcast first so remote participants start close to our
  // own start time, then start locally. sessionStartedAt uses our local clock
  // so all participants share a single reference timestamp on the Track row.
  const handleStartRecording = useCallback(async () => {
    // Hard invariant from issue #61: cannot start a new recording while a
    // previous one is finalizing. The button itself is disabled in that state,
    // but enforce here too for the broadcast/control-message path.
    if (
      studioStateRef.current === "recording" ||
      studioStateRef.current === "finalizing" ||
      recorderRef.current
    ) {
      return;
    }

    const sessionStartedAt = new Date().toISOString();
    try {
      await transport.sendControlMessage({ type: "recording_start", sessionStartedAt });
    } catch (err) {
      console.error("Failed to broadcast recording_start:", err);
      showNotification("Couldn't tell the room to start recording");
      return;
    }

    const started = await startRecordingLocal(sessionStartedAt);
    if (!started) {
      showNotification("Couldn't start your recorder — stopping the room");
      try {
        await transport.sendControlMessage({ type: "recording_stop" });
      } catch (err) {
        console.error("Failed to broadcast recording_stop after start failure:", err);
      }
    }
  }, [transport, startRecordingLocal, showNotification]);

  const handleStopRecording = useCallback(async () => {
    try {
      await transport.sendControlMessage({ type: "recording_stop" });
    } catch (err) {
      console.error("Failed to broadcast recording_stop:", err);
      showNotification("Couldn't tell the room to stop recording");
    }
    await stopRecordingLocal();
  }, [transport, stopRecordingLocal, showNotification]);

  // Subscribe to remote control messages. LiveKit does not echo the sender's
  // own messages back, but startRecordingLocal/stopRecordingLocal are
  // idempotent anyway as a belt-and-braces guard.
  useEffect(() => {
    const unsub = transport.onControlMessage((msg, fromParticipant) => {
      if (msg.type === "recording_start") {
        showNotification(
          `Recording started by ${fromParticipant || "another participant"}`,
        );
        void startRecordingLocal(msg.sessionStartedAt).then((started) => {
          if (!started) {
            showNotification("Couldn't start your recorder — check your mic");
          }
        });
      } else if (msg.type === "recording_stop") {
        showNotification(
          `Recording stopped by ${fromParticipant || "another participant"}`,
        );
        void stopRecordingLocal();
      } else if (msg.type === "recording_status") {
        if (!fromParticipant) return;
        updateRemoteRecordingStatus(fromParticipant, {
          state: msg.state,
          sessionStartedAt: msg.sessionStartedAt,
          reason: msg.reason,
          updatedAt: Date.now(),
        });

        if (msg.sessionStartedAt === recordingSessionStartedAtRef.current) {
          setUnconfirmedRecordingParticipants((prev) => {
            if (!prev.has(fromParticipant)) return prev;
            const next = new Set(prev);
            next.delete(fromParticipant);
            return next;
          });
        }

        if (msg.state === "failed") {
          showNotification(
            `${fromParticipant} could not start recording${
              msg.reason ? `: ${msg.reason}` : ""
            }`,
          );
        }
      }
    });
    return unsub;
  }, [
    transport,
    startRecordingLocal,
    stopRecordingLocal,
    showNotification,
    updateRemoteRecordingStatus,
  ]);


  // Warn before tab close when uploads are in flight or recording is active.
  // This is the Layer A fix for #49 — prevents accidental data loss.
  useEffect(() => {
    if (!uploadTracker.hasInflight && studioState !== "recording") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [uploadTracker.hasInflight, studioState]);

  useEffect(() => {
    return () => {
      downmixDisposeRef.current?.();
      downmixDisposeRef.current = null;
      const rawStream = rawStreamRef.current;
      const monoStream = streamRef.current;
      if (rawStream) {
        rawStream.getTracks().forEach((t) => t.stop());
      }
      // Guard against double-stopping when the fallback path made
      // monoStream === rawStream.
      if (monoStream && monoStream !== rawStream) {
        monoStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // Dismissable warning banner — surfaces when the local mic is built-in.
  // Remote-participant warnings will reuse this banner once #28 propagates
  // isBuiltInMic via LiveKit metadata.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const showLocalMicWarning = selectedMicIsBuiltIn && !bannerDismissed;

  const isRecording = studioState === "recording";
  const isFinalizing = studioState === "finalizing";

  const localStatus: Status = isFinalizing
    ? "uploading"
    : isRecording
    ? "recording"
    : "connected";

  const getRemoteStatus = useCallback(
    (identity: string): Status => {
      const remoteStatus = remoteRecordingStatuses.get(identity);
      const matchesCurrentSession =
        recordingSessionStartedAt !== null &&
        remoteStatus?.sessionStartedAt === recordingSessionStartedAt;

      if (
        remoteStatus?.state === "failed" &&
        (recordingSessionStartedAt === null || matchesCurrentSession)
      ) {
        return "failed";
      }
      if (
        remoteStatus?.state === "finalizing" &&
        (recordingSessionStartedAt === null || matchesCurrentSession)
      ) {
        return "uploading";
      }
      if (
        remoteStatus?.state === "recording" &&
        (recordingSessionStartedAt === null || matchesCurrentSession)
      ) {
        return "recording";
      }
      if (
        remoteStatus?.state === "connected" &&
        (recordingSessionStartedAt === null || matchesCurrentSession)
      ) {
        return "connected";
      }
      if (unconfirmedRecordingParticipants.has(identity)) {
        return "unconfirmed";
      }
      if (
        recordingSessionStartedAt !== null &&
        isRecording &&
        expectedRecordingParticipants.has(identity)
      ) {
        return "starting";
      }
      return "connected";
    },
    [
      expectedRecordingParticipants,
      isRecording,
      recordingSessionStartedAt,
      remoteRecordingStatuses,
      unconfirmedRecordingParticipants,
    ],
  );

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
            clipping={localClipping}
          />

          {remoteParticipants.map((p) => (
            <ParticipantStrip
              key={p.identity}
              name={p.identity}
              role="guest"
              micLabel={undefined /* Remote mic label — needs #28 (LiveKit metadata propagation). */}
              isBuiltIn={false /* Remote built-in detection — needs #28. */}
              level={audioLevels.get(p.identity) ?? 0}
              status={getRemoteStatus(p.identity)}
              clipping={remoteAudio.clipping.has(p.identity)}
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
                waitForUploads={uploadTracker.waitForUploads}
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
                disabled={isFinalizing}
                className={`w-[60px] h-[60px] rounded-full flex items-center justify-center border-2 ${
                  isRecording ? "rec-ring" : ""
                } ${isFinalizing ? "cursor-not-allowed" : "cursor-pointer"}`}
                style={{
                  background: isRecording ? "rgba(232,80,80,0.1)" : "var(--card)",
                  borderColor: isRecording ? "var(--rec)" : "var(--border-hi)",
                  opacity: isFinalizing ? 0.5 : 1,
                  transition: "all 200ms ease",
                }}
                aria-label={
                  isFinalizing
                    ? "Finalizing previous recording"
                    : isRecording
                    ? "Stop recording"
                    : "Start recording"
                }
                title={
                  isFinalizing ? "Finalizing previous recording…" : undefined
                }
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
              className="font-mono text-[10px] font-medium tracking-[0.08em] text-center"
              style={{
                color: isRecording
                  ? "var(--rec)"
                  : isFinalizing
                  ? "var(--text-2)"
                  : "var(--text-3)",
              }}
            >
              {isFinalizing
                ? "FINALIZING…"
                : isRecording
                ? "STOP"
                : "REC"}
            </span>
            <div
              className="font-mono text-[13px] tracking-[0.06em]"
              style={{
                color:
                  isRecording || isFinalizing ? "var(--text-2)" : "var(--text-3)",
              }}
            >
              {formatElapsed(elapsedMs)}
            </div>
            {isFinalizing && (
              <span className="font-sans text-[10px] text-text-3 text-center px-2 max-w-[100px] leading-tight">
                Finalizing previous recording…
              </span>
            )}
          </div>

          <div className="w-10 h-px my-3" style={{ background: "var(--border)" }} />

          <UploadProgressBar
            progress={uploadTracker.progress}
            recordingStopped={studioState !== "recording"}
          />
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
  const [isMobile, setIsMobile] = useState(false);
  const [mobileWarningDismissed, setMobileWarningDismissed] = useState(false);
  // Role drives host-only affordances (e.g. the cohost invite tile). Guests
  // arriving via /join have their display name recorded in the cookie; we
  // use it to prefill the prejoin form.
  const [isHost, setIsHost] = useState(false);

  useEffect(() => {
    setMonitorEnabled(getStoredMonitorEnabled());
    setMonitorVolume(getStoredMonitorVolume());
  }, []);

  useEffect(() => {
    setIsMobile(isMobileBrowser(navigator));
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
      isSelectedMicBuiltIn(mics, selectedMic) &&
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
      <StudioFrame
        showMobileWarning={isMobile && !mobileWarningDismissed}
        onDismissMobileWarning={() => setMobileWarningDismissed(true)}
      >
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
      </StudioFrame>
    );
  }

  // ---------- Connected / Recording ----------

  return (
    <StudioFrame
      session={`Session ${sessionId.slice(0, 8)}…`}
      showMobileWarning={isMobile && !mobileWarningDismissed}
      onDismissMobileWarning={() => setMobileWarningDismissed(true)}
    >
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
          selectedMicIsBuiltIn={selectedMicDevice ? isSelectedMicBuiltIn(mics, selectedMic) : false}
          studioState={studioState}
          setStudioState={setStudioState}
          monitorEnabled={monitorEnabled}
          monitorVolume={monitorVolume}
          onMonitorEnabledChange={setMonitorEnabled}
          onMonitorVolumeChange={setMonitorVolume}
          isHost={isHost}
        />
      </LiveKitRoom>
    </StudioFrame>
  );
}
