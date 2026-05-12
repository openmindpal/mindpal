'use client';

import { Video, VideoOff, Loader2 } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

interface VideoButtonProps {
  state: 'idle' | 'connecting' | 'streaming' | 'error';
  onStart: () => void;
  onStop: () => void;
}

function VideoButton({ state, onStart, onStop }: VideoButtonProps) {
  const isStreaming = state === 'streaming';
  const isConnecting = state === 'connecting';

  const handleClick = () => {
    if (isStreaming) {
      onStop();
    } else if (state === 'idle' || state === 'error') {
      onStart();
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isConnecting}
      className={cn(
        'inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius-md)] transition-colors duration-150',
        isStreaming
          ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
          : 'text-[var(--color-text)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)]',
        isConnecting && 'opacity-50 cursor-not-allowed'
      )}
      aria-label={isStreaming ? '关闭摄像头' : '开启摄像头'}
      title={isStreaming ? '关闭摄像头' : '开启实时视频'}
    >
      {isConnecting ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : isStreaming ? (
        <VideoOff className="h-5 w-5" />
      ) : (
        <Video className="h-5 w-5" />
      )}
    </button>
  );
}

export { VideoButton };
