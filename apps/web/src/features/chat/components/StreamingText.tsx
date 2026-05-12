"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/shared/lib/cn";
import { CodeBlock } from "./CodeBlock";

interface StreamingTextProps {
  content: string;
  isStreaming: boolean;
  className?: string;
}

function StreamingText({ content, isStreaming, className }: StreamingTextProps) {
  return (
    <div className={cn("relative", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className: codeClassName, children, ...props }) {
            const match = /language-(\w+)/.exec(codeClassName || "");
            const codeString = String(children).replace(/\n$/, "");

            if (match) {
              return <CodeBlock language={match[1]}>{codeString}</CodeBlock>;
            }

            return (
              <code
                className={cn(
                  "rounded px-1.5 py-0.5 bg-[var(--color-surface-sunken)] text-sm font-[var(--font-mono)]",
                  codeClassName
                )}
                {...props}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>

      {isStreaming && (
        <span
          className="inline-block w-[2px] h-[1.2em] ml-0.5 align-middle bg-[var(--color-text)] animate-[blink_1s_infinite]"
          aria-hidden="true"
        />
      )}

      <style jsx>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

export { StreamingText, type StreamingTextProps };
