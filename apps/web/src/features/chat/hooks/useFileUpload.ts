'use client';

import { useState, useCallback, useRef } from 'react';
import { apiFetch } from '@/shared/lib/api';

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  previewUrl?: string;
}

export interface FileUploadItem {
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'success' | 'error';
  uploaded?: UploadedFile;
  error?: string;
}

export function useFileUpload() {
  const [files, setFiles] = useState<FileUploadItem[]>([]);
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  const uploadFile = useCallback(async (item: FileUploadItem) => {
    const controller = new AbortController();
    const key = `${item.file.name}-${item.file.size}-${item.file.lastModified}`;
    abortControllers.current.set(key, controller);

    setFiles(prev => prev.map(f =>
      f.file === item.file ? { ...f, status: 'uploading' as const } : f
    ));

    try {
      const base64 = await fileToBase64(item.file);
      const res = await apiFetch('/media/objects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: item.file.name,
          mimeType: item.file.type,
          data: base64,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Upload failed: ${res.status}`);
      }

      const data = await res.json();

      const uploaded: UploadedFile = {
        id: data.id,
        name: item.file.name,
        size: item.file.size,
        mimeType: item.file.type,
        previewUrl: item.file.type.startsWith('image/')
          ? URL.createObjectURL(item.file)
          : undefined,
      };

      setFiles(prev => prev.map(f =>
        f.file === item.file ? { ...f, status: 'success' as const, progress: 100, uploaded } : f
      ));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : 'Upload failed';
      setFiles(prev => prev.map(f =>
        f.file === item.file ? { ...f, status: 'error' as const, error: message } : f
      ));
    }
  }, []);

  const addFiles = useCallback((newFiles: File[]) => {
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    const validFiles = newFiles.filter(f => f.size <= MAX_SIZE);

    const items: FileUploadItem[] = validFiles.map(f => ({
      file: f,
      progress: 0,
      status: 'pending' as const,
    }));

    setFiles(prev => [...prev, ...items]);
    items.forEach(item => uploadFile(item));
  }, [uploadFile]);

  const removeFile = useCallback((index: number) => {
    setFiles(prev => {
      const item = prev[index];
      if (item) {
        const key = `${item.file.name}-${item.file.size}-${item.file.lastModified}`;
        const ctrl = abortControllers.current.get(key);
        ctrl?.abort();
        abortControllers.current.delete(key);
        if (item.uploaded?.previewUrl) URL.revokeObjectURL(item.uploaded.previewUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearAll = useCallback(() => {
    setFiles(prev => {
      prev.forEach(f => {
        if (f.uploaded?.previewUrl) URL.revokeObjectURL(f.uploaded.previewUrl);
      });
      return [];
    });
    abortControllers.current.forEach(c => c.abort());
    abortControllers.current.clear();
  }, []);

  const getAttachments = useCallback(() => {
    return files
      .filter(f => f.status === 'success' && f.uploaded)
      .map(f => f.uploaded!);
  }, [files]);

  const isUploading = files.some(f => f.status === 'uploading');

  return { files, addFiles, removeFile, clearAll, getAttachments, isUploading };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
