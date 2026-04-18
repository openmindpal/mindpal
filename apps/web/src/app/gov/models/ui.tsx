"use client";

import { useCallback, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Card, PageHeader, Table, StatusBadge, getHelpHref, FormHint, AlertBanner, friendlyError } from "@/components/ui";
import { useUndoToast, UndoToastContainer } from "@/components/ui/UndoToast";
import { nextId } from "@/lib/apiError";

type Binding = { id?: string; modelRef?: string; provider?: string; model?: string; baseUrl?: string | null; chatCompletionsPath?: string | null; connectorInstanceId?: string; secretId?: string; secretIds?: string[]; status?: string; updatedAt?: string };

type ProviderKey =
  | "openai_compatible"
  | "deepseek"
  | "hunyuan"
  | "qianwen"
  | "doubao"
  | "zhipu"
  | "kimi"
  | "kimimax"
  | "custom_openai"
  | "anthropic"
  | "custom_anthropic"
  | "gemini"
  | "custom_gemini";
type OnboardResult = { modelRef: string; provider: string; model: string; baseUrl: string | null; binding?: Binding };

const PROVIDER_OPTIONS: ProviderKey[] = [
  "deepseek",
  "hunyuan",
  "qianwen",
  "doubao",
  "zhipu",
  "kimi",
  "kimimax",
  "openai_compatible",
  "custom_openai",
  "anthropic",
  "custom_anthropic",
  "gemini",
  "custom_gemini",
];

const PROVIDER_BASE_URLS: Record<ProviderKey, string> = {
  deepseek: "https://api.deepseek.com",
  hunyuan: "https://api.hunyuan.cloud.tencent.com",
  qianwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  kimi: "https://api.moonshot.cn/v1",
  kimimax: "https://api.moonshot.cn/v1",
  openai_compatible: "https://api.openai.com/v1",
  custom_openai: "https://your-proxy.example.com/v1",
  anthropic: "https://api.anthropic.com",
  custom_anthropic: "https://your-proxy.example.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  custom_gemini: "https://your-proxy.example.com/v1beta",
};

const PROVIDER_PATHS: Record<ProviderKey, string> = {
  deepseek: "/chat/completions",
  hunyuan: "/chat/completions",
  qianwen: "/chat/completions",
  doubao: "/chat/completions",
  zhipu: "/chat/completions",
  kimi: "/chat/completions",
  kimimax: "/chat/completions",
  openai_compatible: "/chat/completions",
  custom_openai: "/chat/completions",
  anthropic: "/v1/messages",
  custom_anthropic: "/v1/messages",
  gemini: "/models/{model}:generateContent",
  custom_gemini: "/models/{model}:generateContent",
};

export default function GovModelsClient(props: { locale: string; initial: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [bindings, setBindings] = useState<{ status: number; json: any }>(props.initial?.bindings ?? { status: 0, json: null });
  const [, setCatalog] = useState<{ status: number; json: any }>(props.initial?.catalog ?? { status: 0, json: null });

  const bindingItems = useMemo(() => (Array.isArray(bindings?.json?.bindings) ? (bindings.json.bindings as Binding[]) : []), [bindings]);

  const pageSize = 20;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(bindingItems.length / pageSize));
  const paged = useMemo(() => bindingItems.slice(page * pageSize, (page + 1) * pageSize), [bindingItems, page]);

  const [providerKey, setProviderKey] = useState<ProviderKey>("deepseek");
  const [baseUrl, setBaseUrl] = useState(PROVIDER_BASE_URLS.deepseek);
  const [chatCompletionsPath, setChatCompletionsPath] = useState(PROVIDER_PATHS.deepseek);
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [lastSaved, setLastSaved] = useState<OnboardResult | null>(null);
  const [testOutput, setTestOutput] = useState<{ outputText: string; traceId: string } | null>(null);
  const [testError, setTestError] = useState<string>("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const providerBaseUrlPlaceholder = PROVIDER_BASE_URLS[providerKey];
  const providerPathPlaceholder = PROVIDER_PATHS[providerKey];

  const handleProviderChange = useCallback((nextProvider: ProviderKey) => {
    setProviderKey(nextProvider);
    setBaseUrl(PROVIDER_BASE_URLS[nextProvider]);
    setChatCompletionsPath(PROVIDER_PATHS[nextProvider]);
  }, []);

  /* Undo toast for delete operations (§07§6 Delay Window) */
  const { toasts: undoToasts, enqueue: enqueueUndo, undo: undoAction } = useUndoToast();

  const refreshCatalog = useCallback(async () => {
    const res = await apiFetch(`/models/catalog`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setCatalog({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  const refreshBindings = useCallback(async () => {
    setPage(0);
    const res = await apiFetch(`/models/bindings`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setBindings({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setTestError("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function saveOnboard() {
    await runAction(async () => {
      setTestOutput(null);
      setTestError("");
      setNotice("");
      const idem =
        typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function" ? `model-onboard-${(crypto as any).randomUUID()}` : `model-onboard-${Date.now()}`;
      const res = await apiFetch(`/models/onboard`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({ provider: providerKey, baseUrl, chatCompletionsPath: chatCompletionsPath.trim() || undefined, apiKey, modelName }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const modelRef = String((json as any)?.modelRef ?? "");
      const provider = String((json as any)?.provider ?? "");
      const model = String((json as any)?.model ?? "");
      const savedBaseUrl = (json as any)?.baseUrl != null ? String((json as any).baseUrl) : null;
      const testPassed = Boolean((json as any)?.connectionTestPassed);
      setLastSaved({ modelRef, provider, model, baseUrl: savedBaseUrl, binding: (json as any)?.binding ?? null });
      setApiKey("");
      await refreshBindings();
      await refreshCatalog();
      setNotice(testPassed ? t(props.locale, "gov.models.testAndSaveSuccess") : t(props.locale, "gov.models.saved"));
    });
  }

  async function testModel(modelRef: string) {
    await runAction(async () => {
      const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function"
        ? `model-test-${(crypto as any).randomUUID()}` : `model-test-${Date.now()}`;
      const res = await apiFetch(`/models/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({
          purpose: "gov.models.test",
          modelRef,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setTestOutput(null);
        setTestError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
        return;
      }
      setTestError("");
      setTestOutput({ outputText: String((json as any)?.outputText ?? ""), traceId: String((json as any)?.traceId ?? "") });
    });
  }

  async function deleteModel(bindingId: string) {
    /* Use UndoToast delay-confirm instead of browser confirm() (§07§6) */
    const undoId = nextId("undo");
    setDeletingId(bindingId);
    setError("");
    setNotice("");
    enqueueUndo({
      id: undoId,
      label: `${t(props.locale, "gov.models.action.delete")} ${bindingId}`,
      durationMs: 5000,
      onConfirm: async () => {
        try {
          const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function"
            ? `model-delete-${(crypto as any).randomUUID()}` : `model-delete-${Date.now()}`;
          const res = await apiFetch(`/models/bindings/${encodeURIComponent(bindingId)}`, {
            method: "DELETE",
            headers: { "idempotency-key": idem },
            locale: props.locale,
          });
          const json = await res.json().catch(() => null);
          if (!res.ok) {
            setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
            return;
          }
          setNotice(t(props.locale, "gov.models.deleted"));
          await refreshBindings();
        } catch (e: any) {
          setError(errText(props.locale, toApiError(e)));
        } finally {
          setDeletingId(null);
        }
      },
      onUndo: () => {
        setDeletingId(null);
      },
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.models.title")}
        helpHref={getHelpHref("/gov/models", props.locale) ?? undefined}
        actions={
          <>
            <StatusBadge locale={props.locale} status={bindings.status} />
            <button onClick={refreshBindings} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? (() => { const fe = friendlyError(error, props.locale); return <AlertBanner severity="error" locale={props.locale} technical={error} recovery={fe.recovery}>{fe.message}</AlertBanner>; })() : null}
      {notice ? <AlertBanner severity="success" locale={props.locale}>{notice}</AlertBanner> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.models.bindingsTitle")}>
          <Table>
            <thead>
              <tr>
                <th>{t(props.locale, "gov.models.table.modelRef")}</th>
                <th>{t(props.locale, "gov.models.table.provider")}</th>
                <th>{t(props.locale, "gov.models.table.model")}</th>
                <th>{t(props.locale, "gov.models.table.baseUrl")}</th>
                <th>{t(props.locale, "gov.models.table.connectorInstanceId")}</th>
                <th>{t(props.locale, "gov.models.table.secrets")}</th>
                <th>{t(props.locale, "gov.models.table.status")}</th>
                <th>{t(props.locale, "gov.models.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {paged.length === 0 ? (
                  <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
                ) : paged.map((b, idx) => (
                <tr key={String(b.id ?? b.modelRef ?? idx)}>
                  <td>{String(b.modelRef ?? "")}</td>
                  <td>{String(b.provider ?? "")}</td>
                  <td>{String(b.model ?? "")}</td>
                  <td>{String(b.baseUrl ?? "")}</td>
                  <td>{String(b.connectorInstanceId ?? "")}</td>
                  <td>{Array.isArray(b.secretIds) && b.secretIds.length ? String(b.secretIds.length) : b.secretId ? "1" : "0"}</td>
                  <td>{String(b.status ?? "")}</td>
                  <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={() => testModel(String(b.modelRef ?? ""))} disabled={busy || !String(b.modelRef ?? "")}>
                      {t(props.locale, "action.test")}
                    </button>
                    <button
                      onClick={() => deleteModel(String(b.id ?? ""))}
                      disabled={busy || deletingId === String(b.id ?? "") || !String(b.id ?? "")}
                      style={{ color: "crimson" }}
                    >
                      {deletingId === String(b.id ?? "")
                        ? t(props.locale, "gov.models.action.deleting")
                        : t(props.locale, "gov.models.action.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(page * pageSize + 1)).replace("{to}", String(Math.min((page + 1) * pageSize, bindingItems.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(bindingItems.length))}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(page + 1))}</span>
                <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.models.onboardTitle")}>
          <div style={{ display: "grid", gap: 10, marginTop: 12, maxWidth: 820 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.provider")}<FormHint text={t(props.locale, "gov.models.hint.provider")} /></div>
              <select value={providerKey} onChange={(e) => handleProviderChange(e.target.value as ProviderKey)} disabled={busy}>
                {PROVIDER_OPTIONS.map((provider) => (
                  <option key={provider} value={provider}>{t(props.locale, `gov.models.provider.${provider}`)}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.baseUrl")}<FormHint text={t(props.locale, "gov.models.hint.baseUrl")} /></div>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} placeholder={providerBaseUrlPlaceholder} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.chatPath")}<FormHint text={t(props.locale, "gov.models.hint.chatPath")} /></div>
              <input value={chatCompletionsPath} onChange={(e) => setChatCompletionsPath(e.target.value)} disabled={busy} placeholder={providerPathPlaceholder} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.apiKey")}<FormHint text={t(props.locale, "gov.models.hint.apiKey")} /></div>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} type="password" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.modelName")}<FormHint text={t(props.locale, "gov.models.hint.modelName")} /></div>
              <input value={modelName} onChange={(e) => setModelName(e.target.value)} disabled={busy} placeholder="deepseek-v3" />
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={saveOnboard} disabled={busy || !baseUrl.trim() || !apiKey || !modelName.trim()}>
                {busy ? t(props.locale, "gov.models.testingAndSaving") : t(props.locale, "gov.models.testAndSave")}
              </button>
              <button onClick={() => (lastSaved?.modelRef ? testModel(lastSaved.modelRef) : null)} disabled={busy || !lastSaved?.modelRef}>
                {t(props.locale, "action.test")}
              </button>
              {lastSaved?.modelRef ? <span>{`${t(props.locale, "gov.models.modelRef")}: ${lastSaved.modelRef}`}</span> : null}
            </div>
          </div>
        </Card>
      </div>

      {testError ? <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>{testError}</pre> : null}
      {testOutput ? (
        <div style={{ marginTop: 12 }}>
          <Card title={t(props.locale, "gov.models.testResult")}>
            <pre style={{ whiteSpace: "pre-wrap" }}>{testOutput.outputText}</pre>
            <div>{testOutput.traceId ? `traceId=${testOutput.traceId}` : ""}</div>
          </Card>
        </div>
      ) : null}

      {/* Undo Toast */}
      <UndoToastContainer toasts={undoToasts} onUndo={undoAction} undoLabel={t(props.locale, "action.undo")} />
    </div>
  );
}
