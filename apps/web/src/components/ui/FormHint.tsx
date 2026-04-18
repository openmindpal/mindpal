"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";

/**
 * FormHint – a small "?" icon next to a label that shows a tooltip on hover / focus.
 * Pure CSS positioning, no external deps.
 */
export function FormHint({ text }: { text: ReactNode }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  /* close on outside click */
  useEffect(() => {
    if (!show) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [show]);

  return (
    <span
      ref={ref}
      style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 4 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      tabIndex={0}
      role="button"
      aria-label="help"
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 15,
          height: 15,
          borderRadius: "50%",
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
          color: "var(--sl-accent, #6366f1)",
          background: "var(--sl-accent-bg, rgba(99,102,241,0.1))",
          cursor: "help",
          userSelect: "none",
        }}
      >
        ?
      </span>
      {show && (
        <span
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            minWidth: 200,
            maxWidth: 320,
            padding: "8px 12px",
            borderRadius: 8,
            background: "var(--sl-tooltip-bg, #1e293b)",
            color: "var(--sl-tooltip-fg, #f8fafc)",
            fontSize: 12,
            lineHeight: 1.5,
            boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
            zIndex: 100,
            pointerEvents: "none",
            whiteSpace: "normal",
          }}
        >
          {text}
          {/* arrow */}
          <span
            style={{
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: "5px solid var(--sl-tooltip-bg, #1e293b)",
            }}
          />
        </span>
      )}
    </span>
  );
}
