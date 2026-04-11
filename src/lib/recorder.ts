"use client";

export type ChunkCallback = (chunk: Blob, index: number) => void;

type RecorderInstance = {
  startRecording: () => void;
  stopRecording: (callback: () => void) => void;
  getBlob: () => Blob;
};

export class CozyRecorder {
  private recorder: RecorderInstance | null = null;
  private stream: MediaStream;
  private chunkCallbacks: ChunkCallback[] = [];
  private chunkIndex = 0;
  private allChunks: Blob[] = [];
  private mimeType: string;

  constructor(
    stream: MediaStream,
    options?: { mimeType?: string; timeSlice?: number }
  ) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "audio/webm;codecs=opus";
  }

  onChunk(callback: ChunkCallback): void {
    this.chunkCallbacks.push(callback);
  }

  async start(timeSlice = 5000): Promise<void> {
    this.chunkIndex = 0;
    this.allChunks = [];

    const { default: RecordRTC, StereoAudioRecorder } = await import("recordrtc");

    this.recorder = new RecordRTC(this.stream, {
      type: "audio",
      mimeType: "audio/webm",
      recorderType: StereoAudioRecorder,
      timeSlice,
      ondataavailable: (blob: Blob) => {
        this.allChunks.push(blob);
        const idx = this.chunkIndex++;
        for (const cb of this.chunkCallbacks) {
          cb(blob, idx);
        }
      },
      desiredSampRate: 48000,
      numberOfAudioChannels: 1,
    });

    this.recorder.startRecording();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error("Recorder not started"));
        return;
      }

      this.recorder.stopRecording(() => {
        const blob = this.getBlob();
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("No recording data available"));
        }
      });
    });
  }

  getBlob(): Blob {
    if (this.allChunks.length > 0) {
      return new Blob(this.allChunks, { type: this.mimeType });
    }
    if (this.recorder) {
      return this.recorder.getBlob();
    }
    return new Blob([], { type: this.mimeType });
  }
}
