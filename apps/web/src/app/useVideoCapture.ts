"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoStreamServerMessage } from "@openslin/shared";

export interface StreamingOptions {
  frameRate?: number;
  quality?: number;
  onAnalysis?: (analysis: VideoStreamServerMessage["analysis"]) => void;
}

export interface VideoCaptureState {
  /** Whether the camera is currently active */
  videoActive: boolean;
  /** Live MediaStream reference (for video element srcObject) */
  videoStream: MediaStream | null;
  /** Latest captured frame as base64 data URL */
  lastFrame: string | null;
  /** Whether the browser supports getUserMedia */
  videoSupported: boolean;
  /** Whether WebSocket streaming is active */
  streaming: boolean;
  /** Start the camera */
  startVideo: () => void;
  /** Stop the camera and release tracks */
  stopVideo: () => void;
  /** Manually capture the current frame, returns base64 data URL or null */
  captureFrame: () => string | null;
  /** Start WebSocket continuous frame streaming */
  startStreaming: (opts?: StreamingOptions) => void;
  /** Stop WebSocket streaming */
  stopStreaming: () => void;
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
  const [streaming, setStreaming] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const frameLoopRef = useRef<number | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

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

  const stopStreaming = useCallback(() => {
    if (frameLoopRef.current !== null) {
      clearInterval(frameLoopRef.current);
      frameLoopRef.current = null;
    }
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    const ws = wsRef.current;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "finish" })); } catch { /* ignore */ }
        ws.close();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      wsRef.current = null;
    }
    setStreaming(false);
  }, []);

  const startStreaming = useCallback((opts?: StreamingOptions) => {
    // Ensure video is active first
    if (!streamRef.current) {
      // Start video then retry streaming after camera is ready
      if (!videoSupported) {
        console.warn("[VideoCapture] getUserMedia not supported, cannot stream");
        return;
      }
      navigator.mediaDevices
        .getUserMedia({ video: { width: 640, height: 480 } })
        .then((stream) => {
          streamRef.current = stream;
          setVideoStream(stream);
          setVideoActive(true);
          const video = getVideoEl();
          video.srcObject = stream;
          video.play().catch(() => {});
          // Now start the WS stream
          initiateWsStream(opts);
        })
        .catch((err) => {
          console.error("[VideoCapture] Camera access denied:", err);
        });
      return;
    }
    initiateWsStream(opts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSupported]);

  const initiateWsStream = useCallback((opts?: StreamingOptions) => {
    // Close any existing streaming session
    stopStreaming();

    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${location.host}/v1/video/stream`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      console.warn("[VideoCapture] WebSocket connection failed");
      return;
    }
    wsRef.current = ws;
    const abortCtrl = new AbortController();
    streamAbortRef.current = abortCtrl;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "config", config: { frameRate: opts?.frameRate ?? 2, quality: opts?.quality ?? 0.7 } }));
      setStreaming(true);
      const intervalMs = 1000 / (opts?.frameRate ?? 2);
      const loop = window.setInterval(() => {
        if (abortCtrl.signal.aborted) return;
        const frame = captureFrame();
        if (frame && ws.readyState === WebSocket.OPEN) {
          // Send only base64 data without the data URL prefix
          const base64 = frame.includes(",") ? frame.split(",")[1] : frame;
          ws.send(JSON.stringify({ type: "video_frame", data: base64, timestamp: Date.now() }));
        }
      }, intervalMs);
      frameLoopRef.current = loop as unknown as number;
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "analysis" && opts?.onAnalysis) {
          opts.onAnalysis(msg.analysis);
        }
      } catch { /* ignore */ }
    };

    ws.onerror = () => { stopStreaming(); };
    ws.onclose = () => { setStreaming(false); };
  }, [captureFrame, stopStreaming]);

  const stopVideo = useCallback(() => {
    stopStreaming();
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
  }, [stopStreaming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop streaming resources
      if (frameLoopRef.current !== null) {
        clearInterval(frameLoopRef.current);
        frameLoopRef.current = null;
      }
      streamAbortRef.current?.abort();
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      wsRef.current = null;
      // Stop media resources
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
    streaming,
    startVideo,
    stopVideo,
    captureFrame,
    startStreaming,
    stopStreaming,
  };
}
