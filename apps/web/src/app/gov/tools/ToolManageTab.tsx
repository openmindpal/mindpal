"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, Table, FormHint } from "@/components/ui";
import { toApiError } from "@/lib/apiError";
import type { ToolsTabContext } from "./types";
import { useFormState } from "@/hooks/useFormState";

const PAGE_SIZE = 20;

/**
 * 工具管理 Tab：工具列表 + 批量操作 + 启用/禁用 + 设置活跃版本。
 *
 * 操作引导：
 * - 从工具列表中勾选工具，可批量启用/禁用
 * - 单个工具操作请在下方「Rollout 操作」卡片中选择工具并操作
 * - 禁用工具前会自动执行影响分析，提示当前正在使用该工具的任务数
 */
export default function ToolManageTab({ ctx }: { ctx: ToolsTabContext }) {
  const { locale, busy, tools, rollouts } = ctx;

  // ── Tool selection for batch ops ──
  const [selectedToolNames, setSelectedToolNames] = useState<Set<string>>(new Set());
  const allToolNames = useMemo(() => tools.map((td) => td.activeToolRef ?? td.name ?? "").filter(Boolean), [tools]);
  const isAllSelected = allToolNames.length > 0 && selectedToolNames.size === allToolNames.length;

  function toggleToolSelection(ref: string) {
    setSelectedToolNames((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }
  function toggleSelectAll() {
    if (isAllSelected) setSelectedToolNames(new Set());
    else setSelectedToolNames(new Set(allToolNames));
  }

  // ── Rollout action state (useFormState) ──
  const rolloutForm = useFormState({
    initial: { toolRef: "", manualToolRefMode: false, rolloutScope: "space" as "space" | "tenant", disableMode: "immediate" as "immediate" | "graceful", graceMinutes: "5", scope: "" as "" | "space" | "tenant" },
  });
  const toolRef = rolloutForm.fields.toolRef;
  const manualToolRefMode = rolloutForm.fields.manualToolRefMode;
  const rolloutScope = rolloutForm.fields.rolloutScope;
  const disableMode = rolloutForm.fields.disableMode;
  const graceMinutes = rolloutForm.fields.graceMinutes;
  const scope = rolloutForm.fields.scope;

  // ── Set active state ──
  const [toolName, setToolName] = useState("");
  const [activeToolRef, setActiveToolRef] = useState("");

  // ── Pagination ──
  const [toolsPage, setToolsPage] = useState(0);
  const toolsTotalPages = Math.max(1, Math.ceil(tools.length / PAGE_SIZE));
  const pagedTools = useMemo(() => tools.slice(toolsPage * PAGE_SIZE, (toolsPage + 1) * PAGE_SIZE), [tools, toolsPage]);

  // ── Derived state ──
  const selectedToolRollout = useMemo(() => {
    if (!toolRef.trim()) return null;
    const name = toolRef.split("@")[0] ?? toolRef;
    return rollouts.find((r) => {
      const ref = r.toolRef?.split("@")[0] ?? r.toolRef;
      return ref === name && r.scopeType === rolloutScope;
    }) ?? null;
  }, [toolRef, rollouts, rolloutScope]);
  const selectedToolEnabled = selectedToolRollout?.enabled ?? null;

  // ── Actions ──
  async function batchAction(action: "enable" | "disable") {
    if (selectedToolNames.size === 0) return;
    await ctx.runAction(async () => {
      const res = await apiFetch("/governance/tools/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({ toolRefs: Array.from(selectedToolNames), action, scope: rolloutScope }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setSelectedToolNames(new Set());
      return json;
    });
  }

  async function enableDisable(enabled: boolean) {
    await ctx.runAction(async () => {
      if (!enabled) {
        try {
          const impactRes = await apiFetch(
            `/governance/tools/${encodeURIComponent(toolRef.trim())}/impact-analysis`,
            { locale, cache: "no-store" },
          );
          if (impactRes.ok) {
            const impact = (await impactRes.json()) as any;
            if (impact?.activeRunCount > 0) {
              const confirmed = window.confirm(
                t(locale, "gov.tools.disableImpactWarning")
                  .replace("{riskFactors}", (impact.riskSummary?.riskFactors ?? []).join("\n"))
                  .replace("{recommendation}", impact.riskSummary?.recommendation ?? ""),
              );
              if (!confirmed) return;
            }
          }
        } catch {
          console.warn("[gov.tools] impact-analysis call failed, proceeding with disable");
        }
      }
      const path = enabled ? "enable" : "disable";
      const bodyPayload: Record<string, unknown> = { scope: rolloutScope };
      if (!enabled) {
        bodyPayload.mode = disableMode;
        if (disableMode === "graceful") bodyPayload.graceMinutes = Number(graceMinutes) || 5;
      }
      const res = await apiFetch(`/governance/tools/${encodeURIComponent(toolRef.trim())}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify(bodyPayload),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  async function setActive() {
    await ctx.runAction(async () => {
      const res = await apiFetch(`/governance/tools/${encodeURIComponent(toolName.trim())}/active`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({ toolRef: activeToolRef.trim() }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  return (
    <>
      <Table header={<span>{t(locale, "gov.tools.definitionsTitle")} ({tools.length})</span>}>
        <thead>
          <tr>
            <th style={{ width: 32 }}>
              <input type="checkbox" checked={isAllSelected} onChange={toggleSelectAll} disabled={busy || allToolNames.length === 0} title={isAllSelected ? t(locale, "gov.tools.clearAll") : t(locale, "gov.tools.selectAll")} />
            </th>
            <th align="left">{t(locale, "gov.tools.col.name")}</th>
            <th align="left">{t(locale, "gov.tools.col.displayName")}</th>
            <th align="left">{t(locale, "gov.tools.col.description")}</th>
            <th align="left">{t(locale, "gov.tools.col.scopeField")}</th>
            <th align="left">{t(locale, "gov.tools.col.riskLevel")}</th>
            <th align="left">{t(locale, "gov.tools.col.approvalRequired")}</th>
            <th align="left">{t(locale, "gov.tools.col.activeToolRef")}</th>
          </tr>
        </thead>
        <tbody>
          {pagedTools.length === 0 ? (
            <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(locale, "widget.noData")}</td></tr>
          ) : pagedTools.map((td, idx) => {
            const ref = td.activeToolRef ?? td.name ?? "";
            return (
              <tr key={`${td.name ?? "x"}:${idx}`}>
                <td><input type="checkbox" checked={selectedToolNames.has(ref)} onChange={() => toggleToolSelection(ref)} disabled={busy} /></td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{td.name ?? "-"}</td>
                <td>{td.displayName ? text(td.displayName as Record<string, string>, locale) : "-"}</td>
                <td>{td.description ? text(td.description as Record<string, string>, locale) : "-"}</td>
                <td>{td.scope ?? "-"}</td>
                <td><Badge>{td.riskLevel ?? "-"}</Badge></td>
                <td>{td.approvalRequired ? "✓" : "-"}</td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{td.activeToolRef ?? "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      {/* 批量操作栏 — 勾选工具后出现 */}
      {selectedToolNames.size > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", marginTop: 8, borderRadius: 6, background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.2)" }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {t(locale, "gov.tools.batchSelected").replace("{count}", String(selectedToolNames.size))}
          </span>
          <button onClick={() => batchAction("enable")} disabled={busy} style={{ fontSize: 13 }}>
            {t(locale, "gov.tools.batchEnable")}
          </button>
          <button onClick={() => batchAction("disable")} disabled={busy} style={{ fontSize: 13 }}>
            {t(locale, "gov.tools.batchDisable")}
          </button>
          <button onClick={() => setSelectedToolNames(new Set())} disabled={busy} style={{ fontSize: 11, color: "var(--sl-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
            {t(locale, "gov.tools.clearSelection")}
          </button>
        </div>
      )}

      {/* 分页 */}
      {toolsTotalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            {t(locale, "pagination.showing").replace("{from}", String(toolsPage * PAGE_SIZE + 1)).replace("{to}", String(Math.min((toolsPage + 1) * PAGE_SIZE, tools.length)))}
            {t(locale, "pagination.total").replace("{count}", String(tools.length))}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={toolsPage === 0} onClick={() => setToolsPage((p) => Math.max(0, p - 1))}>{t(locale, "pagination.prev")}</button>
            <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(locale, "pagination.page").replace("{page}", String(toolsPage + 1))}</span>
            <button disabled={toolsPage >= toolsTotalPages - 1} onClick={() => setToolsPage((p) => p + 1)}>{t(locale, "pagination.next")}</button>
          </div>
        </div>
      )}

      {/* 筛选 */}
      <div style={{ marginTop: 16 }}>
        <Card title={t(locale, "gov.tools.filterTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(locale, "gov.tools.scope")}</span>
              <select value={scope} onChange={(e) => rolloutForm.setField("scope", e.target.value === "tenant" ? "tenant" : e.target.value === "space" ? "space" : "")} disabled={busy}>
                <option value="">{t(locale, "gov.tools.scopeAll")}</option>
                <option value="space">{t(locale, "scope.space")}</option>
                <option value="tenant">{t(locale, "scope.tenant")}</option>
              </select>
            </label>
            <button onClick={ctx.refresh} disabled={busy}>
              {t(locale, "action.apply")}
            </button>
          </div>
        </Card>
      </div>

      {/* Rollout 操作 — 选择工具后可启用/禁用 */}
      <div style={{ marginTop: 16 }}>
        <Card title={t(locale, "gov.tools.rolloutActionsTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(locale, "gov.tools.toolRef")}<FormHint text={t(locale, "gov.tools.hint.toolRef")} /></div>
              {!manualToolRefMode ? (
                <>
                  <select value={toolRef} onChange={(e) => rolloutForm.setField("toolRef", e.target.value)} disabled={busy} style={{ minWidth: 260 }}>
                    <option value="" disabled>
                      {tools.length === 0 ? t(locale, "gov.tools.emptyTools") : t(locale, "gov.tools.selectToolPlaceholder")}
                    </option>
                    {tools.map((td, idx) => {
                      const ref = td.activeToolRef ?? td.name ?? "";
                      const displayLabel = td.displayName ? `${td.name} - ${text(td.displayName as Record<string, string>, locale)}` : td.name ?? "";
                      const risk = td.riskLevel ? ` (${td.riskLevel})` : "";
                      return (
                        <option key={`${td.name ?? "x"}:${idx}`} value={ref}>
                          {displayLabel}{risk}
                        </option>
                      );
                    })}
                  </select>
                  <button type="button" onClick={() => rolloutForm.setField("manualToolRefMode", true)} style={{ fontSize: 11, color: "var(--sl-muted)", background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left", textDecoration: "underline" }}>
                    {t(locale, "gov.tools.manualInput")}
                  </button>
                </>
              ) : (
                <>
                  <input value={toolRef} onChange={(e) => rolloutForm.setField("toolRef", e.target.value)} disabled={busy} placeholder="builtin:http_request" />
                  <button type="button" onClick={() => rolloutForm.setField("manualToolRefMode", false)} style={{ fontSize: 11, color: "var(--sl-muted)", background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left", textDecoration: "underline" }}>
                    {t(locale, "gov.tools.selectFromList")}
                  </button>
                </>
              )}
              <div style={{ fontSize: 11, color: "var(--sl-muted)" }}>{t(locale, "gov.tools.toolRefHint")}</div>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(locale, "gov.tools.scope")}<FormHint text={t(locale, "gov.tools.hint.scope")} /></div>
              <select value={rolloutScope} onChange={(e) => rolloutForm.setField("rolloutScope", e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
                <option value="space">{t(locale, "scope.space")}</option>
                <option value="tenant">{t(locale, "scope.tenant")}</option>
              </select>
            </label>
            {/* 当前状态提示 */}
            {selectedToolEnabled !== null && (
              <div style={{ fontSize: 12, padding: "4px 8px", borderRadius: 4, background: selectedToolEnabled ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", color: selectedToolEnabled ? "#16a34a" : "#dc2626", width: "fit-content" }}>
                {selectedToolEnabled ? t(locale, "gov.tools.currentlyEnabled") : t(locale, "gov.tools.currentlyDisabled")}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={() => enableDisable(true)} disabled={busy || !toolRef.trim()} style={selectedToolEnabled === true ? { opacity: 0.5 } : {}} title={selectedToolEnabled === true ? t(locale, "gov.tools.alreadyEnabled") : undefined}>
                {t(locale, "gov.tools.enable")}
              </button>
              <button onClick={() => enableDisable(false)} disabled={busy || !toolRef.trim()} style={selectedToolEnabled === false ? { opacity: 0.5 } : {}} title={selectedToolEnabled === false ? t(locale, "gov.tools.alreadyDisabled") : undefined}>
                {t(locale, "gov.tools.disable")}
              </button>
            </div>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(locale, "gov.tools.disableMode")}</div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <label style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
                  <input type="radio" name="disableMode" value="immediate" checked={disableMode === "immediate"} onChange={() => rolloutForm.setField("disableMode", "immediate")} disabled={busy} />
                  <span>{t(locale, "gov.tools.disableImmediate")}</span>
                </label>
                <label style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
                  <input type="radio" name="disableMode" value="graceful" checked={disableMode === "graceful"} onChange={() => rolloutForm.setField("disableMode", "graceful")} disabled={busy} />
                  <span>{t(locale, "gov.tools.disableGraceful")}</span>
                </label>
              </div>
              {disableMode === "graceful" && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", paddingLeft: 4 }}>
                  <span style={{ fontSize: 12 }}>{t(locale, "gov.tools.gracePeriod")}</span>
                  <input type="number" min={1} max={1440} value={graceMinutes} onChange={(e) => rolloutForm.setField("graceMinutes", e.target.value)} disabled={busy} style={{ width: 70 }} />
                  <span style={{ fontSize: 12 }}>{t(locale, "gov.tools.minutes")}</span>
                  <span style={{ fontSize: 11, color: "var(--sl-muted)" }}>{t(locale, "gov.tools.graceHint")}</span>
                </div>
              )}
            </label>
          </div>
        </Card>
      </div>

      {/* 活跃版本设置 */}
      <div style={{ marginTop: 16 }}>
        <Card title={t(locale, "gov.tools.activeActionsTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(locale, "gov.tools.toolName")}<FormHint text={t(locale, "gov.tools.hint.toolName")} /></div>
              <input value={toolName} onChange={(e) => setToolName(e.target.value)} disabled={busy} placeholder="http_request" />
              <div style={{ fontSize: 11, color: "var(--sl-muted)" }}>{t(locale, "gov.tools.toolNameHint")}</div>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(locale, "gov.tools.activeToolRef")}<FormHint text={t(locale, "gov.tools.hint.activeToolRef")} /></div>
              <input value={activeToolRef} onChange={(e) => setActiveToolRef(e.target.value)} disabled={busy} placeholder="builtin:http_request@v2" />
              <div style={{ fontSize: 11, color: "var(--sl-muted)" }}>{t(locale, "gov.tools.activeToolRefHint")}</div>
            </label>
            <div>
              <button onClick={setActive} disabled={busy || !toolName.trim() || !activeToolRef.trim()}>
                {t(locale, "gov.tools.setActive")}
              </button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
