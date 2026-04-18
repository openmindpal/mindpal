"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";
import { type Nl2UiConfig } from "@/components/nl2ui/DynamicBlockRenderer";
import type { FlowNl2UiResult, RecentEntry } from "./homeHelpers";
import { addRecent } from "./homeHelpers";

/**
 * useNl2uiActions — manages NL2UI save-as-page and maximized overlay state.
 */
export default function useNl2uiActions({
  locale,
  setRecent,
}: {
  locale: string;
  setRecent: React.Dispatch<React.SetStateAction<RecentEntry[]>>;
}) {
  const [savingPageId, setSavingPageId] = useState<string | null>(null);
  const [savedPages, setSavedPages] = useState<Record<string, { pageName: string; pageUrl: string }>>({});
  const [maximizedNl2ui, setMaximizedNl2ui] = useState<FlowNl2UiResult | null>(null);
  const [nl2uiLoading, setNl2uiLoading] = useState(false);

  /* ─── T5: save NL2UI result as page ─── */
  const saveAsPage = useCallback(async (flowItemId: string, config: Nl2UiConfig, userInput: string) => {
    setSavingPageId(flowItemId);
    try {
      const res = await apiFetch(`/nl2ui/save-page`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({
          config,
          title: userInput.slice(0, 80),
          autoPublish: true,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { success: boolean; pageName: string; pageUrl: string };
        if (data.success) {
          setSavedPages((prev) => ({ ...prev, [flowItemId]: { pageName: data.pageName, pageUrl: data.pageUrl } }));
          setRecent(addRecent({ kind: "page", name: data.pageName }));
        }
      }
    } catch { /* ignore */ }
    setSavingPageId(null);
  }, [locale, setRecent]);

  return {
    savingPageId,
    savedPages,
    maximizedNl2ui, setMaximizedNl2ui,
    nl2uiLoading, setNl2uiLoading,
    saveAsPage,
  };
}
