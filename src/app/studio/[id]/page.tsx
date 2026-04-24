"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRemoteParticipants,
  useLocalParticipant,
  useRoomContext,
} from "@livekit/components-react";
import { RoomEvent, type TrackPublishOptions } from "livekit-client";
import { v4 as uuidv4 } from "uuid";
import { CozyRecorder } from "@/lib/recorder";
import { getPresignedUploadUrl, uploadChunk, completeUpload } from "@/lib/upload";
import { getToken, LIVEKIT_URL } from "@/lib/livekit";
import { isBuiltInMic } from "@/lib/devices";
import { BuiltInMicWarningModal } from "@/components/BuiltInMicWarningModal";
import {
  MicMonitorToggle,
  getStoredMonitorEnabled,
  getStoredMonitorVolume,
} from "@/components/MicMonitorToggle";
import { useMicMonitor } from "@/hooks/useMicMonitor";

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

const FULL_QUALITY_PUBLISH: TrackPublishOptions = {
  audioPreset: { maxBitrate: 128_000 },
  dtx: false,
};

const BANDWIDTH_SAVING_PUBLISH: TrackPublishOptions = {
  audioPreset: { maxBitrate: 48_000 },
  dtx: true,
};

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
}) {
  const room = useRoomContext();
  const remoteParticipants = useRemoteParticipants();
  const { localParticipant } = useLocalParticipant();
  const recorderRef = useRef<CozyRecorder | null>(null);
  const trackIdRef = useRef<string>("");
  const streamRef = useRef<MediaStream | null>(null);
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(null);

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

  // Listen for remote audio level data via data channel
  useEffect(() => {
    if (!room) return;

    function handleActiveSpeakers() {
      const speakers = room.activeSpeakers;
      setAudioLevels((prev) => {
        const next = new Map(prev);
        for (const s of speakers) {
          next.set(
            s.identity ?? "unknown",
            Math.round((s.audioLevel ?? 0) * 255)
          );
        }
        return next;
      });
    }

    room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);
    };
  }, [room]);

  // Tick the elapsed-time display while recording
  useEffect(() => {
    if (studioState === "recording") {
      setElapsedMs(0);
      const started = Date.now();
      elapsedTimerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - started);
      }, 250);
    } else {
      setElapsedMs(0);
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    }
    return () => {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    };
  }, [studioState]);

  const startRecording = useCallback(async () => {
    if (!streamRef.current) return;

    trackIdRef.current = uuidv4();
    const trackId = trackIdRef.current;

    try {
      await getPresignedUploadUrl(sessionId, trackId, 0, participantName, {
        deviceLabel: selectedMicLabel,
        deviceId: selectedMic,
        isBuiltInMic: selectedMicIsBuiltIn,
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

    setStudioState("recording");

    // Auto-switch to bandwidth-saving mode for the LiveKit preview
    const switched = await switchAudioQuality("bandwidth-saving");
    if (switched) {
      showNotification("Preview quality reduced — local recording is unaffected");
    } else {
      showNotification("Couldn't switch audio quality — check console");
    }

    // Notify other participants via data channel
    const encoder = new TextEncoder();
    const data = encoder.encode(
      JSON.stringify({ type: "recording_started", participant: participantName })
    );
    localParticipant.publishData(data, { reliable: true });
  }, [
    sessionId,
    participantName,
    selectedMic,
    selectedMicLabel,
    selectedMicIsBuiltIn,
    localParticipant,
    setStudioState,
    showNotification,
    switchAudioQuality,
    trackChunkUpload,
  ]);

  const stopRecording = useCallback(async () => {
    if (!recorderRef.current) return;

    try {
      const blob = await recorderRef.current.stop();
      const trackId = trackIdRef.current;
      const durationMs = Date.now() - recordingStartRef.current;

      // Upload the final complete blob
      const url = await getPresignedUploadUrl(sessionId, trackId, 9999);
      await uploadChunk(url, blob);
      await waitForChunkUploads();
      await completeUpload(sessionId, trackId, durationMs);

      // Notify other participants
      const encoder = new TextEncoder();
      const data = encoder.encode(
        JSON.stringify({ type: "recording_stopped", participant: participantName })
      );
      localParticipant.publishData(data, { reliable: true });

      setStudioState("connected");

      // Restore full-quality preview
      await switchAudioQuality("full");
    } catch (err) {
      console.error("Failed to stop recording:", err);
    }

    recorderRef.current = null;
  }, [
    sessionId,
    participantName,
    localParticipant,
    setStudioState,
    switchAudioQuality,
    waitForChunkUploads,
  ]);

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

          {/* Invite tile — blocked on cozytrack#23 (invite tokens). */}
          <div
            className="rounded-lg px-4 py-3.5 flex items-center gap-3 opacity-50 cursor-not-allowed border border-dashed"
            style={{ borderColor: "var(--border)" }}
            title="Cohost invite links tracked in #23"
          >
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center border border-dashed"
              style={{ borderColor: "var(--border-hi)" }}
            >
              <IcoPlus size={14} color="var(--text-3)" />
            </div>
            <span className="text-[13px] text-text-3">Invite a cohost…</span>
            <div className="ml-auto">
              <IcoLink size={13} color="var(--text-3)" />
            </div>
          </div>

          {/* Monitor toggle kept below the strips so it doesn't crowd the meters */}
          <div className="mt-2">
            <MicMonitorToggle
              enabled={monitorEnabled}
              volume={monitorVolume}
              onEnabledChange={onMonitorEnabledChange}
              onVolumeChange={onMonitorVolumeChange}
            />
          </div>
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
                onClick={() => (isRecording ? stopRecording() : startRecording())}
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

  useEffect(() => {
    setMonitorEnabled(getStoredMonitorEnabled());
    setMonitorVolume(getStoredMonitorVolume());
  }, []);

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
        />
      </LiveKitRoom>
    </div>
  );
}
