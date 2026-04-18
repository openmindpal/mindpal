"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table, StatusBadge, StructuredData, JsonFormEditor } from "@/components/ui";
import { toApiError, errText } from "@/lib/apiError";
import { toDisplayText, toRecord } from "@/lib/viewData";

type Device = Record<string, unknown>;
type Artifact = Record<string, unknown>;
type ToolDef = { name: string; displayName?: Record<string, string> | string | null; category?: string; riskLevel?: string; sourceLayer?: string };

type InitialData = { status: number; json: unknown };

export default function GovDevicesClient(props: { locale: string; initial?: InitialData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [ownerScope, setOwnerScope] = useState<"space" | "user">("space");
  const [devicesResp, setDevicesResp] = useState<{ status: number; json: any }>(props.initial ? { status: props.initial.status, json: props.initial.json } : { status: 0, json: null });
  const devices = useMemo(() => (Array.isArray(devicesResp?.json?.devices) ? (devicesResp.json.devices as Device[]) : []), [devicesResp]);

  const [selectedId, setSelectedId] = useState("");
  const [detailResp, setDetailResp] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const device = useMemo(() => toRecord(detailResp?.json?.device), [detailResp]);
  const policy = useMemo(() => toRecord(detailResp?.json?.policy), [detailResp]);

  const [createDeviceType, setCreateDeviceType] = useState<"desktop" | "mobile">("desktop");
  const [createOs, setCreateOs] = useState("macOS");
  const [createAgentVersion, setCreateAgentVersion] = useState("0.1.0");
  const [createStatus, setCreateStatus] = useState(0);
  const [createResult, setCreateResult] = useState<any>(null);

  const [pairStatus, setPairStatus] = useState(0);
  const [pairResult, setPairResult] = useState<any>(null);
  const [pairCopied, setPairCopied] = useState(false);

  // 工具选择器状态
  const [availableTools, setAvailableTools] = useState<ToolDef[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [deviceToolsOnly, setDeviceToolsOnly] = useState(true);

  const [policyJson, setPolicyJson] = useState<string>("{\"evidencePolicy\":{\"allowUpload\":true,\"allowedTypes\":[\"text/plain\"],\"retentionDays\":7}}");
  const [savePolicyStatus, setSavePolicyStatus] = useState(0);
  const [savePolicyResult, setSavePolicyResult] = useState<any>(null);

  const [evidenceResp, setEvidenceResp] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const evidenceItems = useMemo(() => (Array.isArray(evidenceResp?.json?.items) ? (evidenceResp.json.items as Artifact[]) : []), [evidenceResp]);
  const [downloadStatus, setDownloadStatus] = useState(0);
  const [downloadResult, setDownloadResult] = useState<any>(null);

  async function refreshDevices() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      q.set("limit", "50");
      q.set("offset", "0");
      q.set("ownerScope", ownerScope);
      const res = await apiFetch(`/devices?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      setDevicesResp({ status: res.status, json });
      if (!res.ok) throw toApiError(json);
      const list = toRecord(json)?.devices;
      if (!selectedId && Array.isArray(list) && list.length) setSelectedId(toDisplayText(toRecord(list[0])?.deviceId));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      setDevicesResp({ status: 0, json: null });
    } finally {
      setBusy(false);
    }
  }

  async function loadDetail(deviceId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/devices/${encodeURIComponent(deviceId)}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      setDetailResp({ status: res.status, json });
      if (!res.ok) throw toApiError(json);
      const pol = toRecord(toRecord(json)?.policy);
      if (pol) {
        const next = {
          allowedTools: pol.allowedTools ?? null,
          filePolicy: pol.filePolicy ?? null,
          networkPolicy: pol.networkPolicy ?? null,
          uiPolicy: pol.uiPolicy ?? null,
          evidencePolicy: pol.evidencePolicy ?? null,
          limits: pol.limits ?? null,
        };
        setPolicyJson(JSON.stringify(next, null, 2));
        // 同步 allowedTools 到工具选择器
        if (Array.isArray(pol.allowedTools)) {
          setSelectedTools(new Set(pol.allowedTools.map(String)));
        } else {
          setSelectedTools(new Set());
        }
      }
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      setDetailResp({ status: 0, json: null });
    } finally {
      setBusy(false);
    }
  }

  async function createDevice() {
    setError("");
    setCreateResult(null);
    setCreateStatus(0);
    setBusy(true);
    try {
      const res = await apiFetch(`/devices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ ownerScope, deviceType: createDeviceType, os: createOs, agentVersion: createAgentVersion }),
      });
      setCreateStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setCreateResult(json);
      await refreshDevices();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createPairing(deviceId: string) {
    setError("");
    setPairResult(null);
    setPairStatus(0);
    setPairCopied(false);
    setBusy(true);
    try {
      const res = await apiFetch(`/devices/${encodeURIComponent(deviceId)}/pairing`, { method: "POST", locale: props.locale });
      setPairStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPairResult(json);
      await loadDetail(deviceId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  // 获取可用工具列表
  const loadAvailableTools = useCallback(async () => {
    setToolsLoading(true);
    try {
      const res = await apiFetch(`/tools`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (res.ok && json && typeof json === "object" && Array.isArray((json as any).tools)) {
        setAvailableTools((json as any).tools as ToolDef[]);
      }
    } catch {
      // 忽略加载失败
    } finally {
      setToolsLoading(false);
    }
  }, [props.locale]);

  // 首次加载工具列表
  useEffect(() => { loadAvailableTools(); }, [loadAvailableTools]);

  // 过滤后的工具列表
  const filteredTools = useMemo(() => {
    if (deviceToolsOnly) return availableTools.filter((t) => t.name.startsWith("device."));
    return availableTools;
  }, [availableTools, deviceToolsOnly]);

  function toggleTool(name: string) {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectAllTools() {
    setSelectedTools(new Set(filteredTools.map((t) => t.name)));
  }

  function deselectAllTools() {
    setSelectedTools(new Set());
  }

  // 将工具选择器的勾选应用到 JSON 策略编辑器
  function applyToolSelectionToPolicy() {
    try {
      const obj = JSON.parse(policyJson || "{}");
      obj.allowedTools = [...selectedTools].sort();
      setPolicyJson(JSON.stringify(obj, null, 2));
    } catch {
      setPolicyJson(JSON.stringify({ allowedTools: [...selectedTools].sort() }, null, 2));
    }
  }

  // 配对命令生成
  const pairingCommand = useMemo(() => {
    if (!pairResult) return "";
    const rec = toRecord(pairResult);
    const code = rec?.pairingCode ? toDisplayText(rec.pairingCode) : "";
    if (!code) return "";
    return `npx openslin-device-agent pair --pairingCode ${code}`;
  }, [pairResult]);

  async function copyPairingCommand() {
    try {
      await navigator.clipboard.writeText(pairingCommand);
      setPairCopied(true);
      setTimeout(() => setPairCopied(false), 2000);
    } catch { /* fallback: user can manually copy */ }
  }

  async function revoke(deviceId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshDevices();
      await loadDetail(deviceId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy(deviceId: string) {
    setError("");
    setSavePolicyResult(null);
    setSavePolicyStatus(0);
    setBusy(true);
    try {
      let obj: any = {};
      try {
        obj = JSON.parse(policyJson || "{}");
      } catch {
        obj = {};
      }
      const res = await apiFetch(`/devices/${encodeURIComponent(deviceId)}/policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(obj),
      });
      setSavePolicyStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setSavePolicyResult(json);
      await loadDetail(deviceId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadEvidence(deviceId: string) {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      q.set("limit", "50");
      q.set("deviceId", deviceId);
      const res = await apiFetch(`/artifacts/device-evidence?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      setEvidenceResp({ status: res.status, json });
      if (!res.ok) throw toApiError(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      setEvidenceResp({ status: 0, json: null });
    } finally {
      setBusy(false);
    }
  }

  async function createDownloadToken(artifactId: string) {
    setError("");
    setDownloadResult(null);
    setDownloadStatus(0);
    setBusy(true);
    try {
      const res = await apiFetch(`/artifacts/${encodeURIComponent(artifactId)}/download-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({}),
      });
      setDownloadStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setDownloadResult(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.devices")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={devicesResp.status} />
            <select value={ownerScope} onChange={(e) => setOwnerScope(e.target.value as any)} disabled={busy}>
              <option value="space">{t(props.locale, "gov.devices.ownerScope.space")}</option>
              <option value="user">{t(props.locale, "gov.devices.ownerScope.user")}</option>
            </select>
            <button disabled={busy} onClick={refreshDevices}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.devices.createTitle")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={createDeviceType} onChange={(e) => setCreateDeviceType(e.target.value as any)} disabled={busy}>
            <option value="desktop">{t(props.locale, "gov.devices.deviceType.desktop")}</option>
            <option value="mobile">{t(props.locale, "gov.devices.deviceType.mobile")}</option>
          </select>
          <input value={createOs} onChange={(e) => setCreateOs(e.currentTarget.value)} placeholder={t(props.locale, "gov.devices.placeholder.os")} disabled={busy} />
          <input value={createAgentVersion} onChange={(e) => setCreateAgentVersion(e.currentTarget.value)} placeholder={t(props.locale, "gov.devices.placeholder.agentVersion")} disabled={busy} />
          <button disabled={busy} onClick={createDevice}>
            {t(props.locale, "action.create")}
          </button>
          {createStatus ? <StatusBadge locale={props.locale} status={createStatus} /> : null}
        </div>
        {createResult ? <div style={{ marginTop: 8 }}><StructuredData data={createResult} /></div> : null}
      </Card>

      <Card title={t(props.locale, "gov.devices.listTitle")}>
        <Table header={<span>{devices.length ? `${devices.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.devices.table.deviceId")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.deviceType")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.status")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.lastSeenAt")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.agentVersion")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d, idx) => {
              const rec = toRecord(d);
              const id = rec ? toDisplayText(rec.deviceId ?? idx) : String(idx);
              return (
                <tr key={id}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{id}</td>
                  <td>{rec ? toDisplayText(rec.deviceType ?? "-") : "-"}</td>
                  <td>{rec ? <Badge>{statusLabel(toDisplayText(rec.status ?? "-"), props.locale)}</Badge> : "-"}</td>
                  <td>{fmtDateTime(rec?.lastSeenAt ?? rec?.lastSeenAtMs, props.locale)}</td>
                  <td>{rec ? toDisplayText(rec.agentVersion ?? "-") : "-"}</td>
                  <td>
                    <button
                      disabled={busy || !id}
                      onClick={async () => {
                        setSelectedId(id);
                        await loadDetail(id);
                      }}
                    >
                      {t(props.locale, "gov.devices.view")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card
        title={t(props.locale, "gov.devices.detailTitle")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={detailResp.status} />
            <input value={selectedId} onChange={(e) => setSelectedId(e.currentTarget.value)} placeholder={t(props.locale, "gov.devices.placeholder.deviceId")} style={{ width: 420 }} disabled={busy} />
            <button disabled={busy || !selectedId.trim()} onClick={() => loadDetail(selectedId.trim())}>
              {t(props.locale, "action.load")}
            </button>
          </div>
        }
      >
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button disabled={busy || !selectedId.trim()} onClick={() => createPairing(selectedId.trim())}>
              {t(props.locale, "gov.devices.pairing")}
            </button>
            {pairStatus ? <StatusBadge locale={props.locale} status={pairStatus} /> : null}
            <button disabled={busy || !selectedId.trim()} onClick={() => revoke(selectedId.trim())}>
              {t(props.locale, "gov.devices.revoke")}
            </button>
          </div>
          {pairResult ? <StructuredData data={pairResult} /> : null}

          {/* 配对命令一键复制 */}
          {pairingCommand ? (
            <div style={{ background: "#1a1a2e", borderRadius: 8, padding: "12px 16px", marginTop: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ color: "#a0a0c0", fontSize: 13 }}>
                  {t(props.locale, "gov.devices.pairing.commandHint")}
                  <span style={{ marginLeft: 8, color: "#ff9800", fontSize: 12 }}>{t(props.locale, "gov.devices.pairing.expiresIn")}</span>
                </span>
                <button
                  onClick={copyPairingCommand}
                  style={{ fontSize: 12, padding: "4px 12px", background: pairCopied ? "#4caf50" : "#3f51b5", color: "white", border: "none", borderRadius: 4, cursor: "pointer" }}
                >
                  {pairCopied ? t(props.locale, "gov.devices.pairing.copied") + " ✓" : t(props.locale, "gov.devices.pairing.copy")}
                </button>
              </div>
              <pre style={{ margin: 0, color: "#e0e0ff", fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", overflowX: "auto", userSelect: "all" }}>
                {pairingCommand}
              </pre>
            </div>
          ) : null}

          <StructuredData data={{ device, policy }} />
        </div>
      </Card>

      <Card
        title={t(props.locale, "gov.devices.toolSelector.title")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "#666" }}>
              {t(props.locale, "gov.devices.toolSelector.selected").replace("{count}", String(selectedTools.size))}
            </span>
            <button disabled={busy || !selectedId.trim() || selectedTools.size === 0} onClick={applyToolSelectionToPolicy}>
              {t(props.locale, "gov.devices.toolSelector.applyToPolicy")}
            </button>
            <button disabled={busy || !selectedId.trim() || selectedTools.size === 0} onClick={() => { applyToolSelectionToPolicy(); setTimeout(() => savePolicy(selectedId.trim()), 100); }}>
              {t(props.locale, "action.save")}
            </button>
          </div>
        }
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
            <input type="checkbox" checked={deviceToolsOnly} onChange={() => setDeviceToolsOnly(!deviceToolsOnly)} />
            {t(props.locale, "gov.devices.toolSelector.devicePrefix")}
          </label>
          <button onClick={selectAllTools} disabled={busy} style={{ fontSize: 12, padding: "2px 8px" }}>
            {t(props.locale, "gov.devices.toolSelector.selectAll")}
          </button>
          <button onClick={deselectAllTools} disabled={busy} style={{ fontSize: 12, padding: "2px 8px" }}>
            {t(props.locale, "gov.devices.toolSelector.deselectAll")}
          </button>
          {toolsLoading ? <span style={{ fontSize: 12, color: "#999" }}>{t(props.locale, "gov.devices.toolSelector.loading")}</span> : null}
        </div>

        {filteredTools.length === 0 && !toolsLoading ? (
          <div style={{ color: "#999", fontSize: 13, padding: 8 }}>{t(props.locale, "gov.devices.toolSelector.empty")}</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 6, maxHeight: 320, overflowY: "auto", padding: 4 }}>
            {filteredTools.map((tool) => {
              const checked = selectedTools.has(tool.name);
              const displayName = tool.displayName
                ? (typeof tool.displayName === "string" ? tool.displayName : (tool.displayName as Record<string, string>)[props.locale] ?? (tool.displayName as Record<string, string>)["zh-CN"] ?? tool.name)
                : tool.name;
              const riskColor = tool.riskLevel === "high" ? "#f44336" : tool.riskLevel === "medium" ? "#ff9800" : "#4caf50";
              return (
                <label
                  key={tool.name}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                    borderRadius: 6, border: checked ? "1.5px solid #3f51b5" : "1px solid #e0e0e0",
                    background: checked ? "#e8eaf6" : "transparent", cursor: "pointer", fontSize: 13,
                    transition: "all 0.15s",
                  }}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggleTool(tool.name)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
                    <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace" }}>{tool.name}</div>
                  </div>
                  <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: riskColor, color: "white" }}>
                    {tool.riskLevel ?? "low"}
                  </span>
                  {tool.category ? <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "#e0e0e0", color: "#555" }}>{tool.category}</span> : null}
                </label>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title={t(props.locale, "gov.devices.policyTitle")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button disabled={busy || !selectedId.trim()} onClick={() => savePolicy(selectedId.trim())}>
              {t(props.locale, "action.save")}
            </button>
            {savePolicyStatus ? <StatusBadge locale={props.locale} status={savePolicyStatus} /> : null}
          </div>
        }
      >
        <JsonFormEditor value={policyJson} onChange={setPolicyJson} locale={props.locale} disabled={busy} rows={8} />
        {savePolicyResult ? <div style={{ marginTop: 8 }}><StructuredData data={savePolicyResult} /></div> : null}
      </Card>

      <Card
        title={t(props.locale, "gov.devices.evidenceTitle")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={evidenceResp.status} />
            <button disabled={busy || !selectedId.trim()} onClick={() => loadEvidence(selectedId.trim())}>
              {t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      >
        <Table header={<span>{evidenceItems.length ? `${evidenceItems.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.devices.table.artifactId")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.type")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {evidenceItems.map((a, idx) => {
              const rec = toRecord(a);
              const artifactId = rec ? toDisplayText(rec.artifactId ?? idx) : String(idx);
              return (
                <tr key={artifactId}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{artifactId}</td>
                  <td>{rec ? toDisplayText(rec.type ?? "-") : "-"}</td>
                  <td>{fmtDateTime(rec?.createdAt, props.locale)}</td>
                  <td>
                    <button disabled={busy || !artifactId} onClick={() => createDownloadToken(artifactId)}>
                      {t(props.locale, "gov.devices.download")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>

        {downloadStatus ? <StatusBadge locale={props.locale} status={downloadStatus} /> : null}
        {downloadResult ? <div style={{ marginTop: 8 }}><StructuredData data={downloadResult} /></div> : null}
      </Card>
    </div>
  );
}
