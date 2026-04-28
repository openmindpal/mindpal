"use client";

import React, { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";

export interface VideoPreviewProps {
  locale: string;
  videoStream: MediaStream | null;
  videoActive: boolean;
  onCapture: () => void;
  onStop: () => void;
}

/**
 * VideoPreview — corner preview window showing live camera feed.
 * Lightweight inline component, no external dependencies.
 */
export default function VideoPreview({ locale, videoStream, videoActive, onCapture, onStop }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (videoStream) {
      video.srcObject = videoStream;
      video.play().catch(() => {});
    } else {
      video.srcObject = null;
    }
  }, [videoStream]);

  if (!videoActive || !videoStream) return null;

  return (
    <div style={{
      position: "relative",
      display: "inline-flex",
      flexDirection: "column",
      gap: 4,
      padding: 6,
      borderRadius: 8,
      background: "#1a1a2e",
      border: "1px solid #333",
      maxWidth: 200,
    }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: 180,
          height: 135,
          borderRadius: 6,
          objectFit: "cover",
          background: "#000",
        }}
      />
      <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
        <button
          type="button"
          onClick={onCapture}
          title={t(locale, "chat.video.capture")}
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 4,
            border: "1px solid #555",
            background: "#2563eb",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          {t(locale, "chat.video.capture")}
        </button>
        <button
          type="button"
          onClick={onStop}
          title={t(locale, "chat.video.stop")}
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 4,
            border: "1px solid #555",
            background: "#dc2626",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          {t(locale, "chat.video.stop")}
        </button>
      </div>
    </div>
  );
}
