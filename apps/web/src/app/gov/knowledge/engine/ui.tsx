"use client";

import { useState } from "react";
import { API_BASE, apiHeaders } from "@/lib/api";
import { t, boolLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

/* ═══ Types ═══ */
type RerankConfigRow = { id?: string; spaceId?: string; enabled?: boolean; provider?: string; endpoint?: string; model?: string; topN?: number; timeoutMs?: number; fallbackMode?: string; crossEncoderModelPath?: string | null; crossEncoderModelType?: string; updatedAt?: string };
type EmbeddingConfigRow = { id?: string; spaceId?: string | null; modelName?: string; provider?: string; endpoint?: string; dimensions?: number; batchSize?: number; concurrency?: number; maxRetries?: number; timeoutMs?: number; isDefault?: boolean; isActive?: boolean; updatedAt?: string };
type ChunkConfigRow = { id?: string; spaceId?: string; strategy?: string; maxLen?: number; overlap?: number; semanticThreshold?: number; enableParentChild?: boolean; parentMaxLen?: number; childMaxLen?: number; tableAware?: boolean; codeAware?: boolean; updatedAt?: string };
type VectorStoreConfigRow = { id?: string; spaceId?: string; provider?: string; endpoint?: string; timeoutMs?: number; collectionPrefix?: string; dbName?: string; enabled?: boolean; updatedAt?: string };
type RetrievalStrategyRow = { id?: string; spaceId?: string; name?: string; version?: number; status?: string; enableHyde?: boolean; hydePromptTemplate?: string; enableQueryExpansion?: boolean; queryExpansionMode?: string; enableSparseEmbedding?: boolean; updatedAt?: string };
type RetentionPolicyRow = { spaceId?: string; allowSnippet?: boolean; retentionDays?: number; maxSnippetLen?: number; updatedAt?: string };

type TabId = "rerank" | "embedding" | "chunk" | "vectorStore" | "retrieval" | "retention";

function safeArr<T>(data: unknown, key: string): T[] { const d = data as any; return Array.isArray(d?.[key]) ? d[key] : []; }

type Props = {
  locale: string;
  rerankInitial?: unknown; embeddingInitial?: unknown; chunkInitial?: unknown;
  vectorStoreInitial?: unknown; retrievalInitial?: unknown; retentionInitial?: unknown;
};

export default function KnowledgeEngineClient(props: Props) {
  const L = props.locale;
  const [tab, setTab] = useState<TabId>("rerank");
  const monoStyle: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" };

  /* ── Rerank state ── */
  const [rerankConfigs, setRerankConfigs] = useState<RerankConfigRow[]>(() => safeArr(props.rerankInitial, "configs"));
  const [rkSpaceId, setRkSpaceId] = useState(""); const [rkEnabled, setRkEnabled] = useState(true);
  const [rkProvider, setRkProvider] = useState("external"); const [rkEndpoint, setRkEndpoint] = useState("");
  const [rkApiKey, setRkApiKey] = useState(""); const [rkModel, setRkModel] = useState("rerank-v1");
  const [rkTopN, setRkTopN] = useState(10); const [rkTimeoutMs, setRkTimeoutMs] = useState(5000);
  const [rkFallbackMode, setRkFallbackMode] = useState("cross_encoder_then_rule");
  const [rkCeModelPath, setRkCeModelPath] = useState(""); const [rkCeModelType, setRkCeModelType] = useState("mock");
  const [rkError, setRkError] = useState(""); const [rkBusy, setRkBusy] = useState(false);

  /* ── Embedding state ── */
  const [embConfigs, setEmbConfigs] = useState<EmbeddingConfigRow[]>(() => safeArr(props.embeddingInitial, "configs"));
  const [embSpaceId, setEmbSpaceId] = useState(""); const [embModelName, setEmbModelName] = useState("text-embedding-3-small");
  const [embProvider, setEmbProvider] = useState("openai"); const [embEndpoint, setEmbEndpoint] = useState("");
  const [embApiKey, setEmbApiKey] = useState(""); const [embDims, setEmbDims] = useState(1536);
  const [embBatch, setEmbBatch] = useState(50); const [embConcurrency, setEmbConcurrency] = useState(2);
  const [embRetries, setEmbRetries] = useState(2); const [embTimeout, setEmbTimeout] = useState(30000);
  const [embDefault, setEmbDefault] = useState(false); const [embActive, setEmbActive] = useState(true);
  const [embError, setEmbError] = useState(""); const [embBusy, setEmbBusy] = useState(false);

  /* ── Chunk state ── */
  const [chunkConfigs, setChunkConfigs] = useState<ChunkConfigRow[]>(() => safeArr(props.chunkInitial, "configs"));
  const [ckSpaceId, setCkSpaceId] = useState(""); const [ckStrategy, setCkStrategy] = useState("recursive");
  const [ckMaxLen, setCkMaxLen] = useState(600); const [ckOverlap, setCkOverlap] = useState(80);
  const [ckSemThreshold, setCkSemThreshold] = useState(0.5);
  const [ckParentChild, setCkParentChild] = useState(false); const [ckParentMax, setCkParentMax] = useState(2000);
  const [ckChildMax, setCkChildMax] = useState(300); const [ckTableAware, setCkTableAware] = useState(true);
  const [ckCodeAware, setCkCodeAware] = useState(true);
  const [ckError, setCkError] = useState(""); const [ckBusy, setCkBusy] = useState(false);

  /* ── Vector Store state ── */
  const [vsConfigs, setVsConfigs] = useState<VectorStoreConfigRow[]>(() => safeArr(props.vectorStoreInitial, "configs"));
  const [vsSpaceId, setVsSpaceId] = useState(""); const [vsProvider, setVsProvider] = useState("pg_fallback");
  const [vsEndpoint, setVsEndpoint] = useState(""); const [vsApiKey, setVsApiKey] = useState("");
  const [vsTimeout, setVsTimeout] = useState(10000); const [vsPrefix, setVsPrefix] = useState("");
  const [vsDbName, setVsDbName] = useState("default"); const [vsEnabled, setVsEnabled] = useState(true);
  const [vsError, setVsError] = useState(""); const [vsBusy, setVsBusy] = useState(false);

  /* ── Retrieval Strategy state ── */
  const [rtStrategies, setRtStrategies] = useState<RetrievalStrategyRow[]>(() => safeArr(props.retrievalInitial, "strategies"));
  const [rtSpaceId, setRtSpaceId] = useState(""); const [rtName, setRtName] = useState("");
  const [rtStatus, setRtStatus] = useState("draft"); const [rtHyde, setRtHyde] = useState(false);
  const [rtHydePrompt, setRtHydePrompt] = useState(""); const [rtQueryExp, setRtQueryExp] = useState(false);
  const [rtExpMode, setRtExpMode] = useState("synonym"); const [rtSparse, setRtSparse] = useState(false);
  const [rtError, setRtError] = useState(""); const [rtBusy, setRtBusy] = useState(false);

  /* ── Retention Policy state ── */
  const [retPolicies, setRetPolicies] = useState<RetentionPolicyRow[]>(() => safeArr(props.retentionInitial, "policies"));
  const [retSpaceId, setRetSpaceId] = useState(""); const [retAllowSnippet, setRetAllowSnippet] = useState(true);
  const [retDays, setRetDays] = useState(30); const [retMaxLen, setRetMaxLen] = useState(600);
  const [retError, setRetError] = useState(""); const [retBusy, setRetBusy] = useState(false);

  /* ── Generic helpers ── */
  const hdr = (locale: string) => ({ ...apiHeaders(locale), "content-type": "application/json" });
  async function apiCall(method: string, url: string, body?: unknown) {
    const opts: any = { method, headers: body ? hdr(L) : apiHeaders(L) };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${url}`, opts);
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw toApiError(json);
    return json;
  }

  /* ── Rerank actions ── */
  async function refreshRerank() { try { const j: any = await apiCall("GET", "/governance/knowledge/rerank-configs"); setRerankConfigs(safeArr(j, "configs")); } catch {} }
  async function upsertRerank() { setRkError(""); setRkBusy(true); try { await apiCall("PUT", "/governance/knowledge/rerank-config", { spaceId: rkSpaceId.trim(), enabled: rkEnabled, provider: rkProvider, endpoint: rkEndpoint.trim(), apiKey: rkApiKey.trim(), model: rkModel.trim(), topN: rkTopN, timeoutMs: rkTimeoutMs, fallbackMode: rkFallbackMode, crossEncoderModelPath: rkCeModelPath.trim(), crossEncoderModelType: rkCeModelType }); setRkSpaceId(""); setRkEndpoint(""); setRkApiKey(""); setRkModel("rerank-v1"); setRkTopN(10); setRkTimeoutMs(5000); setRkCeModelPath(""); setRkCeModelType("mock"); await refreshRerank(); } catch (e: unknown) { setRkError(errText(L, toApiError(e))); } finally { setRkBusy(false); } }
  async function deleteRerank(spaceId: string) { setRkError(""); setRkBusy(true); try { await apiCall("DELETE", `/governance/knowledge/rerank-config/${encodeURIComponent(spaceId)}`); await refreshRerank(); } catch (e: unknown) { setRkError(errText(L, toApiError(e))); } finally { setRkBusy(false); } }

  /* ── Embedding actions ── */
  async function refreshEmb() { try { const j: any = await apiCall("GET", "/governance/knowledge/embedding-configs"); setEmbConfigs(safeArr(j, "configs")); } catch {} }
  async function upsertEmb() { setEmbError(""); setEmbBusy(true); try { await apiCall("PUT", "/governance/knowledge/embedding-config", { spaceId: embSpaceId.trim() || undefined, modelName: embModelName.trim(), provider: embProvider, endpoint: embEndpoint.trim(), apiKeyRef: embApiKey.trim(), dimensions: embDims, batchSize: embBatch, concurrency: embConcurrency, maxRetries: embRetries, timeoutMs: embTimeout, isDefault: embDefault, isActive: embActive }); setEmbSpaceId(""); setEmbModelName("text-embedding-3-small"); setEmbEndpoint(""); setEmbApiKey(""); setEmbDims(1536); await refreshEmb(); } catch (e: unknown) { setEmbError(errText(L, toApiError(e))); } finally { setEmbBusy(false); } }
  async function deleteEmb(id: string) { setEmbError(""); setEmbBusy(true); try { await apiCall("DELETE", `/governance/knowledge/embedding-config/${encodeURIComponent(id)}`); await refreshEmb(); } catch (e: unknown) { setEmbError(errText(L, toApiError(e))); } finally { setEmbBusy(false); } }

  /* ── Chunk actions ── */
  async function refreshChunk() { try { const j: any = await apiCall("GET", "/governance/knowledge/chunk-configs"); setChunkConfigs(safeArr(j, "configs")); } catch {} }
  async function upsertChunk() { setCkError(""); setCkBusy(true); try { await apiCall("PUT", "/governance/knowledge/chunk-config", { spaceId: ckSpaceId.trim(), strategy: ckStrategy, maxLen: ckMaxLen, overlap: ckOverlap, semanticThreshold: ckSemThreshold, enableParentChild: ckParentChild, parentMaxLen: ckParentMax, childMaxLen: ckChildMax, tableAware: ckTableAware, codeAware: ckCodeAware }); setCkSpaceId(""); setCkStrategy("recursive"); setCkMaxLen(600); setCkOverlap(80); await refreshChunk(); } catch (e: unknown) { setCkError(errText(L, toApiError(e))); } finally { setCkBusy(false); } }
  async function deleteChunk(spaceId: string) { setCkError(""); setCkBusy(true); try { await apiCall("DELETE", `/governance/knowledge/chunk-config/${encodeURIComponent(spaceId)}`); await refreshChunk(); } catch (e: unknown) { setCkError(errText(L, toApiError(e))); } finally { setCkBusy(false); } }

  /* ── Vector Store actions ── */
  async function refreshVs() { try { const j: any = await apiCall("GET", "/governance/knowledge/vector-store-configs"); setVsConfigs(safeArr(j, "configs")); } catch {} }
  async function upsertVs() { setVsError(""); setVsBusy(true); try { await apiCall("PUT", "/governance/knowledge/vector-store-config", { spaceId: vsSpaceId.trim(), provider: vsProvider, endpoint: vsEndpoint.trim(), apiKey: vsApiKey.trim(), timeoutMs: vsTimeout, collectionPrefix: vsPrefix.trim(), dbName: vsDbName.trim(), enabled: vsEnabled }); setVsSpaceId(""); setVsEndpoint(""); setVsApiKey(""); setVsProvider("pg_fallback"); await refreshVs(); } catch (e: unknown) { setVsError(errText(L, toApiError(e))); } finally { setVsBusy(false); } }
  async function deleteVs(spaceId: string) { setVsError(""); setVsBusy(true); try { await apiCall("DELETE", `/governance/knowledge/vector-store-config/${encodeURIComponent(spaceId)}`); await refreshVs(); } catch (e: unknown) { setVsError(errText(L, toApiError(e))); } finally { setVsBusy(false); } }

  /* ── Retrieval Strategy actions ── */
  async function refreshRt() { try { const j: any = await apiCall("GET", "/governance/knowledge/retrieval-strategies"); setRtStrategies(safeArr(j, "strategies")); } catch {} }
  async function upsertRt() { setRtError(""); setRtBusy(true); try { await apiCall("PUT", "/governance/knowledge/retrieval-strategy", { spaceId: rtSpaceId.trim(), name: rtName.trim(), status: rtStatus, enableHyde: rtHyde, hydePromptTemplate: rtHydePrompt.trim(), enableQueryExpansion: rtQueryExp, queryExpansionMode: rtExpMode, enableSparseEmbedding: rtSparse }); setRtSpaceId(""); setRtName(""); setRtStatus("draft"); setRtHyde(false); setRtHydePrompt(""); setRtQueryExp(false); setRtSparse(false); await refreshRt(); } catch (e: unknown) { setRtError(errText(L, toApiError(e))); } finally { setRtBusy(false); } }
  async function deleteRt(id: string) { setRtError(""); setRtBusy(true); try { await apiCall("DELETE", `/governance/knowledge/retrieval-strategy/${encodeURIComponent(id)}`); await refreshRt(); } catch (e: unknown) { setRtError(errText(L, toApiError(e))); } finally { setRtBusy(false); } }

  /* ── Retention actions ── */
  async function refreshRet() { try { const j: any = await apiCall("GET", "/governance/knowledge/retention-policies"); setRetPolicies(safeArr(j, "policies")); } catch {} }
  async function upsertRet() { setRetError(""); setRetBusy(true); try { await apiCall("PUT", "/governance/knowledge/retention-policy", { spaceId: retSpaceId.trim(), allowSnippet: retAllowSnippet, retentionDays: retDays, maxSnippetLen: retMaxLen }); setRetSpaceId(""); setRetAllowSnippet(true); setRetDays(30); setRetMaxLen(600); await refreshRet(); } catch (e: unknown) { setRetError(errText(L, toApiError(e))); } finally { setRetBusy(false); } }
  async function deleteRet(spaceId: string) { setRetError(""); setRetBusy(true); try { await apiCall("DELETE", `/governance/knowledge/retention-policy/${encodeURIComponent(spaceId)}`); await refreshRet(); } catch (e: unknown) { setRetError(errText(L, toApiError(e))); } finally { setRetBusy(false); } }

  /* ── Helper: form field ── */
  const F = ({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) => (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontWeight: 500 }}>{label}</div>
      {help && <div style={{ color: "var(--sl-muted)", fontSize: 13 }}>{help}</div>}
      {children}
    </div>
  );
  const Err = ({ msg }: { msg: string }) => msg ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginTop: 8 }}>{msg}</pre> : null;
  const SaveBtn = ({ onClick, disabled, busy: b }: { onClick: () => void; disabled: boolean; busy: boolean }) => (
    <div><button onClick={onClick} disabled={disabled}>{b ? t(L, "action.loading") : t(L, "action.save")}</button></div>
  );
  const NoData = ({ cols }: { cols: number }) => <tr><td colSpan={cols} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(L, "widget.noData")}</td></tr>;

  /* ── Tab config ── */
  const TABS: { id: TabId; label: string }[] = [
    { id: "rerank", label: t(L, "gov.tab.rerank") },
    { id: "embedding", label: t(L, "gov.tab.embedding") },
    { id: "chunk", label: t(L, "gov.tab.chunk") },
    { id: "vectorStore", label: t(L, "gov.tab.vectorStore") },
    { id: "retrieval", label: t(L, "gov.tab.retrieval") },
    { id: "retention", label: t(L, "gov.tab.retention") },
  ];

  return (
    <div>
      <PageHeader title={t(L, "gov.knowledgeEngine.title")} />
      <p style={{ color: "var(--sl-muted)", margin: "4px 0 12px", fontSize: 14 }}>{t(L, "gov.knowledgeEngine.subtitle")}</p>

      {/* ── Tab Bar ── */}
      <div style={{ display: "flex", gap: 0, borderBottom: "2px solid var(--sl-border, #e2e2e5)", marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{ padding: "8px 16px", border: "none", borderBottom: tab === tb.id ? "2px solid var(--sl-primary, #2563eb)" : "2px solid transparent", background: "none", fontWeight: tab === tb.id ? 600 : 400, color: tab === tb.id ? "var(--sl-primary, #2563eb)" : "var(--sl-muted)", cursor: "pointer", fontSize: 14, marginBottom: -2 }}>
            {tb.label}
          </button>
        ))}
      </div>

      {/* ═══ TAB: Rerank ═══ */}
      {tab === "rerank" && (<>
        <Err msg={rkError} />
        <Card title={t(L, "gov.rerank.upsertTitle")}>
          <div style={{ display: "grid", gap: 14, maxWidth: 780 }}>
            <F label={t(L, "gov.rerank.spaceId")} help={t(L, "gov.rerank.spaceIdHelp")}><input value={rkSpaceId} onChange={e => setRkSpaceId(e.target.value)} disabled={rkBusy} placeholder="e.g. space_dev" /></F>
            <F label={t(L, "gov.rerank.provider")}><select value={rkProvider} onChange={e => setRkProvider(e.target.value)} disabled={rkBusy} style={{ padding: "6px 8px" }}><option value="external">External API (Cohere/Jina)</option><option value="local">Local Cross-Encoder</option></select></F>
            <F label={t(L, "gov.rerank.endpoint")} help={t(L, "gov.rerank.endpointHelp")}><input value={rkEndpoint} onChange={e => setRkEndpoint(e.target.value)} disabled={rkBusy} placeholder="https://api.jina.ai" /></F>
            <F label="API Key"><input type="password" value={rkApiKey} onChange={e => setRkApiKey(e.target.value)} disabled={rkBusy} placeholder={t(L, "gov.rerank.apiKeyPlaceholder")} /></F>
            <F label={t(L, "gov.rerank.model")} help={t(L, "gov.rerank.modelHelp")}><input value={rkModel} onChange={e => setRkModel(e.target.value)} disabled={rkBusy} /></F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <F label="Top N"><input type="number" min={1} max={100} value={rkTopN} onChange={e => setRkTopN(Number(e.target.value) || 10)} disabled={rkBusy} /></F>
              <F label={t(L, "gov.rerank.timeoutMs")}><input type="number" min={1000} max={30000} value={rkTimeoutMs} onChange={e => setRkTimeoutMs(Number(e.target.value) || 5000)} disabled={rkBusy} /></F>
            </div>
            <F label={t(L, "gov.rerank.fallbackMode")} help={t(L, "gov.rerank.fallbackModeHelp")}>
              <select value={rkFallbackMode} onChange={e => setRkFallbackMode(e.target.value)} disabled={rkBusy} style={{ padding: "6px 8px" }}>
                <option value="cross_encoder_then_rule">{t(L, "gov.rerank.fallback.crossEncoderThenRule")}</option>
                <option value="external_only">{t(L, "gov.rerank.fallback.externalOnly")}</option>
                <option value="cross_encoder">{t(L, "gov.rerank.fallback.crossEncoder")}</option>
                <option value="rule">{t(L, "gov.rerank.fallback.rule")}</option>
                <option value="none">{t(L, "gov.rerank.fallback.none")}</option>
              </select>
            </F>
            {(rkFallbackMode === "cross_encoder" || rkFallbackMode === "cross_encoder_then_rule") && (
              <div style={{ display: "grid", gap: 12, padding: 12, background: "var(--sl-surface, #f7f7f8)", borderRadius: 8 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{t(L, "gov.rerank.crossEncoderSection")}</div>
                <F label={t(L, "gov.rerank.ceModelType")}><select value={rkCeModelType} onChange={e => setRkCeModelType(e.target.value)} disabled={rkBusy} style={{ padding: "6px 8px" }}><option value="mock">Mock</option><option value="http_local">HTTP Local</option><option value="onnx">ONNX</option></select></F>
                {rkCeModelType === "http_local" && <F label={t(L, "gov.rerank.ceModelPath")}><input value={rkCeModelPath} onChange={e => setRkCeModelPath(e.target.value)} disabled={rkBusy} placeholder="http://localhost:8080" /></F>}
              </div>
            )}
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={rkEnabled} onChange={e => setRkEnabled(e.target.checked)} disabled={rkBusy} /><span>{t(L, "gov.rerank.enabled")}</span></label>
            <SaveBtn onClick={upsertRerank} disabled={rkBusy || !rkSpaceId.trim()} busy={rkBusy} />
          </div>
        </Card>
        <div style={{ marginTop: 16 }}>
          <Table header={<><span>{t(L, "gov.rerank.listTitle")}</span> <Badge>{rerankConfigs.length}</Badge></>}>
            <thead><tr><th align="left">{t(L, "gov.rerank.spaceId")}</th><th align="left">{t(L, "gov.rerank.provider")}</th><th align="left">{t(L, "gov.rerank.model")}</th><th align="left">{t(L, "gov.rerank.endpoint")}</th><th align="left">{t(L, "gov.rerank.fallbackMode")}</th><th align="left">{t(L, "gov.rerank.enabled")}</th><th align="left">{t(L, "gov.rerank.updatedAt")}</th><th align="left">{t(L, "gov.rerank.actions")}</th></tr></thead>
            <tbody>{rerankConfigs.length === 0 ? <NoData cols={8} /> : rerankConfigs.map((c, i) => (
              <tr key={c.id ?? i}><td style={monoStyle}>{c.spaceId ?? "-"}</td><td>{c.provider ?? "external"}</td><td style={monoStyle}>{c.model ?? "-"}</td><td style={{ ...monoStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{c.endpoint || "-"}</td><td>{c.fallbackMode ?? "-"}</td><td>{boolLabel(Boolean(c.enabled), L)}</td><td>{fmtDateTime(c.updatedAt, L)}</td><td>{c.spaceId ? <button onClick={() => deleteRerank(c.spaceId!)} disabled={rkBusy}>{t(L, "action.delete")}</button> : "-"}</td></tr>
            ))}</tbody>
          </Table>
        </div>
      </>)}

      {/* ═══ TAB: Embedding ═══ */}
      {tab === "embedding" && (<>
        <Err msg={embError} />
        <Card title={t(L, "gov.embedding.title")}>
          <div style={{ display: "grid", gap: 14, maxWidth: 780 }}>
            <F label={t(L, "gov.embedding.spaceId")}><input value={embSpaceId} onChange={e => setEmbSpaceId(e.target.value)} disabled={embBusy} /></F>
            <F label={t(L, "gov.embedding.provider")}>
              <select value={embProvider} onChange={e => setEmbProvider(e.target.value)} disabled={embBusy} style={{ padding: "6px 8px" }}>
                <option value="openai">OpenAI</option><option value="local">Local (TEI)</option><option value="ollama">Ollama</option>
              </select>
            </F>
            <F label={t(L, "gov.embedding.modelName")}><input value={embModelName} onChange={e => setEmbModelName(e.target.value)} disabled={embBusy} /></F>
            <F label={t(L, "gov.embedding.endpoint")}><input value={embEndpoint} onChange={e => setEmbEndpoint(e.target.value)} disabled={embBusy} placeholder="https://api.openai.com" /></F>
            <F label="API Key"><input type="password" value={embApiKey} onChange={e => setEmbApiKey(e.target.value)} disabled={embBusy} /></F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <F label={t(L, "gov.embedding.dimensions")}><input type="number" min={64} max={4096} value={embDims} onChange={e => setEmbDims(Number(e.target.value) || 1536)} disabled={embBusy} /></F>
              <F label={t(L, "gov.embedding.batchSize")}><input type="number" min={1} max={100} value={embBatch} onChange={e => setEmbBatch(Number(e.target.value) || 50)} disabled={embBusy} /></F>
              <F label={t(L, "gov.embedding.concurrency")}><input type="number" min={1} max={8} value={embConcurrency} onChange={e => setEmbConcurrency(Number(e.target.value) || 2)} disabled={embBusy} /></F>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <F label={t(L, "gov.embedding.maxRetries")}><input type="number" min={0} max={5} value={embRetries} onChange={e => setEmbRetries(Number(e.target.value) || 2)} disabled={embBusy} /></F>
              <F label={t(L, "gov.embedding.timeoutMs")}><input type="number" min={1000} max={120000} value={embTimeout} onChange={e => setEmbTimeout(Number(e.target.value) || 30000)} disabled={embBusy} /></F>
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={embDefault} onChange={e => setEmbDefault(e.target.checked)} disabled={embBusy} /><span>{t(L, "gov.embedding.isDefault")}</span></label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={embActive} onChange={e => setEmbActive(e.target.checked)} disabled={embBusy} /><span>{t(L, "gov.embedding.isActive")}</span></label>
            </div>
            <SaveBtn onClick={upsertEmb} disabled={embBusy || !embModelName.trim()} busy={embBusy} />
          </div>
        </Card>
        <div style={{ marginTop: 16 }}>
          <Table header={<><span>{t(L, "gov.embedding.title")}</span> <Badge>{embConfigs.length}</Badge></>}>
            <thead><tr><th align="left">{t(L, "gov.embedding.spaceId")}</th><th align="left">{t(L, "gov.embedding.provider")}</th><th align="left">{t(L, "gov.embedding.modelName")}</th><th align="left">{t(L, "gov.embedding.dimensions")}</th><th align="left">{t(L, "gov.embedding.endpoint")}</th><th align="left">{t(L, "gov.embedding.isActive")}</th><th align="left">{t(L, "gov.routing.updatedAt")}</th><th align="left">{t(L, "gov.routing.actions")}</th></tr></thead>
            <tbody>{embConfigs.length === 0 ? <NoData cols={8} /> : embConfigs.map((c, i) => (
              <tr key={c.id ?? i}><td style={monoStyle}>{c.spaceId || t(L, "gov.embedding.noData")}</td><td>{c.provider ?? "openai"}</td><td style={monoStyle}>{c.modelName ?? "-"}</td><td>{c.dimensions ?? 1536}</td><td style={{ ...monoStyle, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{c.endpoint || "-"}</td><td>{boolLabel(Boolean(c.isActive), L)}</td><td>{fmtDateTime(c.updatedAt, L)}</td><td>{c.id ? <button onClick={() => deleteEmb(c.id!)} disabled={embBusy}>{t(L, "action.delete")}</button> : "-"}</td></tr>
            ))}</tbody>
          </Table>
        </div>
      </>)}

      {/* ═══ TAB: Chunk Strategy ═══ */}
      {tab === "chunk" && (<>
        <Err msg={ckError} />
        <Card title={t(L, "gov.chunk.title")}>
          <div style={{ display: "grid", gap: 14, maxWidth: 780 }}>
            <F label={t(L, "gov.chunk.spaceId")}><input value={ckSpaceId} onChange={e => setCkSpaceId(e.target.value)} disabled={ckBusy} placeholder="e.g. space_dev" /></F>
            <F label={t(L, "gov.chunk.strategy")}>
              <select value={ckStrategy} onChange={e => setCkStrategy(e.target.value)} disabled={ckBusy} style={{ padding: "6px 8px" }}>
                <option value="fixed">{t(L, "gov.chunk.strategyFixed")}</option>
                <option value="paragraph">{t(L, "gov.chunk.strategyParagraph")}</option>
                <option value="recursive">{t(L, "gov.chunk.strategyRecursive")}</option>
                <option value="semantic">{t(L, "gov.chunk.strategySemantic")}</option>
                <option value="parent_child">Parent-Child</option>
                <option value="table_aware">Table Aware</option>
                <option value="code_aware">Code Aware</option>
              </select>
            </F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <F label={t(L, "gov.chunk.maxLen")}><input type="number" min={50} max={10000} value={ckMaxLen} onChange={e => setCkMaxLen(Number(e.target.value) || 600)} disabled={ckBusy} /></F>
              <F label={t(L, "gov.chunk.overlap")}><input type="number" min={0} max={5000} value={ckOverlap} onChange={e => setCkOverlap(Number(e.target.value) || 80)} disabled={ckBusy} /></F>
              <F label={t(L, "gov.chunk.semanticThreshold")}><input type="number" min={0} max={1} step={0.05} value={ckSemThreshold} onChange={e => setCkSemThreshold(Number(e.target.value) || 0.5)} disabled={ckBusy} /></F>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={ckParentChild} onChange={e => setCkParentChild(e.target.checked)} disabled={ckBusy} /><span>{t(L, "gov.chunk.enableParentChild")}</span></label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={ckTableAware} onChange={e => setCkTableAware(e.target.checked)} disabled={ckBusy} /><span>{t(L, "gov.chunk.tableAware")}</span></label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={ckCodeAware} onChange={e => setCkCodeAware(e.target.checked)} disabled={ckBusy} /><span>{t(L, "gov.chunk.codeAware")}</span></label>
            </div>
            {ckParentChild && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <F label={t(L, "gov.chunk.parentMaxLen")}><input type="number" min={200} max={10000} value={ckParentMax} onChange={e => setCkParentMax(Number(e.target.value) || 2000)} disabled={ckBusy} /></F>
                <F label={t(L, "gov.chunk.childMaxLen")}><input type="number" min={50} max={5000} value={ckChildMax} onChange={e => setCkChildMax(Number(e.target.value) || 300)} disabled={ckBusy} /></F>
              </div>
            )}
            <SaveBtn onClick={upsertChunk} disabled={ckBusy || !ckSpaceId.trim()} busy={ckBusy} />
          </div>
        </Card>
        <div style={{ marginTop: 16 }}>
          <Table header={<><span>{t(L, "gov.chunk.title")}</span> <Badge>{chunkConfigs.length}</Badge></>}>
            <thead><tr><th align="left">{t(L, "gov.chunk.spaceId")}</th><th align="left">{t(L, "gov.chunk.strategy")}</th><th align="left">{t(L, "gov.chunk.maxLen")}</th><th align="left">{t(L, "gov.chunk.overlap")}</th><th align="left">{t(L, "gov.chunk.tableAware")}</th><th align="left">{t(L, "gov.chunk.codeAware")}</th><th align="left">{t(L, "gov.routing.updatedAt")}</th><th align="left">{t(L, "gov.routing.actions")}</th></tr></thead>
            <tbody>{chunkConfigs.length === 0 ? <NoData cols={8} /> : chunkConfigs.map((c, i) => (
              <tr key={c.id ?? i}><td style={monoStyle}>{c.spaceId ?? "-"}</td><td>{c.strategy ?? "recursive"}</td><td>{c.maxLen ?? 600}</td><td>{c.overlap ?? 80}</td><td>{boolLabel(Boolean(c.tableAware), L)}</td><td>{boolLabel(Boolean(c.codeAware), L)}</td><td>{fmtDateTime(c.updatedAt, L)}</td><td>{c.spaceId ? <button onClick={() => deleteChunk(c.spaceId!)} disabled={ckBusy}>{t(L, "action.delete")}</button> : "-"}</td></tr>
            ))}</tbody>
          </Table>
        </div>
      </>)}

      {/* ═══ TAB: Vector Store ═══ */}
      {tab === "vectorStore" && (<>
        <Err msg={vsError} />
        <Card title={t(L, "gov.vectorStore.title")}>
          <div style={{ display: "grid", gap: 14, maxWidth: 780 }}>
            <F label={t(L, "gov.vectorStore.spaceId")}><input value={vsSpaceId} onChange={e => setVsSpaceId(e.target.value)} disabled={vsBusy} placeholder="e.g. space_dev" /></F>
            <F label={t(L, "gov.vectorStore.provider")}>
              <select value={vsProvider} onChange={e => setVsProvider(e.target.value)} disabled={vsBusy} style={{ padding: "6px 8px" }}>
                <option value="qdrant">Qdrant</option><option value="milvus">Milvus / Zilliz</option><option value="external">External HTTP</option><option value="pg_fallback">PostgreSQL Fallback</option>
              </select>
            </F>
            {vsProvider !== "pg_fallback" && (<>
              <F label={t(L, "gov.vectorStore.endpoint")}><input value={vsEndpoint} onChange={e => setVsEndpoint(e.target.value)} disabled={vsBusy} placeholder={vsProvider === "qdrant" ? "http://qdrant:6333" : "http://milvus:19530"} /></F>
              <F label="API Key / Token"><input type="password" value={vsApiKey} onChange={e => setVsApiKey(e.target.value)} disabled={vsBusy} /></F>
            </>)}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <F label={t(L, "gov.vectorStore.timeoutMs")}><input type="number" min={1000} max={60000} value={vsTimeout} onChange={e => setVsTimeout(Number(e.target.value) || 10000)} disabled={vsBusy} /></F>
              <F label={t(L, "gov.vectorStore.collectionPrefix")}><input value={vsPrefix} onChange={e => setVsPrefix(e.target.value)} disabled={vsBusy} placeholder="kn_" /></F>
              {vsProvider === "milvus" && <F label={t(L, "gov.vectorStore.dbName")}><input value={vsDbName} onChange={e => setVsDbName(e.target.value)} disabled={vsBusy} /></F>}
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={vsEnabled} onChange={e => setVsEnabled(e.target.checked)} disabled={vsBusy} /><span>{t(L, "gov.vectorStore.enabled")}</span></label>
            <SaveBtn onClick={upsertVs} disabled={vsBusy || !vsSpaceId.trim()} busy={vsBusy} />
          </div>
        </Card>
        <div style={{ marginTop: 16 }}>
          <Table header={<><span>{t(L, "gov.vectorStore.title")}</span> <Badge>{vsConfigs.length}</Badge></>}>
            <thead><tr><th align="left">{t(L, "gov.vectorStore.spaceId")}</th><th align="left">{t(L, "gov.vectorStore.provider")}</th><th align="left">{t(L, "gov.vectorStore.endpoint")}</th><th align="left">{t(L, "gov.vectorStore.timeoutMs")}</th><th align="left">{t(L, "gov.vectorStore.enabled")}</th><th align="left">{t(L, "gov.routing.updatedAt")}</th><th align="left">{t(L, "gov.routing.actions")}</th></tr></thead>
            <tbody>{vsConfigs.length === 0 ? <NoData cols={7} /> : vsConfigs.map((c, i) => (
              <tr key={c.id ?? i}><td style={monoStyle}>{c.spaceId ?? "-"}</td><td>{c.provider ?? "pg_fallback"}</td><td style={{ ...monoStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{c.endpoint || "-"}</td><td>{c.timeoutMs ?? 10000}</td><td>{boolLabel(Boolean(c.enabled), L)}</td><td>{fmtDateTime(c.updatedAt, L)}</td><td>{c.spaceId ? <button onClick={() => deleteVs(c.spaceId!)} disabled={vsBusy}>{t(L, "action.delete")}</button> : "-"}</td></tr>
            ))}</tbody>
          </Table>
        </div>
      </>)}

      {/* ═══ TAB: Retrieval Strategy ═══ */}
      {tab === "retrieval" && (<>
        <Err msg={rtError} />
        <Card title={t(L, "gov.retrieval.title")}>
          <div style={{ display: "grid", gap: 14, maxWidth: 780 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <F label={t(L, "gov.retrieval.spaceId")}><input value={rtSpaceId} onChange={e => setRtSpaceId(e.target.value)} disabled={rtBusy} placeholder="e.g. space_dev" /></F>
              <F label={t(L, "gov.retrieval.name")}><input value={rtName} onChange={e => setRtName(e.target.value)} disabled={rtBusy} /></F>
            </div>
            <F label={t(L, "gov.retrieval.status")}>
              <select value={rtStatus} onChange={e => setRtStatus(e.target.value)} disabled={rtBusy} style={{ padding: "6px 8px" }}>
                <option value="draft">{t(L, "gov.retrieval.statusDraft")}</option><option value="active">{t(L, "gov.retrieval.statusActive")}</option><option value="archived">{t(L, "gov.retrieval.statusArchived")}</option>
              </select>
            </F>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={rtHyde} onChange={e => setRtHyde(e.target.checked)} disabled={rtBusy} /><span>{t(L, "gov.retrieval.enableHyde")}</span></label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={rtQueryExp} onChange={e => setRtQueryExp(e.target.checked)} disabled={rtBusy} /><span>{t(L, "gov.retrieval.enableQueryExpansion")}</span></label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={rtSparse} onChange={e => setRtSparse(e.target.checked)} disabled={rtBusy} /><span>{t(L, "gov.retrieval.enableSparseEmbedding")}</span></label>
            </div>
            {rtHyde && <F label={t(L, "gov.retrieval.hydePromptTemplate")}><textarea value={rtHydePrompt} onChange={e => setRtHydePrompt(e.target.value)} disabled={rtBusy} rows={3} style={{ width: "100%" }} placeholder="{{query}}" /></F>}
            {rtQueryExp && (
              <F label={t(L, "gov.retrieval.queryExpansionMode")}>
                <select value={rtExpMode} onChange={e => setRtExpMode(e.target.value)} disabled={rtBusy} style={{ padding: "6px 8px" }}>
                  <option value="synonym">{t(L, "gov.retrieval.modeSynonym")}</option><option value="subquery">{t(L, "gov.retrieval.modeSubquery")}</option><option value="both">{t(L, "gov.retrieval.modeBoth")}</option>
                </select>
              </F>
            )}
            <SaveBtn onClick={upsertRt} disabled={rtBusy || !rtSpaceId.trim() || !rtName.trim()} busy={rtBusy} />
          </div>
        </Card>
        <div style={{ marginTop: 16 }}>
          <Table header={<><span>{t(L, "gov.retrieval.title")}</span> <Badge>{rtStrategies.length}</Badge></>}>
            <thead><tr><th align="left">{t(L, "gov.retrieval.spaceId")}</th><th align="left">{t(L, "gov.retrieval.name")}</th><th align="left">{t(L, "gov.retrieval.status")}</th><th align="left">HyDE</th><th align="left">{t(L, "gov.retrieval.enableQueryExpansion")}</th><th align="left">{t(L, "gov.retrieval.enableSparseEmbedding")}</th><th align="left">{t(L, "gov.routing.updatedAt")}</th><th align="left">{t(L, "gov.routing.actions")}</th></tr></thead>
            <tbody>{rtStrategies.length === 0 ? <NoData cols={8} /> : rtStrategies.map((s, i) => (
              <tr key={s.id ?? i}><td style={monoStyle}>{s.spaceId ?? "-"}</td><td>{s.name ?? "-"}</td><td><Badge>{s.status ?? "draft"}</Badge></td><td>{boolLabel(Boolean(s.enableHyde), L)}</td><td>{boolLabel(Boolean(s.enableQueryExpansion), L)}</td><td>{boolLabel(Boolean(s.enableSparseEmbedding), L)}</td><td>{fmtDateTime(s.updatedAt, L)}</td><td>{s.id ? <button onClick={() => deleteRt(s.id!)} disabled={rtBusy}>{t(L, "action.delete")}</button> : "-"}</td></tr>
            ))}</tbody>
          </Table>
        </div>
      </>)}

      {/* ═══ TAB: Retention Policy ═══ */}
      {tab === "retention" && (<>
        <Err msg={retError} />
        <Card title={t(L, "gov.retention.title")}>
          <div style={{ display: "grid", gap: 14, maxWidth: 780 }}>
            <F label={t(L, "gov.retention.spaceId")}><input value={retSpaceId} onChange={e => setRetSpaceId(e.target.value)} disabled={retBusy} placeholder="e.g. space_dev" /></F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <F label={t(L, "gov.retention.retentionDays")}><input type="number" min={1} max={3650} value={retDays} onChange={e => setRetDays(Number(e.target.value) || 30)} disabled={retBusy} /></F>
              <F label={t(L, "gov.retention.maxSnippetLen")}><input type="number" min={50} max={5000} value={retMaxLen} onChange={e => setRetMaxLen(Number(e.target.value) || 600)} disabled={retBusy} /></F>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={retAllowSnippet} onChange={e => setRetAllowSnippet(e.target.checked)} disabled={retBusy} /><span>{t(L, "gov.retention.allowSnippet")}</span></label>
            <SaveBtn onClick={upsertRet} disabled={retBusy || !retSpaceId.trim()} busy={retBusy} />
          </div>
        </Card>
        <div style={{ marginTop: 16 }}>
          <Table header={<><span>{t(L, "gov.retention.title")}</span> <Badge>{retPolicies.length}</Badge></>}>
            <thead><tr><th align="left">{t(L, "gov.retention.spaceId")}</th><th align="left">{t(L, "gov.retention.allowSnippet")}</th><th align="left">{t(L, "gov.retention.retentionDays")}</th><th align="left">{t(L, "gov.retention.maxSnippetLen")}</th><th align="left">{t(L, "gov.routing.updatedAt")}</th><th align="left">{t(L, "gov.routing.actions")}</th></tr></thead>
            <tbody>{retPolicies.length === 0 ? <NoData cols={6} /> : retPolicies.map((p, i) => (
              <tr key={p.spaceId ?? i}><td style={monoStyle}>{p.spaceId ?? "-"}</td><td>{boolLabel(Boolean(p.allowSnippet), L)}</td><td>{p.retentionDays ?? 30}</td><td>{p.maxSnippetLen ?? 600}</td><td>{fmtDateTime(p.updatedAt, L)}</td><td>{p.spaceId ? <button onClick={() => deleteRet(p.spaceId!)} disabled={retBusy}>{t(L, "action.delete")}</button> : "-"}</td></tr>
            ))}</tbody>
          </Table>
        </div>
      </>)}

    </div>
  );
}
