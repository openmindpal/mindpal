'use client';

import { X } from 'lucide-react';
import type { RefObject } from 'react';

interface VideoStreamPanelProps {
  state: 'idle' | 'connecting' | 'streaming' | 'error';
  latestAnalysis: string;
  error: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  fps: number;
  onStop: () => void;
}

function VideoStreamPanel({
  state,
  latestAnalysis,
  error,
  videoRef,
  canvasRef,
  fps,
  onStop,
}: VideoStreamPanelProps) {
  if (state === 'idle') return null;

  return (
    <div className="relative mx-4 mb-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-0)] shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)]">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              state === 'streaming' ? 'bg-green-500 animate-pulse' : 
              state === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
            }`}
          />
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">
            {state === 'streaming' ? '实时分析中' : 
             state === 'connecting' ? '连接中...' : '连接错误'}
          </span>
          {state === 'streaming' && (
            <span className="text-[10px] text-[var(--color-text-muted)]">{fps} FPS</span>
          )}
        </div>
        <button
          type="button"
          onClick={onStop}
          className="inline-flex items-center justify-center h-6 w-6 rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
          aria-label="关闭视频流"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Video preview */}
      <div className="relative aspect-video max-h-[200px] bg-black">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="h-full w-full object-cover"
        />
        {/* Hidden canvas for frame capture */}
        <canvas ref={canvasRef} className="hidden" />
      </div>

      {/* Analysis result */}
      {latestAnalysis && (
        <div className="px-3 py-2 border-t border-[var(--color-border)]">
          <p className="text-xs text-[var(--color-text-secondary)] line-clamp-3">
            {latestAnalysis}
          </p>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="px-3 py-2 border-t border-[var(--color-border)]">
          <p className="text-xs text-red-500">{error}</p>
        </div>
      )}
    </div>
  );
}

export { VideoStreamPanel };
