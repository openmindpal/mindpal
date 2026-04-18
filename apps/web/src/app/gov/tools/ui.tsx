"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { PageHeader, StatusBadge, TabNav, getHelpHref, AlertBanner, friendlyError } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import type { GovernanceToolsResponse, ToolsTabContext } from "./types";
import ToolManageTab from "./ToolManageTab";
import ToolNetworkPolicyTab from "./ToolNetworkPolicyTab";
import ToolRolloutsTab from "./ToolRolloutsTab";

export default function GovToolsClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<GovernanceToolsResponse | null>((props.initial as GovernanceToolsResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const rollouts = useMemo(() => (Array.isArray(data?.rollouts) ? data!.rollouts! : []), [data]);
  const actives = useMemo(() => (Array.isArray(data?.actives) ? data!.actives! : []), [data]);
  const tools = useMemo(() => (Array.isArray(data?.tools) ? data!.tools! : []), [data]);

  const refresh = useCallback(async () => {
    setError("");
    const res = await apiFetch("/governance/tools", { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as GovernanceToolsResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  async function runAction(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refresh();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refresh]);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  const ctx: ToolsTabContext = { locale: props.locale, busy, error, tools, rollouts, actives, refresh, runAction };

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.tools.title")}
        helpHref={getHelpHref("/gov/tools", props.locale) ?? undefined}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? (() => { const fe = friendlyError(error, props.locale); return <AlertBanner severity="error" locale={props.locale} technical={error} recovery={fe.recovery}>{fe.message}</AlertBanner>; })() : null}
      {!error && initialError ? (() => { const fe = friendlyError(initialError, props.locale); return <AlertBanner severity="warning" locale={props.locale} technical={initialError} recovery={fe.recovery}>{fe.message}</AlertBanner>; })() : null}

      <TabNav tabs={[
        { key: "manage", label: t(props.locale, "gov.tools.tab.manage"), content: <ToolManageTab ctx={ctx} /> },
        { key: "networkPolicy", label: t(props.locale, "gov.tools.tab.networkPolicy"), content: <ToolNetworkPolicyTab ctx={ctx} /> },
        { key: "rollouts", label: t(props.locale, "gov.tools.tab.rollouts"), content: <ToolRolloutsTab ctx={ctx} /> },
      ]} />
    </div>
  );
}
