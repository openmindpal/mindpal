'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { API_BASE } from '@/shared/lib/api';

type VideoState = 'idle' | 'connecting' | 'streaming' | 'error';

export function useVideoStream() {
  const [state, setState] = useState<VideoState>('idle');
  const [latestAnalysis, setLatestAnalysis] = useState('');
  const [fps, setFps] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const captureAndSend = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !wsRef.current) return;
    if (wsRef.current.readyState !== WebSocket.OPEN) return;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    const base64 = dataUrl.split(',')[1];

    wsRef.current.send(JSON.stringify({ frame: base64, timestamp: Date.now() }));
  }, []);

  const startStream = useCallback(async () => {
    try {
      setState('connecting');
      setError(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // Derive WebSocket URL from API_BASE
      const wsBase = API_BASE.replace(/^http/, 'ws').replace(/\/v1$/, '');
      const wsUrl = `${wsBase}/v1/video/stream`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setState('streaming');
        intervalRef.current = setInterval(() => captureAndSend(), 1000 / fps);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.analysis) setLatestAnalysis(data.analysis);
        } catch { /* ignore non-JSON */ }
      };

      ws.onerror = () => {
        setState('error');
        setError('WebSocket 连接失败');
      };

      ws.onclose = () => {
        setState(prev => prev === 'streaming' ? 'idle' : prev);
      };
    } catch (err: unknown) {
      setState('error');
      setError(err instanceof Error ? err.message : '摄像头权限被拒绝');
    }
  }, [fps, captureAndSend]);

  const stopStream = useCallback(() => {
    clearInterval(intervalRef.current);
    wsRef.current?.close();
    wsRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState('idle');
    setLatestAnalysis('');
  }, []);

  useEffect(() => {
    return () => {
      clearInterval(intervalRef.current);
      wsRef.current?.close();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return {
    state,
    latestAnalysis,
    error,
    fps,
    setFps,
    videoRef,
    canvasRef,
    startStream,
    stopStream,
    isStreaming: state === 'streaming',
  };
}
