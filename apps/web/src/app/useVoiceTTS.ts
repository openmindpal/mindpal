"use client";

import { useCallback, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

// ── 句子提取工具（与 dialogEnginePlugin.ts L115-124 同构）──────────
function extractSentences(buf: string): { sentences: string[]; remainder: string } {
  const re = /[^。！？!?\n]+[。！？!?\n]+/g;
  const sentences: string[] = [];
  let last = 0;
  for (const m of buf.matchAll(re)) {
    sentences.push(m[0].trim());
    last = (m.index ?? 0) + m[0].length;
  }
  return { sentences, remainder: buf.slice(last) };
}

// ── 原有接口（保持兼容）──────────────────────────────────────────
export interface VoiceTTSState {
  speaking: boolean;
  ttsReady: boolean;
  speak: (text: string, voice?: string) => Promise<void>;
  stopSpeaking: () => void;
  checkTTSReady: () => Promise<boolean>;
  /** 流式 TTS 引擎：SSE onChunk 喂入增量文本 */
  feedChunk: (text: string) => void;
  /** 流式 TTS 引擎：SSE 完成后，将剩余 buffer 推入 TTS */
  flushAndFinish: () => void;
  /** 流式 TTS 引擎：中止所有 TTS 播放（Barge-in） */
  abortStreaming: () => void;
  /** 当前是否在流式 TTS 播放中 */
  isSpeaking: boolean;
}

export default function useVoiceTTS(): VoiceTTSState {
  const [speaking, setSpeaking] = useState(false);
  const [ttsReady, setTtsReady] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── 流式 TTS 引擎状态 ──
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sentenceQueueRef = useRef<string[]>([]);
  const sentenceBufferRef = useRef("");
  const streamAbortRef = useRef<AbortController | null>(null);
  const isConsumingRef = useRef(false);
  const streamDoneRef = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

  /** 懒创建 AudioContext（需在用户交互后首次调用） */
  const getAudioContext = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext();
    }
    // 如果被挂起（浏览器安全策略），尝试恢复
    if (audioCtxRef.current.state === "suspended") {
      void audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  // ── 原有功能：TTS 就绪检查 ──
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

  // ── 原有功能：停止播放（单次 speak 模式）──
  const stopSpeaking = useCallback(() => {
    try { abortRef.current?.abort(); } catch { /* expected */ }
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setSpeaking(false);
  }, []);

  // ── 原有功能：一次性 speak（保持向后兼容）──
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

  // ── 流式 TTS 消费循环 ──
  const consumeQueue = useCallback(async () => {
    if (isConsumingRef.current) return;
    isConsumingRef.current = true;
    setSpeaking(true);

    const ctx = getAudioContext();

    while (!streamAbortRef.current?.signal.aborted) {
      const sentence = sentenceQueueRef.current.shift();
      if (!sentence) {
        // 队列为空：如果流已结束则退出，否则等一下
        if (streamDoneRef.current) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        if (sentenceQueueRef.current.length === 0 && streamDoneRef.current) break;
        continue;
      }

      const cleaned = sentence.replace(/```[\s\S]*?```/g, "").replace(/[#*_`~>|[\](){}]/g, "").trim();
      if (!cleaned) continue;

      try {
        const res = await apiFetch("/audio/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: cleaned }),
          signal: streamAbortRef.current?.signal,
        });
        if (!res.ok) {
          console.warn("[StreamTTS] API returned", res.status);
          continue;
        }
        if (streamAbortRef.current?.signal.aborted) break;

        const arrayBuf = await res.arrayBuffer();
        if (streamAbortRef.current?.signal.aborted) break;

        const audioBuf = await ctx.decodeAudioData(arrayBuf);
        if (streamAbortRef.current?.signal.aborted) break;

        // 播放并等待结束
        await new Promise<void>((resolve, reject) => {
          const source = ctx.createBufferSource();
          source.buffer = audioBuf;
          source.connect(ctx.destination);
          currentSourceRef.current = source;
          source.onended = () => {
            currentSourceRef.current = null;
            resolve();
          };
          // 如果被 abort 则停止
          const onAbort = () => {
            try { source.stop(); } catch { /* may already be stopped */ }
            currentSourceRef.current = null;
            reject(new DOMException("Aborted", "AbortError"));
          };
          streamAbortRef.current?.signal.addEventListener("abort", onAbort, { once: true });
          source.start();
        });
      } catch (err: any) {
        if (err?.name === "AbortError") break;
        console.error("[StreamTTS] sentence playback failed:", err);
      }
    }

    isConsumingRef.current = false;
    currentSourceRef.current = null;
    setSpeaking(false);
  }, [getAudioContext]);

  // ── feedChunk：SSE onChunk 喂入增量文本 ──
  const feedChunk = useCallback((text: string) => {
    if (!text) return;
    // 首次调用时初始化 abort controller
    if (!streamAbortRef.current || streamAbortRef.current.signal.aborted) {
      streamAbortRef.current = new AbortController();
      streamDoneRef.current = false;
      sentenceQueueRef.current = [];
      sentenceBufferRef.current = "";
    }

    sentenceBufferRef.current += text;
    const { sentences, remainder } = extractSentences(sentenceBufferRef.current);
    sentenceBufferRef.current = remainder;

    if (sentences.length > 0) {
      sentenceQueueRef.current.push(...sentences);
      // 启动消费循环（如果尚未运行）
      if (!isConsumingRef.current) {
        void consumeQueue();
      }
    }
  }, [consumeQueue]);

  // ── flushAndFinish：SSE 完成后，将剩余 buffer 推入 TTS ──
  const flushAndFinish = useCallback(() => {
    const remaining = sentenceBufferRef.current.trim();
    if (remaining) {
      sentenceQueueRef.current.push(remaining);
      sentenceBufferRef.current = "";
    }
    streamDoneRef.current = true;
    // 确保消费循环运行中
    if (!isConsumingRef.current && sentenceQueueRef.current.length > 0) {
      void consumeQueue();
    }
  }, [consumeQueue]);

  // ── abortStreaming：中止所有流式 TTS（Barge-in）──
  const abortStreaming = useCallback(() => {
    // 停止流式 TTS
    try { streamAbortRef.current?.abort(); } catch { /* expected */ }
    streamAbortRef.current = null;
    sentenceQueueRef.current = [];
    sentenceBufferRef.current = "";
    streamDoneRef.current = true;
    // 停止当前 AudioBufferSourceNode
    try { currentSourceRef.current?.stop(); } catch { /* may already be stopped */ }
    currentSourceRef.current = null;
    // 同时停止原有 speak 模式
    stopSpeaking();
  }, [stopSpeaking]);

  return {
    speaking,
    ttsReady,
    speak,
    stopSpeaking,
    checkTTSReady,
    feedChunk,
    flushAndFinish,
    abortStreaming,
    isSpeaking: speaking,
  };
}
