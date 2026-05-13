"use client";

import * as React from "react";
import {
  Bot,
  Check,
  ChevronDown,
  MessageCircle,
  Mic,
  Paperclip,
  Send,
  Sparkles,
  Users,
  Video,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Spinner } from "@/shared/components/primitives/Spinner";
import { apiFetch } from "@/shared/lib/api";

type ChatMode = "auto" | "answer" | "execute" | "collab";

const MODE_OPTIONS: { value: ChatMode; label: string; icon: React.ElementType }[] = [
  { value: "auto", label: "自动", icon: Sparkles },
  { value: "answer", label: "回答", icon: MessageCircle },
  { value: "execute", label: "执行", icon: Zap },
  { value: "collab", label: "协作", icon: Users },
];

interface ModelEntry {
  modelRef: string;
  label?: string;
}

const SELECTED_MODEL_STORAGE_KEY = "mindpal.selectedModelRef";

function getModelDisplayName(model?: Pick<ModelEntry, "modelRef" | "label">) {
  const raw = (model?.label ?? model?.modelRef ?? "").trim();
  if (!raw) return "";

  const colonIndex = raw.indexOf(":");
  return colonIndex >= 0 ? raw.slice(colonIndex + 1).trim() || raw : raw;
}

interface ChatComposerProps {
  onSend: (text: string, options?: { files?: File[]; model?: string }) => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  mode?: ChatMode;
  onModeChange?: (mode: ChatMode) => void;
}

function ChatComposer({
  onSend,
  isLoading = false,
  disabled = false,
  placeholder = "给 MindPal 发送消息...",
  className,
  mode = "auto",
  onModeChange,
}: ChatComposerProps) {
  const [text, setText] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const [files, setFiles] = React.useState<File[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [isVoiceActive, setIsVoiceActive] = React.useState(false);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const audioStreamRef = React.useRef<MediaStream | null>(null);

  const [models, setModels] = React.useState<ModelEntry[]>([]);
  const [selectedModel, setSelectedModel] = React.useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(SELECTED_MODEL_STORAGE_KEY) ?? "";
  });
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const modelMenuRef = React.useRef<HTMLDivElement>(null);

  const [videoStream, setVideoStream] = React.useState<MediaStream | null>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const frameIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

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
          label:
            m.displayName ??
            m.display_name ??
            m.label ??
            m.name ??
            m.modelRef ??
            m.model_ref ??
            m.id ??
            "Unknown",
        }));
        setModels(list);
        setSelectedModel((current) => {
          if (current && list.some((entry) => entry.modelRef === current)) {
            return current;
          }
          return list[0]?.modelRef || "";
        });
      })
      .catch(() => {
        // Keep lightweight fallback UI when there is no available model binding.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const adjustHeight = React.useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, []);

  React.useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  React.useEffect(() => {
    if (!modelMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modelMenuOpen]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    if (selectedModel) {
      window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, selectedModel);
    } else {
      window.localStorage.removeItem(SELECTED_MODEL_STORAGE_KEY);
    }
  }, [selectedModel]);

  React.useEffect(() => {
    return () => {
      if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
      audioStreamRef.current?.getTracks().forEach((t) => t.stop());
      videoStream?.getTracks().forEach((t) => t.stop());
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, [videoStream]);

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

  const sendAudioChunk = React.useCallback(
    async (chunk: Blob) => {
      const formData = new FormData();
      formData.append("audio", chunk, "chunk.webm");
      formData.append("type", "input_audio");
      if (selectedModel) formData.append("model", selectedModel);
      try {
        await apiFetch("/models/chat/stream", { method: "POST", body: formData });
      } catch {
        // Ignore transient streaming failures for now.
      }
    },
    [selectedModel]
  );

  const sendVideoFrame = React.useCallback(
    async (dataUrl: string) => {
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
        // Ignore transient streaming failures for now.
      }
    },
    [selectedModel]
  );

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
    void sendVideoFrame(dataUrl);
  }, [sendVideoFrame]);

  const toggleVoiceStream = React.useCallback(async () => {
    if (isVoiceActive) {
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
        if (e.data.size > 0) {
          void sendAudioChunk(e.data);
        }
      };
      recorder.start(2000);
      setIsVoiceActive(true);
    } catch {
      // Microphone not available or permission denied.
    }
  }, [isVoiceActive, sendAudioChunk]);

  const toggleVideoStream = React.useCallback(async () => {
    if (videoStream) {
      videoStream.getTracks().forEach((t) => t.stop());
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
      setVideoStream(null);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      setVideoStream(stream);
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      });
      frameIntervalRef.current = setInterval(() => {
        captureAndSendFrame();
      }, 3000);
    } catch {
      // Camera not available or permission denied.
    }
  }, [videoStream, captureAndSendFrame]);

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
  const selectedModelEntry = models.find((entry) => entry.modelRef === selectedModel) ?? models[0];

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  const renderModelTrigger = () => {
    if (models.length === 0) {
      return (
        <span className="inline-flex h-9 items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 text-xs font-medium text-[var(--color-text-muted)]">
          默认路由
        </span>
      );
    }

    if (models.length === 1) {
      return (
        <span className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 text-xs font-medium text-[var(--color-text-secondary)]">
          <Bot className="h-3.5 w-3.5 text-[var(--color-primary)]" />
          <span className="max-w-[180px] truncate" title={models[0].label ?? models[0].modelRef}>
            {getModelDisplayName(models[0])}
          </span>
        </span>
      );
    }

    return (
      <button
        type="button"
        onClick={() => setModelMenuOpen((open) => !open)}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-full border border-[var(--color-border)] bg-white px-3 text-xs font-medium text-[var(--color-text-secondary)] shadow-[var(--shadow-xs)]",
          "transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        )}
      >
        <span
          className="max-w-[180px] truncate"
          title={selectedModelEntry?.label ?? selectedModelEntry?.modelRef ?? "选择模型"}
        >
          {selectedModelEntry ? getModelDisplayName(selectedModelEntry) : "选择模型"}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-[var(--color-text-muted)] transition-transform duration-150",
            modelMenuOpen && "rotate-180"
          )}
        />
      </button>
    );
  };

  return (
    <>
      <div className={cn("flex flex-col gap-3", className)}>
        <div className="overflow-hidden rounded-[28px] border border-[var(--color-border)] bg-white/96 shadow-[0_18px_48px_rgba(17,24,39,0.08)] backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-light)] px-3 pb-2 pt-3 sm:px-4">
            <div className="flex flex-wrap items-center gap-2">
              {MODE_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onModeChange?.(value)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-all duration-150",
                    mode === value
                      ? "border border-[var(--color-border-strong)] bg-white text-[var(--color-text)] shadow-[var(--shadow-xs)]"
                      : "bg-[var(--color-surface-sunken)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <div className="relative" ref={modelMenuRef}>
                {renderModelTrigger()}
                {modelMenuOpen && models.length > 1 && (
                  <div className="absolute right-0 top-[calc(100%+8px)] z-[var(--z-dropdown)] min-w-[220px] overflow-hidden rounded-[18px] border border-[var(--color-border)] bg-white p-1.5 shadow-[0_12px_30px_rgba(17,24,39,0.08)]">
                    {models.map((entry) => {
                      const isSelected = entry.modelRef === selectedModel;

                      return (
                        <button
                          key={entry.modelRef}
                          type="button"
                          onClick={() => {
                            setSelectedModel(entry.modelRef);
                            setModelMenuOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left transition-colors",
                            isSelected
                              ? "bg-[var(--color-surface-sunken)] text-[var(--color-text)]"
                              : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text)]"
                          )}
                        >
                          <span className="flex h-4 w-4 items-center justify-center">
                            {isSelected ? <Check className="h-3.5 w-3.5 text-[var(--color-primary)]" /> : null}
                          </span>
                          <span
                            className="truncate text-xs font-medium"
                            title={entry.label ?? entry.modelRef}
                          >
                            {getModelDisplayName(entry)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {videoStream && (
            <div className="border-b border-[var(--color-border-light)] bg-[var(--color-surface-sunken)]/60 px-3 py-3 sm:px-4">
              <div className="flex items-center gap-3">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="h-[120px] w-40 rounded-[18px] object-cover bg-black"
                />
                <div className="flex flex-col gap-2">
                  <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--color-success-text)]">
                    <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" />
                    视频采集中
                  </span>
                  <button
                    type="button"
                    onClick={toggleVideoStream}
                    className="inline-flex h-8 items-center justify-center rounded-full bg-[var(--color-danger-bg)] px-3 text-xs font-medium text-[var(--color-danger-text)] transition-colors hover:opacity-90"
                  >
                    关闭视频
                  </button>
                </div>
              </div>
            </div>
          )}

          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn("transition-colors duration-150", isDragging && "bg-[var(--color-primary-soft)]")}
          >
            {isDragging && (
              <div className="px-4 pt-4 text-center text-xs font-medium text-[var(--color-text-secondary)]">
                释放以上传文件
              </div>
            )}

            {files.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-3 sm:px-4">
                {files.map((file, idx) => (
                  <div
                    key={`${file.name}-${idx}`}
                    className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 text-xs text-[var(--color-text-secondary)]"
                  >
                    <span className="truncate">{file.name}</span>
                    <span className="shrink-0 text-[var(--color-text-muted)]">{formatSize(file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(idx)}
                      className="ml-0.5 shrink-0 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-danger-text)]"
                      aria-label={`移除 ${file.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={isLoading || disabled}
              rows={3}
              className="min-h-[108px] max-h-[220px] w-full resize-none border-none bg-transparent px-4 pb-3 pt-4 text-sm leading-7 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />

            <div className="flex flex-wrap items-center justify-between gap-3 px-3 pb-3 sm:px-4 sm:pb-4">
              <div className="flex items-center gap-1">
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
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text)]"
                  aria-label="添加文件"
                  title="添加文件"
                >
                  <Paperclip className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  onClick={toggleVoiceStream}
                  className={cn(
                    "relative inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors",
                    isVoiceActive
                      ? "bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text)]"
                  )}
                  aria-label={isVoiceActive ? "停止语音" : "开始语音"}
                  title={isVoiceActive ? "停止语音对话" : "开始语音对话"}
                >
                  <Mic className="h-4 w-4" />
                  {isVoiceActive && (
                    <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--color-danger)]" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={toggleVideoStream}
                  className={cn(
                    "relative inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors",
                    videoStream
                      ? "bg-[var(--color-success-bg)] text-[var(--color-success-text)]"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text)]"
                  )}
                  aria-label={videoStream ? "停止视频" : "开始视频"}
                  title={videoStream ? "停止视频对话" : "开始视频对话"}
                >
                  <Video className="h-4 w-4" />
                  {videoStream && (
                    <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--color-success)]" />
                  )}
                </button>
              </div>

              <div className="flex items-center gap-3">
                <span className="hidden text-[11px] text-[var(--color-text-muted)] sm:inline">
                  Enter 发送，Shift + Enter 换行
                </span>
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSend}
                  className={cn(
                    "inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-border-strong)] focus-visible:outline-offset-2",
                    canSend
                      ? "bg-[var(--color-text)] text-[var(--color-text-inverse)] hover:bg-[#1f2937]"
                      : "cursor-not-allowed bg-[var(--color-surface-sunken)] text-[var(--color-text-muted)]"
                  )}
                  aria-label="发送消息"
                >
                  {isLoading ? (
                    <Spinner size="sm" className="text-current" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        <p className="px-2 text-center text-[11px] text-[var(--color-text-muted)]">
          内容由模型生成，请注意甄别。
        </p>
      </div>

    </>
  );
}

export { ChatComposer, type ChatComposerProps, type ChatMode };
