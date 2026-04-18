"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { t, statusLabel } from "@/lib/i18n";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Badge, Card, PageHeader, StructuredData, Table, getHelpHref } from "@/components/ui";

type Space = { id: string; name?: string };
type BackupItem = {
  backupId: string;
  status: string;
  scope?: string;
  schemaName?: string;
  entityNames?: string[] | null;
  format?: string;
  createdAt?: string;
  updatedAt?: string;
  backupArtifactId?: string | null;
  reportArtifactId?: string | null;
  policySnapshotRef?: string | null;
  runId?: string | null;
  stepId?: string | null;
  createdBySubjectId?: string | null;
};
type SpacesResp = { spaces?: Space[] } & ApiError;
type BackupsResp = { items?: BackupItem[] } & ApiError;
type ActionResult = { kind: "create" | "dry_run" | "commit"; payload: Record<string, unknown> } | null;

const btnPrimary: React.CSSProperties = {
  padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer",
  background: "var(--sl-accent, #818cf8)", color: "#fff", fontSize: 13, fontWeight: 500,
};
const btnSecondary: React.CSSProperties = {
  padding: "6px 16px", borderRadius: 6, border: "1px solid var(--sl-border)", cursor: "pointer",
  background: "transparent", color: "var(--sl-fg)", fontSize: 13,
};

function parseCsvText(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function snapshotHrefOf(locale: string, policySnapshotRef?: string | null) {
  const raw = String(policySnapshotRef ?? "");
  if (!raw.startsWith("policy_snapshot:")) return "";
  const snapshotId = raw.slice("policy_snapshot:".length);
  if (!snapshotId) return "";
  return `/gov/policy-snapshots/${encodeURIComponent(snapshotId)}?lang=${encodeURIComponent(locale)}`;
}

export default function BackupsClient(props: {
  locale: string;
  initialSpaces: unknown;
  initialSpacesStatus: number;
}) {
  const [spacesData] = useState<SpacesResp | null>((props.initialSpaces as SpacesResp) ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedSpaceId, setSelectedSpaceId] = useState("");
  const [backups, setBackups] = useState<BackupsResp | null>(null);
  const [schemaName, setSchemaName] = useState("");
  const [entityNamesText, setEntityNamesText] = useState("");
  const [backupFormat, setBackupFormat] = useState<"json" | "jsonl">("jsonl");
  const [restoreSchemaName, setRestoreSchemaName] = useState("");
  const [restoreConflictStrategy, setRestoreConflictStrategy] = useState<"fail" | "upsert">("fail");
  const [restoreTargetMode, setRestoreTargetMode] = useState<"current_space" | "new_space">("new_space");
  const [restoreTargetSpaceId, setRestoreTargetSpaceId] = useState("");
  const [restoreTargetSpaceName, setRestoreTargetSpaceName] = useState("");
  const [selectedBackupId, setSelectedBackupId] = useState("");
  const [actionResult, setActionResult] = useState<ActionResult>(null);

  const spaces = useMemo(() => Array.isArray(spacesData?.spaces) ? spacesData!.spaces! : [], [spacesData]);

  // Auto-select first space
  useEffect(() => {
    if (!selectedSpaceId && spaces.length > 0) {
      setSelectedSpaceId(spaces[0]!.id);
    }
  }, [spaces, selectedSpaceId]);

  const loadBackups = useCallback(async () => {
    if (!selectedSpaceId) return;
    setError("");
    try {
      const res = await apiFetch(`/spaces/${encodeURIComponent(selectedSpaceId)}/backups?limit=50`, { locale: props.locale, cache: "no-store" });
      const json = (await res.json().catch(() => null)) as BackupsResp;
      if (!res.ok) { setError(errText(props.locale, json)); return; }
      setBackups(json);
      const items = Array.isArray(json?.items) ? json.items : [];
      setSelectedBackupId((prev) => {
        if (prev && items.some((item) => item.backupId === prev)) return prev;
        return items[0]?.backupId ?? "";
      });
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    }
  }, [selectedSpaceId, props.locale]);

  useEffect(() => {
    if (selectedSpaceId) loadBackups();
  }, [selectedSpaceId, loadBackups]);

  async function handleCreate() {
    if (!selectedSpaceId) return;
    setBusy(true);
    setError("");
    setActionResult(null);
    try {
      const res = await apiFetch(`/spaces/${encodeURIComponent(selectedSpaceId)}/backups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaName: schemaName.trim() || undefined,
          entityNames: parseCsvText(entityNamesText),
          format: backupFormat,
        }),
        locale: props.locale,
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) { setError(errText(props.locale, json)); return; }
      setActionResult({ kind: "create", payload: { backupId: json.backupId ?? "", receipt: json.receipt ?? null } });
      await loadBackups();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(backup: BackupItem, mode: "dry_run" | "commit") {
    if (!selectedSpaceId || !backup.backupArtifactId) return;
    const confirmMessage = mode === "commit" ? t(props.locale, "admin.backups.commitConfirm") : t(props.locale, "admin.backups.restoreConfirm");
    if (!confirm(confirmMessage)) return;
    setBusy(true);
    setError("");
    setActionResult(null);
    try {
      const res = await apiFetch(`/spaces/${encodeURIComponent(selectedSpaceId)}/restores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backupArtifactId: backup.backupArtifactId,
          mode,
          conflictStrategy: restoreConflictStrategy,
          schemaName: restoreSchemaName.trim() || undefined,
          targetMode: restoreTargetMode,
          targetSpaceId: restoreTargetMode === "new_space" ? (restoreTargetSpaceId.trim() || undefined) : undefined,
          targetSpaceName: restoreTargetMode === "new_space" ? (restoreTargetSpaceName.trim() || undefined) : undefined,
        }),
        locale: props.locale,
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) { setError(errText(props.locale, json)); return; }
      if (mode === "dry_run") {
        setActionResult({
          kind: "dry_run",
          payload: {
            backupId: backup.backupId,
            acceptedCount: json.acceptedCount ?? 0,
            rejectedCount: json.rejectedCount ?? 0,
            conflicts: json.conflicts ?? 0,
            conflictsDigest: json.conflictsDigest ?? null,
            targetMode: json.targetMode ?? restoreTargetMode,
            targetSpaceId: json.targetSpaceId ?? (restoreTargetMode === "current_space" ? selectedSpaceId : restoreTargetSpaceId || null),
            targetSpaceName: json.targetSpaceName ?? (restoreTargetMode === "new_space" ? restoreTargetSpaceName || null : null),
          },
        });
      } else {
        setActionResult({
          kind: "commit",
          payload: {
            backupId: backup.backupId,
            runId: json.runId ?? null,
            stepId: json.stepId ?? null,
            receipt: json.receipt ?? null,
            conflictStrategy: restoreConflictStrategy,
            targetMode: json.targetMode ?? restoreTargetMode,
            targetSpaceId: json.targetSpaceId ?? (restoreTargetMode === "current_space" ? selectedSpaceId : restoreTargetSpaceId || null),
            targetSpaceName: json.targetSpaceName ?? (restoreTargetMode === "new_space" ? restoreTargetSpaceName || null : null),
          },
        });
      }
      await loadBackups();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const backupItems = useMemo(() => Array.isArray(backups?.items) ? backups!.items! : [], [backups]);
  const selectedBackup = useMemo(
    () => backupItems.find((item) => item.backupId === selectedBackupId) ?? backupItems[0] ?? null,
    [backupItems, selectedBackupId],
  );

  return (
    <div>
      <PageHeader
        title={t(props.locale, "admin.backups.title")}
        description={t(props.locale, "admin.backups.desc")}
        helpHref={getHelpHref("/admin/backups", props.locale) ?? undefined}
        actions={
          <button style={btnPrimary} onClick={handleCreate} disabled={busy || !selectedSpaceId}>
            {busy ? t(props.locale, "admin.backups.creating") : t(props.locale, "admin.backups.create")}
          </button>
        }
      />

      {(error) && (
        <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: "8px 0", fontSize: 12 }}>{error}</pre>
      )}
      {actionResult ? (
        <Card title={t(props.locale, `admin.backups.result.${actionResult.kind}`)}>
          <StructuredData data={actionResult.payload} />
        </Card>
      ) : null}

      <div style={{ margin: "16px 0", display: "flex", alignItems: "center", gap: 12 }}>
        <label style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "admin.backups.space")}</label>
        <select
          value={selectedSpaceId}
          onChange={(e) => setSelectedSpaceId(e.target.value)}
          style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-bg)", color: "var(--sl-fg)", fontSize: 13 }}
        >
          {spaces.length === 0 && <option value="">{t(props.locale, "admin.backups.noSpaces")}</option>}
          {spaces.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.id}</option>)}
        </select>
        <button style={btnSecondary} onClick={loadBackups} disabled={busy || !selectedSpaceId}>{t(props.locale, "admin.backups.refresh")}</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 420px) 1fr", gap: 16, marginBottom: 16 }}>
        <Card title={t(props.locale, "admin.backups.createOptions")}>
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "admin.backups.schemaName")}</span>
              <input
                value={schemaName}
                onChange={(e) => setSchemaName(e.target.value)}
                placeholder={t(props.locale, "admin.backups.schemaPlaceholder")}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "admin.backups.entityNames")}</span>
              <input
                value={entityNamesText}
                onChange={(e) => setEntityNamesText(e.target.value)}
                placeholder={t(props.locale, "admin.backups.entityNamesPlaceholder")}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "admin.backups.format")}</span>
              <select value={backupFormat} onChange={(e) => setBackupFormat(e.target.value === "json" ? "json" : "jsonl")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
                <option value="jsonl">{t(props.locale, "admin.backups.format.jsonl")}</option>
                <option value="json">{t(props.locale, "admin.backups.format.json")}</option>
              </select>
            </label>
          </div>
        </Card>

        <Card title={t(props.locale, "admin.backups.restoreOptions")}>
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "admin.backups.restoreTargetMode")}</span>
              <select value={restoreTargetMode} onChange={(e) => setRestoreTargetMode(e.target.value === "current_space" ? "current_space" : "new_space")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
                <option value="new_space">{t(props.locale, "admin.backups.targetMode.new_space")}</option>
                <option value="current_space">{t(props.locale, "admin.backups.targetMode.current_space")}</option>
              </select>
            </label>
            {restoreTargetMode === "new_space" ? (
              <>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "admin.backups.targetSpaceId")}</span>
                  <input
                    value={restoreTargetSpaceId}
                    onChange={(e) => setRestoreTargetSpaceId(e.target.value)}
                    placeholder={t(props.locale, "admin.backups.targetSpaceIdPlaceholder")}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                  />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "admin.backups.targetSpaceName")}</span>
                  <input
                    value={restoreTargetSpaceName}
                    onChange={(e) => setRestoreTargetSpaceName(e.target.value)}
                    placeholder={t(props.locale, "admin.backups.targetSpaceNamePlaceholder")}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                  />
                </label>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "var(--sl-muted)" }}>
                {t(props.locale, "admin.backups.currentSpaceHint").replace("{spaceId}", selectedSpaceId || "-")}
              </div>
            )}
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "admin.backups.schemaOverride")}</span>
              <input
                value={restoreSchemaName}
                onChange={(e) => setRestoreSchemaName(e.target.value)}
                placeholder={t(props.locale, "admin.backups.schemaPlaceholder")}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "admin.backups.conflictStrategy")}</span>
              <select value={restoreConflictStrategy} onChange={(e) => setRestoreConflictStrategy(e.target.value === "upsert" ? "upsert" : "fail")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
                <option value="fail">{t(props.locale, "admin.backups.conflict.fail")}</option>
                <option value="upsert">{t(props.locale, "admin.backups.conflict.upsert")}</option>
              </select>
            </label>
            <div style={{ fontSize: 12, color: "var(--sl-muted)" }}>{t(props.locale, "admin.backups.restoreHint")}</div>
          </div>
        </Card>
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <th>{t(props.locale, "admin.backups.col.backupId")}</th>
              <th>{t(props.locale, "admin.backups.col.status")}</th>
              <th>{t(props.locale, "admin.backups.col.schema")}</th>
              <th>{t(props.locale, "admin.backups.col.entities")}</th>
              <th>{t(props.locale, "admin.backups.col.format")}</th>
              <th>{t(props.locale, "admin.backups.col.createdAt")}</th>
              <th>{t(props.locale, "admin.backups.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {backupItems.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--sl-muted)" }}>{t(props.locale, "admin.backups.noRecords")}</td></tr>
            )}
            {backupItems.map((b) => (
              <tr
                key={b.backupId}
                onClick={() => setSelectedBackupId(b.backupId)}
                style={{ background: selectedBackup?.backupId === b.backupId ? "var(--sl-accent-bg)" : undefined, cursor: "pointer" }}
              >
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>{b.backupId}</td>
                <td><Badge>{statusLabel(b.status, props.locale)}</Badge></td>
                <td>{b.schemaName ?? "—"}</td>
                <td>{Array.isArray(b.entityNames) && b.entityNames.length > 0 ? b.entityNames.join(", ") : t(props.locale, "admin.backups.allEntities")}</td>
                <td>{b.format ?? "—"}</td>
                <td>{b.createdAt ? fmtDateTime(b.createdAt, props.locale) : "—"}</td>
                <td>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      style={{ ...btnSecondary, padding: "2px 8px", fontSize: 12 }}
                      onClick={(e) => { e.stopPropagation(); setSelectedBackupId(b.backupId); }}
                    >
                      {t(props.locale, "admin.backups.detail")}
                    </button>
                    {b.backupArtifactId ? (
                      <>
                        <button
                          style={{ ...btnSecondary, padding: "2px 8px", fontSize: 12 }}
                          onClick={(e) => { e.stopPropagation(); void handleRestore(b, "dry_run"); }}
                          disabled={busy}
                        >
                          {t(props.locale, "admin.backups.restore")}
                        </button>
                        <button
                          style={{ ...btnPrimary, padding: "2px 8px", fontSize: 12 }}
                          onClick={(e) => { e.stopPropagation(); void handleRestore(b, "commit"); }}
                          disabled={busy}
                        >
                          {t(props.locale, "admin.backups.commit")}
                        </button>
                      </>
                    ) : (
                      <span style={{ color: "var(--sl-muted)", fontSize: 12 }}>{t(props.locale, "admin.backups.noArtifact")}</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "admin.backups.detailTitle")}>
          {selectedBackup ? (
            <div style={{ display: "grid", gap: 12 }}>
              <StructuredData
                data={{
                  backupId: selectedBackup.backupId,
                  status: selectedBackup.status,
                  scope: selectedBackup.scope ?? "space",
                  schemaName: selectedBackup.schemaName ?? null,
                  entityNames: selectedBackup.entityNames ?? null,
                  format: selectedBackup.format ?? null,
                  createdBySubjectId: selectedBackup.createdBySubjectId ?? null,
                  createdAt: selectedBackup.createdAt ?? null,
                  updatedAt: selectedBackup.updatedAt ?? null,
                  backupArtifactId: selectedBackup.backupArtifactId ?? null,
                  reportArtifactId: selectedBackup.reportArtifactId ?? null,
                  policySnapshotRef: selectedBackup.policySnapshotRef ?? null,
                  runId: selectedBackup.runId ?? null,
                  stepId: selectedBackup.stepId ?? null,
                }}
              />
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                {selectedBackup.runId ? (
                  <a href={`/runs/${encodeURIComponent(selectedBackup.runId)}?lang=${encodeURIComponent(props.locale)}`} style={{ color: "var(--sl-accent)" }}>
                    {t(props.locale, "admin.backups.openRun")}
                  </a>
                ) : null}
                {snapshotHrefOf(props.locale, selectedBackup.policySnapshotRef) ? (
                  <a href={snapshotHrefOf(props.locale, selectedBackup.policySnapshotRef)} style={{ color: "var(--sl-accent)" }}>
                    {t(props.locale, "admin.backups.openSnapshot")}
                  </a>
                ) : null}
              </div>
            </div>
          ) : (
            <p style={{ margin: 0, color: "var(--sl-muted)", fontSize: 13 }}>{t(props.locale, "admin.backups.noSelection")}</p>
          )}
        </Card>
      </div>
    </div>
  );
}
