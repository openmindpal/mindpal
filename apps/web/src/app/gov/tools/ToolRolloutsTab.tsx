"use client";

import { useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Table } from "@/components/ui";
import type { ToolsTabContext } from "./types";

const PAGE_SIZE = 20;

/**
 * Rollouts & Actives Tab：展示工具灰度记录和活跃版本列表。
 *
 * 操作引导：
 * - 此页面为只读查看，展示当前空间/租户下所有工具的 rollout 状态
 * - enabled = true 表示工具已启用，false 表示已禁用
 * - 「活跃版本」表格展示各工具当前激活的版本引用
 */
export default function ToolRolloutsTab({ ctx }: { ctx: ToolsTabContext }) {
  const { locale, rollouts, actives } = ctx;

  // ── Rollouts Pagination ──
  const [rolloutsPage, setRolloutsPage] = useState(0);
  const rolloutsTotalPages = Math.max(1, Math.ceil(rollouts.length / PAGE_SIZE));
  const pagedRollouts = useMemo(() => rollouts.slice(rolloutsPage * PAGE_SIZE, (rolloutsPage + 1) * PAGE_SIZE), [rollouts, rolloutsPage]);

  // ── Actives Pagination ──
  const [activesPage, setActivesPage] = useState(0);
  const activesTotalPages = Math.max(1, Math.ceil(actives.length / PAGE_SIZE));
  const pagedActives = useMemo(() => actives.slice(activesPage * PAGE_SIZE, (activesPage + 1) * PAGE_SIZE), [actives, activesPage]);

  return (
    <>
      <Table header={<span>{t(locale, "gov.tools.rolloutsTitle")}</span>}>
        <thead>
          <tr>
            <th align="left">{t(locale, "gov.tools.col.scope")}</th>
            <th align="left">{t(locale, "gov.tools.col.toolRef")}</th>
            <th align="left">{t(locale, "gov.tools.enabled")}</th>
            <th align="left">{t(locale, "gov.tools.updatedAt")}</th>
          </tr>
        </thead>
        <tbody>
          {pagedRollouts.length === 0 ? (
            <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(locale, "widget.noData")}</td></tr>
          ) : pagedRollouts.map((r, idx) => (
            <tr key={`${r.tool_ref ?? "x"}:${idx}`}>
              <td>{r.scope_type ?? "-"}:{r.scope_id ?? "-"}</td>
              <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{r.tool_ref ?? "-"}</td>
              <td>{String(r.enabled ?? false)}</td>
              <td>{fmtDateTime(r.updated_at, locale)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {rolloutsTotalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            {t(locale, "pagination.showing").replace("{from}", String(rolloutsPage * PAGE_SIZE + 1)).replace("{to}", String(Math.min((rolloutsPage + 1) * PAGE_SIZE, rollouts.length)))}
            {t(locale, "pagination.total").replace("{count}", String(rollouts.length))}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={rolloutsPage === 0} onClick={() => setRolloutsPage((p) => Math.max(0, p - 1))}>{t(locale, "pagination.prev")}</button>
            <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(locale, "pagination.page").replace("{page}", String(rolloutsPage + 1))}</span>
            <button disabled={rolloutsPage >= rolloutsTotalPages - 1} onClick={() => setRolloutsPage((p) => p + 1)}>{t(locale, "pagination.next")}</button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(locale, "gov.tools.activesTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">{t(locale, "gov.tools.toolName")}</th>
              <th align="left">{t(locale, "gov.tools.activeToolRef")}</th>
              <th align="left">{t(locale, "gov.tools.updatedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {pagedActives.length === 0 ? (
              <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(locale, "widget.noData")}</td></tr>
            ) : pagedActives.map((a, idx) => (
              <tr key={`${a.name ?? "x"}:${idx}`}>
                <td>{a.name ?? "-"}</td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{a.active_tool_ref ?? "-"}</td>
                <td>{a.updated_at ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {activesTotalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
            <span style={{ opacity: 0.7, fontSize: 13 }}>
              {t(locale, "pagination.showing").replace("{from}", String(activesPage * PAGE_SIZE + 1)).replace("{to}", String(Math.min((activesPage + 1) * PAGE_SIZE, actives.length)))}
              {t(locale, "pagination.total").replace("{count}", String(actives.length))}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={activesPage === 0} onClick={() => setActivesPage((p) => Math.max(0, p - 1))}>{t(locale, "pagination.prev")}</button>
              <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(locale, "pagination.page").replace("{page}", String(activesPage + 1))}</span>
              <button disabled={activesPage >= activesTotalPages - 1} onClick={() => setActivesPage((p) => p + 1)}>{t(locale, "pagination.next")}</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
