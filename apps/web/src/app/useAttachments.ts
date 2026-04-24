"use client";

import { useCallback, useRef, useState } from "react";
import { type ChatAttachment } from "./homeHelpers";
import { nextId } from "@/lib/apiError";
import { t } from "@/lib/i18n";

export const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";
export const DOC_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.pptx,.txt,.csv,.md,.json,.xml,.html,.htm,.rtf,.log,.yml,.yaml,.ini,.conf,.toml";
export const AUDIO_ACCEPT = "audio/wav,audio/mpeg,audio/mp3,audio/ogg,audio/webm,audio/flac,audio/aac,audio/mp4,audio/x-m4a";
export const VIDEO_ACCEPT = "video/mp4,video/webm,video/ogg,video/quicktime";
// Backend config: MEDIA_MAX_INLINE_BYTES (default 5MB for inline base64)
// These frontend limits are independent client-side guards
export const MAX_FILE_MB = 20;
export const MAX_TOTAL_ATTACHMENTS_MB = 20;

export interface AttachmentsState {
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  docInputRef: React.RefObject<HTMLInputElement | null>;
  audioInputRef: React.RefObject<HTMLInputElement | null>;
  videoInputRef: React.RefObject<HTMLInputElement | null>;
  addAttachment: (file: File, type: ChatAttachment["type"]) => void;
  removeAttachment: (id: string) => void;
  handleImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleDocSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleAudioSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleVideoSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export default function useAttachments(opts: {
  locale: string;
}): AttachmentsState {
  const { locale } = opts;

  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const addAttachment = useCallback((file: File, type: ChatAttachment["type"]) => {
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      const msg = t(locale, "chat.attach.fileTooLarge").replace("{max}", String(MAX_FILE_MB));
      console.warn(`[attach] ${msg}`, file.name, file.size);
      return;
    }
    setAttachments((prev) => {
      const totalBytes = prev.reduce((sum, a) => sum + a.size, 0) + file.size;
      if (totalBytes > MAX_TOTAL_ATTACHMENTS_MB * 1024 * 1024) {
        const msg = t(locale, "chat.attach.fileTooLarge").replace("{max}", String(MAX_TOTAL_ATTACHMENTS_MB));
        console.warn(`[attach] ${msg}`, { currentBytes: totalBytes, limitBytes: MAX_TOTAL_ATTACHMENTS_MB * 1024 * 1024 });
        return prev;
      }
      const att: ChatAttachment = {
        id: nextId("att"),
        type,
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        file,
        previewUrl: type === "image" || type === "voice" || type === "video" ? URL.createObjectURL(file) : undefined,
      };
      return [...prev, att];
    });
  }, [locale]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((f) => addAttachment(f, "image"));
    e.target.value = "";
  }, [addAttachment]);

  const handleDocSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((f) => addAttachment(f, "document"));
    e.target.value = "";
  }, [addAttachment]);

  const handleAudioSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((f) => addAttachment(f, "voice"));
    e.target.value = "";
  }, [addAttachment]);

  const handleVideoSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((f) => addAttachment(f, "video"));
    e.target.value = "";
  }, [addAttachment]);

  return {
    attachments,
    setAttachments,
    imageInputRef,
    docInputRef,
    audioInputRef,
    videoInputRef,
    addAttachment,
    removeAttachment,
    handleImageSelect,
    handleDocSelect,
    handleAudioSelect,
    handleVideoSelect,
  };
}
