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
  useConnectionState,
} from "@livekit/components-react";
import { CozyRecorder } from "@/lib/recorder";
import { forceMonoStream, getTrackChannelCount } from "@/lib/audio-downmix";
import { splitStereoStream } from "@/lib/audio-splitter";
import {
  getPresignedUploadTarget,
  getPresignedUploadUrl,
  uploadChunk,
  completeUpload,
} from "@/lib/upload";
import {
  getRecordingTakeState,
  RecordingStateError,
  reportRecordingTakeParticipantStatus,
  startRecordingTake,
  stopRecordingTake,
} from "@/lib/recording-state";
import {
  browserRecordingBackupStore,
  type RecordingBackupManifest,
} from "@/lib/recording-backup";
import {
  RecordingLifecycleController,
  type RecordingSlotSpec,
} from "@/lib/recording-lifecycle";
import { retryLocalRecordingBackupUpload } from "@/lib/recording-backup-upload";
import { getToken, LIVEKIT_URL } from "@/lib/livekit";
import {
  useTransport,
  isHostSender,
  parseParticipantMetadata,
  type RecordingStatusState,
} from "@/lib/transport";
import { isSelectedMicBuiltIn } from "@/lib/devices";
import { BuiltInMicWarningModal } from "@/components/BuiltInMicWarningModal";
import {
  MicMonitorToggle,
  getStoredMonitorEnabled,
  getStoredMonitorVolume,
  setStoredMonitorEnabled,
  setStoredMonitorVolume,
} from "@/components/MicMonitorToggle";
import { useMicMonitor } from "@/hooks/useMicMonitor";
import { useRemoteAudioLevels } from "@/hooks/useRemoteAudioLevels";
import { useTimingDiagnostics } from "@/hooks/useTimingDiagnostics";
import {
  advanceClipHold,
  shapeLevel,
  smoothLevel,
} from "@/lib/audio-meter";
import { FinishRecordingButton } from "@/components/FinishRecordingButton";
import { useUploadProgress } from "@/hooks/useUploadProgress";
import { useNavigationGuard } from "@/hooks/useNavigationGuard";
import { UploadProgressBar } from "@/components/UploadProgressBar";

import { Aurora } from "@/components/ui/Aurora";
import { Button } from "@/components/ui/Button";
import { Topbar } from "@/components/ui/Topbar";
import { Wordmark } from "@/components/ui/Wordmark";
import { type Status } from "@/components/ui/StatusDot";
import { LavaLamp } from "@/components/LavaLamp";
import { speakerHue } from "@/lib/speaker-hues";
import { getUploadPhase } from "@/lib/upload-progress";
import {
  IcoAlert,
  IcoDownload,
  IcoMic,
  IcoTrash,
  IcoUpload,
  IcoX,
} from "@/components/ui/Icon";

// ---------- Types ----------

type StudioState = "prejoin" | "connected" | "recording" | "finalizing";
type AudioQualityMode = "full" | "bandwidth-saving";
type RemoteRecordingStatus = {
  state: RecordingStatusState;
  takeId?: string;
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

// Host-owned local channel slots (issue #135). The slot ids are the contract
// values the upload presign endpoint accepts and derives stable synthetic
// participant ids from — they are duplicated here (rather than imported from
// @/lib/auth, which pulls server-only deps) because this is a client bundle.
const LOCAL_TRACK_SLOTS = [
  { slotId: "host-local-ch-1", label: "Local Ch 1" },
  { slotId: "host-local-ch-2", label: "Local Ch 2" },
] as const;
type LocalTrackSlotId = (typeof LOCAL_TRACK_SLOTS)[number]["slotId"];

type TwoChannelStatus = "idle" | "ok" | "unsupported" | "missing-channels";

// One split desktop channel wired up for capture and metering.
type SlotCapture = {
  slotId: LocalTrackSlotId;
  label: string;
  stream: MediaStream;
};

// ---------- Helpers ----------

function formatElapsed(totalMs: number): string {
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = (totalSec % 60).toString().padStart(2, "0");
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s}`
    : `${m.toString().padStart(2, "0")}:${s}`;
}

function formatParticipantList(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function displayNameFromMetadata(metadata: string | undefined): string | undefined {
  return parseParticipantMetadata(metadata)?.displayName;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function backupByteCount(manifest: RecordingBackupManifest): number {
  return manifest.chunks.reduce((sum, chunk) => sum + chunk.byteSize, 0);
}

function isRecoverableBackup(
  manifest: RecordingBackupManifest | null,
): manifest is RecordingBackupManifest {
  return Boolean(
    manifest && manifest.state !== "uploaded" && manifest.chunks.length > 0,
  );
}

function backupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Local recording backup failed";
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
      className="flex items-start gap-3 px-4 py-3 rounded-[10px] border backdrop-blur-[6px]"
      style={{
        background: "rgba(34,26,69,0.92)",
        borderColor: "rgba(255,179,71,0.28)",
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

// ---------- Speaker chrome (Sunset 2a/2b) ----------

/** Quantize a 0..255 level to 4% meter steps so width writes are change-gated. */
function meterPct(level: number): number {
  return Math.round((Math.max(0, Math.min(255, level)) / 255) * 25) * 4;
}

/** Talking threshold shared by dots and the wax tint: eased level > 0.22. */
function isTalking(level: number): boolean {
  return level / 255 > 0.22;
}

/** 8px identity dot — idle slate, speaker hue while talking, red while clipping. */
function TalkingDot({
  hue,
  level,
  clipping = false,
}: {
  hue: string;
  level: number;
  clipping?: boolean;
}) {
  const on = clipping || isTalking(level);
  const color = clipping ? "var(--rec)" : hue;
  return (
    <span
      aria-hidden
      className="w-2 h-2 rounded-full flex-shrink-0"
      style={{
        background: on ? color : "#6f65a0",
        boxShadow: on
          ? `0 0 8px 2px ${clipping ? "rgba(255,59,77,0.40)" : `${hue}66`}`
          : "none",
        transition: "background 240ms ease, box-shadow 240ms ease",
      }}
    />
  );
}

/** Per-track status → mono chip tag. Maps the existing Status vocabulary. */
function statusTag(status: Status): { label: string; color: string } | null {
  switch (status) {
    case "recording":
      return { label: "REC", color: "var(--rec)" };
    case "starting":
    case "unconfirmed":
      return { label: "STARTING…", color: "var(--warn)" };
    case "uploading":
      return { label: "UPLOADING…", color: "var(--warn)" };
    case "failed":
      return { label: "FAILED", color: "var(--rec)" };
    default:
      return null;
  }
}

interface SpeakerChipProps {
  name: string;
  hue: string;
  level: number; // 0..255
  status: Status;
  clipping?: boolean;
}

/** Floating speaker chip (host 2a): talking dot · name · gradient meter · status. */
function SpeakerChip({ name, hue, level, status, clipping = false }: SpeakerChipProps) {
  const tag = statusTag(status);
  return (
    <span
      className="flex items-center gap-[9px] rounded-full border backdrop-blur-[6px]"
      style={{
        background: "rgba(25,19,56,0.78)",
        borderColor: "rgba(210,190,255,0.12)",
        padding: "8px 14px 8px 10px",
      }}
    >
      <TalkingDot hue={hue} level={level} clipping={clipping} />
      <span className="text-[12.5px] font-semibold text-text whitespace-nowrap">
        {name}
      </span>
      <span
        className="block w-14 h-[5px] rounded-[3px] overflow-hidden flex-shrink-0"
        style={{ background: "#221a45" }}
      >
        <span
          className="block h-full"
          style={{
            width: `${meterPct(level)}%`,
            background: "linear-gradient(90deg,#7b4dff,#ff4d7d 55%,#ffb347)",
            transition: "width 200ms ease-out",
          }}
        />
      </span>
      {tag && (
        <span
          className="font-mono text-[9.5px] tracking-[0.06em] whitespace-nowrap"
          style={{ color: tag.color }}
        >
          {tag.label}
        </span>
      )}
    </span>
  );
}

// ---------- Invite Participant Tile ----------

// Host-only chip. Clicking mints a fresh invite URL via the session's invite
// endpoint, copies it to the clipboard, and shows a modal so the host can
// re-copy or see the expiry. Each click mints a new token — we don't persist
// the last one; it's cheap and keeps the UI stateless across reloads.
function InviteChip({ sessionId }: { sessionId: string }) {
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
        className="flex items-center gap-[7px] rounded-full border border-dashed px-3.5 py-2 text-[12px] text-text-2 backdrop-blur-[6px] hover:text-text focus:outline-none focus:ring-1 focus:ring-[var(--border-hi)] transition-colors disabled:opacity-60 disabled:cursor-wait whitespace-nowrap"
        style={{
          borderColor: "rgba(210,190,255,0.22)",
          background: "rgba(25,19,56,0.35)",
        }}
        title="Generate a shareable invite link for a participant"
      >
        {pending ? "Generating invite…" : "+ Invite"}
      </button>
      {error && (
        <span className="text-[11px] text-rec" role="alert">
          {error}
        </span>
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
        className="max-w-md w-full rounded-[10px] border p-6 shadow-2xl space-y-5"
        style={{ background: "var(--card)", borderColor: "var(--border-hi)" }}
      >
        <div>
          <h2
            id="invite-link-title"
            className="text-lg font-semibold text-text"
          >
            Invite a participant
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
              className="text-[12px] px-3 py-1.5 rounded-[8px] border hover:bg-card/50"
              style={{ borderColor: "var(--border-hi)", color: "var(--text-2)" }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={copy}
              className="text-[12px] px-3 py-1.5 rounded-[8px] font-semibold"
              style={{ background: "var(--accent)", color: "#2b0b18" }}
            >
              {copyState === "copied" ? "Copy again" : "Copy link"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LocalRecordingBackupPanel({
  manifest,
  error,
  action,
  onRetry,
  onDownload,
  onClear,
}: {
  manifest: RecordingBackupManifest | null;
  error: string | null;
  action: "idle" | "retrying" | "downloading" | "clearing";
  onRetry: () => void;
  onDownload: () => void;
  onClear: () => void;
}) {
  const hasChunks = Boolean(manifest && manifest.chunks.length > 0);
  const isBusy = action !== "idle";
  const totalBytes = manifest ? backupByteCount(manifest) : 0;
  const statusText =
    action === "retrying"
      ? "Retrying upload from local backup..."
      : manifest?.state === "failed"
      ? "Remote upload failed. Local backup is available in this browser."
      : manifest?.state === "uploading"
      ? "Uploading local backup..."
      : manifest
      ? "Local recording backup found in this browser."
      : "Local recording backup is unavailable.";

  return (
    <div
      role="alert"
      className="rounded-[10px] border px-4 py-3.5 flex flex-col gap-3 backdrop-blur-[6px]"
      style={{
        background: "rgba(34,26,69,0.92)",
        borderColor: "rgba(255,179,71,0.28)",
      }}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex-shrink-0">
          <IcoAlert size={15} color="var(--warn)" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-warn">
            Local recording backup
          </h2>
          <p className="mt-1 text-[12px] leading-5 text-text-2">
            {statusText}
          </p>
          {manifest && (
            <p className="mt-1 font-mono text-[10px] text-text-3">
              {manifest.participantName} - {manifest.chunks.length} chunk
              {manifest.chunks.length === 1 ? "" : "s"} - {formatBytes(totalBytes)}
            </p>
          )}
          {manifest?.persistentStorage === false && (
            <p className="mt-1 text-[11px] leading-4 text-text-3">
              Browser persistence was not granted, so keep this tab open until
              the backup is handled.
            </p>
          )}
          {error && (
            <p className="mt-1 text-[11px] leading-4 text-rec">{error}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="primary"
          onClick={onRetry}
          disabled={!hasChunks || isBusy}
        >
          <IcoUpload size={13} />
          {action === "retrying" ? "Retrying" : "Retry upload"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="subtle"
          onClick={onDownload}
          disabled={!hasChunks || isBusy}
        >
          <IcoDownload size={13} />
          {action === "downloading" ? "Preparing" : "Download"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="danger"
          onClick={onClear}
          disabled={!hasChunks || isBusy}
        >
          <IcoTrash size={13} />
          {action === "clearing" ? "Clearing" : "Clear"}
        </Button>
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
  showMobileWarning,
  onDismissMobileWarning,
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
  showMobileWarning: boolean;
  onDismissMobileWarning: () => void;
}) {
  const remoteParticipants = useRemoteParticipants();
  const { localParticipant } = useLocalParticipant();
  const roomConnectionState = useConnectionState();
  const roomConnected = roomConnectionState === "connected";
  const transport = useTransport();
  const remoteParticipantNames = useMemo(() => {
    const next = new Map<string, string>();
    for (const participant of remoteParticipants) {
      next.set(
        participant.identity,
        participant.name ||
          displayNameFromMetadata(participant.metadata) ||
          participant.identity,
      );
    }
    return next;
  }, [remoteParticipants]);
  const remoteParticipantName = useCallback(
    (identity: string) => remoteParticipantNames.get(identity) ?? identity,
    [remoteParticipantNames],
  );
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

  // ---- Two-channel local mode (issue #135) ----
  // An additive, host-only capture path. When off, the single-track machinery
  // above is the sole recorder and behaves exactly as before. When on, one
  // desktop interface is split into two mono channels, each recorded as its
  // own logical track slot. The slot array *is* the "small array of local
  // recording slots" — single-track mode is the degenerate 1-recorder case
  // served by the untouched path above.
  const [twoChannelMode, setTwoChannelMode] = useState(false);
  const [twoChannelStatus, setTwoChannelStatus] =
    useState<TwoChannelStatus>("idle");
  const [slotCaptures, setSlotCaptures] = useState<SlotCapture[]>([]);
  const slotCapturesRef = useRef<SlotCapture[]>([]);
  const [slotLevels, setSlotLevels] = useState<Map<string, number>>(new Map());
  const splitterDisposeRef = useRef<(() => void) | null>(null);
  const splitRawStreamRef = useRef<MediaStream | null>(null);
  const setSlotCapturesSync = useCallback((next: SlotCapture[]) => {
    slotCapturesRef.current = next;
    setSlotCaptures(next);
  }, []);
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
  const [recoveryBackup, setRecoveryBackup] =
    useState<RecordingBackupManifest | null>(null);
  const recoveryBackupRef = useRef<RecordingBackupManifest | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupAction, setBackupAction] = useState<
    "idle" | "retrying" | "downloading" | "clearing"
  >("idle");
  const setRecoveryBackupSync = useCallback(
    (manifest: RecordingBackupManifest | null) => {
      recoveryBackupRef.current = manifest;
      setRecoveryBackup(manifest);
    },
    [],
  );

  // Elapsed recording timer
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [recordingSessionStartedAt, setRecordingSessionStartedAt] =
    useState<string | null>(null);
  const recordingSessionStartedAtRef = useRef<string | null>(null);
  const recordingTakeIdRef = useRef<string | null>(null);
  // Reconnect catch-up: the id of the active take we've already attempted to
  // resume on this client, so effect reruns cannot start the same take twice.
  const caughtUpTakeIdRef = useRef<string | null>(null);
  // Catch-up belongs to the initial room-join lifecycle, not every later UI
  // transition back to `connected` after a recording finishes. Keep the
  // window open only when an active take was observed before recorder inputs
  // became ready; that lets mic readiness retry without rearming catch-up.
  const catchUpPhaseRef = useRef<
    "checking" | "waiting-for-stream" | "complete"
  >("checking");
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

  useEffect(() => {
    let cancelled = false;
    async function loadLocalBackups() {
      try {
        const backups = await browserRecordingBackupStore.listBackups(sessionId);
        if (cancelled) return;
        const backup = backups.find((item) => isRecoverableBackup(item)) ?? null;
        if (backup) {
          setRecoveryBackupSync(backup);
          setBackupError(null);
        }
      } catch (error) {
        if (!cancelled) setBackupError(backupErrorMessage(error));
      }
    }
    void loadLocalBackups();
    return () => {
      cancelled = true;
    };
  }, [sessionId, setRecoveryBackupSync]);

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
          `Recording not confirmed by ${formatParticipantList(
            unconfirmed.map(remoteParticipantName),
          )}`,
        );
      }, RECORDING_CONFIRMATION_TIMEOUT_MS);
    },
    [
      clearRecordingConfirmationTimer,
      remoteParticipantName,
      remoteParticipants,
      showNotification,
    ],
  );

  const broadcastRecordingStatus = useCallback(
    async (
      state: RecordingStatusState,
      sessionStartedAt?: string,
      reason?: string,
      takeId?: string | null,
    ) => {
      const effectiveTakeId = takeId ?? recordingTakeIdRef.current;
      try {
        await transport.sendControlMessage({
          type: "recording_status",
          state,
          ...(effectiveTakeId ? { takeId: effectiveTakeId } : {}),
          ...(sessionStartedAt !== undefined ? { sessionStartedAt } : {}),
          ...(reason !== undefined ? { reason } : {}),
        });
      } catch (err) {
        console.error("Failed to broadcast recording_status:", err);
      }

      if (!effectiveTakeId) return;
      try {
        await reportRecordingTakeParticipantStatus(sessionId, {
          takeId: effectiveTakeId,
          participantName,
          recordingStatus: state,
          ...(reason !== undefined ? { reason } : {}),
        });
      } catch (err) {
        console.error("Failed to report recording participant status:", err);
      }
    },
    [participantName, sessionId, transport],
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
      const targetLevel = Math.round(shapeLevel(normalized) * 255);
      const smoothedLevel = Math.round(
        smoothLevel(localLevelRef.current, targetLevel)
      );
      localLevelRef.current = smoothedLevel;

      // Hold the visible clip flag briefly; 30 RAF frames is roughly 500ms.
      const clipStep = advanceClipHold(
        {
          consecutiveClipFrames: localClipFramesRef.current,
          holdFrames: localClipHoldRef.current,
        },
        peak,
        30,
      );
      localClipFramesRef.current = clipStep.state.consecutiveClipFrames;
      localClipHoldRef.current = clipStep.state.holdFrames;
      const isClipping = clipStep.isClipping;
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

  // Acquire and split the selected interface into two mono channels whenever
  // two-channel mode is enabled. Fails closed via splitStereoStream: if the
  // device can't prove 2-channel capture we surface a status instead of two
  // silent/duplicated slots. Host-only.
  useEffect(() => {
    if (!isHost || !twoChannelMode) return;

    let cancelled = false;
    async function acquireSplit() {
      // Hoisted so every failure/cancel path can stop the captured device — an
      // orphaned 2-channel input stream would otherwise hold the mic open until
      // page teardown.
      let rawStream: MediaStream | null = null;
      try {
        rawStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: selectedMic ? { exact: selectedMic } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2,
          },
        });
        if (cancelled) {
          rawStream.getTracks().forEach((track) => track.stop());
          return;
        }

        // splitStereoStream fails closed (never throws), so a non-"ok" result
        // is the single signal to release the input stream.
        const result = splitStereoStream(rawStream);
        if (result.state !== "ok") {
          rawStream.getTracks().forEach((track) => track.stop());
          setTwoChannelStatus(result.state);
          setSlotCapturesSync([]);
          return;
        }

        splitRawStreamRef.current = rawStream;
        splitterDisposeRef.current = result.dispose;
        setSlotCapturesSync(
          LOCAL_TRACK_SLOTS.map((slot, i) => ({
            slotId: slot.slotId,
            label: slot.label,
            stream: result.channels[i],
          })),
        );
        setTwoChannelStatus("ok");
      } catch (err) {
        console.error("Failed to acquire two-channel stream:", err);
        // Defense in depth: if anything after acquisition throws, the stream we
        // opened isn't owned by splitRawStreamRef yet, so stop it here.
        if (rawStream && splitRawStreamRef.current !== rawStream) {
          rawStream.getTracks().forEach((track) => track.stop());
        }
        if (!cancelled) {
          setTwoChannelStatus("unsupported");
          setSlotCapturesSync([]);
        }
      }
    }

    void acquireSplit();

    return () => {
      cancelled = true;
      splitterDisposeRef.current?.();
      splitterDisposeRef.current = null;
      splitRawStreamRef.current?.getTracks().forEach((track) => track.stop());
      splitRawStreamRef.current = null;
      setSlotCapturesSync([]);
      setTwoChannelStatus("idle");
    };
  }, [isHost, twoChannelMode, selectedMic, setSlotCapturesSync]);

  // Per-slot level meters. One analyser per split channel, feeding slotLevels
  // keyed by slot id (kept separate from the shared audioLevels map, whose
  // remote-merge effect would otherwise wipe these keys).
  useEffect(() => {
    if (slotCaptures.length === 0) {
      setSlotLevels(new Map());
      return;
    }

    const cleanups: Array<() => void> = [];
    for (const capture of slotCaptures) {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(capture.stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.fftSize);
      let raf = 0;
      let level = 0;

      const tick = () => {
        analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (const value of dataArray) {
          const centered = (value - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        const normalized = Math.min(1, Math.max(0, (rms - 0.01) / 0.12));
        const target = Math.round(shapeLevel(normalized) * 255);
        level = Math.round(smoothLevel(level, target));
        setSlotLevels((prev) => {
          const next = new Map(prev);
          next.set(capture.slotId, level);
          return next;
        });
        raf = requestAnimationFrame(tick);
      };
      tick();

      cleanups.push(() => {
        cancelAnimationFrame(raf);
        audioCtx.close();
      });
    }

    return () => cleanups.forEach((fn) => fn());
  }, [slotCaptures]);

  // Track remote audio levels via getStats() polling on each remote audio
  // track's RTCRtpReceiver. Replaces the prior `useSpeakingParticipants`
  // approach, which only emitted while the LiveKit voice-activity heuristic
  // flagged a participant as "speaking" — fine for grid highlights but useless
  // for level monitoring (silent talkers + no clipping signal). See #47.
  const remoteAudio = useRemoteAudioLevels(remoteParticipants);

  // Issue #7 investigation: ?timing=1 enables structured [TIMING] console logs
  // (getStats snapshots + chunk/start/stop events) for cross-track drift
  // analysis. No-op without the flag.
  const timingDebug = useMemo(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("timing") === "1",
    [],
  );
  useTimingDiagnostics({
    enabled: timingDebug,
    localParticipant,
    remoteParticipants,
  });
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

  // ---- Unified slot recording lifecycle (issue #135 refactor) ----
  // One controller drives every local recording, whatever the mode: the
  // single-track mic is the degenerate 1-slot case, two-channel local mode
  // passes 2 slots. The controller owns the per-slot pipeline (presign →
  // recorder → chunked upload → crash-safe local backup → finalize); the
  // studio keeps orchestration — takes, control messages, confirmation,
  // timer, preview quality, and UI state. It is a plain object rather than a
  // hook so the pipeline stays unit-testable despite the meters' rAF loops
  // keeping React perpetually busy (see tests/recording-lifecycle.test.ts).
  const recordingLifecycle = useMemo(
    () =>
      new RecordingLifecycleController({
        sessionId,
        uploadApi: {
          getPresignedUploadTarget,
          getPresignedUploadUrl,
          uploadChunk,
          completeUpload,
        },
        backupStore: browserRecordingBackupStore,
        tracker: {
          reset: trackerReset,
          onChunkRecorded: trackerOnChunkRecorded,
          trackUpload: trackerTrackUpload,
          freezeRecorded: trackerFreezeRecorded,
          waitForUploads: trackerWaitForUploads,
        },
        createRecorder: (stream) => new CozyRecorder(stream),
        callbacks: {
          onRecoveryBackup: setRecoveryBackupSync,
          onBackupError: setBackupError,
          onBackupUnavailable: () =>
            showNotification("Local backup unavailable - remote upload only"),
          onTiming: (event) => {
            if (!timingDebug) return;
            console.log(
              "[TIMING]",
              JSON.stringify({ ...event, perfNow: performance.now() }),
            );
          },
        },
      }),
    [
      sessionId,
      setRecoveryBackupSync,
      showNotification,
      timingDebug,
      trackerFreezeRecorded,
      trackerOnChunkRecorded,
      trackerReset,
      trackerTrackUpload,
      trackerWaitForUploads,
    ],
  );

  // Which channels the next take records. Two-channel mode maps each split
  // capture to its named host slot; otherwise the primary mic stream is the
  // single slot.
  const buildRecordingSlotSpecs = useCallback(():
    | { ok: true; specs: RecordingSlotSpec[] }
    | { ok: false; reason: string } => {
    if (isHost && twoChannelMode) {
      const captures = slotCapturesRef.current;
      if (captures.length !== LOCAL_TRACK_SLOTS.length) {
        return { ok: false, reason: "two-channel capture unavailable" };
      }
      return {
        ok: true,
        specs: captures.map((capture) => ({
          localTrackSlotId: capture.slotId,
          participantName: capture.label,
          stream: capture.stream,
          deviceInfo: {
            deviceLabel: selectedMicLabel
              ? `${capture.label} · ${selectedMicLabel}`
              : capture.label,
            deviceId: selectedMic,
            isBuiltInMic: selectedMicIsBuiltIn,
          },
        })),
      };
    }
    if (!streamRef.current) {
      return { ok: false, reason: "microphone stream unavailable" };
    }
    return {
      ok: true,
      specs: [
        {
          participantName,
          stream: streamRef.current,
          deviceInfo: {
            deviceLabel: selectedMicLabel,
            deviceId: selectedMic,
            isBuiltInMic: selectedMicIsBuiltIn,
          },
        },
      ],
    };
  }, [
    isHost,
    participantName,
    selectedMic,
    selectedMicIsBuiltIn,
    selectedMicLabel,
    twoChannelMode,
  ]);

  // Core recording start. Idempotent against double-invocation: if we're
  // already recording (our own click echoed via a later remote message, or the
  // button pressed twice), this is a no-op.
  const startRecordingLocal = useCallback(
    async (
      sessionStartedAtIso: string,
      takeId?: string | null,
    ): Promise<boolean> => {
      const effectiveTakeId = takeId ?? recordingTakeIdRef.current;
      if (effectiveTakeId) recordingTakeIdRef.current = effectiveTakeId;
      // Hard invariant from issue #61: cannot start a new recording while a
      // previous one is finalizing. Enforced here so both local and remote
      // (control-message) start paths honor the invariant.
      if (studioStateRef.current === "finalizing") {
        console.warn(
          "Ignoring recording_start: currently finalizing previous recording",
        );
        void broadcastRecordingStatus(
          "failed",
          sessionStartedAtIso,
          "still finalizing previous recording",
          effectiveTakeId,
        );
        return false;
      }
      if (studioStateRef.current === "recording" || recordingLifecycle.active) {
        void broadcastRecordingStatus(
          "recording",
          recordingSessionStartedAtRef.current ?? sessionStartedAtIso,
          undefined,
          effectiveTakeId,
        );
        return true;
      }

      const slotSpecs = buildRecordingSlotSpecs();
      if (!slotSpecs.ok) {
        console.warn(`Cannot start recording: ${slotSpecs.reason}`);
        clearRecordingConfirmationState();
        void broadcastRecordingStatus(
          "failed",
          sessionStartedAtIso,
          slotSpecs.reason,
          effectiveTakeId,
        );
        return false;
      }

      const result = await recordingLifecycle.start(slotSpecs.specs, {
        sessionStartedAt: sessionStartedAtIso,
        takeId: effectiveTakeId,
      });
      if (!result.ok) {
        if (result.stage === "already-active") {
          // Lost a race against a concurrent start path — treat it like the
          // idempotent early-return above.
          void broadcastRecordingStatus(
            "recording",
            recordingSessionStartedAtRef.current ?? sessionStartedAtIso,
            undefined,
            effectiveTakeId,
          );
          return true;
        }
        clearRecordingConfirmationState();
        void broadcastRecordingStatus(
          "failed",
          sessionStartedAtIso,
          result.stage === "presign"
            ? "upload initialization failed"
            : "recorder failed to start",
          effectiveTakeId,
        );
        return false;
      }

      if (result.stopPending || !recordingLifecycle.recording) {
        // A stop arrived while the recorders were still starting. It is
        // already waiting inside the controller and will finalize the started
        // slots; the stop path owns studio state from here, so flipping to
        // `recording` now would resurrect the UI/status after the room
        // stopped. The recorders did start, so this is not a start failure.
        return true;
      }

      setRecordingSessionStartedAtSync(sessionStartedAtIso);
      scheduleRecordingConfirmationCheck(sessionStartedAtIso);
      setStudioStateSync("recording");
      void broadcastRecordingStatus(
        "recording",
        sessionStartedAtIso,
        undefined,
        effectiveTakeId,
      );

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
      buildRecordingSlotSpecs,
      clearRecordingConfirmationState,
      recordingLifecycle,
      scheduleRecordingConfirmationCheck,
      setRecordingSessionStartedAtSync,
      setStudioStateSync,
      showNotification,
      switchAudioQuality,
    ],
  );

  // Core recording stop. Idempotent: no-op when we have no active recording or
  // we're already finalizing.
  const stopRecordingLocal = useCallback(async () => {
    const sessionStartedAtForStatus =
      recordingSessionStartedAtRef.current ?? undefined;
    const takeIdForStatus = recordingTakeIdRef.current;
    if (studioStateRef.current === "finalizing") return;
    clearRecordingConfirmationState(false);

    if (!recordingLifecycle.active) {
      setRecordingSessionStartedAtSync(null);
      recordingTakeIdRef.current = null;
      void broadcastRecordingStatus(
        "connected",
        sessionStartedAtForStatus,
        undefined,
        takeIdForStatus,
      );
      return;
    }

    // Transition synchronously so the elapsed timer tears down immediately —
    // even if the upload pipeline hangs. The controller snapshots its own
    // per-slot state, so a hypothetical concurrent re-record (blocked by the
    // finalizing-state gate, but defended in depth there) cannot corrupt the
    // finalize. If the take is still starting, controller.stop() waits for
    // startup to settle and then stops whatever started — the paired
    // stopPending signal keeps the start path from flipping back to
    // `recording`.
    setStudioStateSync("finalizing");
    void broadcastRecordingStatus(
      "finalizing",
      sessionStartedAtForStatus,
      undefined,
      takeIdForStatus,
    );

    try {
      const result = await recordingLifecycle.stop();
      if (result.anyCompleted) setHasRecorded(true);
    } finally {
      // The controller does not resolve until the chunk-upload promise set is
      // drained (issue #61's finalizing invariant), so leaving `finalizing`
      // here is safe on every path.
      setStudioStateSync("connected");
      setRecordingSessionStartedAtSync(null);
      recordingTakeIdRef.current = null;
      void broadcastRecordingStatus(
        "connected",
        sessionStartedAtForStatus,
        undefined,
        takeIdForStatus,
      );
      // Best-effort restoration of full-quality preview. Fire-and-forget —
      // a failure here must not keep us stuck in `finalizing`.
      void switchAudioQuality("full").catch((err) => {
        console.error("Failed to restore audio quality:", err);
      });
    }
  }, [
    broadcastRecordingStatus,
    clearRecordingConfirmationState,
    recordingLifecycle,
    setRecordingSessionStartedAtSync,
    setStudioStateSync,
    switchAudioQuality,
  ]);

  const handleRetryLocalBackupUpload = useCallback(async () => {
    if (backupAction !== "idle") return;
    if (studioStateRef.current !== "connected") return;
    const current = recoveryBackupRef.current;
    if (!isRecoverableBackup(current)) return;

    setBackupAction("retrying");
    setBackupError(null);
    try {
      const latest =
        (await browserRecordingBackupStore.getBackup(current.id)) ?? current;
      const recovered = await retryLocalRecordingBackupUpload(latest);
      setRecoveryBackupSync(recovered);
      await browserRecordingBackupStore.clearBackup(recovered.id, "verified-upload");
      setRecoveryBackupSync(null);
      setHasRecorded(true);
      showNotification("Local backup uploaded");
    } catch (error) {
      const message = backupErrorMessage(error);
      setBackupError(message);
      try {
        const latest = await browserRecordingBackupStore.getBackup(current.id);
        if (latest) setRecoveryBackupSync(latest);
      } catch (backupErr) {
        console.error("Failed to refresh local backup after retry:", backupErr);
      }
      showNotification("Retry failed - local backup kept");
    } finally {
      setBackupAction("idle");
    }
  }, [backupAction, setRecoveryBackupSync, showNotification]);

  const handleDownloadLocalBackup = useCallback(async () => {
    if (backupAction !== "idle") return;
    if (studioStateRef.current !== "connected") return;
    const current = recoveryBackupRef.current;
    if (!isRecoverableBackup(current)) return;

    setBackupAction("downloading");
    setBackupError(null);
    try {
      const recording = await browserRecordingBackupStore.buildRecordingBlob(
        current.id,
      );
      const url = URL.createObjectURL(recording);
      const link = document.createElement("a");
      link.href = url;
      link.download = `cozytrack-${current.sessionId.slice(0, 8)}-${current.trackId.slice(0, 8)}.webm`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setBackupError(backupErrorMessage(error));
    } finally {
      setBackupAction("idle");
    }
  }, [backupAction]);

  const handleClearLocalBackup = useCallback(async () => {
    if (backupAction !== "idle") return;
    if (studioStateRef.current !== "connected") return;
    const current = recoveryBackupRef.current;
    if (!isRecoverableBackup(current)) return;
    if (!window.confirm("Clear this local recording backup?")) return;

    setBackupAction("clearing");
    setBackupError(null);
    try {
      await browserRecordingBackupStore.clearBackup(current.id, "user-confirmed");
      setRecoveryBackupSync(null);
    } catch (error) {
      setBackupError(backupErrorMessage(error));
    } finally {
      setBackupAction("idle");
    }
  }, [backupAction, setRecoveryBackupSync]);

  // Synchronous "request in flight" guards. Set true at the top of the click
  // handler before any await so a rapid second click is dropped immediately
  // (issue #74). studioStateRef is only updated mid-way through
  // startRecordingLocal/stopRecordingLocal — between the click and that
  // update there's an `await transport.sendControlMessage(...)` window where
  // a second click would otherwise pass every existing guard. These refs
  // close that window. Cleared in the finally block so a failed send does
  // not permanently lock out the button.
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);

  // Button handler: broadcast first so remote participants start close to our
  // own start time, then start locally. sessionStartedAt uses our local clock
  // so all participants share a single reference timestamp on the Track row.
  const handleStartRecording = useCallback(async () => {
    // Host-only: guests should never reach this codepath because the button
    // is hidden for them, but defend in depth — a guest with devtools could
    // call this, and we still want correctness.
    if (!isHost) return;
    // Hard invariant from issue #61: cannot start a new recording while a
    // previous one is finalizing. The button itself is disabled in that state,
    // but enforce here too for the broadcast/control-message path.
    if (
      startingRef.current ||
      studioStateRef.current === "recording" ||
      studioStateRef.current === "finalizing" ||
      recordingLifecycle.active
    ) {
      return;
    }

    // In two-channel mode, refuse to start a take / broadcast to the room until
    // the split capture is proven ready — otherwise we'd blip remote
    // participants and create a throwaway take that the lifecycle controller
    // then has to roll back. The REC button is also disabled in this state;
    // this guards the programmatic/devtools path.
    if (
      twoChannelMode &&
      slotCapturesRef.current.length !== LOCAL_TRACK_SLOTS.length
    ) {
      showNotification("Two-channel capture isn't ready yet");
      return;
    }

    startingRef.current = true;
    try {
      const requestedSessionStartedAt = new Date().toISOString();
      let sessionStartedAt = requestedSessionStartedAt;
      let takeId: string | null = null;
      try {
        const takeState = await startRecordingTake(
          sessionId,
          requestedSessionStartedAt,
        );
        sessionStartedAt =
          takeState.sessionStartedAt ?? requestedSessionStartedAt;
        takeId = takeState.take?.id ?? null;
        recordingTakeIdRef.current = takeId;
      } catch (err) {
        console.error("Failed to activate recording take:", err);
        // A finalized session rejects new takes (issue #151). Surface the
        // server's explanation so the host knows to start a fresh session
        // rather than seeing a generic failure.
        const finalized =
          err instanceof RecordingStateError && err.status === 409;
        showNotification(
          finalized && err.message
            ? err.message
            : "Couldn't update recording state",
        );
        return;
      }

      try {
        await transport.sendControlMessage({
          type: "recording_start",
          sessionStartedAt,
          ...(takeId ? { takeId } : {}),
        });
      } catch (err) {
        console.error("Failed to broadcast recording_start:", err);
        showNotification("Couldn't tell the room to start recording");
        try {
          await stopRecordingTake(sessionId);
        } catch (stopErr) {
          console.error("Failed to close recording take after broadcast failure:", stopErr);
        }
        recordingTakeIdRef.current = null;
        return;
      }

      const started = await startRecordingLocal(sessionStartedAt, takeId);
      if (!started) {
        showNotification("Couldn't start your recorder — stopping the room");
        try {
          await transport.sendControlMessage({ type: "recording_stop" });
        } catch (err) {
          console.error("Failed to broadcast recording_stop after start failure:", err);
        }
        try {
          await stopRecordingTake(sessionId);
        } catch (stopErr) {
          console.error("Failed to close recording take after local start failure:", stopErr);
        }
        recordingTakeIdRef.current = null;
      }
    } finally {
      startingRef.current = false;
    }
  }, [
    isHost,
    sessionId,
    transport,
    recordingLifecycle,
    startRecordingLocal,
    twoChannelMode,
    showNotification,
  ]);

  const handleStopRecording = useCallback(async () => {
    if (!isHost) return;
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      try {
        // stopRecordingTake retries transient failures internally, so reaching
        // this catch means the stop genuinely could not be persisted after
        // several attempts (not just a single blip).
        await stopRecordingTake(sessionId);
      } catch (err) {
        console.error("Failed to close recording take:", err);
        showNotification("Couldn't update recording state");
        return;
      }
      try {
        await transport.sendControlMessage({ type: "recording_stop" });
      } catch (err) {
        console.error("Failed to broadcast recording_stop:", err);
        showNotification("Couldn't tell the room to stop recording");
      }
      await stopRecordingLocal();
    } finally {
      stoppingRef.current = false;
    }
  }, [
    isHost,
    sessionId,
    transport,
    stopRecordingLocal,
    showNotification,
  ]);

  // Subscribe to remote control messages. LiveKit does not echo the sender's
  // own messages back, but startRecordingLocal/stopRecordingLocal are
  // idempotent anyway as a belt-and-braces guard.
  //
  // Host-only enforcement: recording_start/stop are session-wide controls.
  // We only honor them when the sender's LiveKit token metadata identifies
  // them as a host (see participant-role.ts). A guest cannot mint a token
  // claiming role: "host" without LIVEKIT_API_SECRET, so this is sufficient
  // for the trust model documented in issue #74.
  useEffect(() => {
    const unsub = transport.onControlMessage((msg, sender) => {
      const senderName =
        displayNameFromMetadata(sender.metadata) ||
        remoteParticipantName(sender.identity) ||
        "another participant";
      if (msg.type === "recording_start" || msg.type === "recording_stop") {
        if (!isHostSender(sender.metadata)) {
          console.warn(
            `Ignoring ${msg.type} from non-host sender ${sender.identity || "<unknown>"}`,
          );
          return;
        }
      }
      if (msg.type === "recording_start") {
        showNotification(
          `Recording started by ${senderName}`,
        );
        void startRecordingLocal(msg.sessionStartedAt, msg.takeId).then((started) => {
          if (!started) {
            showNotification("Couldn't start your recorder — check your mic");
          }
        });
      } else if (msg.type === "recording_stop") {
        // A stop can arrive while the initial authoritative-state GET is still
        // pending. Invalidate that join snapshot before stopping locally so a
        // stale `active: true` response cannot restart the take afterward.
        catchUpPhaseRef.current = "complete";
        showNotification(
          `Recording stopped by ${senderName}`,
        );
        void stopRecordingLocal();
      } else if (msg.type === "recording_status") {
        const fromParticipant = sender.identity;
        if (!fromParticipant) return;
        updateRemoteRecordingStatus(fromParticipant, {
          state: msg.state,
          takeId: msg.takeId,
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
            `${remoteParticipantName(fromParticipant)} could not start recording${
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
    remoteParticipantName,
    updateRemoteRecordingStatus,
  ]);

  // Reconnect catch-up (stack 5). A participant who (re)joins after the host
  // pressed record missed the live `recording_start` control message, so during
  // the initial connected join window we ask the server for the authoritative
  // active take.
  // Because RecordingTake.status is the source of truth (a host stop durably
  // flips it to "stopped" before the room tears down — see #148/#150), a take
  // that still reads `recording` here is genuinely ongoing: we resume it by
  // starting a fresh segment under the same logical track (presign re-links via
  // the take id). A stopped take reports active:false and nothing happens — no
  // host-stop marker needed. startRecordingLocal is idempotent, so this can't
  // race a live start/stop into a double recorder.
  useEffect(() => {
    if (studioState !== "connected") {
      catchUpPhaseRef.current = "complete";
      return;
    }
    // Token acquisition mounts RoomContent before LiveKit has joined the room,
    // and onDisconnected does not cover transient reconnecting states. Require
    // LiveKit's full connection state to be exactly connected so any stop sent
    // while we were absent is reflected by the snapshot we fetch below.
    if (!roomConnected) return;
    if (catchUpPhaseRef.current === "complete") return;
    let cancelled = false;

    void (async () => {
      let state;
      try {
        state = await getRecordingTakeState(sessionId);
      } catch (err) {
        // GET is side-effect-free; skip catch-up this time and let a later
        // connect retry rather than surfacing noise to the user.
        console.error("Failed to check for an active recording take:", err);
        return;
      }
      if (cancelled || catchUpPhaseRef.current === "complete") return;
      if (
        !state.active ||
        !state.take ||
        state.take.status !== "recording" ||
        !state.sessionStartedAt
      ) {
        catchUpPhaseRef.current = "complete";
        return;
      }
      // The room can connect before getUserMedia finishes. Do not spend the
      // take's catch-up attempt until recorder inputs exist. Keep this initial
      // join window open so recordingStream can trigger one fresh authoritative
      // snapshot, without letting later recording-state transitions rearm it.
      if (!recordingStream) {
        catchUpPhaseRef.current = "waiting-for-stream";
        return;
      }
      // Resume each active take at most once, and only while we're still idle —
      // a start/stop the user triggered in the meantime takes precedence.
      if (caughtUpTakeIdRef.current === state.take.id) {
        catchUpPhaseRef.current = "complete";
        return;
      }
      if (studioStateRef.current !== "connected") {
        catchUpPhaseRef.current = "complete";
        return;
      }
      catchUpPhaseRef.current = "complete";
      caughtUpTakeIdRef.current = state.take.id;

      const started = await startRecordingLocal(
        state.sessionStartedAt,
        state.take.id,
      );
      if (!started && !cancelled) {
        caughtUpTakeIdRef.current = null;
        showNotification("Couldn't resume the active recording — check your mic");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    roomConnected,
    studioState,
    recordingStream,
    sessionId,
    startRecordingLocal,
    showNotification,
  ]);


  // Block accidental navigation while recording, finalizing, or uploading.
  // Covers tab close (beforeunload), browser back/forward (popstate), in-app
  // <a>/Link clicks, and form submits (e.g. the topbar sign-out POST). See
  // #73 for the live-test repro and #49 for the original tab-close warning
  // this supersedes.
  useNavigationGuard({
    when:
      studioState === "recording" ||
      studioState === "finalizing" ||
      uploadTracker.hasInflight,
    message:
      "Recording is in progress and may be lost if you leave. Leave anyway?",
  });

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
      // Two-channel split teardown.
      splitterDisposeRef.current?.();
      splitterDisposeRef.current = null;
      splitRawStreamRef.current?.getTracks().forEach((t) => t.stop());
      splitRawStreamRef.current = null;
    };
  }, []);

  // Dismissable warning banner — surfaces when the local mic is built-in.
  // Remote-participant warnings will reuse this banner once #28 propagates
  // isBuiltInMic via LiveKit metadata.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const showLocalMicWarning = selectedMicIsBuiltIn && !bannerDismissed;

  // ---- Sunset chrome (host "ambient-2a" / guest "chromeless-2b") ----
  // Presentation-only state: recording lifecycle, uploads, and status logic
  // above are untouched by the redesign.
  const [micMuted, setMicMuted] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // The controls cluster rests at 0.45 opacity and wakes to 1 on pointer
  // movement anywhere in the room (plus plain CSS hover/focus on itself).
  const [controlsAwake, setControlsAwake] = useState(false);
  const controlsAwakeRef = useRef(false);
  const controlsAwakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeControls = useCallback(() => {
    if (!controlsAwakeRef.current) {
      controlsAwakeRef.current = true;
      setControlsAwake(true);
    }
    if (controlsAwakeTimerRef.current) clearTimeout(controlsAwakeTimerRef.current);
    controlsAwakeTimerRef.current = setTimeout(() => {
      controlsAwakeRef.current = false;
      setControlsAwake(false);
    }, 2600);
  }, []);
  useEffect(
    () => () => {
      if (controlsAwakeTimerRef.current) clearTimeout(controlsAwakeTimerRef.current);
    },
    [],
  );

  // Preview-level mute: disables the published LiveKit track so the room
  // stops hearing you. The local recorder consumes its own device stream and
  // keeps rolling — recording capture is deliberately unaffected.
  //
  // State flips only after setMicrophoneEnabled resolves: an optimistic flip
  // would let the UI claim "Muted" while a rejected call left the mic live.
  const mutePendingRef = useRef(false);
  const toggleMute = useCallback(async () => {
    if (mutePendingRef.current) return;
    mutePendingRef.current = true;
    const next = !micMuted;
    try {
      await localParticipant.setMicrophoneEnabled?.(!next);
      setMicMuted(next);
    } catch (err) {
      console.error("Failed to toggle microphone:", err);
      showNotification(
        next
          ? "Couldn't mute your microphone"
          : "Couldn't unmute your microphone",
      );
    } finally {
      mutePendingRef.current = false;
    }
  }, [micMuted, localParticipant, showNotification]);

  const toggleMonitor = useCallback(() => {
    const next = !monitorEnabled;
    setStoredMonitorEnabled(next);
    onMonitorEnabledChange(next);
  }, [monitorEnabled, onMonitorEnabledChange]);

  const isRecording = studioState === "recording";
  const isFinalizing = studioState === "finalizing";
  // In two-channel mode the host can't start until both split channels are
  // captured; block the REC button so a click can't create a bad take.
  const twoChannelNotReady =
    twoChannelMode && slotCaptures.length !== LOCAL_TRACK_SLOTS.length;
  const startDisabled = isFinalizing || (!isRecording && twoChannelNotReady);

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

  const showBackupPanel =
    studioState === "connected" &&
    (Boolean(backupError) || isRecoverableBackup(recoveryBackup));

  // Ordered speaker roster shared by the lamp, chips, and name dots: local
  // capture first (both channel slots when the split is live), then remotes
  // in join order. Identity hues cycle by roster index.
  const twoChannelChipsActive =
    isHost && twoChannelMode && slotCaptures.length === LOCAL_TRACK_SLOTS.length;
  const speakers = useMemo(() => {
    const locals = twoChannelChipsActive
      ? LOCAL_TRACK_SLOTS.map((slot) => ({
          key: slot.slotId,
          name: slot.label,
          kind: "slot" as const,
        }))
      : [{ key: participantName, name: participantName, kind: "local" as const }];
    const remotes = remoteParticipants.map((p) => ({
      key: p.identity,
      name: remoteParticipantName(p.identity),
      kind: "remote" as const,
      host: isHostSender(p.metadata),
    }));
    // Hue slots follow the design's roster order: the host owns pink,
    // guests take the following hues in join order. Guests therefore list
    // the remote host first, then themselves, then the other guests.
    if (isHost) return [...locals, ...remotes];
    const remoteHosts = remotes.filter((r) => r.host);
    const remoteGuests = remotes.filter((r) => !r.host);
    return [...remoteHosts, ...locals, ...remoteGuests];
  }, [
    isHost,
    twoChannelChipsActive,
    participantName,
    remoteParticipants,
    remoteParticipantName,
  ]);

  const speakerLevel = useCallback(
    (s: { key: string; kind: "slot" | "local" | "remote" }) =>
      s.kind === "slot" ? slotLevels.get(s.key) ?? 0 : audioLevels.get(s.key) ?? 0,
    [slotLevels, audioLevels],
  );

  const speakerClipping = useCallback(
    (s: { key: string; kind: "slot" | "local" | "remote" }) =>
      s.kind === "local"
        ? localClipping
        : s.kind === "remote"
        ? remoteAudio.clipping.has(s.key)
        : false,
    [localClipping, remoteAudio.clipping],
  );

  const lampLevels = useMemo(
    () => speakers.map((s) => speakerLevel(s) / 255),
    [speakers, speakerLevel],
  );

  const uploadPhase = getUploadPhase(
    uploadTracker.progress,
    studioState !== "recording",
  );

  const connectionTint =
    roomConnectionState === "connected"
      ? { dot: "var(--ok)", label: "Connected" }
      : roomConnectionState === "reconnecting"
      ? { dot: "var(--warn)", label: "Reconnecting…" }
      : roomConnectionState === "connecting"
      ? { dot: "var(--text-3)", label: "Connecting…" }
      : { dot: "var(--rec)", label: "Disconnected" };

  const chromeMode = isHost ? "ambient-2a" : "chromeless-2b";

  return (
    <div
      className="relative flex-1 min-h-0 overflow-hidden"
      data-chrome={chromeMode}
      onPointerMove={isHost ? wakeControls : undefined}
    >
      <Aurora variant="studio" stars frame />

      {/* Stage — the lamp is the room. */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ paddingBottom: isHost ? 100 : 40 }}
      >
        <div
          className="relative"
          style={{ height: isHost ? "80%" : "90%", aspectRatio: "400 / 640" }}
        >
          <LavaLamp levels={lampLevels} rec={isRecording} />
        </div>
      </div>

      {/* Notification toast */}
      {notification && (
        <div
          className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-3.5 py-2 rounded-lg text-[12px] text-text-2 shadow-lg animate-toast-fade-in border"
          style={{
            background: "var(--card-hi)",
            borderColor: "var(--border-hi)",
          }}
        >
          {notification}
        </div>
      )}

      {/* Transient overlays — warnings surface as floating toasts, never
          persistent panels owning the room. */}
      <div className="absolute top-14 left-1/2 -translate-x-1/2 z-40 flex flex-col items-stretch gap-2 w-[min(560px,92%)]">
        {showMobileWarning && (
          <MobileBrowserWarningBanner onDismiss={onDismissMobileWarning} />
        )}
        {showLocalMicWarning && (
          <div
            className="flex items-center gap-2.5 px-4 py-3 rounded-[10px] border backdrop-blur-[6px]"
            style={{
              background: "rgba(34,26,69,0.92)",
              borderColor: "rgba(255,179,71,0.28)",
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
        {isHost && twoChannelMode && !twoChannelChipsActive && (
          <div
            role="status"
            className="flex items-start gap-2.5 px-4 py-3.5 rounded-[10px] border backdrop-blur-[6px]"
            style={{
              background: "rgba(34,26,69,0.92)",
              borderColor: "rgba(255,179,71,0.28)",
            }}
          >
            <span className="mt-0.5 flex-shrink-0">
              <IcoAlert size={14} color="var(--warn)" />
            </span>
            <span className="text-[12px] leading-5 text-warn">
              {twoChannelStatus === "missing-channels"
                ? "Selected interface reports a single channel — pick a 2-channel input to split into Local Ch 1 and Ch 2."
                : twoChannelStatus === "unsupported"
                ? "This browser or device can't prove 2-channel capture, so two-channel recording is unavailable."
                : "Preparing two channels…"}
            </span>
          </div>
        )}
        {showBackupPanel && (
          <LocalRecordingBackupPanel
            manifest={recoveryBackup}
            error={backupError}
            action={backupAction}
            onRetry={handleRetryLocalBackupUpload}
            onDownload={handleDownloadLocalBackup}
            onClear={handleClearLocalBackup}
          />
        )}
      </div>

      {/* Upload progress — transient corner chip, only while it matters. */}
      {uploadPhase !== "idle" && (
        <div
          className="absolute bottom-5 left-5 z-30 w-[132px] rounded-[10px] border px-2 py-2 backdrop-blur-[6px]"
          style={{
            background: "rgba(34,26,69,0.85)",
            borderColor: "var(--border-hi)",
          }}
        >
          <UploadProgressBar
            progress={uploadTracker.progress}
            recordingStopped={studioState !== "recording"}
          />
        </div>
      )}

      {isHost ? (
        <>
          {/* Host 2a topbar — wordmark · session · connection · REC pill.
              Elapsed time lives here now (moved from the old right sidebar). */}
          <div className="absolute top-0 left-0 right-0 z-20 flex items-center px-[18px] py-3.5">
            <Wordmark size={15} />
            <span className="text-[12px] text-text-3 ml-2.5 truncate">
              · Session {sessionId.slice(0, 8)}…
            </span>
            <span className="ml-auto flex items-center gap-3.5">
              <span
                className="flex items-center gap-1.5 text-[12px]"
                style={{ color: "var(--text-3)" }}
              >
                <span
                  className="w-[7px] h-[7px] rounded-full"
                  style={{ background: connectionTint.dot }}
                />
                {connectionTint.label}
              </span>
              {(isRecording || isFinalizing) && (
                <span
                  className="flex items-center gap-2 rounded-full border backdrop-blur-[6px] font-semibold text-[12px] text-text"
                  style={{
                    background: "rgba(25,19,56,0.7)",
                    borderColor: isFinalizing
                      ? "rgba(255,179,71,0.35)"
                      : "rgba(255,59,77,0.35)",
                    padding: "6px 12px",
                  }}
                >
                  {isRecording ? (
                    <span
                      className="relative w-2 h-2 rounded-full ping-dot"
                      style={{ background: "var(--rec)" }}
                    />
                  ) : (
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ background: "var(--warn)" }}
                    />
                  )}
                  {isRecording ? "REC" : "FINALIZING…"}
                  <span className="font-mono font-medium">
                    {formatElapsed(elapsedMs)}
                  </span>
                </span>
              )}
            </span>
          </div>

          {/* Bottom column: finalize flow, speaker chips, controls cluster.
              One flex column anchored to the bottom edge so the pieces can
              never overlap, however many chips wrap or which finalize state
              is showing. */}
          <div className="absolute bottom-4 left-0 right-0 z-30 flex flex-col items-center gap-3 px-4">
            {/* Post-stop finalize flow sits above the chips. */}
            {studioState === "connected" && hasRecorded && (
              <FinishRecordingButton
                sessionId={sessionId}
                waitForUploads={uploadTracker.waitForUploads}
              />
            )}

            {/* Speaker chips — every track's proof-of-recording, always on. */}
            <div className="flex justify-center items-center gap-3 flex-wrap">
            {speakers.map((s, i) => (
              <SpeakerChip
                key={s.key}
                name={s.name}
                hue={speakerHue(i)}
                level={speakerLevel(s)}
                status={s.kind === "remote" ? getRemoteStatus(s.key) : localStatus}
                clipping={speakerClipping(s)}
              />
            ))}
            <InviteChip sessionId={sessionId} />
            {studioState === "connected" && (
              <span
                className="flex items-center gap-2 rounded-full border border-dashed px-3.5 py-2 backdrop-blur-[6px]"
                style={{
                  borderColor: "rgba(210,190,255,0.22)",
                  background: "rgba(25,19,56,0.35)",
                }}
              >
                {/* Standalone input (not wrapped in a <label>) — a wrapping
                    label re-forwards the click to its control, which recurses
                    under happy-dom. aria-label carries the accessible name. */}
                <input
                  id="two-channel-toggle"
                  type="checkbox"
                  aria-label="Two-channel local mode"
                  checked={twoChannelMode}
                  disabled={studioState !== "connected"}
                  onChange={(e) => setTwoChannelMode(e.target.checked)}
                  className="accent-[var(--accent)] cursor-pointer"
                />
                <label
                  htmlFor="two-channel-toggle"
                  className="text-[12px] text-text-2 cursor-pointer whitespace-nowrap"
                >
                  Two-channel local mode
                </label>
                {twoChannelMode && twoChannelStatus === "ok" && (
                  <span className="font-mono text-[10px] text-text-3 truncate max-w-[180px]">
                    {selectedMicLabel ?? "selected interface"} → 2 channels
                  </span>
                )}
              </span>
            )}
          </div>

            {/* Controls cluster — rests at 0.45 opacity, wakes on pointer. */}
            <div
              className={`relative flex items-center gap-2.5 rounded-full border backdrop-blur-[8px] transition-opacity duration-[220ms] hover:opacity-100 focus-within:opacity-100 ${
                controlsAwake || overflowOpen ? "opacity-100" : "opacity-[0.45]"
              }`}
              style={{
                background: "rgba(25,19,56,0.85)",
                borderColor: "rgba(210,190,255,0.12)",
                padding: "8px 10px",
              }}
            >
              <button
                type="button"
                onClick={toggleMute}
                aria-pressed={micMuted}
                aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
                title={
                  micMuted
                    ? "Unmute microphone (room preview only — local recording keeps rolling)"
                    : "Mute microphone (room preview only — local recording keeps rolling)"
                }
                className="relative w-9 h-9 rounded-full border flex items-center justify-center"
                style={{
                  background: micMuted ? "rgba(255,59,77,0.14)" : "var(--card)",
                  borderColor: micMuted
                    ? "rgba(255,59,77,0.4)"
                    : "var(--border-hi)",
                  color: micMuted ? "var(--rec)" : "var(--text)",
                }}
              >
                <IcoMic size={16} color="currentColor" />
                {micMuted && (
                  <span
                    aria-hidden
                    className="absolute w-5 h-[1.5px] rotate-45 rounded-full"
                    style={{ background: "var(--rec)" }}
                  />
                )}
              </button>
              <button
                type="button"
                onClick={toggleMonitor}
                aria-pressed={monitorEnabled}
                className="flex items-center gap-[7px] rounded-full border px-[13px] py-2 text-[12px] text-text-2 hover:text-text"
                style={{ background: "var(--card)", borderColor: "var(--border-hi)" }}
              >
                <span
                  className="w-[7px] h-[7px] rounded-full"
                  style={{
                    background: monitorEnabled ? "var(--ok)" : "var(--text-3)",
                  }}
                />
                Monitor
              </button>
              {isFinalizing ? (
                <span
                  className="flex items-center gap-2 px-4 py-[9px] rounded-full font-mono text-[11px] tracking-[0.06em]"
                  style={{
                    background: "rgba(255,179,71,0.10)",
                    border: "1px solid rgba(255,179,71,0.35)",
                    color: "var(--warn)",
                  }}
                >
                  FINALIZING…
                </span>
              ) : isRecording ? (
                <button
                  type="button"
                  onClick={() => handleStopRecording()}
                  aria-label="Stop recording"
                  className="flex items-center gap-2 px-4 py-[9px] rounded-full text-[12.5px] font-semibold"
                  style={{
                    background: "rgba(255,59,77,0.14)",
                    border: "1px solid rgba(255,59,77,0.4)",
                    color: "#ffb0b8",
                  }}
                >
                  <span
                    className="w-3 h-3 rounded-[3px]"
                    style={{ background: "var(--rec)" }}
                  />
                  Stop recording
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleStartRecording()}
                  disabled={startDisabled}
                  aria-label="Start recording"
                  title={
                    twoChannelNotReady
                      ? "Waiting for two-channel capture…"
                      : undefined
                  }
                  className="px-4 py-[9px] rounded-full text-[12.5px] font-semibold text-accent-ink disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: "linear-gradient(100deg,#ff4d7d,#ff7a54)",
                    boxShadow: "0 2px 18px rgba(255,77,125,0.35)",
                  }}
                >
                  Start recording
                </button>
              )}
              <button
                type="button"
                onClick={() => setOverflowOpen((v) => !v)}
                aria-label="More options"
                aria-expanded={overflowOpen}
                className="w-9 h-9 rounded-full border flex items-center justify-center text-[15px] tracking-[1px] text-text-2 hover:text-text"
                style={{ background: "var(--card)", borderColor: "var(--border-hi)" }}
              >
                ···
              </button>
              {overflowOpen && (
                <div
                  className="absolute bottom-[52px] right-0 rounded-[10px] border p-3.5 flex flex-col gap-3 w-64 shadow-2xl"
                  style={{
                    background: "rgba(34,26,69,0.95)",
                    borderColor: "var(--border-hi)",
                    backdropFilter: "blur(8px)",
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[12px] text-text-2">Preview quality</span>
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.05em]"
                      style={{
                        color:
                          audioQualityMode === "full" ? "var(--ok)" : "var(--warn)",
                      }}
                    >
                      {audioQualityMode === "full" ? "Full" : "Saving"}
                    </span>
                  </div>
                  {isRecording && (
                    <button
                      type="button"
                      onClick={() =>
                        switchAudioQuality(
                          audioQualityMode === "full" ? "bandwidth-saving" : "full",
                        )
                      }
                      className="text-left text-[11px] text-text-3 hover:text-text-2 underline underline-offset-2 font-sans"
                    >
                      {audioQualityMode === "full"
                        ? "Switch to bandwidth-saving"
                        : "Switch to full quality"}
                    </button>
                  )}
                  {monitorEnabled && (
                    <label className="flex items-center gap-2 text-[11px] text-text-3">
                      Monitor volume
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={monitorVolume}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setStoredMonitorVolume(v);
                          onMonitorVolumeChange(v);
                        }}
                        className="flex-1 accent-[var(--accent)]"
                        aria-label="Monitor volume"
                      />
                    </label>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Guest 2b — chromeless: faint brand, clock only while capturing. */}
          <div className="absolute top-[17px] left-[18px] z-20 flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <Wordmark size={13} className="tracking-[0.01em] opacity-80" />
              <span className="text-[11px] text-text-3">
                · Session {sessionId.slice(0, 8)}…
              </span>
            </span>
            <span className="font-sans text-[10px] text-text-3">
              Host controls recording
            </span>
          </div>
          {(isRecording || isFinalizing) && (
            <div
              role="status"
              aria-label={
                isRecording ? "Recording in progress" : "Recording finalizing"
              }
              className="absolute top-4 right-[18px] z-20 flex items-center gap-2 font-mono text-[11px] text-text-2"
            >
              {isRecording ? (
                <span
                  className="relative w-[7px] h-[7px] rounded-full ping-dot"
                  style={{ background: "var(--rec)" }}
                />
              ) : (
                <>
                  <span
                    className="w-[7px] h-[7px] rounded-full"
                    style={{ background: "var(--warn)" }}
                  />
                  <span className="text-warn">FINALIZING…</span>
                </>
              )}
              {formatElapsed(elapsedMs)}
            </div>
          )}

          {/* Name dots — all participants equal, no meters, no statuses. */}
          <div className="absolute bottom-[34px] left-0 right-0 z-20 flex justify-center items-center gap-[22px] flex-wrap px-4">
            {speakers.map((s, i) => (
              <span key={s.key} className="flex items-center gap-2">
                <TalkingDot
                  hue={speakerHue(i)}
                  level={speakerLevel(s)}
                  clipping={speakerClipping(s)}
                />
                <span className="text-[12px] font-medium text-text-2 whitespace-nowrap">
                  {s.name}
                </span>
              </span>
            ))}
          </div>

          {/* Overflow — mute, monitor, and quality live behind it. */}
          <div className="absolute bottom-[22px] right-[18px] z-30">
            {overflowOpen && (
              <div
                className="absolute bottom-[46px] right-0 rounded-[10px] border p-3.5 flex flex-col gap-3 w-64 shadow-2xl"
                style={{
                  background: "rgba(34,26,69,0.95)",
                  borderColor: "var(--border-hi)",
                  backdropFilter: "blur(8px)",
                }}
              >
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-pressed={micMuted}
                  className="flex items-center justify-between gap-3 text-[12px] text-text-2 hover:text-text"
                >
                  {/* Label follows the actual track state, mirroring the host
                      control; the status chip is visual redundancy only. */}
                  <span>{micMuted ? "Unmute microphone" : "Mute microphone"}</span>
                  <span
                    aria-hidden
                    className="font-mono text-[10px] uppercase tracking-[0.05em]"
                    style={{ color: micMuted ? "var(--rec)" : "var(--text-3)" }}
                  >
                    {micMuted ? "Muted" : "Live"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={toggleMonitor}
                  aria-pressed={monitorEnabled}
                  className="flex items-center justify-between gap-3 text-[12px] text-text-2 hover:text-text"
                >
                  <span>Monitor my mic</span>
                  <span
                    className="w-[7px] h-[7px] rounded-full"
                    style={{
                      background: monitorEnabled ? "var(--ok)" : "var(--text-3)",
                    }}
                  />
                </button>
                {monitorEnabled && (
                  <label className="flex items-center gap-2 text-[11px] text-text-3">
                    Volume
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={monitorVolume}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setStoredMonitorVolume(v);
                        onMonitorVolumeChange(v);
                      }}
                      className="flex-1 accent-[var(--accent)]"
                      aria-label="Monitor volume"
                    />
                  </label>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] text-text-2">Preview quality</span>
                  <span
                    className="font-mono text-[10px] uppercase tracking-[0.05em]"
                    style={{
                      color:
                        audioQualityMode === "full" ? "var(--ok)" : "var(--warn)",
                    }}
                  >
                    {audioQualityMode === "full" ? "Full" : "Saving"}
                  </span>
                </div>
                {isRecording && (
                  <button
                    type="button"
                    onClick={() =>
                      switchAudioQuality(
                        audioQualityMode === "full" ? "bandwidth-saving" : "full",
                      )
                    }
                    className="text-left text-[11px] text-text-3 hover:text-text-2 underline underline-offset-2 font-sans"
                  >
                    {audioQualityMode === "full"
                      ? "Switch to bandwidth-saving"
                      : "Switch to full quality"}
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => setOverflowOpen((v) => !v)}
              aria-label="More options"
              aria-expanded={overflowOpen}
              className="w-9 h-9 rounded-full border flex items-center justify-center text-[15px] tracking-[1px] text-text-2 backdrop-blur-[6px] hover:text-text"
              style={{
                background: "rgba(34,26,69,0.8)",
                borderColor: "var(--border-hi)",
              }}
            >
              ···
            </button>
          </div>
        </>
      )}
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
  // Role drives host-only affordances (e.g. the participant invite tile). Guests
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
        <div className="relative flex-1 flex items-center justify-center px-4 overflow-hidden">
          <Aurora variant="auth" />
          <div className="relative w-full max-w-[360px] flex flex-col items-center">
            {/* Idle lamp — the room rests until you join. */}
            <div className="relative mb-1.5" style={{ height: 140, aspectRatio: "400 / 640" }}>
              <LavaLamp idle seed={12} />
            </div>
            <h1 className="text-[22px] font-extrabold text-text tracking-[-0.03em]">Join Studio</h1>
            <p className="font-mono text-[11px] text-text-3 mt-1.5">
              Session {sessionId.slice(0, 8)}…
            </p>

            <div className="w-full mt-7 space-y-4">
              <div>
                <label className="block font-sans text-[11px] font-semibold text-text-3 uppercase tracking-[0.08em] mb-2">
                  Your Name
                </label>
                <input
                  type="text"
                  value={participantName}
                  onChange={(e) => setParticipantName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                  placeholder="Enter your name"
                  className="w-full px-3.5 py-2.5 text-sm rounded-[8px] outline-none border font-sans text-text"
                  style={{
                    background: "var(--card)",
                    borderColor: "var(--border)",
                  }}
                />
              </div>

              <div>
                <label className="block font-sans text-[11px] font-semibold text-text-3 uppercase tracking-[0.08em] mb-2">
                  Microphone
                </label>
                <select
                  ref={micSelectRef}
                  value={selectedMic}
                  onChange={(e) => setSelectedMic(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm rounded-[8px] outline-none border font-sans text-text"
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
                className="w-full py-[11px] text-[15px] font-semibold font-sans rounded-[10px] border disabled:cursor-not-allowed"
                style={{
                  background: !participantName.trim() || connecting ? "var(--card)" : "var(--accent)",
                  color: !participantName.trim() || connecting ? "var(--text-3)" : "#2b0b18",
                  borderColor: !participantName.trim() || connecting ? "var(--border)" : "var(--accent)",
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
    <div className="animate-page-enter min-h-screen bg-bg flex flex-col">
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
          showMobileWarning={isMobile && !mobileWarningDismissed}
          onDismissMobileWarning={() => setMobileWarningDismissed(true)}
        />
      </LiveKitRoom>
    </div>
  );
}
