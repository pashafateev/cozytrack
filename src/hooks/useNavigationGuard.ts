"use client";

import { useEffect, useRef } from "react";

export interface NavigationGuardOptions {
  /**
   * When true, the guard is armed and will intercept navigation attempts.
   * When false, the hook is a no-op (no listeners, no history mutation).
   */
  when: boolean;
  /**
   * Message shown in the in-app confirm dialog for back/forward and link
   * clicks. The browser owns the wording for `beforeunload`.
   */
  message: string;
}

interface AnchorClickInfo {
  /** Resolved href on the clicked anchor, if any. */
  href: string | null;
  /** Anchor target attribute, if any. */
  target: string | null;
  /** True if the anchor has a `download` attribute. */
  hasDownload: boolean;
  /** True if any modifier key (meta/ctrl/shift/alt) was pressed. */
  modifierPressed: boolean;
  /** Mouse button (0 = left). Non-zero buttons are ignored. */
  button: number;
}

// Marker we tag onto our pushState entry so we can recognize it on cleanup
// and pop it without disturbing application state pushed by other code.
const SENTINEL_KEY = "__cozytrackNavGuard__";
type SentinelState = { [SENTINEL_KEY]: true; inner: unknown };

function isSentinelState(state: unknown): state is SentinelState {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { [SENTINEL_KEY]?: unknown })[SENTINEL_KEY] === true
  );
}

/**
 * Pure decision: given a clicked anchor's properties and the current
 * location, should we intercept (warn) before letting the browser navigate?
 *
 * Returns false for:
 * - missing/empty href
 * - non-http(s) schemes (mailto:, tel:, javascript:, blob:, etc.)
 * - download links
 * - target=_blank / new windows / non-_self targets
 * - modified clicks (cmd/ctrl/shift/alt) and middle-click — those don't leave
 *   the current document
 * - cross-origin links (we only care about leaving the studio in-app)
 * - same-pathname links (in-page anchors and re-clicks, including bare
 *   `#hash` and `?query` hrefs that resolve onto the current pathname)
 */
export function shouldInterceptAnchorClick(
  info: AnchorClickInfo,
  currentUrl: string,
): boolean {
  if (info.button !== 0) return false;
  if (info.modifierPressed) return false;
  if (info.hasDownload) return false;
  if (info.target && info.target !== "" && info.target !== "_self") return false;

  const href = info.href;
  if (!href) return false;

  let current: URL;
  let url: URL;
  try {
    current = new URL(currentUrl);
    // Resolve relative hrefs against the full current URL so bare `#hash`
    // and `?query` hrefs land on the current pathname instead of root.
    url = new URL(href, currentUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin !== current.origin) return false;
  if (url.pathname === current.pathname) return false;

  return true;
}

/**
 * Block accidental navigation away from the current page while a critical
 * operation (active recording, finalize, in-flight upload) is running.
 *
 * Coverage:
 * - tab close / refresh / hard navigation → native `beforeunload` prompt
 * - in-app `<a>` clicks (incl. next/link) → in-app confirm dialog
 * - form submits (e.g. sign-out POST) → in-app confirm dialog
 * - browser back/forward → in-app confirm dialog (popstate + history sentinel)
 *
 * The hook is fully passive when `when` is false: no listeners, no history
 * mutation. This keeps idle navigation frictionless (acceptance criterion
 * from #73).
 */
export function useNavigationGuard({ when, message }: NavigationGuardOptions): void {
  // Keep the latest message in a ref so listeners read fresh copy without
  // resubscribing when callers reformat the prompt mid-session.
  const messageRef = useRef(message);
  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  useEffect(() => {
    if (!when) return;
    if (typeof window === "undefined") return;

    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };

    const onClickCapture = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const anchor = target.closest("a");
      if (!anchor) return;

      const intercept = shouldInterceptAnchorClick(
        {
          href: anchor.getAttribute("href"),
          target: anchor.getAttribute("target"),
          hasDownload: anchor.hasAttribute("download"),
          modifierPressed: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
          button: e.button,
        },
        window.location.href,
      );
      if (!intercept) return;

      if (!window.confirm(messageRef.current)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };

    const onSubmitCapture = (e: SubmitEvent) => {
      // Block any form submit that would leave the current document. The
      // sign-out form in the topbar is the concrete case this covers; any
      // other in-page form submit (e.g. an inline edit POST) would also
      // navigate away on success, which we want to confirm.
      if (!window.confirm(messageRef.current)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };

    const pushSentinel = () => {
      const inner = isSentinelState(window.history.state)
        ? window.history.state.inner
        : window.history.state;
      const sentinel: SentinelState = { [SENTINEL_KEY]: true, inner };
      window.history.pushState(sentinel, "", window.location.href);
    };

    // Sentinel history entry so we can catch the first browser-back press.
    // popstate fires after the browser has already moved the pointer back,
    // so pre-pushing gives us something to consume without actually leaving.
    pushSentinel();

    // When we accept a back navigation we call history.back() ourselves,
    // which triggers a second popstate while the listener is still attached.
    // This flag swallows that one so we don't re-prompt on the way out.
    let skipNextPop = false;

    const onPopState = () => {
      if (skipNextPop) {
        skipNextPop = false;
        return;
      }
      if (window.confirm(messageRef.current)) {
        // User accepted: we already popped the sentinel, so step back once
        // more to actually leave. Mark the resulting popstate as ours.
        skipNextPop = true;
        window.history.back();
      } else {
        // User cancelled: re-push the sentinel so the next back press will
        // trip popstate again instead of silently leaving.
        pushSentinel();
      }
    };

    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("submit", onSubmitCapture, true);
    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("submit", onSubmitCapture, true);
      window.removeEventListener("popstate", onPopState);
      // If our sentinel is still on top of the history stack, pop it so
      // back-navigation behaves normally after the guard disarms (no extra
      // back press needed). Listener is already removed, so the resulting
      // popstate is a no-op.
      if (isSentinelState(window.history.state)) {
        window.history.back();
      }
    };
  }, [when]);
}
