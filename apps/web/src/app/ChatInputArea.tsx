"use client";

import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { t } from "@/lib/i18n";
import type { IntentMode } from "@/lib/types";
import type { ChatAttachment } from "./homeHelpers";
import type { ModelBinding } from "./useChatSession";
import { ModeSelector } from "@/components/flow/RunStatusIndicator";
import { IconSliders } from "./HomeIcons";
import { AUDIO_ACCEPT, DOC_ACCEPT, IMAGE_ACCEPT, VIDEO_ACCEPT } from "./useAttachments";
import styles from "./page.module.css";

export interface ChatInputAreaProps {
  locale: string;
  hasMessages: boolean;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  busy: boolean;
  canSend: boolean;
  execMode: "auto" | IntentMode;
  setExecMode: React.Dispatch<React.SetStateAction<"auto" | IntentMode>>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  send: () => void;
  abortRef: React.MutableRefObject<AbortController | null>;
  /* Attachments */
  attachments: ChatAttachment[];
  removeAttachment: (id: string) => void;
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  docInputRef: React.RefObject<HTMLInputElement | null>;
  audioInputRef: React.RefObject<HTMLInputElement | null>;
  videoInputRef: React.RefObject<HTMLInputElement | null>;
  handleImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleDocSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleAudioSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleVideoSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /* Voice */
  voiceListening: boolean;
  voiceInterim: string;
  voiceConversation: boolean;
  speaking: boolean;
  startVoice: () => void;
  toggleConversation: () => void;
  stopSpeaking: () => void;
  /* Model picker */
  bindings: ModelBinding[];
  selectedModelRef: string;
  setSelectedModelRef: React.Dispatch<React.SetStateAction<string>>;
  modelPickerOpen: boolean;
  setModelPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  modelPickerTitle: string;
  modelPickerRef: React.RefObject<HTMLDivElement | null>;
  /* P1-19: Multi-task queue context */
  /** Number of active tasks in queue (executing / ready) */
  activeQueueCount?: number;
  /** Number of queued tasks waiting */
  queuedCount?: number;
  /** Whether to show stop button — only when there's a foreground streaming task (not background) */
  showStop?: boolean;
}

export default function ChatInputArea(props: ChatInputAreaProps) {
  const {
    locale, hasMessages, draft, setDraft, busy, canSend,
    execMode, setExecMode, inputRef, onKeyDown, send, abortRef,
    attachments, removeAttachment, imageInputRef, docInputRef, audioInputRef, videoInputRef, handleImageSelect, handleDocSelect, handleAudioSelect, handleVideoSelect,
    voiceListening, voiceInterim, voiceConversation, speaking, startVoice, toggleConversation, stopSpeaking,
    bindings, selectedModelRef, setSelectedModelRef,
    modelPickerOpen, setModelPickerOpen, modelPickerTitle, modelPickerRef,
    activeQueueCount = 0, queuedCount = 0, showStop,
  } = props;
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!attachMenuOpen && !modelPickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (attachMenuOpen && attachMenuRef.current && !attachMenuRef.current.contains(event.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    const onKeyDownWindow = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (modelPickerOpen) setModelPickerOpen(false);
        if (attachMenuOpen) setAttachMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDownWindow);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDownWindow);
    };
  }, [attachMenuOpen, modelPickerOpen, setModelPickerOpen]);

  const openPicker = (kind: "image" | "document" | "audio" | "video") => {
    setAttachMenuOpen(false);
    if (kind === "image") imageInputRef.current?.click();
    else if (kind === "document") docInputRef.current?.click();
    else if (kind === "audio") audioInputRef.current?.click();
    else videoInputRef.current?.click();
  };

  return (
    <div className={`${styles.inputBox} ${hasMessages ? styles.inputBoxDocked : ""}`}>
      {/* Mode selector */}
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <ModeSelector mode={execMode} onChange={setExecMode} locale={locale} disabled={busy} />
        {execMode !== "auto" && (
          <span style={{ fontSize: 12, color: "#6b7280" }}>
            {execMode === "answer" ? t(locale, "chat.mode.answer")
              : execMode === "execute" ? t(locale, "chat.mode.execute")
              : t(locale, "chat.mode.collab")}
          </span>
        )}
      </div>

      {/* Textarea */}
      <textarea
        ref={inputRef}
        className={styles.inputArea}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const ta = e.target;
          ta.style.height = "auto";
          ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
          ta.style.overflowY = ta.scrollHeight > 240 ? "auto" : "hidden";
        }}
        placeholder={t(locale, hasMessages ? "chat.composer.placeholder" : "home.inputPlaceholder")}
        rows={hasMessages ? 1 : 3}
        onKeyDown={onKeyDown}
      />

      {/* Attachment preview strip */}
      {attachments.length > 0 && (
        <div className={styles.attachPreviewStrip}>
          {attachments.map((att) => (
            <div key={att.id} className={styles.attachPreviewItem}>
              {att.type === "image" && att.previewUrl ? (
                <Image src={att.previewUrl} alt={att.name} className={styles.attachPreviewThumb} width={64} height={64} unoptimized />
              ) : att.type === "voice" ? (
                <span className={styles.attachPreviewIcon}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
                </span>
              ) : att.type === "video" ? (
                <span className={styles.attachPreviewIcon}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="15" height="14" rx="2" /><polygon points="16 12 21 9 21 15 16 12" /></svg>
                </span>
              ) : (
                <span className={styles.attachPreviewIcon}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </span>
              )}
              <span className={styles.attachPreviewName}>{att.name}</span>
              <span className={styles.attachPreviewSize}>{att.size < 1024 * 1024 ? `${(att.size / 1024).toFixed(0)}KB` : `${(att.size / 1024 / 1024).toFixed(1)}MB`}</span>
              <button className={styles.attachPreviewRemove} onClick={() => removeAttachment(att.id)} title={t(locale, "chat.attach.remove")}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Attachment toolbar */}
      <div className={styles.attachToolbar}>
        <input ref={imageInputRef} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={handleImageSelect} />
        <input ref={docInputRef} type="file" accept={DOC_ACCEPT} multiple hidden onChange={handleDocSelect} />
        <input ref={audioInputRef} type="file" accept={AUDIO_ACCEPT} multiple hidden onChange={handleAudioSelect} />
        <input ref={videoInputRef} type="file" accept={VIDEO_ACCEPT} multiple hidden onChange={handleVideoSelect} />
        <div ref={attachMenuRef} className={styles.attachMenu}>
          <button
            className={styles.attachBtn}
            onClick={() => setAttachMenuOpen((v) => !v)}
            disabled={busy}
            title="@"
          >
            <span className={styles.attachAtSymbol}>@</span>
          </button>
          {attachMenuOpen && (
            <div className={styles.attachMenuDropdown}>
              <button type="button" className={styles.attachMenuItem} onClick={() => openPicker("image")} title={t(locale, "chat.attach.imageTypes")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                </svg>
                <span>{t(locale, "chat.attach.imageShort")}</span>
              </button>
              <button type="button" className={styles.attachMenuItem} onClick={() => openPicker("document")} title={t(locale, "chat.attach.docTypes")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
                <span>{t(locale, "chat.attach.documentShort")}</span>
              </button>
              <button type="button" className={styles.attachMenuItem} onClick={() => openPicker("audio")} title={t(locale, "chat.attach.audioTypes")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
                <span>{t(locale, "chat.attach.audioShort")}</span>
              </button>
              <button type="button" className={styles.attachMenuItem} onClick={() => openPicker("video")} title={t(locale, "chat.attach.videoTypes")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="15" height="14" rx="2" /><polygon points="16 12 21 9 21 15 16 12" />
                </svg>
                <span>{t(locale, "chat.attach.videoShort")}</span>
              </button>
            </div>
          )}
        </div>
        <button
          className={`${styles.attachBtn} ${voiceConversation ? styles.attachBtnRecording : ""}`}
          onClick={() => {
            if (speaking) stopSpeaking();
            toggleConversation();
            if (!voiceConversation) {
              setTimeout(() => startVoice(), 100);
            }
          }}
          title={voiceConversation ? t(locale, "chat.voice.stopConversation") : t(locale, "chat.voice.startConversation")}
          disabled={busy}
        >
          {voiceConversation ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
              <span style={{ color: "#ef4444" }}>{t(locale, "common.stop")}</span>
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
              <span>{t(locale, "chat.attach.voiceShort")}</span>
            </>
          )}
        </button>
      </div>

      {/* Voice listening hints */}
      {voiceListening && voiceInterim && (
        <div className={styles.voiceInlineHint}><span className={styles.voiceInlineDot} />{voiceInterim}</div>
      )}
      {voiceListening && !voiceInterim && (
        <div className={styles.voiceInlineHint}><span className={styles.voiceInlineDot} />{t(locale, "chat.attach.listening")}</div>
      )}
      {/* Voice conversation mode status */}
      {voiceConversation && !voiceListening && speaking && (
        <div className={styles.voiceInlineHint}><span className={styles.voiceInlineDot} />{t(locale, "chat.voice.speakingHint")}</div>
      )}
      {voiceConversation && !voiceListening && busy && !speaking && (
        <div className={styles.voiceInlineHint}><span className={styles.voiceInlineDot} />{t(locale, "chat.voice.thinkingHint")}</div>
      )}

      {/* Actions: model picker + queue indicator + send/stop */}
      <div className={styles.inputActions}>
        {/* P1-19: Queue status indicator */}
        {(activeQueueCount > 0 || queuedCount > 0) && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontSize: 11, color: "#6b7280", padding: "2px 8px",
            background: "#f3f4f6", borderRadius: 12, whiteSpace: "nowrap",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: activeQueueCount > 0 ? "#3b82f6" : "#9ca3af" }} />
            {activeQueueCount > 0 && `${activeQueueCount} ${t(locale, "taskQueue.running")}`}
            {activeQueueCount > 0 && queuedCount > 0 && " \u00b7 "}
            {queuedCount > 0 && `${queuedCount} ${t(locale, "taskQueue.queued")}`}
          </span>
        )}
        {bindings.length > 0 && (
          <div
            ref={modelPickerRef}
            className={`${styles.modelPicker} ${busy || bindings.length <= 1 ? styles.modelPickerDisabled : ""}`}
          >
            <button
              type="button"
              className={`${styles.modelPickerTrigger} ${modelPickerOpen ? styles.modelPickerTriggerActive : ""}`}
              onClick={() => { if (!busy && bindings.length > 1) setModelPickerOpen((v) => !v); }}
              title={modelPickerTitle}
            >
              <span className={styles.modelPickerTriggerIcon}><IconSliders /></span>
            </button>
            {modelPickerOpen && (
              <>
                <div className={styles.modelPickerOverlay} onClick={() => setModelPickerOpen(false)} />
                <div className={styles.modelPickerDropdown}>
                  <div className={styles.modelPickerHeader}>{t(locale, "home.modelPicker")}</div>
                  <div className={styles.modelPickerList}>
                    {bindings.map((b) => (
                      <div
                        key={b.modelRef}
                        className={`${styles.modelPickerItem} ${b.modelRef === selectedModelRef ? styles.modelPickerItemActive : ""}`}
                        onClick={() => { setSelectedModelRef(b.modelRef); setModelPickerOpen(false); }}
                      >
                        <span className={styles.modelPickerItemDot} />
                        <span className={styles.modelPickerItemInfo}>
                          <span className={styles.modelPickerItemModel}>{b.model}</span>
                          <span className={styles.modelPickerItemProvider}>{b.provider}</span>
                        </span>
                        <span className={styles.modelPickerItemCheck}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        {/* P1-19: Show stop button only for foreground streaming task, not background tasks */}
        {showStop !== undefined ? (
          showStop ? (
            <button className={`${styles.sendBtn} ${styles.stopBtn}`} onClick={() => { try { abortRef.current?.abort(); } catch { /* expected: abort may throw */ } }} title={t(locale, "common.stop")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            </button>
          ) : (
            <button className={styles.sendBtn} onClick={() => void send()} disabled={!canSend}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2 11 13" /><path d="M22 2 15 22 11 13 2 9z" />
              </svg>
            </button>
          )
        ) : (
          /* Fallback: original logic when showStop is not provided */
          busy && !canSend ? (
          <button className={`${styles.sendBtn} ${styles.stopBtn}`} onClick={() => { try { abortRef.current?.abort(); } catch {} }} title={t(locale, "common.stop")}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </button>
        ) : (
          <button className={styles.sendBtn} onClick={() => void send()} disabled={!canSend}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13" /><path d="M22 2 15 22 11 13 2 9z" />
            </svg>
          </button>
        )
        )}
      </div>
    </div>
  );
}
