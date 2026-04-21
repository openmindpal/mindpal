"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui";

/**
 * Three-way merge conflict resolver for a single conflict item.
 * Shows local | merged result | remote in a side-by-side view,
 * with strategy selection and confirm/cancel buttons.
 */
export default function ConflictResolver(props: {
  locale: string;
  conflict: {
    field: string;
    localValue: unknown;
    remoteValue: unknown;
  };
  onResolve: (field: string, pick: "local" | "remote" | "manual", mergedValue?: unknown) => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const { conflict } = props;
  const localStr = typeof conflict.localValue === "object" ? JSON.stringify(conflict.localValue, null, 2) : String(conflict.localValue ?? "");
  const remoteStr = typeof conflict.remoteValue === "object" ? JSON.stringify(conflict.remoteValue, null, 2) : String(conflict.remoteValue ?? "");

  const [strategy, setStrategy] = useState<"local" | "remote" | "manual">("local");
  const [mergedText, setMergedText] = useState(localStr);

  function handleConfirm() {
    if (strategy === "manual") {
      try {
        const parsed = JSON.parse(mergedText);
        props.onResolve(conflict.field, "manual", parsed);
      } catch {
        props.onResolve(conflict.field, "manual", mergedText);
      }
    } else {
      props.onResolve(conflict.field, strategy);
    }
  }

  return (
    <Card title={`${conflict.field}`}>
      {/* Three-column view */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
            {t(props.locale, "gov.syncConflicts.threeWay.local")}
          </div>
          <pre style={{
            margin: 0,
            padding: 8,
            background: "#fff3e0",
            whiteSpace: "pre-wrap",
            fontSize: 12,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            minHeight: 60,
            borderRadius: 4,
          }}>
            {localStr}
          </pre>
        </div>

        <div>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
            {t(props.locale, "gov.syncConflicts.threeWay.merged")}
          </div>
          {strategy === "manual" ? (
            <textarea
              value={mergedText}
              onChange={(e) => setMergedText(e.target.value)}
              disabled={props.disabled}
              style={{
                width: "100%",
                minHeight: 60,
                padding: 8,
                fontSize: 12,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                borderRadius: 4,
                border: "1px solid #ccc",
                boxSizing: "border-box",
              }}
            />
          ) : (
            <pre style={{
              margin: 0,
              padding: 8,
              background: "#e8f5e9",
              whiteSpace: "pre-wrap",
              fontSize: 12,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              minHeight: 60,
              borderRadius: 4,
            }}>
              {strategy === "local" ? localStr : remoteStr}
            </pre>
          )}
        </div>

        <div>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
            {t(props.locale, "gov.syncConflicts.threeWay.remote")}
          </div>
          <pre style={{
            margin: 0,
            padding: 8,
            background: "#e3f2fd",
            whiteSpace: "pre-wrap",
            fontSize: 12,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            minHeight: 60,
            borderRadius: 4,
          }}>
            {remoteStr}
          </pre>
        </div>
      </div>

      {/* Strategy selection */}
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
        <label style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
          <input type="radio" checked={strategy === "local"} onChange={() => { setStrategy("local"); setMergedText(localStr); }} />
          <span style={{ fontSize: 13 }}>{t(props.locale, "gov.syncConflicts.strategy.keepLocal")}</span>
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
          <input type="radio" checked={strategy === "remote"} onChange={() => { setStrategy("remote"); setMergedText(remoteStr); }} />
          <span style={{ fontSize: 13 }}>{t(props.locale, "gov.syncConflicts.strategy.keepRemote")}</span>
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
          <input type="radio" checked={strategy === "manual"} onChange={() => setStrategy("manual")} />
          <span style={{ fontSize: 13 }}>{t(props.locale, "gov.syncConflicts.strategy.manual")}</span>
        </label>
      </div>

      {/* Confirm / Cancel */}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={handleConfirm} disabled={props.disabled}>
          {t(props.locale, "action.save")}
        </button>
        <button onClick={props.onCancel} disabled={props.disabled}>
          {t(props.locale, "action.cancel")}
        </button>
      </div>
    </Card>
  );
}
