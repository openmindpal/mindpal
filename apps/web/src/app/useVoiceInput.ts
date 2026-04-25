"use client";

import { useCallback, useRef, useState } from "react";
import { t } from "@/lib/i18n";

/* Web Speech API type shims — avoids (window as any) */
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } };
}
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

export interface VoiceInputState {
  voiceListening: boolean;
  voiceInterim: string;
  voiceConversation: boolean;
  startVoice: () => void;
  stopVoice: () => void;
  toggleConversation: () => void;
}

export default function useVoiceInput(opts: {
  locale: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  onAutoSend?: (text: string) => void;
}): VoiceInputState {
  const { locale, setDraft, onAutoSend } = opts;

  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState("");
  const [voiceConversation, setVoiceConversation] = useState(false);
  const recognitionRef = useRef<any>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const conversationRef = useRef(false);
  const accumulatedTextRef = useRef("");

  const transcribeViaServer = useCallback(async (audioBlob: Blob): Promise<string | null> => {
    const WHISPER_TIMEOUT_MS = parseInt(
      process.env.NEXT_PUBLIC_WHISPER_TIMEOUT_MS ?? "15000",
      10,
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

    try {
      const formData = new FormData();
      formData.append("file", audioBlob, "recording.webm");
      formData.append("language", locale.startsWith("en") ? "en" : "zh");
      const res = await fetch("/api/voice", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn("[VoiceInput] Whisper API error:", res.status);
        return null;
      }
      const data = await res.json();
      return data.transcript || null;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.warn(
          "[VoiceInput] Whisper request timed out after",
          WHISPER_TIMEOUT_MS,
          "ms — falling back",
        );
      } else {
        console.warn("[VoiceInput] Whisper request failed:", err);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }, [locale]);

  const startVoice = useCallback(() => {
    accumulatedTextRef.current = "";
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SR) {
      const recognition = new SR();
      recognition.lang = locale.startsWith("en") ? "en-US" : "zh-CN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        console.log("[voice] SpeechRecognition started");
        setVoiceListening(true);
        setVoiceInterim("");
      };
      recognition.onresult = (event) => {
        let interim = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalText += transcript;
          } else {
            interim += transcript;
          }
        }
        setVoiceInterim(interim);
        if (finalText) {
          accumulatedTextRef.current += finalText;
          if (conversationRef.current) {
            setDraft(accumulatedTextRef.current);
          } else {
            setDraft((prev) => prev + finalText);
          }
          setVoiceInterim("");
        }
      };
      recognition.onerror = (event: any) => {
        console.error("[voice] SpeechRecognition error:", event.error, event.message);
        setVoiceListening(false);
        setVoiceInterim("");
      };
      recognition.onend = () => {
        console.log("[voice] SpeechRecognition ended");
        setVoiceListening(false);
        setVoiceInterim("");
        if (conversationRef.current && accumulatedTextRef.current.trim()) {
          onAutoSend?.(accumulatedTextRef.current.trim());
          accumulatedTextRef.current = "";
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } else {
      console.log("[voice] SpeechRecognition not available, falling back to MediaRecorder + server STT");
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
        chunksRef.current = [];

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };

        recorder.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          chunksRef.current = [];
          setVoiceListening(false);
          setVoiceInterim("");

          if (blob.size < 1000) return;

          setVoiceInterim("Transcribing...");
          const transcript = await transcribeViaServer(blob);
          setVoiceInterim("");

          if (transcript) {
            if (conversationRef.current) {
              onAutoSend?.(transcript);
            } else {
              setDraft((prev) => prev + transcript);
            }
          } else {
            /* Whisper timed-out or failed — attempt browser SpeechRecognition fallback */
            const SRFallback =
              typeof window !== "undefined"
                ? window.SpeechRecognition || window.webkitSpeechRecognition
                : undefined;
            if (SRFallback) {
              console.info(
                "[VoiceInput] Falling back to browser SpeechRecognition",
              );
              setVoiceInterim(t(locale, "voice.fallbackNotice"));
              const fallback = new SRFallback();
              fallback.lang = locale.startsWith("en") ? "en-US" : "zh-CN";
              fallback.continuous = false;
              fallback.interimResults = false;
              fallback.maxAlternatives = 1;

              fallback.onresult = (evt: any) => {
                const text: string =
                  evt.results?.[0]?.[0]?.transcript ?? "";
                if (text) {
                  if (conversationRef.current) {
                    onAutoSend?.(text);
                  } else {
                    setDraft((prev) => prev + text);
                  }
                }
              };
              fallback.onerror = () => {
                console.warn("[VoiceInput] Browser fallback recognition failed");
              };
              fallback.onend = () => {
                setVoiceInterim("");
              };
              fallback.start();
            } else {
              console.warn(
                "[VoiceInput] Whisper failed and browser SpeechRecognition unavailable",
              );
            }
          }
        };

        recorderRef.current = recorder;
        recorder.start();
        setVoiceListening(true);
        setVoiceInterim("");
      }).catch((err) => {
        console.error("[voice] MediaRecorder error:", err);
      });
    }
  }, [locale, setDraft, onAutoSend, transcribeViaServer]);

  const stopVoice = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    setVoiceListening(false);
    setVoiceInterim("");
  }, []);

  const toggleConversation = useCallback(() => {
    setVoiceConversation((prev) => {
      const next = !prev;
      conversationRef.current = next;
      if (!next) {
        if (recognitionRef.current) { recognitionRef.current.stop(); recognitionRef.current = null; }
        if (recorderRef.current && recorderRef.current.state !== "inactive") { recorderRef.current.stop(); recorderRef.current = null; }
        setVoiceListening(false);
        setVoiceInterim("");
      }
      return next;
    });
  }, []);

  return {
    voiceListening,
    voiceInterim,
    voiceConversation,
    startVoice,
    stopVoice,
    toggleConversation,
  };
}
