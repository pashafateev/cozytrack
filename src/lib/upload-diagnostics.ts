"use client";

import {
  isUploadDiagnosticId,
  sanitizeUploadDiagnosticEvent,
  type UploadDiagnosticEvent,
} from "@/lib/upload-diagnostic-event";

export const UPLOAD_DIAGNOSTICS_STORAGE_KEY = "cozytrack-upload-diagnostics-v1";
const MAX_EVENTS = 300;
const MAX_JOURNAL_CHARACTERS = 192_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 20;
const MAX_BATCHES_PER_FLUSH = 4;
const REPORT_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 5_000;

export type UploadDiagnosticContext = {
  attemptId: string;
  sessionId: string;
  trackId: string;
  segmentId?: string;
  kind: "chunk" | "final" | "retry";
  partNumber?: number;
  recordingToken?: string;
};
type Details = {
  stage: UploadDiagnosticEvent["stage"];
  outcome: UploadDiagnosticEvent["outcome"];
  bytes?: number;
  elapsedMs?: number;
  httpStatus?: number;
  errorCategory?: UploadDiagnosticEvent["errorCategory"];
  trackStatus?: string;
};
type Options = {
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  fetch?: typeof fetch;
  now?: () => number;
};
type JournalEntry = { event: UploadDiagnosticEvent; delivered: boolean };

let fallbackId = 0;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    fallbackId += 1;
    return `diagnostic-${Date.now().toString(36)}-${fallbackId.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

function browserFamily(): string {
  try {
    const agent = navigator.userAgent;
    if (/Edg\//.test(agent)) return "Edge";
    if (/OPR\//.test(agent)) return "Opera";
    if (/Firefox\/|FxiOS\//.test(agent)) return "Firefox";
    if (/Chrome\/|CriOS\//.test(agent)) return "Chrome";
    if (/Safari\//.test(agent)) return "Safari";
  } catch {
    // Metadata is optional; never expose the full user-agent string.
  }
  return "Other";
}

function browserStorage(): Options["storage"] {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function scope(event: Pick<UploadDiagnosticContext, "sessionId" | "trackId" | "segmentId">): string {
  return JSON.stringify([event.sessionId, event.trackId, event.segmentId ?? null]);
}

function serialize(entries: JournalEntry[]): string {
  return JSON.stringify({ version: 1, entries });
}

export function createUploadDiagnosticContext(input: Omit<UploadDiagnosticContext, "attemptId">): UploadDiagnosticContext {
  return { ...input, attemptId: newId() };
}

/** Bounded browser history, separate from audio backups. Storage is best effort:
 * sequential cross-tab writes merge, but simultaneous localStorage writes are
 * not transactional. Acknowledgments prevent routine re-sends after reload.
 */
export function createUploadDiagnostics(options: Options = {}) {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  let entries: JournalEntry[] = [];
  // Credentials never enter a journal entry or downloaded report.
  const recordingTokens = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let lastAttemptedScope: string | undefined;

  function bound(values: JournalEntry[]): JournalEntry[] {
    const currentTime = now();
    const recent = values
      .filter(({ event }) => event.at >= currentTime - RETENTION_MS && event.at <= currentTime + 60_000)
      .sort((a, b) => a.event.at - b.event.at)
      .slice(-MAX_EVENTS);
    // The event allowlist contains ASCII only, so this also bounds UTF-8 bytes.
    while (recent.length && serialize(recent).length > MAX_JOURNAL_CHARACTERS) recent.shift();
    return recent;
  }

  function refresh(): void {
    let stored: JournalEntry[] = [];
    try {
      const text = storage?.getItem(UPLOAD_DIAGNOSTICS_STORAGE_KEY);
      if (text && text.length <= MAX_JOURNAL_CHARACTERS) {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === 1 &&
          "entries" in parsed && Array.isArray(parsed.entries)) {
          stored = parsed.entries.slice(-MAX_EVENTS).flatMap((entry: unknown) => {
            if (!entry || typeof entry !== "object" || !("event" in entry)) return [];
            const event = sanitizeUploadDiagnosticEvent(entry.event);
            return event ? [{ event, delivered: "delivered" in entry && entry.delivered === true }] : [];
          });
        }
      }
    } catch {
      // Storage denied, full, or malformed: the bounded memory journal survives.
    }
    const merged = new Map<string, JournalEntry>();
    for (const entry of [...stored, ...entries]) {
      const previous = merged.get(entry.event.id);
      merged.set(entry.event.id, {
        event: entry.event,
        delivered: entry.delivered || previous?.delivered === true,
      });
    }
    entries = bound([...merged.values()]);
    const activeScopes = new Set(entries.map(({ event }) => scope(event)));
    for (const key of recordingTokens.keys()) {
      if (!activeScopes.has(key)) recordingTokens.delete(key);
    }
  }

  function persist(): void {
    entries = bound(entries);
    try {
      storage?.setItem(UPLOAD_DIAGNOSTICS_STORAGE_KEY, serialize(entries));
    } catch {
      // Diagnostic writes cannot interfere with recording or audio backup writes.
    }
  }

  function schedule(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, REPORT_DELAY_MS);
  }

  function record(context: UploadDiagnosticContext, details: Details): void {
    try {
      refresh();
      const event = sanitizeUploadDiagnosticEvent({
        version: 1, id: newId(), attemptId: context.attemptId,
        sessionId: context.sessionId, trackId: context.trackId, segmentId: context.segmentId,
        kind: context.kind, partNumber: context.partNumber, at: now(), browser: browserFamily(),
        stage: details.stage, outcome: details.outcome, bytes: details.bytes,
        elapsedMs: details.elapsedMs, httpStatus: details.httpStatus,
        errorCategory: details.errorCategory, trackStatus: details.trackStatus,
      });
      if (!event) return;
      if (context.recordingToken) recordingTokens.set(scope(event), context.recordingToken);
      // Successful frequent chunks would crowd out the useful failure history.
      if (!(event.kind === "chunk" && (event.outcome === "started" || event.outcome === "succeeded"))) {
        entries.push({ event, delivered: false });
        persist();
      }
      if (entries.some(entry => !entry.delivered)) schedule();
    } catch {
      // Includes metadata/ID failures: diagnostics are never an upload dependency.
    }
  }

  async function send(batch: JournalEntry[]): Promise<boolean> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = recordingTokens.get(scope(batch[0].event));
      if (token) headers["X-Cozytrack-Recording-Token"] = token;
      const expired = new Promise<boolean>(resolve => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(false);
        }, REQUEST_TIMEOUT_MS);
      });
      const delivered = Promise.resolve(fetcher("/api/upload/diagnostics", {
        method: "POST", credentials: "same-origin", headers,
        body: JSON.stringify({ events: batch.map(entry => entry.event) }),
        signal: controller.signal,
      })).then(response => response.ok, () => false);
      return await Promise.race([delivered, expired]);
    } catch {
      return false;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async function drain(): Promise<void> {
    // Bounded work per trigger. Failed scopes wait for an online event or later
    // recording action instead of spinning; other scopes can still be delivered.
    const failedScopes = new Set<string>();
    refresh();
    const scopes = [...new Set(entries.filter(entry => !entry.delivered).map(entry => scope(entry.event)))];
    const previousIndex = lastAttemptedScope === undefined ? -1 : scopes.indexOf(lastAttemptedScope);
    const orderedScopes = [...scopes.slice(previousIndex + 1), ...scopes.slice(0, previousIndex + 1)];
    for (let count = 0; count < MAX_BATCHES_PER_FLUSH; count++) {
      refresh();
      const pending = entries.filter(entry => !entry.delivered && !failedScopes.has(scope(entry.event)));
      if (!pending.length) break;
      // Rotate between triggers so old unauthorized scopes cannot starve newer
      // recordings when the per-flush request limit is reached.
      const key = orderedScopes.find(candidate => pending.some(entry => scope(entry.event) === candidate)) ?? scope(pending[0].event);
      lastAttemptedScope = key;
      const batch = pending.filter(entry => scope(entry.event) === key).slice(0, BATCH_SIZE);
      if (await send(batch)) {
        const accepted = new Set(batch.map(entry => entry.event.id));
        refresh();
        entries = entries.map(entry => accepted.has(entry.event.id) ? { ...entry, delivered: true } : entry);
        persist();
      } else {
        failedScopes.add(key);
      }
    }
  }

  function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!inFlight) {
      inFlight = drain().catch(() => {
        // No raw exceptions are recorded, and diagnostics never diagnose itself.
      }).finally(() => { inFlight = undefined; });
    }
    return inFlight;
  }

  function report(sessionId: string): { version: 1; events: UploadDiagnosticEvent[] } {
    refresh();
    return {
      version: 1,
      events: entries.filter(entry => entry.event.sessionId === sessionId)
        .flatMap(entry => {
          const event = sanitizeUploadDiagnosticEvent(entry.event);
          return event ? [event] : [];
        }),
    };
  }

  return { record, flush, report };
}

let browserDiagnostics: ReturnType<typeof createUploadDiagnostics> | undefined;

function getBrowserDiagnostics() {
  if (!browserDiagnostics) {
    browserDiagnostics = createUploadDiagnostics();
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => { void flushUploadDiagnostics(); });
    }
  }
  return browserDiagnostics;
}

export function recordUploadDiagnostic(context: UploadDiagnosticContext, details: Details): void {
  try {
    if (typeof window !== "undefined") getBrowserDiagnostics().record(context, details);
  } catch {
    // Keep upload callers isolated even when browser storage is unavailable.
  }
}

export async function flushUploadDiagnostics(): Promise<void> {
  try {
    if (typeof window !== "undefined") await getBrowserDiagnostics().flush();
  } catch {
    // Best effort only, including browser initialization failures.
  }
}

export async function downloadUploadDiagnostics(sessionId: string): Promise<void> {
  const report = getBrowserDiagnostics().report(sessionId);
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = `cozytrack-upload-diagnostics-${isUploadDiagnosticId(sessionId) ? sessionId : "session"}.json`;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Give the browser a chance to consume the object URL before revoking it.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
