"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  LiveKitRoom,
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

// ---------- Types ----------

type StudioState = "prejoin" | "connected" | "recording";
type AudioQualityMode = "full" | "bandwidth-saving";

interface AudioLevel {
  identity: string;
  level: number;
}

// ---------- Audio Quality Presets ----------

const FULL_QUALITY_PUBLISH: TrackPublishOptions = {
  audioPreset: { maxBitrate: 128_000 },
  dtx: false,
};

const BANDWIDTH_SAVING_PUBLISH: TrackPublishOptions = {
  audioPreset: { maxBitrate: 48_000 },
  dtx: true,
};

// ---------- Audio Level Meter ----------

function AudioLevelMeter({ level }: { level: number }) {
  const barCount = 12;
  const filledBars = Math.round((level / 255) * barCount);

  return (
    <div className="flex items-end gap-0.5 h-6">
      {Array.from({ length: barCount }, (_, i) => (
        <div
          key={i}
          className={`w-1 rounded-full transition-all duration-75 ${
            i < filledBars
              ? i < barCount * 0.6
                ? "bg-green-400"
                : i < barCount * 0.85
                  ? "bg-yellow-400"
                  : "bg-red-400"
              : "bg-cozy-700"
          }`}
          style={{ height: `${((i + 1) / barCount) * 100}%` }}
        />
      ))}
    </div>
  );
}

// ---------- Participant Tile ----------

function ParticipantTile({
  name,
  level,
  isSelf,
}: {
  name: string;
  level: number;
  isSelf?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 rounded-xl bg-cozy-900 border border-cozy-700">
      <div
        className={`w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold ${
          isSelf ? "bg-indigo-600" : "bg-cozy-600"
        }`}
      >
        {name.charAt(0).toUpperCase()}
      </div>
      <span className="text-sm font-medium text-white">{name}</span>
      <AudioLevelMeter level={level} />
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
}: {
  sessionId: string;
  participantName: string;
  selectedMic: string;
  selectedMicLabel: string;
  selectedMicIsBuiltIn: boolean;
  studioState: StudioState;
  setStudioState: (state: StudioState) => void;
}) {
  const room = useRoomContext();
  const remoteParticipants = useRemoteParticipants();
  const { localParticipant } = useLocalParticipant();
  const recorderRef = useRef<CozyRecorder | null>(null);
  const trackIdRef = useRef<string>("");
  const streamRef = useRef<MediaStream | null>(null);
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(null);
  const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map());
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const recordingStartRef = useRef<number>(0);
  const localLevelRef = useRef(0);
  const chunkUploadPromisesRef = useRef(new Set<Promise<void>>());

  const [audioQualityMode, setAudioQualityMode] = useState<AudioQualityMode>("full");
  const [notification, setNotification] = useState<string | null>(null);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
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

  // Get mic stream on mount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <div className="space-y-8">
      {/* Notification Toast */}
      {notification && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-cozy-800 border border-cozy-600 text-sm text-gray-200 shadow-lg animate-toast-fade-in">
          {notification}
        </div>
      )}

      {/* Audio Quality Badge */}
      <div className="flex items-center justify-center gap-3">
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
            audioQualityMode === "full"
              ? "bg-green-900/50 text-green-400 border border-green-700"
              : "bg-yellow-900/50 text-yellow-400 border border-yellow-700"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              audioQualityMode === "full" ? "bg-green-400" : "bg-yellow-400"
            }`}
          />
          {audioQualityMode === "full"
            ? "Full Quality Preview"
            : "Bandwidth-Saving Mode"}
        </span>
        {studioState === "recording" && (
          <button
            onClick={() =>
              switchAudioQuality(
                audioQualityMode === "full" ? "bandwidth-saving" : "full",
              )
            }
            className="text-xs text-gray-400 hover:text-white underline underline-offset-2 transition-colors"
          >
            {audioQualityMode === "full"
              ? "Switch to bandwidth-saving"
              : "Switch to full quality"}
          </button>
        )}
      </div>

      {/* Participants Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <ParticipantTile
          name={participantName}
          level={audioLevels.get(participantName) ?? 0}
          isSelf
        />
        {remoteParticipants.map((p) => (
          <ParticipantTile
            key={p.identity}
            name={p.identity}
            level={audioLevels.get(p.identity) ?? 0}
          />
        ))}
      </div>

      {/* Recording Controls */}
      <div className="flex justify-center">
        {studioState === "connected" && (
          <button
            onClick={startRecording}
            className="px-8 py-3 rounded-full bg-red-600 hover:bg-red-700 text-white font-medium transition-colors flex items-center gap-3"
          >
            <span className="w-3 h-3 rounded-full bg-white" />
            Start Recording
          </button>
        )}
        {studioState === "recording" && (
          <button
            onClick={stopRecording}
            className="px-8 py-3 rounded-full bg-cozy-700 hover:bg-cozy-600 text-white font-medium transition-colors flex items-center gap-3 ring-2 ring-red-500"
          >
            <span className="w-3 h-3 rounded-sm bg-red-500 animate-pulse" />
            Stop Recording
          </button>
        )}
      </div>

      {/* Status */}
      {studioState === "recording" && (
        <p className="text-center text-red-400 text-sm animate-pulse">
          Recording in progress...
        </p>
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
  const [showMicWarning, setShowMicWarning] = useState(false);
  const [acknowledgedDevices, setAcknowledgedDevices] = useState<Set<string>>(
    () => new Set(),
  );
  const micSelectRef = useRef<HTMLSelectElement>(null);

  // Enumerate mic devices
  useEffect(() => {
    async function getMics() {
      try {
        // Need to request permission first to get device labels
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

    const mic = mics.find((m) => m.deviceId === selectedMic);
    if (mic && isBuiltInMic(mic.label) && !acknowledgedDevices.has(selectedMic)) {
      setShowMicWarning(true);
      return;
    }

    proceedToJoin();
  }

  // ---------- Pre-join screen ----------

  if (studioState === "prejoin") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
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
        <div className="max-w-md w-full space-y-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-white">Join Studio</h1>
            <p className="text-gray-400 mt-2">Session: {sessionId.slice(0, 8)}...</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Your Name
              </label>
              <input
                type="text"
                value={participantName}
                onChange={(e) => setParticipantName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                placeholder="Enter your name"
                className="w-full px-4 py-3 rounded-lg bg-cozy-900 border border-cozy-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Microphone
              </label>
              <select
                ref={micSelectRef}
                value={selectedMic}
                onChange={(e) => setSelectedMic(e.target.value)}
                className="w-full px-4 py-3 rounded-lg bg-cozy-900 border border-cozy-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {mics.map((mic) => (
                  <option key={mic.deviceId} value={mic.deviceId}>
                    {mic.label || `Microphone ${mic.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={handleJoin}
              disabled={!participantName.trim() || connecting}
              className="w-full px-6 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {connecting ? "Connecting..." : "Join Studio"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Connected / Recording ----------

  return (
    <div className="min-h-screen px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Studio</h1>
            <p className="text-gray-400 text-sm">
              {participantName} &middot; {sessionId.slice(0, 8)}...
            </p>
          </div>
          {studioState === "recording" && (
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-red-400 text-sm font-medium">REC</span>
            </div>
          )}
        </div>

        <LiveKitRoom
          serverUrl={LIVEKIT_URL}
          token={token}
          audio={{
            deviceId: selectedMic ? { exact: selectedMic } : undefined,
          }}
          options={{
            publishDefaults: {
              audioPreset: { maxBitrate: 128_000 },
              dtx: false,
            },
          }}
          connect={true}
        >
          <RoomContent
            sessionId={sessionId}
            participantName={participantName}
            selectedMic={selectedMic}
            selectedMicLabel={mics.find((m) => m.deviceId === selectedMic)?.label ?? ""}
            selectedMicIsBuiltIn={isBuiltInMic(mics.find((m) => m.deviceId === selectedMic)?.label ?? "")}
            studioState={studioState}
            setStudioState={setStudioState}
          />
        </LiveKitRoom>
      </div>
    </div>
  );
}
