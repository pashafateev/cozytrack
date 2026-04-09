"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  LiveKitRoom,
  useRemoteParticipants,
  useLocalParticipant,
  useRoomContext,
} from "@livekit/components-react";
import { RoomEvent, DataPacket_Kind } from "livekit-client";
import { v4 as uuidv4 } from "uuid";
import { CozyRecorder } from "@/lib/recorder";
import { getPresignedUploadUrl, uploadChunk, completeUpload } from "@/lib/upload";
import { getToken, LIVEKIT_URL } from "@/lib/livekit";

// ---------- Types ----------

type StudioState = "prejoin" | "connected" | "recording";

interface AudioLevel {
  identity: string;
  level: number;
}

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
  studioState,
  setStudioState,
}: {
  sessionId: string;
  participantName: string;
  studioState: StudioState;
  setStudioState: (state: StudioState) => void;
}) {
  const room = useRoomContext();
  const remoteParticipants = useRemoteParticipants();
  const { localParticipant } = useLocalParticipant();
  const recorderRef = useRef<CozyRecorder | null>(null);
  const trackIdRef = useRef<string>("");
  const streamRef = useRef<MediaStream | null>(null);
  const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map());
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const recordingStartRef = useRef<number>(0);

  // Monitor local audio levels
  useEffect(() => {
    if (!streamRef.current) return;

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(streamRef.current);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    function tick() {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      setAudioLevels((prev) => {
        const next = new Map(prev);
        next.set(participantName, avg);
        return next;
      });
      animFrameRef.current = requestAnimationFrame(tick);
    }

    tick();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      audioCtx.close();
    };
  }, [participantName]);

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

    // Create the track in the database
    await fetch("/api/sessions/" + sessionId, { method: "GET" });

    // Create a DB track record
    const trackRes = await fetch("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, trackId, partNumber: 0 }),
    });

    if (!trackRes.ok) {
      console.error("Failed to initialize upload");
      return;
    }

    const recorder = new CozyRecorder(streamRef.current);

    recorder.onChunk(async (chunk, index) => {
      try {
        const url = await getPresignedUploadUrl(sessionId, trackId, index);
        await uploadChunk(url, chunk);
      } catch (err) {
        console.error("Failed to upload chunk:", err);
      }
    });

    recorderRef.current = recorder;
    recordingStartRef.current = Date.now();
    recorder.start(5000);
    setStudioState("recording");

    // Notify other participants via data channel
    const encoder = new TextEncoder();
    const data = encoder.encode(
      JSON.stringify({ type: "recording_started", participant: participantName })
    );
    localParticipant.publishData(data, { reliable: true });
  }, [sessionId, participantName, localParticipant, setStudioState]);

  const stopRecording = useCallback(async () => {
    if (!recorderRef.current) return;

    try {
      const blob = await recorderRef.current.stop();
      const trackId = trackIdRef.current;
      const durationMs = Date.now() - recordingStartRef.current;

      // Upload the final complete blob
      const url = await getPresignedUploadUrl(sessionId, trackId, 9999);
      await uploadChunk(url, blob);
      await completeUpload(sessionId, trackId);

      // Notify other participants
      const encoder = new TextEncoder();
      const data = encoder.encode(
        JSON.stringify({ type: "recording_stopped", participant: participantName })
      );
      localParticipant.publishData(data, { reliable: true });

      setStudioState("connected");
    } catch (err) {
      console.error("Failed to stop recording:", err);
    }

    recorderRef.current = null;
  }, [sessionId, participantName, localParticipant, setStudioState]);

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

  async function handleJoin() {
    if (!participantName.trim()) return;

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

  // ---------- Pre-join screen ----------

  if (studioState === "prejoin") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
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
          connect={true}
        >
          <RoomContent
            sessionId={sessionId}
            participantName={participantName}
            studioState={studioState}
            setStudioState={setStudioState}
          />
        </LiveKitRoom>
      </div>
    </div>
  );
}
