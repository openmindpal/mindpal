"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { t } from "@/lib/i18n";
import { apiFetch } from "@/lib/api";

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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
  const wsCleanupRef = useRef<(() => void) | null>(null);
  const wsSTTAvailableRef = useRef<boolean | null>(null);
  const transcribeViaServer = useCallback(async (audioBlob: Blob): Promise<string | null> => {
    const WHISPER_TIMEOUT_MS = parseInt(
      process.env.NEXT_PUBLIC_WHISPER_TIMEOUT_MS ?? "15000",
      10,
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

    try {
      const audioBase64 = await blobToBase64(audioBlob);
      const res = await apiFetch("/audio/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          language: locale.startsWith("en") ? "en" : "zh",
          format: "webm",
        }),
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

  // ── WebSocket 流式 STT 可用性检测 ─────────────────────
  useEffect(() => {
    if (wsSTTAvailableRef.current !== null) return;
    apiFetch("/audio/capabilities")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        wsSTTAvailableRef.current = Boolean(data?.stt?.streamingReady);
      })
      .catch(() => { wsSTTAvailableRef.current = false; });
  }, []);

  // ── PCM 转换辅助 ───────────────────────────────
  const float32ToInt16Base64 = useCallback((float32: Float32Array): string => {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // Convert Int16Array to base64
    const bytes = new Uint8Array(int16.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }, []);

  // ── WebSocket 流式 STT 路径 ─────────────────────────
  const startWebSocketSTT = useCallback((): boolean => {
    if (!wsSTTAvailableRef.current) return false;

    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const langParam = locale.startsWith("en") ? "en" : "zh";
    const wsUrl = `${wsProtocol}//${location.host}/v1/audio/stream-stt?language=${langParam}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      console.warn("[voice] WebSocket STT connection failed");
      return false;
    }

    let audioCtx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    let stream: MediaStream | null = null;
    let stopped = false;

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      try { processor?.disconnect(); } catch { /* ignore */ }
      try { source?.disconnect(); } catch { /* ignore */ }
      try { audioCtx?.close(); } catch { /* ignore */ }
      stream?.getTracks().forEach((t) => t.stop());
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "finish" })); } catch { /* ignore */ }
        ws.close();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      wsCleanupRef.current = null;
      setVoiceListening(false);
      setVoiceInterim("");
      if (conversationRef.current && accumulatedTextRef.current.trim()) {
        onAutoSend?.(accumulatedTextRef.current.trim());
        accumulatedTextRef.current = "";
      }
    };

    wsCleanupRef.current = cleanup;

    ws.onopen = () => {
      // 开始采集麦克风音频
      navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true } })
        .then((mediaStream) => {
          if (stopped) { mediaStream.getTracks().forEach((t) => t.stop()); return; }
          stream = mediaStream;
          audioCtx = new AudioContext({ sampleRate: 16000 });
          source = audioCtx.createMediaStreamSource(mediaStream);
          processor = audioCtx.createScriptProcessor(4096, 1, 1);
          source.connect(processor);
          processor.connect(audioCtx.destination);

          processor.onaudioprocess = (e) => {
            if (stopped || ws.readyState !== WebSocket.OPEN) return;
            const pcm = e.inputBuffer.getChannelData(0);
            const base64 = float32ToInt16Base64(pcm);
            try {
              ws.send(JSON.stringify({ type: "audio_chunk", data: base64 }));
            } catch { /* ignore */ }
          };

          setVoiceListening(true);
          setVoiceInterim("");
        })
        .catch((err) => {
          console.error("[voice] getUserMedia failed:", err);
          cleanup();
        });
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "interim") {
          setVoiceInterim(msg.text || "");
          accumulatedTextRef.current = msg.text || "";
        } else if (msg.type === "final") {
          const text = msg.text || "";
          accumulatedTextRef.current = text;
          setVoiceInterim("");
          if (conversationRef.current) {
            setDraft(text);
          } else {
            setDraft((prev) => prev + text);
          }
        } else if (msg.type === "error") {
          console.warn("[voice] WS STT error:", msg.error);
        }
      } catch { /* ignore parse error */ }
    };

    ws.onerror = () => {
      console.warn("[voice] WebSocket STT error, will fallback");
      cleanup();
    };

    ws.onclose = () => {
      if (!stopped) cleanup();
    };

    return true;
  }, [locale, setDraft, onAutoSend, float32ToInt16Base64]);

  const startVoice = useCallback(() => {
    accumulatedTextRef.current = "";

    // 优先级 1: WebSocket 流式 STT（最优体验）
    if (startWebSocketSTT()) return;

    // 优先级 2: Web Speech API
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
    // 清理 WebSocket 流式 STT
    if (wsCleanupRef.current) {
      wsCleanupRef.current();
      wsCleanupRef.current = null;
    }
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
        if (wsCleanupRef.current) { wsCleanupRef.current(); wsCleanupRef.current = null; }
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
