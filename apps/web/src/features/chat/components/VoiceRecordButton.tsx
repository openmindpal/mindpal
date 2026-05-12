'use client';

import { Mic, MicOff, Loader2 } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

interface VoiceRecordButtonProps {
  state: 'idle' | 'requesting' | 'recording' | 'processing' | 'done' | 'error';
  duration: number;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function VoiceRecordButton({ state, duration, error, onStart, onStop }: VoiceRecordButtonProps) {
  const isRecording = state === 'recording';
  const isProcessing = state === 'processing' || state === 'requesting';

  const handleClick = () => {
    if (isRecording) {
      onStop();
    } else if (state === 'idle' || state === 'done' || state === 'error') {
      onStart();
    }
  };

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onClick={handleClick}
        disabled={isProcessing}
        className={cn(
          'inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius-md)] transition-colors duration-150',
          isRecording
            ? 'bg-red-500 text-white animate-pulse'
            : 'text-[var(--color-text)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)]',
          isProcessing && 'opacity-50 cursor-not-allowed'
        )}
        aria-label={isRecording ? '停止录音' : '语音输入'}
        title={error ?? (isRecording ? '点击停止' : '语音输入')}
      >
        {isProcessing ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : isRecording ? (
          <MicOff className="h-5 w-5" />
        ) : (
          <Mic className="h-5 w-5" />
        )}
      </button>

      {/* Duration badge */}
      {isRecording && (
        <span className="ml-1 text-xs font-mono text-red-500 tabular-nums">
          {formatDuration(duration)}
        </span>
      )}
    </div>
  );
}

export { VoiceRecordButton };
