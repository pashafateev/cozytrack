"use client";

export type RecordingBackupStorage = "opfs" | "indexeddb";
export type RecordingBackupUploadStatus = "pending" | "uploaded" | "failed";
export type RecordingBackupState =
  | "recording"
  | "available"
  | "uploading"
  | "uploaded"
  | "failed";
export type RecordingBackupClearReason = "user-confirmed" | "verified-upload";

export interface RecordingBackupChunkManifest {
  chunkIndex: number;
  byteSize: number;
  capturedAt: string;
  uploadedAt?: string;
  uploadStatus: RecordingBackupUploadStatus;
  storage: RecordingBackupStorage;
  storageKey: string;
  error?: string;
}

export interface RecordingBackupManifest {
  id: string;
  sessionId: string;
  trackId: string;
  participantName: string;
  createdAt: string;
  updatedAt: string;
  state: RecordingBackupState;
  persistentStorage: boolean | null;
  recordingToken?: string;
  durationMs?: number;
  lastError?: string;
  chunks: RecordingBackupChunkManifest[];
}

export interface StartRecordingBackupInput {
  sessionId: string;
  trackId: string;
  participantName: string;
  recordingToken?: string;
}

export interface RecordingBackupChunkRef {
  sessionId: string;
  trackId: string;
  chunkIndex: number;
}

export interface StoredRecordingBackupChunk {
  storage: RecordingBackupStorage;
  storageKey: string;
}

export interface RecordingBackupBackend {
  requestPersistence(): Promise<boolean | null>;
  writeChunk(
    ref: RecordingBackupChunkRef,
    chunk: Blob,
  ): Promise<StoredRecordingBackupChunk>;
  readChunk(
    ref: RecordingBackupChunkRef,
    stored: StoredRecordingBackupChunk,
  ): Promise<Blob>;
  deleteChunk(
    ref: RecordingBackupChunkRef,
    stored: StoredRecordingBackupChunk,
  ): Promise<void>;
  putManifest(manifest: RecordingBackupManifest): Promise<void>;
  getManifest(id: string): Promise<RecordingBackupManifest | null>;
  listManifests(sessionId?: string): Promise<RecordingBackupManifest[]>;
  deleteManifest(id: string): Promise<void>;
}

const DB_NAME = "cozytrack-recording-backups";
const DB_VERSION = 1;
const MANIFEST_STORE = "manifests";
const CHUNK_STORE = "chunks";
const OPFS_ROOT = "cozytrack-recordings";
const WEBM_MIME_TYPE = "audio/webm;codecs=opus";

type ChunkRecord = {
  key: string;
  blob: Blob;
};

type WritableFileStreamLike = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
};

type FileHandleLike = {
  createWritable(): Promise<WritableFileStreamLike>;
  getFile(): Promise<File>;
};

type DirectoryHandleLike = {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileHandleLike>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
};

type StorageManagerWithDirectory = StorageManager & {
  getDirectory?: () => Promise<DirectoryHandleLike>;
};

export function recordingBackupId(sessionId: string, trackId: string): string {
  return `${sessionId}:${trackId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneManifest(manifest: RecordingBackupManifest): RecordingBackupManifest {
  return JSON.parse(JSON.stringify(manifest)) as RecordingBackupManifest;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : "Recording backup failed";
}

function chunkStorageKey(ref: RecordingBackupChunkRef): string {
  return `${ref.sessionId}:${ref.trackId}:${ref.chunkIndex}`;
}

function opfsFilename(chunkIndex: number): string {
  return `${chunkIndex}.webm`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB error"));
  });
}

async function idbTransaction(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction error"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    work(tx);
  });
}

export class BrowserRecordingBackupBackend implements RecordingBackupBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  async requestPersistence(): Promise<boolean | null> {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) {
      return null;
    }
    try {
      return await navigator.storage.persist();
    } catch {
      return null;
    }
  }

  async writeChunk(
    ref: RecordingBackupChunkRef,
    chunk: Blob,
  ): Promise<StoredRecordingBackupChunk> {
    try {
      const opfsDir = await this.getOpfsTrackDirectory(
        ref.sessionId,
        ref.trackId,
        true,
      );
      if (opfsDir) {
        const filename = opfsFilename(ref.chunkIndex);
        const fileHandle = await opfsDir.getFileHandle(filename, {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(chunk);
        await writable.close();
        return {
          storage: "opfs",
          storageKey: `${OPFS_ROOT}/${safePathSegment(ref.sessionId)}/${safePathSegment(ref.trackId)}/${filename}`,
        };
      }
    } catch (error) {
      console.warn("Recording backup OPFS write failed; falling back to IndexedDB", error);
    }

    const storageKey = chunkStorageKey(ref);
    const db = await this.openDb();
    await idbTransaction(db, CHUNK_STORE, "readwrite", (tx) => {
      tx.objectStore(CHUNK_STORE).put({ key: storageKey, blob: chunk });
    });
    return { storage: "indexeddb", storageKey };
  }

  async readChunk(
    ref: RecordingBackupChunkRef,
    stored: StoredRecordingBackupChunk,
  ): Promise<Blob> {
    if (stored.storage === "opfs") {
      const opfsDir = await this.getOpfsTrackDirectory(
        ref.sessionId,
        ref.trackId,
        false,
      );
      if (opfsDir) {
        const fileHandle = await opfsDir.getFileHandle(opfsFilename(ref.chunkIndex));
        return await fileHandle.getFile();
      }
    }

    const db = await this.openDb();
    const record = await idbRequest<ChunkRecord | undefined>(
      db
        .transaction(CHUNK_STORE, "readonly")
        .objectStore(CHUNK_STORE)
        .get(stored.storageKey),
    );
    if (!record) {
      throw new Error(`Local recording chunk ${ref.chunkIndex} was not found`);
    }
    return record.blob;
  }

  async deleteChunk(
    ref: RecordingBackupChunkRef,
    stored: StoredRecordingBackupChunk,
  ): Promise<void> {
    if (stored.storage === "opfs") {
      try {
        const opfsDir = await this.getOpfsTrackDirectory(
          ref.sessionId,
          ref.trackId,
          false,
        );
        await opfsDir?.removeEntry?.(opfsFilename(ref.chunkIndex));
      } catch {
        // Continue with the IndexedDB cleanup path below. Missing OPFS chunks
        // should not make explicit backup cleanup fail.
      }
    }

    const db = await this.openDb();
    await idbTransaction(db, CHUNK_STORE, "readwrite", (tx) => {
      tx.objectStore(CHUNK_STORE).delete(stored.storageKey);
    });
  }

  async putManifest(manifest: RecordingBackupManifest): Promise<void> {
    const db = await this.openDb();
    await idbTransaction(db, MANIFEST_STORE, "readwrite", (tx) => {
      tx.objectStore(MANIFEST_STORE).put(cloneManifest(manifest));
    });
  }

  async getManifest(id: string): Promise<RecordingBackupManifest | null> {
    const db = await this.openDb();
    const manifest = await idbRequest<RecordingBackupManifest | undefined>(
      db.transaction(MANIFEST_STORE, "readonly").objectStore(MANIFEST_STORE).get(id),
    );
    return manifest ? cloneManifest(manifest) : null;
  }

  async listManifests(sessionId?: string): Promise<RecordingBackupManifest[]> {
    const db = await this.openDb();
    const manifests = await idbRequest<RecordingBackupManifest[]>(
      db
        .transaction(MANIFEST_STORE, "readonly")
        .objectStore(MANIFEST_STORE)
        .getAll(),
    );
    return manifests
      .filter((manifest) => (sessionId ? manifest.sessionId === sessionId : true))
      .map(cloneManifest)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteManifest(id: string): Promise<void> {
    const db = await this.openDb();
    await idbTransaction(db, MANIFEST_STORE, "readwrite", (tx) => {
      tx.objectStore(MANIFEST_STORE).delete(id);
    });
  }

  private async openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not available for recording backup");
    }

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
          db.createObjectStore(MANIFEST_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          db.createObjectStore(CHUNK_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error ?? new Error("Failed to open IndexedDB"));
      };
      request.onblocked = () => {
        this.dbPromise = null;
        reject(new Error("Recording backup database upgrade is blocked"));
      };
    });

    return this.dbPromise;
  }

  private async getOpfsTrackDirectory(
    sessionId: string,
    trackId: string,
    create: boolean,
  ): Promise<DirectoryHandleLike | null> {
    if (typeof navigator === "undefined") return null;
    const storage = navigator.storage as StorageManagerWithDirectory | undefined;
    if (!storage?.getDirectory) return null;

    const root = await storage.getDirectory();
    const appDir = await root.getDirectoryHandle(OPFS_ROOT, { create });
    const sessionDir = await appDir.getDirectoryHandle(safePathSegment(sessionId), {
      create,
    });
    return await sessionDir.getDirectoryHandle(safePathSegment(trackId), {
      create,
    });
  }
}

export class MemoryRecordingBackupBackend implements RecordingBackupBackend {
  private manifests = new Map<string, RecordingBackupManifest>();
  private chunks = new Map<string, Blob>();

  constructor(private persistentStorage: boolean | null = true) {}

  async requestPersistence(): Promise<boolean | null> {
    return this.persistentStorage;
  }

  async writeChunk(
    ref: RecordingBackupChunkRef,
    chunk: Blob,
  ): Promise<StoredRecordingBackupChunk> {
    const storageKey = chunkStorageKey(ref);
    this.chunks.set(storageKey, chunk);
    return { storage: "indexeddb", storageKey };
  }

  async readChunk(
    ref: RecordingBackupChunkRef,
    stored: StoredRecordingBackupChunk,
  ): Promise<Blob> {
    const chunk = this.chunks.get(stored.storageKey);
    if (!chunk) {
      throw new Error(`Local recording chunk ${ref.chunkIndex} was not found`);
    }
    return chunk;
  }

  async deleteChunk(
    _ref: RecordingBackupChunkRef,
    stored: StoredRecordingBackupChunk,
  ): Promise<void> {
    this.chunks.delete(stored.storageKey);
  }

  async putManifest(manifest: RecordingBackupManifest): Promise<void> {
    this.manifests.set(manifest.id, cloneManifest(manifest));
  }

  async getManifest(id: string): Promise<RecordingBackupManifest | null> {
    const manifest = this.manifests.get(id);
    return manifest ? cloneManifest(manifest) : null;
  }

  async listManifests(sessionId?: string): Promise<RecordingBackupManifest[]> {
    return Array.from(this.manifests.values())
      .filter((manifest) => (sessionId ? manifest.sessionId === sessionId : true))
      .map(cloneManifest)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteManifest(id: string): Promise<void> {
    this.manifests.delete(id);
  }
}

export class RecordingBackupStore {
  private locks = new Map<string, Promise<void>>();

  constructor(private backend: RecordingBackupBackend) {}

  async startBackup(
    input: StartRecordingBackupInput,
  ): Promise<RecordingBackupManifest> {
    const now = nowIso();
    const manifest: RecordingBackupManifest = {
      id: recordingBackupId(input.sessionId, input.trackId),
      sessionId: input.sessionId,
      trackId: input.trackId,
      participantName: input.participantName,
      createdAt: now,
      updatedAt: now,
      state: "recording",
      persistentStorage: await this.backend.requestPersistence(),
      recordingToken: input.recordingToken,
      chunks: [],
    };
    await this.backend.putManifest(manifest);
    return cloneManifest(manifest);
  }

  async listBackups(sessionId?: string): Promise<RecordingBackupManifest[]> {
    return await this.backend.listManifests(sessionId);
  }

  async getBackup(id: string): Promise<RecordingBackupManifest | null> {
    return await this.backend.getManifest(id);
  }

  async updateRecordingToken(
    id: string,
    recordingToken: string | undefined,
  ): Promise<RecordingBackupManifest> {
    return await this.mutateManifest(id, (manifest) => {
      manifest.recordingToken = recordingToken;
      return manifest;
    });
  }

  async saveChunk(
    input: {
      sessionId: string;
      trackId: string;
      chunkIndex: number;
      chunk: Blob;
      capturedAt?: Date;
    },
  ): Promise<RecordingBackupManifest> {
    const stored = await this.backend.writeChunk(
      {
        sessionId: input.sessionId,
        trackId: input.trackId,
        chunkIndex: input.chunkIndex,
      },
      input.chunk,
    );

    return await this.mutateManifest(
      recordingBackupId(input.sessionId, input.trackId),
      (manifest) => {
        const chunkManifest: RecordingBackupChunkManifest = {
          chunkIndex: input.chunkIndex,
          byteSize: input.chunk.size,
          capturedAt: (input.capturedAt ?? new Date()).toISOString(),
          uploadStatus: "pending",
          storage: stored.storage,
          storageKey: stored.storageKey,
        };
        const existingIndex = manifest.chunks.findIndex(
          (chunk) => chunk.chunkIndex === input.chunkIndex,
        );
        if (existingIndex >= 0) {
          manifest.chunks[existingIndex] = chunkManifest;
        } else {
          manifest.chunks.push(chunkManifest);
          manifest.chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
        }
        if (manifest.state === "uploaded") manifest.state = "available";
        return manifest;
      },
    );
  }

  async markChunkUploaded(
    sessionId: string,
    trackId: string,
    chunkIndex: number,
  ): Promise<RecordingBackupManifest> {
    return await this.updateChunkUploadState(
      sessionId,
      trackId,
      chunkIndex,
      "uploaded",
    );
  }

  async markChunkFailed(
    sessionId: string,
    trackId: string,
    chunkIndex: number,
    error: unknown,
  ): Promise<RecordingBackupManifest> {
    return await this.updateChunkUploadState(
      sessionId,
      trackId,
      chunkIndex,
      "failed",
      normalizeError(error),
    );
  }

  async markBackupAvailable(
    id: string,
    durationMs?: number,
  ): Promise<RecordingBackupManifest> {
    return await this.mutateManifest(id, (manifest) => {
      manifest.durationMs = durationMs;
      if (manifest.state !== "failed") {
        manifest.state = "available";
      }
      return manifest;
    });
  }

  async markBackupUploading(id: string): Promise<RecordingBackupManifest> {
    return await this.mutateManifest(id, (manifest) => {
      manifest.state = "uploading";
      manifest.lastError = undefined;
      return manifest;
    });
  }

  async markBackupUploaded(id: string): Promise<RecordingBackupManifest> {
    return await this.mutateManifest(id, (manifest) => {
      manifest.state = "uploaded";
      manifest.lastError = undefined;
      return manifest;
    });
  }

  async markBackupFailed(
    id: string,
    error: unknown,
  ): Promise<RecordingBackupManifest> {
    return await this.mutateManifest(id, (manifest) => {
      manifest.state = "failed";
      manifest.lastError = normalizeError(error);
      return manifest;
    });
  }

  async buildRecordingBlob(id: string): Promise<Blob> {
    const manifest = await this.backend.getManifest(id);
    if (!manifest) throw new Error("Local recording backup was not found");
    const chunks = [...manifest.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
    if (chunks.length === 0) {
      throw new Error("Local recording backup has no chunks");
    }

    const blobs: Blob[] = [];
    for (const chunk of chunks) {
      blobs.push(
        await this.backend.readChunk(
          {
            sessionId: manifest.sessionId,
            trackId: manifest.trackId,
            chunkIndex: chunk.chunkIndex,
          },
          { storage: chunk.storage, storageKey: chunk.storageKey },
        ),
      );
    }
    return new Blob(blobs, { type: WEBM_MIME_TYPE });
  }

  async clearBackup(
    id: string,
    reason: RecordingBackupClearReason,
  ): Promise<void> {
    if (reason !== "user-confirmed" && reason !== "verified-upload") {
      throw new Error("Recording backup cleanup requires an explicit reason");
    }

    const manifest = await this.backend.getManifest(id);
    if (!manifest) return;

    for (const chunk of manifest.chunks) {
      await this.backend.deleteChunk(
        {
          sessionId: manifest.sessionId,
          trackId: manifest.trackId,
          chunkIndex: chunk.chunkIndex,
        },
        { storage: chunk.storage, storageKey: chunk.storageKey },
      );
    }

    await this.backend.deleteManifest(id);
  }

  private async updateChunkUploadState(
    sessionId: string,
    trackId: string,
    chunkIndex: number,
    uploadStatus: RecordingBackupUploadStatus,
    error?: string,
  ): Promise<RecordingBackupManifest> {
    return await this.mutateManifest(
      recordingBackupId(sessionId, trackId),
      (manifest) => {
        const chunk = manifest.chunks.find(
          (item) => item.chunkIndex === chunkIndex,
        );
        if (!chunk) return manifest;
        chunk.uploadStatus = uploadStatus;
        chunk.error = error;
        if (uploadStatus === "uploaded") {
          chunk.uploadedAt = nowIso();
        }
        if (uploadStatus === "failed") {
          manifest.state = "failed";
          manifest.lastError = error;
        }
        return manifest;
      },
    );
  }

  private async mutateManifest(
    id: string,
    mutate: (manifest: RecordingBackupManifest) => RecordingBackupManifest,
  ): Promise<RecordingBackupManifest> {
    const prior = this.locks.get(id) ?? Promise.resolve();
    let resolvedManifest: RecordingBackupManifest | null = null;
    const next = prior.then(async () => {
      const current = await this.backend.getManifest(id);
      if (!current) {
        throw new Error("Local recording backup was not found");
      }
      const updated = mutate(cloneManifest(current));
      updated.updatedAt = nowIso();
      await this.backend.putManifest(updated);
      resolvedManifest = updated;
    });

    this.locks.set(
      id,
      next.catch(() => {
        // Keep later mutations from being permanently blocked by a failed one.
      }),
    );

    await next;
    if (!resolvedManifest) {
      throw new Error("Local recording backup update did not complete");
    }
    return cloneManifest(resolvedManifest);
  }
}

export const browserRecordingBackupStore = new RecordingBackupStore(
  new BrowserRecordingBackupBackend(),
);
