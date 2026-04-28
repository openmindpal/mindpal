"use client";

import { useCallback, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

export interface VoiceTTSState {
  speaking: boolean;
  ttsReady: boolean;
  speak: (text: string, voice?: string) => Promise<void>;
  stopSpeaking: () => void;
  checkTTSReady: () => Promise<boolean>;
}

export default function useVoiceTTS(): VoiceTTSState {
  const [speaking, setSpeaking] = useState(false);
  const [ttsReady, setTtsReady] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const checkTTSReady = useCallback(async (): Promise<boolean> => {
    try {
      const res = await apiFetch("/audio/capabilities");
      if (!res.ok) {
        setTtsReady(false);
        return false;
      }
      const data = await res.json();
      const ready = data.tts?.ready === true;
      setTtsReady(ready);
      return ready;
    } catch {
      setTtsReady(false);
      return false;
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    try { abortRef.current?.abort(); } catch {}
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setSpeaking(false);
  }, []);

  const speak = useCallback(async (text: string, voice?: string) => {
    const cleaned = text.replace(/```[\s\S]*?```/g, "").replace(/[#*_`~>|[\](){}]/g, "").trim();
    if (!cleaned) return;

    const truncated = cleaned.slice(0, 3000);

    stopSpeaking();

    const ac = new AbortController();
    abortRef.current = ac;
    setSpeaking(true);

    try {
      const res = await apiFetch("/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: truncated, voice: voice ?? undefined }),
        signal: ac.signal,
      });

      if (!res.ok) {
        console.warn("[TTS] API returned", res.status);
        setSpeaking(false);
        return;
      }

      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
        setSpeaking(false);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
        setSpeaking(false);
      };

      await audio.play();
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        console.error("[TTS] speak failed:", err);
      }
      setSpeaking(false);
    }
  }, [stopSpeaking]);

  return { speaking, ttsReady, speak, stopSpeaking, checkTTSReady };
}
