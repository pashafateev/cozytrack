"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { IcoDownload } from "@/components/ui/Icon";
import { downloadTracksZip } from "@/lib/download-tracks";

interface Track {
  id: string;
  participantName: string;
  format: string;
  status: string;
  s3Key: string;
  s3PurgedAt: string | null;
}

export function DownloadAllTracks({
  sessionId,
  sessionName,
  tracks,
}: {
  sessionId: string;
  sessionName: string;
  tracks: Track[];
}) {
  const [preparing, setPreparing] = useState(false);
  const [failed, setFailed] = useState(false);
  const activeDownload = useRef<AbortController | null>(null);
  const availableTracks = tracks.filter(
    (track) => track.status === "complete" && track.s3Key && !track.s3PurgedAt,
  );

  useEffect(() => {
    return () => activeDownload.current?.abort();
  }, []);

  async function download() {
    if (activeDownload.current || availableTracks.length === 0) return;
    const controller = new AbortController();
    activeDownload.current = controller;
    setPreparing(true);
    setFailed(false);
    try {
      await downloadTracksZip({
        sessionId,
        sessionName,
        tracks: availableTracks.map(({ id, participantName, format }) => ({
          id,
          participantName,
          format,
        })),
      }, { signal: controller.signal });
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      activeDownload.current = null;
      if (!controller.signal.aborted) setPreparing(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 max-w-[320px]">
      <Button
        type="button"
        variant="primary"
        size="md"
        onClick={download}
        disabled={preparing || availableTracks.length === 0}
        title="Download completed, available tracks together as a ZIP"
        aria-busy={preparing}
      >
        <IcoDownload size={13} color="currentColor" />
        {preparing ? "Preparing ZIP…" : "Download All Tracks"}
      </Button>
      {preparing && (
        <p role="status" className="text-[11px] text-text-3">
          Preparing tracks in this browser. Keep this page open until the download starts.
        </p>
      )}
      {availableTracks.length === 0 ? (
        <p className="text-[11px] text-text-3">
          No completed tracks are available to download.
        </p>
      ) : availableTracks.length < tracks.length ? (
        <p className="text-[11px] text-text-3">
          ZIP includes {availableTracks.length} of {tracks.length} tracks. Unfinished or unavailable tracks are excluded.
        </p>
      ) : null}
      {failed && (
        <p role="alert" className="text-[11px] text-warn">
          Could not download all tracks. Check your connection and try again.
          If tracks have changed, refresh this page.
        </p>
      )}
    </div>
  );
}
