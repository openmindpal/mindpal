'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { apiFetch } from '@/shared/lib/api';

type VoiceState = 'idle' | 'requesting' | 'recording' | 'processing' | 'done' | 'error';

export function useVoiceInput() {
  const [state, setState] = useState<VoiceState>('idle');
  const [duration, setDuration] = useState(0);
  const [transcribedText, setTranscribedText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const transcribe = useCallback(async (blob: Blob) => {
    try {
      const base64 = await blobToBase64(blob);
      const res = await apiFetch('/device-agent/dialog/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: base64, format: 'webm' }),
      });

      if (!res.ok) {
        throw new Error(`Transcription failed: ${res.status}`);
      }

      const data = await res.json();
      setTranscribedText(data.text || '');
      setState('done');
    } catch (err: unknown) {
      setState('error');
      setError(err instanceof Error ? err.message : '语音识别失败');
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setState('requesting');
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorder.current = recorder;
      chunks.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(timerRef.current);

        const blob = new Blob(chunks.current, { type: mimeType });
        setState('processing');
        transcribe(blob);
      };

      recorder.start(100);
      setState('recording');
      setDuration(0);
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    } catch (err: unknown) {
      setState('error');
      setError(err instanceof Error ? err.message : '麦克风权限被拒绝');
    }
  }, [transcribe]);

  const stopRecording = useCallback(() => {
    if (mediaRecorder.current?.state === 'recording') {
      mediaRecorder.current.stop();
    }
  }, []);

  const reset = useCallback(() => {
    setState('idle');
    setDuration(0);
    setTranscribedText('');
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      if (mediaRecorder.current?.state === 'recording') {
        mediaRecorder.current.stop();
      }
    };
  }, []);

  return {
    state,
    duration,
    transcribedText,
    error,
    startRecording,
    stopRecording,
    reset,
    isRecording: state === 'recording',
    isProcessing: state === 'processing',
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
