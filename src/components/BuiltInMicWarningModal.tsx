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

  useEffect(() => {
    checkboxRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div role="dialog" aria-modal="true" aria-labelledby="builtin-mic-modal-title" className="max-w-md w-full rounded-xl bg-cozy-900 border border-cozy-700 p-6 shadow-2xl space-y-5">
        <div className="flex items-start gap-3">
          <span className="text-2xl leading-none" aria-hidden="true">
            ⚠️
          </span>
          <div>
            <h2 id="builtin-mic-modal-title" className="text-lg font-semibold text-white">
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
