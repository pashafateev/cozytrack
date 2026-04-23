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
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="builtin-mic-warning-title" className="max-w-md w-full rounded-xl bg-cozy-900 border border-cozy-700 p-6 shadow-2xl space-y-5">
        <div className="flex items-start gap-3">
          <span className="text-2xl leading-none" aria-hidden="true">
            ⚠️
          </span>
          <div>
            <h2 id="builtin-mic-warning-title" className="text-lg font-semibold text-white">
              You&apos;re using your built-in microphone
            </h2>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed">
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
            className="w-4 h-4 rounded border-cozy-600 bg-cozy-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
          />
          <span className="text-sm text-gray-300">
            I understand — continue with built-in mic
          </span>
        </label>

        <div className="flex gap-3">
          <button
            onClick={onSwitchMic}
            className="flex-1 px-4 py-2.5 rounded-lg bg-cozy-700 hover:bg-cozy-600 text-white text-sm font-medium transition-colors"
          >
            Switch Microphone
          </button>
          <button
            onClick={onAcknowledge}
            disabled={!checked}
            className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
