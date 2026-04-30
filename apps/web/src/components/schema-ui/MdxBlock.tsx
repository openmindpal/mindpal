"use client";

import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MdxBlockProps {
  content: string;
}

/* ── safe component overrides ── */
const components: Record<string, React.ComponentType<any>> = {
  table: ({ children, ...props }: any) => (
    <div style={{ overflowX: "auto" }}>
      <table
        {...props}
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.875rem",
        }}
      >
        {children}
      </table>
    </div>
  ),

  th: ({ children, ...props }: any) => (
    <th
      {...props}
      style={{
        textAlign: "left",
        padding: "0.5rem 0.75rem",
        borderBottom: "2px solid var(--border, #e5e7eb)",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  ),

  td: ({ children, ...props }: any) => (
    <td
      {...props}
      style={{
        padding: "0.5rem 0.75rem",
        borderBottom: "1px solid var(--border, #f3f4f6)",
      }}
    >
      {children}
    </td>
  ),

  code: ({ children, className, ...props }: any) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code
          {...props}
          style={{
            background: "var(--code-bg, #f3f4f6)",
            padding: "0.15em 0.35em",
            borderRadius: "3px",
            fontSize: "0.85em",
          }}
        >
          {children}
        </code>
      );
    }
    return (
      <pre
        style={{
          background: "var(--code-bg, #1e1e1e)",
          color: "var(--code-fg, #d4d4d4)",
          padding: "1rem",
          borderRadius: "6px",
          overflowX: "auto",
          fontSize: "0.85rem",
        }}
      >
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    );
  },
};

export function MdxBlock({ content }: MdxBlockProps) {
  if (!content) return null;
  return (
    <div style={{ lineHeight: 1.7 }}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
