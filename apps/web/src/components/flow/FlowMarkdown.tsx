"use client";

import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import FlowCodeBlock from "./FlowCodeBlock";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import styles from "@/styles/page.module.css";

const FlowMarkdown = memo(function FlowMarkdown({ text, locale, onImageClick }: {
  text: string;
  locale: string;
  onImageClick?: (src: string) => void;
}) {
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children, ...rest }) {
            const match = /language-(\w+)/.exec(className || "");
            const codeText = String(children).replace(/\n$/, "");
            if (match) {
              return <FlowCodeBlock lang={match[1]} code={codeText} locale={locale} />;
            }
            return <code className={className} {...rest}>{children}</code>;
          },
          img({ src, alt }) {
            if (!src || typeof src !== "string") return null;
            const safeSrc = src as string;
            try {
              const parsedUrl = new URL(safeSrc, window.location.origin);
              if (!["http:", "https:", "data:"].includes(parsedUrl.protocol)) return null;
            } catch {
              return null;
            }
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={alt || ""}
                style={{ cursor: "zoom-in", maxWidth: "100%", borderRadius: "var(--sl-radius-1, 8px)" }}
                onClick={() => onImageClick?.(String(src))}
              />
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    ),
    [text, locale, onImageClick],
  );
  return rendered;
});

export default FlowMarkdown;
