"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";

interface CodeBlockProps {
  language?: string;
  children: string;
  className?: string;
}

function CodeBlock({ language, children, className }: CodeBlockProps) {
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!language || !codeRef.current) return;
    let cancelled = false;

    async function highlight() {
      const hljs = (await import("highlight.js/lib/core")).default;

      // Dynamically import language pack
      try {
        const langModule = await import(
          /* webpackChunkName: "hljs-[request]" */
          `highlight.js/lib/languages/${language}`
        );
        if (!hljs.getLanguage(language!)) {
          hljs.registerLanguage(language!, langModule.default);
        }
      } catch {
        // Language not available, skip highlighting
        return;
      }

      if (!cancelled && codeRef.current) {
        hljs.highlightElement(codeRef.current);
      }
    }

    highlight();
    return () => {
      cancelled = true;
    };
  }, [language, children]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  };

  const lines = children.replace(/\n$/, "").split("\n");

  return (
    <div
      className={cn(
        "group relative my-3 overflow-hidden rounded-[var(--radius-lg)] bg-[oklch(0.15_0_0)]",
        className
      )}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
        <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">
          {language || "text"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-inverse)] transition-colors duration-[var(--duration-fast)]"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>

      {/* Code area */}
      <div className="max-h-[400px] overflow-y-auto">
        <div className="flex">
          {/* Line numbers */}
          <div className="flex-shrink-0 py-3 pl-4 pr-3 select-none text-right">
            {lines.map((_, i) => (
              <div
                key={i}
                className="text-xs leading-6 text-white/25 font-[var(--font-mono)]"
              >
                {i + 1}
              </div>
            ))}
          </div>

          {/* Code content */}
          <pre className="flex-1 overflow-x-auto py-3 pr-4">
            <code
              ref={codeRef}
              className={cn(
                "text-sm leading-6 font-[var(--font-mono)] text-[var(--color-text-inverse)]",
                language && `language-${language}`
              )}
            >
              {children}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}

export { CodeBlock, type CodeBlockProps };
