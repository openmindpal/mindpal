"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Card, Table, StatusBadge, FormHint } from "@/components/ui";
import { toApiError, errText } from "@/lib/apiError";
import type { ToolsTabContext, NetworkPolicy, NetworkPoliciesResponse } from "./types";

const PAGE_SIZE = 20;

const COMMON_DOMAINS = [
  "*.openai.com", "*.anthropic.com", "*.deepseek.com",
  "*.googleapis.com", "*.azure.com", "*.aliyuncs.com",
  "*.volcengine.com", "*.bigmodel.cn", "*.moonshot.cn",
];

function validateDomain(d: string): boolean {
  return /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(d);
}

/**
 * 网络策略 Tab：编辑工具的出站域名白名单 + 查看所有策略列表。
 *
 * 操作引导：
 * - 输入工具引用名称 → 点击「加载」查看现有策略
 * - 在域名白名单区域编辑或使用快捷按钮添加常见域名
 * - 点击「保存」提交策略变更
 * - 下方表格展示当前空间/租户的所有网络策略
 */
export default function ToolNetworkPolicyTab({ ctx }: { ctx: ToolsTabContext }) {
  const { locale, busy } = ctx;

  const [npStatus, setNpStatus] = useState<number>(0);
  const [npScopeType, setNpScopeType] = useState<"space" | "tenant">("space");
  const [npLimit, setNpLimit] = useState<string>("50");
  const [npData, setNpData] = useState<NetworkPoliciesResponse | null>(null);
  const [npToolRef, setNpToolRef] = useState<string>("");
  const [npEditScopeType, setNpEditScopeType] = useState<"space" | "tenant">("space");
  const [npAllowedDomainsText, setNpAllowedDomainsText] = useState<string>("");
  const [npError, setNpError] = useState<string>("");

  const npItems = useMemo(() => (Array.isArray(npData?.items) ? npData!.items! : []), [npData]);
  const [npPage, setNpPage] = useState(0);
  const npTotalPages = Math.max(1, Math.ceil(npItems.length / PAGE_SIZE));
  const pagedNpItems = useMemo(() => npItems.slice(npPage * PAGE_SIZE, (npPage + 1) * PAGE_SIZE), [npItems, npPage]);

  const refreshNetworkPolicies = useCallback(
    async (nextScopeType?: "space" | "tenant") => {
      setNpError("");
      setNpPage(0);
      const q = new URLSearchParams();
      q.set("scopeType", nextScopeType ?? npScopeType);
      const n = Number(npLimit);
      q.set("limit", String(Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50));
      const res = await apiFetch(`/governance/tools/network-policies?${q.toString()}`, { locale, cache: "no-store" });
      setNpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      setNpData((json as NetworkPoliciesResponse) ?? null);
      if (!res.ok) setNpError(errText(locale, (json as any) ?? { errorCode: String(res.status) }));
    },
    [npLimit, npScopeType, locale],
  );

  useEffect(() => {
    queueMicrotask(() => {
      void refreshNetworkPolicies("space");
    });
  }, [refreshNetworkPolicies]);

  async function runNpAction(fn: () => Promise<unknown>) {
    setNpError("");
    try {
      await fn();
      await refreshNetworkPolicies();
    } catch (e: unknown) {
      setNpError(errText(locale, toApiError(e)));
    }
  }

  function addCommonDomain(domain: string) {
    const existing = npAllowedDomainsText.split(/\r?\n/g).map(s => s.trim()).filter(Boolean);
    if (!existing.includes(domain)) {
      setNpAllowedDomainsText((existing.length ? npAllowedDomainsText.trimEnd() + "\n" : "") + domain);
    }
  }

  async function loadNetworkPolicy() {
    await runNpAction(async () => {
      const ref = npToolRef.trim();
      const res = await apiFetch(
        `/governance/tools/${encodeURIComponent(ref)}/network-policy?scopeType=${encodeURIComponent(npEditScopeType)}`,
        { locale, cache: "no-store" },
      );
      setNpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const p = (json as NetworkPolicy) ?? {};
      const allowed = Array.isArray(p.allowedDomains) ? p.allowedDomains : [];
      setNpAllowedDomainsText(allowed.join("\n"));
      return json;
    });
  }

  async function saveNetworkPolicy() {
    await runNpAction(async () => {
      const ref = npToolRef.trim();
      const allowedDomains = npAllowedDomainsText.split(/\r?\n/g).map((s) => s.trim()).filter(Boolean);
      const invalid = allowedDomains.find(d => !validateDomain(d));
      if (invalid) {
        throw { errorCode: "VALIDATION", message: t(locale, "gov.tools.networkPolicyInvalidDomain").replace("{domain}", invalid) };
      }
      const res = await apiFetch(`/governance/tools/${encodeURIComponent(ref)}/network-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({ scopeType: npEditScopeType, allowedDomains }),
      });
      setNpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  return (
    <>
      {npError && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 8 }}>{npError}</div>}

      <Card title={t(locale, "gov.tools.networkPolicyTitle")}>
        <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(locale, "gov.tools.networkPolicyScopeType")}</div>
            <select value={npEditScopeType} onChange={(e) => setNpEditScopeType(e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
              <option value="space">{t(locale, "scope.space")}</option>
              <option value="tenant">{t(locale, "scope.tenant")}</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(locale, "gov.tools.networkPolicyToolRef")}</div>
            <input value={npToolRef} onChange={(e) => setNpToolRef(e.target.value)} disabled={busy} placeholder="builtin:http_request" />
            <div style={{ fontSize: 11, color: "var(--sl-muted)" }}>{t(locale, "gov.tools.networkPolicyToolRefHint")}</div>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(locale, "gov.tools.networkPolicyAllowedDomains")}<FormHint text={t(locale, "gov.tools.hint.allowedDomains")} /></div>
            <textarea rows={6} value={npAllowedDomainsText} onChange={(e) => setNpAllowedDomainsText(e.target.value)} disabled={busy} placeholder={"*.openai.com\n*.anthropic.com"} />
            <div style={{ fontSize: 11, color: "var(--sl-muted)" }}>{t(locale, "gov.tools.networkPolicyAllowedDomainsHint")}</div>
          </label>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>{t(locale, "gov.tools.networkPolicyQuickAdd")}</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {COMMON_DOMAINS.map(d => (
                <button key={d} type="button" onClick={() => addCommonDomain(d)} disabled={busy}
                  style={{ padding: "2px 8px", fontSize: 11, borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-bg)", color: "var(--sl-fg)", cursor: "pointer" }}>
                  + {d}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={loadNetworkPolicy} disabled={busy || !npToolRef.trim()}>
              {t(locale, "gov.tools.networkPolicyLoad")}
            </button>
            <button onClick={saveNetworkPolicy} disabled={busy || !npToolRef.trim()}>
              {t(locale, "gov.tools.networkPolicySave")}
            </button>
            {npStatus ? <StatusBadge locale={locale} status={npStatus} /> : null}
          </div>
        </div>
      </Card>

      {/* 策略列表 */}
      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span>{t(locale, "gov.tools.networkPoliciesTitle")}</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span>{t(locale, "gov.tools.networkPolicyScopeType")}</span>
                  <select value={npScopeType} onChange={(e) => setNpScopeType(e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
                    <option value="space">{t(locale, "scope.space")}</option>
                    <option value="tenant">{t(locale, "scope.tenant")}</option>
                  </select>
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span>{t(locale, "gov.tools.label.limit")}</span>
                  <input value={npLimit} onChange={(e) => setNpLimit(e.target.value)} disabled={busy} style={{ width: 80 }} />
                </label>
                <button onClick={() => refreshNetworkPolicies()} disabled={busy}>
                  {t(locale, "action.refresh")}
                </button>
              </div>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(locale, "gov.tools.col.toolRef")}</th>
              <th align="left">{t(locale, "gov.tools.allowedDomainsCount")}</th>
              <th align="left">{t(locale, "gov.tools.updatedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {pagedNpItems.length === 0 ? (
              <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(locale, "widget.noData")}</td></tr>
            ) : pagedNpItems.map((p, idx) => (
              <tr key={`${p.toolRef ?? "x"}:${idx}`}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{p.toolRef ?? "-"}</td>
                <td>{Array.isArray(p.allowedDomains) ? p.allowedDomains.length : "-"}</td>
                <td>{fmtDateTime(p.updatedAt, locale)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {npTotalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
            <span style={{ opacity: 0.7, fontSize: 13 }}>
              {t(locale, "pagination.showing").replace("{from}", String(npPage * PAGE_SIZE + 1)).replace("{to}", String(Math.min((npPage + 1) * PAGE_SIZE, npItems.length)))}
              {t(locale, "pagination.total").replace("{count}", String(npItems.length))}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={npPage === 0} onClick={() => setNpPage((p) => Math.max(0, p - 1))}>{t(locale, "pagination.prev")}</button>
              <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(locale, "pagination.page").replace("{page}", String(npPage + 1))}</span>
              <button disabled={npPage >= npTotalPages - 1} onClick={() => setNpPage((p) => p + 1)}>{t(locale, "pagination.next")}</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
