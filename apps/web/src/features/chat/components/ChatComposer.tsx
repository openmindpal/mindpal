"use client";

import * as React from "react";
import { Send, Sparkles, MessageCircle, Zap, Users, ChevronDown, Paperclip, Mic, Video, X } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Spinner } from "@/shared/components/primitives/Spinner";
import { apiFetch } from "@/shared/lib/api";

type ChatMode = "auto" | "answer" | "execute" | "collab";

const MODE_OPTIONS: { value: ChatMode; label: string; icon: React.ElementType }[] = [
  { value: "auto", label: "\u81ea\u52a8", icon: Sparkles },
  { value: "answer", label: "\u56de\u7b54", icon: MessageCircle },
  { value: "execute", label: "\u6267\u884c", icon: Zap },
  { value: "collab", label: "\u534f\u4f5c", icon: Users },
];

interface ModelEntry {
  modelRef: string;
  label?: string;
}

interface ChatComposerProps {
  onSend: (text: string, options?: { files?: File[]; model?: string }) => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Mode selector */
  mode?: ChatMode;
  onModeChange?: (mode: ChatMode) => void;
}

function ChatComposer({
  onSend,
  isLoading = false,
  disabled = false,
  placeholder = "\u8f93\u5165\u6d88\u606f...",
  className,
  mode = "auto",
  onModeChange,
}: ChatComposerProps) {
  const [text, setText] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // ─── File Upload State ───
  const [files, setFiles] = React.useState<File[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // ─── Real-time Voice Streaming State ───
  const [isVoiceActive, setIsVoiceActive] = React.useState(false);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const audioStreamRef = React.useRef<MediaStream | null>(null);

  // ─── Model Selector State ───
  const [models, setModels] = React.useState<ModelEntry[]>([]);
  const [selectedModel, setSelectedModel] = React.useState("");
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const modelMenuRef = React.useRef<HTMLDivElement>(null);

  // ─── Real-time Video Stream State ───
  const [videoStream, setVideoStream] = React.useState<MediaStream | null>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const frameIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Mode Menu State ───
  const [modeMenuOpen, setModeMenuOpen] = React.useState(false);
  const modeMenuRef = React.useRef<HTMLDivElement>(null);

  // ─── Fetch Model Bindings (no fallback, no hardcoded models) ───
  React.useEffect(() => {
    let cancelled = false;
    apiFetch("/models/bindings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const raw = Array.isArray(data)
          ? data
          : Array.isArray(data.bindings)
            ? data.bindings
            : Array.isArray(data.models)
              ? data.models
              : [];
        const list: ModelEntry[] = raw.map((m: any) => ({
          modelRef: m.modelRef ?? m.model_ref ?? m.id ?? `${m.provider}:${m.model}`,
          label: m.displayName ?? m.display_name ?? m.label ?? m.name ?? m.modelRef ?? m.model_ref ?? m.id ?? "Unknown",
        }));
        setModels(list);
        if (list.length > 0 && !selectedModel) {
          setSelectedModel(list[0].modelRef);
        }
      })
      .catch(() => {
        // No fallback — 0 bindings renders "\u9ed8\u8ba4\u6a21\u578b" label
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Textarea Auto-resize ───
  const adjustHeight = React.useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  React.useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  // ─── Close menus on outside click ───
  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    if (modeMenuOpen || modelMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [modeMenuOpen, modelMenuOpen]);

  // ─── Cleanup streams on unmount ───
  React.useEffect(() => {
    return () => {
      if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
      audioStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  // ─── Drag & Drop Handlers ───
  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      setFiles((prev) => [...prev, ...droppedFiles]);
    }
  }, []);

  const handleFileInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (selected && selected.length > 0) {
      setFiles((prev) => [...prev, ...Array.from(selected)]);
    }
    e.target.value = "";
  }, []);

  const removeFile = React.useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ─── Send Audio Chunk to Backend (real-time streaming) ───
  const sendAudioChunk = React.useCallback(async (chunk: Blob) => {
    const formData = new FormData();
    formData.append("audio", chunk, "chunk.webm");
    formData.append("type", "input_audio");
    if (selectedModel) formData.append("model", selectedModel);
    try {
      await apiFetch("/models/chat/stream", { method: "POST", body: formData });
    } catch {
      // streaming send error — ignore
    }
  }, [selectedModel]);

  // ─── Send Video Frame to Backend (real-time streaming) ───
  const sendVideoFrame = React.useCallback(async (dataUrl: string) => {
    try {
      await apiFetch("/models/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "image_url",
          image_url: dataUrl,
          model: selectedModel || undefined,
        }),
      });
    } catch {
      // streaming send error — ignore
    }
  }, [selectedModel]);

  // ─── Capture and Send Current Video Frame ───
  const captureAndSendFrame = React.useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    sendVideoFrame(dataUrl);
  }, [sendVideoFrame]);

  // ─── Toggle Real-time Voice Stream ───
  const toggleVoiceStream = React.useCallback(async () => {
    if (isVoiceActive) {
      // Stop streaming
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      audioStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
      mediaRecorderRef.current = null;
      setIsVoiceActive(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) sendAudioChunk(e.data);
      };
      recorder.start(2000); // emit a chunk every 2 seconds
      setIsVoiceActive(true);
    } catch {
      // Microphone not available or permission denied
    }
  }, [isVoiceActive, sendAudioChunk]);

  // ─── Toggle Real-time Video Stream ───
  const toggleVideoStream = React.useCallback(async () => {
    if (videoStream) {
      // Stop streaming
      videoStream.getTracks().forEach((t) => t.stop());
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
      setVideoStream(null);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        setVideoStream(stream);
        requestAnimationFrame(() => {
          if (videoRef.current) videoRef.current.srcObject = stream;
        });
        // Start periodic frame capture & send every 3 seconds
        frameIntervalRef.current = setInterval(() => {
          captureAndSendFrame();
        }, 3000);
      } catch {
        // Camera not available or permission denied
      }
    }
  }, [videoStream, captureAndSendFrame]);

  // ─── Send Text Message ───
  const handleSend = React.useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || isLoading || disabled) return;

    onSend(trimmed, {
      files: files.length > 0 ? files : undefined,
      model: selectedModel || undefined,
    });
    setText("");
    setFiles([]);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
  }, [text, files, isLoading, disabled, onSend, selectedModel]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const canSend = (text.trim().length > 0 || files.length > 0) && !isLoading && !disabled;
  const activeMode = MODE_OPTIONS.find((m) => m.value === mode) || MODE_OPTIONS[0];

  // ─── File size formatter ───
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  // ─── Model selector: 3-tier rendering ───
  const renderModelSelector = () => {
    // 0 bindings → static "\u9ed8\u8ba4\u6a21\u578b" label
    if (models.length === 0) {
      return (
        <span className="inline-flex items-center h-6 px-2.5 rounded-full text-xs font-medium bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]">
          {"\u9ed8\u8ba4\u6a21\u578b"}
        </span>
      );
    }
    // 1 binding → read-only label
    if (models.length === 1) {
      return (
        <span className="inline-flex items-center h-6 px-2.5 rounded-full text-xs font-medium bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)]">
          {models[0].label}
        </span>
      );
    }
    // ≥2 bindings → interactive dropdown
    return (
      <div className="relative" ref={modelMenuRef}>
        <button
          type="button"
          onClick={() => setModelMenuOpen(!modelMenuOpen)}
          className={cn(
            "inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-xs font-medium transition-colors duration-150 select-none",
            "bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)]/30"
          )}
        >
          <span className="max-w-[120px] truncate">
            {models.find((m) => m.modelRef === selectedModel)?.label || models[0].label}
          </span>
          <ChevronDown className={cn("h-2.5 w-2.5 transition-transform duration-150", modelMenuOpen && "rotate-180")} />
        </button>

        {modelMenuOpen && (
          <div className="absolute top-full right-0 mt-1 z-50 min-w-[180px] max-h-[240px] overflow-y-auto rounded-lg border border-[var(--color-border)]/60 bg-[var(--color-surface)] shadow-[var(--shadow-md)] py-1">
            {models.map((m) => (
              <button
                key={m.modelRef}
                type="button"
                onClick={() => { setSelectedModel(m.modelRef); setModelMenuOpen(false); }}
                className={cn(
                  "flex w-full items-center px-3 py-1.5 text-xs transition-colors duration-100",
                  selectedModel === m.modelRef
                    ? "text-[var(--color-primary)] bg-[var(--color-primary)]/5 font-medium"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]"
                )}
              >
                <span className="truncate">{m.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Mode selector + Model selector — compact pill row */}
      <div className="flex items-center justify-between px-1">
        {/* Mode selector */}
        <div className="relative" ref={modeMenuRef}>
          <button
            type="button"
            onClick={() => setModeMenuOpen(!modeMenuOpen)}
            className={cn(
              "inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-xs font-medium transition-colors duration-150 select-none",
              "bg-[var(--color-primary)]/8 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/12"
            )}
          >
            <activeMode.icon className="h-3 w-3" />
            <span>{activeMode.label}</span>
            <ChevronDown className={cn("h-2.5 w-2.5 transition-transform duration-150", modeMenuOpen && "rotate-180")} />
          </button>

          {modeMenuOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 min-w-[100px] rounded-lg border border-[var(--color-border)]/60 bg-[var(--color-surface)] shadow-[var(--shadow-md)] py-1">
              {MODE_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => { onModeChange?.(value); setModeMenuOpen(false); }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-100",
                    mode === value
                      ? "text-[var(--color-primary)] bg-[var(--color-primary)]/5"
                      : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]"
                  )}
                >
                  <Icon className="h-3 w-3" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Model selector — 3-tier: 0→label, 1→readonly, ≥2→dropdown */}
        {renderModelSelector()}
      </div>

      {/* Real-time video preview panel */}
      {videoStream && (
        <div className="px-3 py-2 border border-[var(--color-border)]/40 rounded-xl mb-2 bg-[var(--color-surface)]">
          <div className="flex items-center gap-3">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-40 h-[120px] rounded-lg object-cover bg-black"
            />
            <div className="flex flex-col gap-1.5">
              <span className="inline-flex items-center gap-1 text-xs text-green-500 font-medium">
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                {"\u76f4\u64ad\u4e2d"}
              </span>
              <button
                type="button"
                onClick={toggleVideoStream}
                className="text-xs px-2.5 py-1.5 rounded-md text-[var(--color-error)] bg-[var(--color-error)]/10 hover:bg-[var(--color-error)]/20 transition-colors"
              >
                {"\u5173\u95ed"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input container with drag/drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "border rounded-2xl bg-[var(--color-surface)] overflow-hidden transition-all duration-200",
          isDragging
            ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]/20 bg-[var(--color-primary)]/5"
            : "border-[var(--color-border)]/60 focus-within:ring-1 focus-within:ring-[var(--color-primary)]/20 focus-within:border-[var(--color-primary)]/30"
        )}
      >
        {/* Drag overlay hint */}
        {isDragging && (
          <div className="flex items-center justify-center py-3 text-xs text-[var(--color-primary)] font-medium">
            {"\u91ca\u653e\u4ee5\u6dfb\u52a0\u6587\u4ef6"}
          </div>
        )}

        {/* File preview list */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-[var(--color-border)]/40">
            {files.map((file, idx) => (
              <div
                key={`${file.name}-${idx}`}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-[var(--color-surface-raised)] text-xs text-[var(--color-text-secondary)] max-w-[180px]"
              >
                <span className="truncate">{file.name}</span>
                <span className="text-[var(--color-text-muted)] shrink-0">({formatSize(file.size)})</span>
                <button
                  type="button"
                  onClick={() => removeFile(idx)}
                  className="shrink-0 ml-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors"
                  aria-label={`\u79fb\u9664 ${file.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isLoading || disabled}
          rows={2}
          className="w-full resize-none border-none bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 text-sm leading-6 px-4 py-2.5 min-h-[64px] max-h-[200px]"
        />

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--color-border)]/40">
          {/* Left: file + voice + video buttons */}
          <div className="flex items-center gap-2">
            {/* File attach button */}
            <input
              type="file"
              ref={fileInputRef}
              hidden
              multiple
              onChange={handleFileInputChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-raised)] transition-colors duration-150"
              aria-label={"\u6dfb\u52a0\u6587\u4ef6"}
              title={"\u6dfb\u52a0\u6587\u4ef6"}
            >
              <Paperclip className="h-4 w-4" />
            </button>

            {/* Real-time voice streaming button */}
            <button
              type="button"
              onClick={toggleVoiceStream}
              className={cn(
                "relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors duration-150",
                isVoiceActive
                  ? "text-red-500 bg-red-500/10 hover:bg-red-500/20"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]"
              )}
              aria-label={isVoiceActive ? "\u505c\u6b62\u8bed\u97f3" : "\u5b9e\u65f6\u8bed\u97f3"}
              title={isVoiceActive ? "\u505c\u6b62\u8bed\u97f3\u5bf9\u8bdd" : "\u5f00\u59cb\u5b9e\u65f6\u8bed\u97f3\u5bf9\u8bdd"}
            >
              <Mic className="h-4 w-4" />
              {isVoiceActive && (
                <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
              )}
            </button>

            {/* Real-time video streaming button */}
            <button
              type="button"
              onClick={toggleVideoStream}
              className={cn(
                "relative inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors duration-150",
                videoStream
                  ? "text-green-500 bg-green-500/10 hover:bg-green-500/20"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]"
              )}
              aria-label={videoStream ? "\u505c\u6b62\u89c6\u9891" : "\u5b9e\u65f6\u89c6\u9891"}
              title={videoStream ? "\u505c\u6b62\u89c6\u9891\u76f4\u64ad" : "\u5f00\u59cb\u5b9e\u65f6\u89c6\u9891\u5bf9\u8bdd"}
            >
              <Video className="h-4 w-4" />
              {videoStream && (
                <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse" />
              )}
            </button>
          </div>

          {/* Right: send button */}
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              "inline-flex items-center justify-center h-8 w-8 rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] focus-visible:outline-offset-2",
              canSend
                ? "bg-[var(--color-primary)] text-[var(--color-text-inverse)] hover:bg-[var(--color-primary-hover)]"
                : "bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] cursor-not-allowed"
            )}
            aria-label={"\u53d1\u9001\u6d88\u606f"}
          >
            {isLoading ? (
              <Spinner size="sm" className="text-current" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export { ChatComposer, type ChatComposerProps, type ChatMode };
