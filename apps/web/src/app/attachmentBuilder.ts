"use client";

import type { ChatAttachment } from "./homeHelpers";

export interface ApiAttachment {
  type: string;
  mimeType: string;
  name?: string;
  dataUrl?: string;
  textContent?: string;
}

/**
 * Convert local ChatAttachment[] to API-ready format (base64 dataUrl).
 */
export async function buildApiAttachments(currentAttachments: ChatAttachment[]): Promise<ApiAttachment[]> {
  const apiAttachments: ApiAttachment[] = [];
  for (const att of currentAttachments) {
    if (att.type === "image" && att.file) {
      try {
        const dataUrl = await readFileAsDataUrl(att.file);
        apiAttachments.push({ type: "image", mimeType: att.mimeType, name: att.name, dataUrl });
      } catch (err) {
        console.warn("[attach] Failed to convert image to base64:", att.name, err);
      }
    } else if (att.type === "document" && att.file) {
      const isTextFile = /\.(txt|csv|md|json|xml|log|yml|yaml|ini|conf|toml)$/i.test(att.name);
      try {
        const dataUrl = await readFileAsDataUrl(att.file);
        if (isTextFile) {
          const textContent = await readFileAsText(att.file);
          apiAttachments.push({ type: "document", mimeType: att.mimeType, name: att.name, dataUrl, textContent });
        } else {
          apiAttachments.push({ type: "document", mimeType: att.mimeType, name: att.name, dataUrl });
        }
      } catch (err) {
        console.warn("[attach] Failed to read document:", att.name, err);
      }
    } else if (att.type === "voice" && att.file) {
      try {
        const dataUrl = await readFileAsDataUrl(att.file);
        apiAttachments.push({ type: "voice", mimeType: att.mimeType, name: att.name, dataUrl });
      } catch (err) {
        console.warn("[attach] Failed to read audio:", att.name, err);
      }
    } else if (att.type === "video" && att.file) {
      try {
        const dataUrl = await readFileAsDataUrl(att.file);
        apiAttachments.push({ type: "video", mimeType: att.mimeType, name: att.name, dataUrl });
      } catch (err) {
        console.warn("[attach] Failed to read video:", att.name, err);
      }
    }
  }
  return apiAttachments;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
