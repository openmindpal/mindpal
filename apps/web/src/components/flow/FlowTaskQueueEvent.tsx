"use client";

import { t } from "@/lib/i18n";
import { type FlowTaskQueueEvent } from "../../app/homeHelpers";

const QUEUE_EVENT_ICONS: Record<string, string> = {
  enqueued: "📥", started: "▶️", completed: "✅", failed: "❌",
  cancelled: "⛔", paused: "⏸️", resumed: "▶️", preempted: "⏏️",
  retried: "🔄", reordered: "↕️", priorityChanged: "⚡",
  foregroundChanged: "🔲", depResolved: "🔗", depBlocked: "🚫",
};

function queueEventLabel(eventType: string, locale: string): string {
  const key = `taskQueue.event.${eventType}`;
  const label = t(locale, key);
  return label !== key ? label : eventType.replace(/([A-Z])/g, " $1").trim();
}

export function FlowTaskQueueEvent({ it, locale }: { it: FlowTaskQueueEvent; locale: string }) {
  const icon = QUEUE_EVENT_ICONS[it.eventType] ?? "📋";
  const label = queueEventLabel(it.eventType, locale);
  const taskShort = it.taskId ? String(it.taskId).slice(0, 8) : null;
  const entryShort = it.entryId ? it.entryId.slice(0, 8) : null;
  const goal = typeof it.data.goal === "string" ? it.data.goal : null;
  const errorMsg = typeof it.data.error === "string" ? it.data.error : null;
  const isTerminal = ["completed", "failed", "cancelled"].includes(it.eventType);
  const isFailed = it.eventType === "failed";

  return (
    <div style={{
      padding: "6px 10px",
      fontSize: 13,
      lineHeight: 1.5,
      color: isFailed ? "#dc2626" : isTerminal ? "#6b7280" : "#374151",
      background: isFailed ? "#fef2f2" : isTerminal ? "#f9fafb" : "#f0f9ff",
      borderRadius: 6,
      borderLeft: `3px solid ${isFailed ? "#dc2626" : isTerminal ? "#9ca3af" : "#3b82f6"}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span>{icon}</span>
        <span style={{ fontWeight: 500 }}>{label}</span>
        {taskShort && (
          <span style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace" }}>#{taskShort}</span>
        )}
        {entryShort && !taskShort && (
          <span style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace" }}>E:{entryShort}</span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#9ca3af" }}>
          {new Date(it.timestamp).toLocaleTimeString()}
        </span>
      </div>
      {goal && (
        <div style={{ marginTop: 2, fontSize: 12, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {goal.length > 80 ? goal.slice(0, 80) + "…" : goal}
        </div>
      )}
      {errorMsg && (
        <div style={{ marginTop: 2, fontSize: 12, color: "#dc2626" }}>
          {errorMsg}
        </div>
      )}
    </div>
  );
}
