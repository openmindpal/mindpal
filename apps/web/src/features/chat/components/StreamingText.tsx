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

      {isStreaming && !content && (
        <span className="inline-flex gap-1 ml-1 items-center">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-[pulse_1.4s_ease-in-out_infinite]" />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-[pulse_1.4s_ease-in-out_0.2s_infinite]" />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-[pulse_1.4s_ease-in-out_0.4s_infinite]" />
        </span>
      )}

      {isStreaming && content && (
        <span
          className="inline-block ml-0.5 text-[var(--color-text)] font-normal"
          style={{ animation: "blink 1s steps(2, start) infinite" }}
          aria-hidden="true"
        >
          ▋
        </span>
      )}
    </div>
  );
}

export { StreamingText, type StreamingTextProps };
