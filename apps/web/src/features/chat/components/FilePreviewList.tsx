'use client';

import { X, FileIcon, ImageIcon, Loader2 } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

interface FileUploadItem {
  file: File;
  status: 'uploading' | 'success' | 'error';
  error?: string;
  uploaded?: { previewUrl?: string };
}

interface FilePreviewListProps {
  files: FileUploadItem[];
  onRemove: (index: number) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FilePreviewList({ files, onRemove }: FilePreviewListProps) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {files.map((item, index) => (
        <div
          key={`${item.file.name}-${item.file.size}-${index}`}
          className={cn(
            'relative flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm',
            item.status === 'error' && 'border-red-400 bg-red-50 dark:bg-red-950/20'
          )}
        >
          {/* Icon */}
          <span className="shrink-0 text-[var(--color-text-muted)]">
            {item.file.type.startsWith('image/') ? (
              item.uploaded?.previewUrl ? (
                <img
                  src={item.uploaded.previewUrl}
                  alt={item.file.name}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : (
                <ImageIcon className="h-5 w-5" />
              )
            ) : (
              <FileIcon className="h-5 w-5" />
            )}
          </span>

          {/* Name & Size */}
          <div className="min-w-0 flex-1">
            <p className="truncate max-w-[120px] text-[var(--color-text)] text-xs font-medium">
              {item.file.name}
            </p>
            <p className="text-[10px] text-[var(--color-text-muted)]">
              {formatSize(item.file.size)}
            </p>
          </div>

          {/* Status indicator */}
          {item.status === 'uploading' && (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--color-primary)]" />
          )}
          {item.status === 'error' && (
            <span className="text-[10px] text-red-500" title={item.error}>!</span>
          )}

          {/* Remove button */}
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            aria-label="删除文件"
          >
            <X className="h-3 w-3" />
          </button>

          {/* Progress bar */}
          {item.status === 'uploading' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden rounded-b-[var(--radius-md)]">
              <div className="h-full w-full animate-pulse bg-[var(--color-primary)]" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export { FilePreviewList };
