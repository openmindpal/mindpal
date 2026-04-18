"use client";

import { useCallback, useRef, useState } from "react";

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
    try {
      const formData = new FormData();
      formData.append("file", audioBlob, "recording.webm");
      formData.append("language", locale.startsWith("en") ? "en" : "zh");
      const res = await fetch("/api/voice", { method: "POST", body: formData });
      if (!res.ok) return null;
      const data = await res.json();
      return data.transcript || null;
    } catch {
      return null;
    }
  }, [locale]);

  const startVoice = useCallback(() => {
    accumulatedTextRef.current = "";
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (SR) {
      const recognition = new SR() as any;
      recognition.lang = locale.startsWith("en") ? "en-US" : "zh-CN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        console.log("[voice] SpeechRecognition started");
        setVoiceListening(true);
        setVoiceInterim("");
      };
      recognition.onresult = (event: any) => {
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
