"use client";

import * as React from "react";
import { Send, Paperclip, Sparkles, MessageCircle, Zap, Users, Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Spinner } from "@/shared/components/primitives/Spinner";
import { useFileUpload } from "../hooks/useFileUpload";
import type { UploadedFile } from "../hooks/useFileUpload";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { useModelCatalog } from "../hooks/useModelCatalog";
import { FilePreviewList } from "./FilePreviewList";
import { VoiceRecordButton } from "./VoiceRecordButton";
import { VideoButton } from "./VideoButton";

type ChatMode = "auto" | "answer" | "execute" | "collab";

const MODE_OPTIONS: { value: ChatMode; label: string; icon: React.ElementType }[] = [
  { value: "auto", label: "\u81ea\u52a8", icon: Sparkles },
  { value: "answer", label: "\u56de\u7b54", icon: MessageCircle },
  { value: "execute", label: "\u6267\u884c", icon: Zap },
  { value: "collab", label: "\u534f\u4f5c", icon: Users },
];

interface ChatComposerProps {
  onSend: (text: string, attachments?: UploadedFile[]) => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Video stream state for VideoButton */
  videoState?: 'idle' | 'connecting' | 'streaming' | 'error';
  onVideoStart?: () => void;
  onVideoStop?: () => void;
  /** Mode selector */
  mode?: ChatMode;
  onModeChange?: (mode: ChatMode) => void;
}

function ChatComposer({
  onSend,
  isLoading = false,
  disabled = false,
  placeholder = "输入消息...",
  className,
  videoState = 'idle',
  onVideoStart,
  onVideoStop,
  mode = 'auto',
  onModeChange,
}: ChatComposerProps) {
  const { models, hasModels, defaultModel, isLoading: modelsLoading } = useModelCatalog();
  const [text, setText] = React.useState("");
  const [selectedModelId, setSelectedModelId] = React.useState<string>("");

  // Sync selectedModelId when models load
  React.useEffect(() => {
    if (models.length > 0 && !models.some(m => m.id === selectedModelId)) {
      setSelectedModelId(models[0].id);
    }
  }, [models, selectedModelId]);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = React.useState(false);

  // File upload
  const { files, addFiles, removeFile, clearAll, getAttachments, isUploading } = useFileUpload();

  // Voice input
  const voice = useVoiceInput();

  // Append transcribed text when voice recognition completes
  React.useEffect(() => {
    if (voice.transcribedText && voice.state === 'done') {
      setText(prev => prev ? `${prev} ${voice.transcribedText}` : voice.transcribedText);
      voice.reset();
    }
  }, [voice.transcribedText, voice.state, voice.reset]);

  const adjustHeight = React.useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  React.useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  const handleSend = React.useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || isLoading || disabled || isUploading) return;

    const attachments = getAttachments();
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setText("");
    clearAll();

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
  }, [text, files.length, isLoading, disabled, isUploading, onSend, getAttachments, clearAll]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // File input handler
  const handleFileChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files;
      if (selected && selected.length > 0) {
        addFiles(Array.from(selected));
      }
      // Reset input so same file can be selected again
      e.target.value = "";
    },
    [addFiles]
  );

  // Drag & Drop handlers
  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const droppedFiles = e.dataTransfer.files;
      if (droppedFiles.length > 0) {
        addFiles(Array.from(droppedFiles));
      }
    },
    [addFiles]
  );

  const canSend = (text.trim().length > 0 || files.some(f => f.status === 'success')) && !isLoading && !disabled && !isUploading;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {/* Mode selector + Model selector — compact pill row */}
      <div className="flex items-center justify-between px-1">
        {/* Mode buttons in capsule container */}
        <div className="inline-flex items-center bg-[var(--color-surface-raised)] rounded-full p-0.5 gap-0.5">
          {MODE_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => onModeChange?.(value)}
              className={cn(
                "inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium transition-colors duration-150 select-none",
                mode === value
                  ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
              )}
            >
              <Icon className="h-3 w-3" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Model select — compact pill style */}
        <div className="relative inline-flex items-center">
          {modelsLoading ? (
            <div className="h-6 flex items-center px-2">
              <Loader2 className="h-3 w-3 animate-spin text-[var(--color-text-muted)]" />
            </div>
          ) : !hasModels ? (
            /* No models bound — show simple label */
            <span className="h-6 flex items-center px-2 text-[11px] text-[var(--color-text-secondary)]">
              {defaultModel.name}
            </span>
          ) : models.length === 1 ? (
            /* Single model — show as label, no dropdown */
            <span className="h-6 flex items-center px-2 rounded-full bg-[var(--color-surface-raised)] text-[11px] text-[var(--color-text-secondary)]">
              {models[0].name}
            </span>
          ) : (
            /* Multiple models — show dropdown */
            <>
              <select
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                className="h-6 rounded-full border-none bg-[var(--color-surface-raised)] px-2 pr-5 text-[11px] text-[var(--color-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] appearance-none cursor-pointer"
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
              <svg className="absolute right-1.5 h-3 w-3 text-[var(--color-text-muted)] pointer-events-none" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
              </svg>
            </>
          )}
        </div>
      </div>

      {/* Input container — flat style */}
      <div
        className={cn(
          "border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden",
          isDragOver && "ring-2 ring-[var(--color-primary)] ring-inset"
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* File preview list */}
        <FilePreviewList files={files} onRemove={removeFile} />

        {/* Drag overlay hint */}
        {isDragOver && (
          <div className="flex items-center justify-center py-3 mx-3 mt-2 rounded-md border-2 border-dashed border-[var(--color-primary)] bg-[var(--color-primary)]/5">
            <span className="text-sm text-[var(--color-primary)]">拖放文件到此处上传</span>
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
          rows={3}
          className="w-full resize-none border-none bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 text-sm leading-6 px-4 py-3 min-h-[80px] max-h-[200px]"
        />

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--color-border)]">
          {/* Left: toolbar buttons */}
          <div className="flex items-center gap-0.5">
            {/* Attachment button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)] transition-colors duration-150"
              aria-label="添加附件"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,.doc,.docx,.txt,.xlsx,.xls,.csv"
              onChange={handleFileChange}
              className="hidden"
            />

            {/* Voice record button */}
            <VoiceRecordButton
              state={voice.state}
              duration={voice.duration}
              error={voice.error}
              onStart={voice.startRecording}
              onStop={voice.stopRecording}
            />

            {/* Video button */}
            {onVideoStart && onVideoStop && (
              <VideoButton
                state={videoState}
                onStart={onVideoStart}
                onStop={onVideoStop}
              />
            )}
          </div>

          {/* Right: send button */}
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              "inline-flex items-center justify-center h-7 w-7 rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] focus-visible:outline-offset-2",
              canSend
                ? "bg-[var(--color-primary)] text-[var(--color-text-inverse)] hover:bg-[var(--color-primary-hover)]"
                : "bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] cursor-not-allowed"
            )}
            aria-label="发送消息"
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
