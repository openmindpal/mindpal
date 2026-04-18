"use client";

/**
 * Reusable empty-state placeholder for tables and lists.
 * Shows a centred, muted message when there is no data to display.
 */
export function EmptyState(props: { text: string }) {
  return (
    <p
      style={{
        color: "var(--sl-muted)",
        fontSize: 13,
        margin: 0,
        textAlign: "center",
        padding: "32px 16px",
        fontStyle: "italic",
      }}
    >
      {props.text}
    </p>
  );
}
