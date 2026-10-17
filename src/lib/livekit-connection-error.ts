export type LiveKitConnectionErrorKind = "minutes-limit" | "connection-failed";

function isMinutesLimit(message: string): boolean {
  return /connection minutes limit exceeded/i.test(message);
}

export async function resolveLiveKitConnectionError(
  error: Error,
  { serverUrl, token, signal }: {
    serverUrl: string;
    token: string;
    signal: AbortSignal;
  },
): Promise<LiveKitConnectionErrorKind> {
  if (isMinutesLimit(error.message)) return "minutes-limit";
  if (error.name !== "ConnectionError" || !token || signal.aborted) {
    return "connection-failed";
  }

  // livekit-client 2.18.1 discards HTTP 429 validation bodies and exposes a
  // generic WebSocket error. One bounded validation-only request recovers the
  // reason without joining a room or starting another connection attempt.
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 5000);
  try {
    const url = new URL(serverUrl);
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "connection-failed";
    }
    // The v0 validation endpoint accepts the existing token without the
    // encoded join_request required by /rtc/v1/validate. Preserve base paths.
    url.pathname = `${url.pathname.replace(/\/$/, "")}/rtc/validate`;
    url.searchParams.set("access_token", token);
    url.hash = "";
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    });
    if (response.status === 429 && isMinutesLimit(await response.text())) {
      return "minutes-limit";
    }
  } catch {
    // A blocked, timed-out, or unavailable diagnostic must leave the general
    // error usable. Never log the token-bearing URL or arbitrary response body.
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
  return "connection-failed";
}
