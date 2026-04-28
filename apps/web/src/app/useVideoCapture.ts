"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface VideoCaptureState {
  /** Whether the camera is currently active */
  videoActive: boolean;
  /** Live MediaStream reference (for video element srcObject) */
  videoStream: MediaStream | null;
  /** Latest captured frame as base64 data URL */
  lastFrame: string | null;
  /** Whether the browser supports getUserMedia */
  videoSupported: boolean;
  /** Start the camera */
  startVideo: () => void;
  /** Stop the camera and release tracks */
  stopVideo: () => void;
  /** Manually capture the current frame, returns base64 data URL or null */
  captureFrame: () => string | null;
}

/**
 * useVideoCapture — camera capture hook for video chat.
 *
 * Design mirrors useVoiceInput.ts: state management via useState/useRef,
 * cleanup on unmount, graceful degradation when permissions denied.
 */
export default function useVideoCapture(): VideoCaptureState {
  const [videoActive, setVideoActive] = useState(false);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [lastFrame, setLastFrame] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Check browser support — deferred to client mount to avoid SSR hydration mismatch
  const [videoSupported, setVideoSupported] = useState(false);

  useEffect(() => {
    setVideoSupported(
      typeof navigator !== "undefined" &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function",
    );
  }, []);

  // Lazy-create hidden canvas for frame capture
  const getCanvas = useCallback((): HTMLCanvasElement => {
    if (!canvasRef.current) {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      canvas.style.display = "none";
      canvasRef.current = canvas;
    }
    return canvasRef.current;
  }, []);

  // Lazy-create hidden video element for stream playback
  const getVideoEl = useCallback((): HTMLVideoElement => {
    if (!videoElRef.current) {
      const video = document.createElement("video");
      video.setAttribute("autoplay", "");
      video.setAttribute("playsinline", "");
      video.setAttribute("muted", "");
      video.muted = true;
      video.style.display = "none";
      document.body.appendChild(video);
      videoElRef.current = video;
    }
    return videoElRef.current;
  }, []);

  const captureFrame = useCallback((): string | null => {
    const video = videoElRef.current;
    if (!video || !streamRef.current || video.readyState < 2) return null;

    const canvas = getCanvas();
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    setLastFrame(dataUrl);
    return dataUrl;
  }, [getCanvas]);

  const startVideo = useCallback(() => {
    if (!videoSupported) {
      console.warn("[VideoCapture] getUserMedia not supported");
      return;
    }
    if (streamRef.current) return; // already active

    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480 } })
      .then((stream) => {
        streamRef.current = stream;
        setVideoStream(stream);
        setVideoActive(true);

        const video = getVideoEl();
        video.srcObject = stream;
        video.play().catch(() => {});

        console.log("[VideoCapture] Camera started");
      })
      .catch((err) => {
        console.error("[VideoCapture] Camera access denied or failed:", err);
        setVideoActive(false);
        setVideoStream(null);
      });
  }, [videoSupported, getVideoEl]);

  const stopVideo = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoElRef.current) {
      videoElRef.current.srcObject = null;
    }
    setVideoStream(null);
    setVideoActive(false);
    setLastFrame(null);
    console.log("[VideoCapture] Camera stopped");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoElRef.current) {
        videoElRef.current.srcObject = null;
        videoElRef.current.remove();
        videoElRef.current = null;
      }
    };
  }, []);

  return {
    videoActive,
    videoStream,
    lastFrame,
    videoSupported,
    startVideo,
    stopVideo,
    captureFrame,
  };
}
