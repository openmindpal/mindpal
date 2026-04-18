"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { isPlainObject } from "@/lib/apiError";
import type { ChatFlowItem, FlowDirective, WorkspaceTab } from "./homeHelpers";
import { addRecent } from "./homeHelpers";

type DirectiveNavState = Record<string, { status: "checking" } | { status: "allowed" } | { status: "blocked"; hint: string }>;

/**
 * useDirectives — manages UI directive validation, navigation,
 * and open-in-panel / navigate behaviors.
 */
export default function useDirectives({
  locale,
  flow,
  openInWorkspace,
}: {
  locale: string;
  flow: ChatFlowItem[];
  openInWorkspace: (tab: { kind: WorkspaceTab["kind"]; name: string; url: string; meta?: WorkspaceTab["meta"] }) => void;
}) {
  const router = useRouter();
  const [directiveNav, setDirectiveNav] = useState<DirectiveNavState>({});
  const directiveValidationStartedRef = useRef<Set<string>>(new Set());
  /* ─── validate UI directives ─── */
  const validateDirective = useCallback(async (it: FlowDirective) => {
    const target = it.target;
    if (!target) return;
    try {
      if (target.kind === "page") {
        const res = await apiFetch(`/ui/pages/${encodeURIComponent(target.name)}`, { method: "GET", locale, cache: "no-store" });
        if (res.status === 401 || res.status === 403) { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.forbidden") } })); return; }
        const json: unknown = await res.json().catch(() => null);
        if (res.ok && isPlainObject(json) && (json as Record<string, unknown>).released != null) { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "allowed" } })); return; }
        setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.pageNotReleased") } })); return;
      }
      if (target.kind === "workbench") {
        const res = await apiFetch(`/workbenches/${encodeURIComponent(target.key)}/effective`, { method: "GET", locale, cache: "no-store" });
        if (res.status === 401 || res.status === 403) { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.forbidden") } })); return; }
        if (res.status === 200) { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "allowed" } })); return; }
        setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.workbenchUnavailable") } })); return;
      }
    } catch { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.validationFailed") } })); }
  }, [locale]);

  useEffect(() => {
    for (const it of flow) {
      if (it.kind !== "uiDirective" || !it.target) continue;
      if (directiveValidationStartedRef.current.has(it.id)) continue;
      directiveValidationStartedRef.current.add(it.id);
      queueMicrotask(() => {
        setDirectiveNav((p) => ({ ...p, [it.id]: { status: "checking" } }));
        void validateDirective(it);
      });
    }
  }, [flow, validateDirective]);

  const openDirective = useCallback((it: FlowDirective, mode: "panel" | "navigate" = "panel") => {
    const target = it.target;
    if (!target || directiveNav[it.id]?.status !== "allowed") return;
    const pagePath = target.kind === "page"
      ? `/p/${encodeURIComponent(target.name)}?lang=${encodeURIComponent(locale)}`
      : `/w/${encodeURIComponent(target.key)}?lang=${encodeURIComponent(locale)}`;

    const entry = target.kind === "page" ? { kind: "page" as const, name: target.name } : { kind: "workbench" as const, name: target.key };
    addRecent(entry);

    if (mode === "panel") {
      openInWorkspace({ kind: target.kind, name: target.kind === "page" ? target.name : target.key, url: pagePath });
    } else {
      router.push(pagePath);
    }
  }, [directiveNav, locale, router, openInWorkspace]);

  return { directiveNav, openDirective };
}
