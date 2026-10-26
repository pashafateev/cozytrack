"use client";

import { useState } from "react";
import { downloadUploadDiagnostics } from "@/lib/upload-diagnostics";
import { Button } from "@/components/ui/Button";
import { IcoDownload } from "@/components/ui/Icon";

export function UploadDiagnosticsDownload({ sessionId }: { sessionId: string }) {
  const [preparing, setPreparing] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    if (preparing) return;
    setPreparing(true);
    setFailed(false);
    try {
      await downloadUploadDiagnostics(sessionId);
    } catch {
      setFailed(true);
    } finally {
      setPreparing(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={download}
        disabled={preparing}
        title="Download upload history saved in this browser for this session. Contains no audio."
      >
        <IcoDownload size={12} color="currentColor" />
        {preparing ? "Preparing diagnostics…" : "Download diagnostics"}
      </Button>
      {failed && (
        <p role="alert" className="text-[11px] text-warn">
          Diagnostics are unavailable in this browser. Try again.
        </p>
      )}
    </div>
  );
}
