"use client";

import { useState, useRef, useEffect } from "react";

interface BuiltInMicWarningModalProps {
  onAcknowledge: () => void;
  onSwitchMic: () => void;
}

export function BuiltInMicWarningModal({
  onAcknowledge,
  onSwitchMic,
}: BuiltInMicWarningModalProps) {
  const [checked, setChecked] = useState(false);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    checkboxRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const container = dialogRef.current;
      if (!container) return;

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>("button, input"),
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
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="builtin-mic-warning-title"
        className="max-w-md w-full rounded-xl border p-6 shadow-2xl space-y-5"
        style={{ background: "var(--card)", borderColor: "var(--border-hi)" }}
      >
        <div className="flex items-start gap-3">
          <span className="text-2xl leading-none" aria-hidden="true">
            ⚠️
          </span>
          <div>
            <h2 id="builtin-mic-warning-title" className="text-lg font-semibold text-text">
              You&apos;re using your built-in microphone
            </h2>
            <p className="text-sm text-text-2 mt-2 leading-relaxed">
              Built-in laptop mics produce significantly lower audio quality.
              Connect an external mic for best results.
            </p>
          </div>
        </div>

        <label className="flex items-center gap-3 cursor-pointer select-none">
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="w-4 h-4 rounded accent-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--amber)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--card)]"
          />
          <span className="text-sm text-text-2">
            I understand — continue with built-in mic
          </span>
        </label>

        <div className="flex gap-3">
          <button
            onClick={onSwitchMic}
            className="flex-1 px-4 py-2.5 rounded-md text-sm font-medium border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--amber)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--card)]"
            style={{ background: "var(--card-hi)", borderColor: "var(--border-hi)", color: "var(--text)" }}
          >
            Switch Microphone
          </button>
          <button
            onClick={onAcknowledge}
            disabled={!checked}
            className="flex-1 px-4 py-2.5 rounded-md text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--amber)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--card)]"
            style={{ background: checked ? "var(--amber)" : "var(--card-hi)", borderColor: checked ? "var(--amber)" : "var(--border-hi)", color: checked ? "var(--bg)" : "var(--text-3)" }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
