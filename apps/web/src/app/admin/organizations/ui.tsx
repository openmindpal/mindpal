"use client";

import { useState, useMemo } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { PageHeader, Card, Table, Badge, TabNav, getHelpHref } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

type OrgUnit = {
  unitId: string;
  tenantId: string;
  name: string;
  parentUnitId?: string;
  path?: string;
  depth?: number;
  createdAt?: string;
};
type Space = {
  id: string;
  name?: string;
  tenantId?: string;
  createdAt?: string;
};
type SpaceMember = {
  memberId: string;
  spaceId: string;
  subjectId: string;
  role: string;
  createdAt?: string;
};
type OrgUnitsList = ApiError & { units?: OrgUnit[] };
type SpacesList = ApiError & { spaces?: Space[] };
type MembersList = ApiError & { members?: SpaceMember[] };

export default function OrganizationsClient(props: {
  locale: string;
  initial: { orgUnits: unknown; spaces: unknown; orgUnitsStatus: number; spacesStatus: number };
}) {
  const [orgUnits, setOrgUnits] = useState<OrgUnitsList | null>((props.initial.orgUnits as OrgUnitsList) ?? null);
  const [spaces, setSpaces] = useState<SpacesList | null>((props.initial.spaces as SpacesList) ?? null);
  const [error, setError] = useState<string>("");

  // Org Unit Form
  const [showUnitForm, setShowUnitForm] = useState(false);
  const [unitName, setUnitName] = useState("");
  const [unitParentId, setUnitParentId] = useState("");

  // Space Create
  const [showSpaceForm, setShowSpaceForm] = useState(false);
  const [spaceName, setSpaceName] = useState("");

  // Space Members
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>("");
  const [spaceMembers, setSpaceMembers] = useState<MembersList | null>(null);
  const [showMemberForm, setShowMemberForm] = useState(false);
  const [memberSubjectId, setMemberSubjectId] = useState("");
  const [memberRole, setMemberRole] = useState("member");

  const orgUnitItems = useMemo(() => (Array.isArray(orgUnits?.units) ? orgUnits.units : []), [orgUnits]);
  const spaceItems = useMemo(() => (Array.isArray(spaces?.spaces) ? spaces.spaces : []), [spaces]);

  async function refreshOrgUnits() {
    const res = await apiFetch(`/org/units`, { locale: props.locale, cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    setOrgUnits((json as OrgUnitsList) ?? null);
    if (!res.ok) throw toApiError(json);
  }

  async function refreshSpaces() {
    const res = await apiFetch(`/spaces`, { locale: props.locale, cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    setSpaces((json as SpacesList) ?? null);
    if (!res.ok) throw toApiError(json);
  }

  async function createOrgUnit() {
    setError("");
    try {
      const res = await apiFetch(`/org/units`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          name: unitName,
          parentUnitId: unitParentId || undefined,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setShowUnitForm(false);
      setUnitName("");
      setUnitParentId("");
      await refreshOrgUnits();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function loadSpaceMembers(spaceId: string) {
    setSelectedSpaceId(spaceId);
    try {
      const res = await apiFetch(`/spaces/${encodeURIComponent(spaceId)}/members`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      setSpaceMembers((json as MembersList) ?? null);
      if (!res.ok) throw toApiError(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function addSpaceMember() {
    setError("");
    try {
      const res = await apiFetch(`/spaces/${encodeURIComponent(selectedSpaceId)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          subjectId: memberSubjectId,
          role: memberRole,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setShowMemberForm(false);
      setMemberSubjectId("");
      setMemberRole("member");
      await loadSpaceMembers(selectedSpaceId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function removeMember(memberId: string) {
    setError("");
    try {
      const res = await apiFetch(`/spaces/${encodeURIComponent(selectedSpaceId)}/members/${encodeURIComponent(memberId)}`, {
        method: "DELETE",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await loadSpaceMembers(selectedSpaceId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  const memberItems = useMemo(() => (Array.isArray(spaceMembers?.members) ? spaceMembers.members : []), [spaceMembers]);

  const unitsTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <Card title={t(props.locale, "admin.org.units.title")}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
          <button
            onClick={() => setShowUnitForm(!showUnitForm)}
            style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
          >
            {showUnitForm ? t(props.locale, "common.cancel") : t(props.locale, "admin.org.units.add")}
          </button>
        </div>

        {showUnitForm && (
          <div style={{ padding: "1rem", background: "rgba(15,23,42,0.03)", borderRadius: "0.5rem", marginBottom: "1rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.org.units.form.name")}</label>
                <input
                  value={unitName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUnitName(e.target.value)}
                  placeholder={t(props.locale, "admin.org.units.form.namePlaceholder")}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.org.units.form.parentUnit")}</label>
                <select
                  value={unitParentId}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setUnitParentId(e.target.value)}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                >
                  <option value="">{t(props.locale, "admin.org.units.form.noParent")}</option>
                  {orgUnitItems.map((u) => (
                    <option key={u.unitId} value={u.unitId}>{u.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ marginTop: "1rem" }}>
              <button onClick={createOrgUnit} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
                {t(props.locale, "common.create")}
              </button>
            </div>
          </div>
        )}

        {orgUnitItems.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2rem", color: "var(--sl-muted)" }}>
            {t(props.locale, "admin.org.units.noUnits")}
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t(props.locale, "admin.org.units.table.name")}</th>
                <th>{t(props.locale, "admin.org.units.table.path")}</th>
                <th>{t(props.locale, "admin.org.units.table.depth")}</th>
                <th>{t(props.locale, "admin.org.units.table.createdAt")}</th>
              </tr>
            </thead>
            <tbody>
              {orgUnitItems.map((u) => (
                <tr key={u.unitId}>
                  <td>{u.name}</td>
                  <td><code style={{ fontSize: 12 }}>{u.path || "/"}</code></td>
                  <td>{u.depth ?? 0}</td>
                  <td>{fmtDateTime(u.createdAt, props.locale)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );

  async function createSpace() {
    setError("");
    try {
      const res = await apiFetch(`/spaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ name: spaceName || undefined }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setShowSpaceForm(false);
      setSpaceName("");
      await refreshSpaces();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function deleteSpace(spaceId: string) {
    if (!confirm(t(props.locale, "admin.org.spaces.deleteConfirm").replace("{spaceId}", spaceId))) return;
    setError("");
    try {
      const res = await apiFetch(`/spaces/${encodeURIComponent(spaceId)}`, {
        method: "DELETE",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      if (selectedSpaceId === spaceId) {
        setSelectedSpaceId("");
        setSpaceMembers(null);
      }
      await refreshSpaces();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  const spacesTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <Card title={t(props.locale, "admin.org.spaces.manage")}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
          <button
            onClick={() => setShowSpaceForm(!showSpaceForm)}
            style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
          >
            {showSpaceForm ? t(props.locale, "common.cancel") : t(props.locale, "admin.org.spaces.create")}
          </button>
        </div>

        {showSpaceForm && (
          <div style={{ padding: "1rem", background: "rgba(15,23,42,0.03)", borderRadius: "0.5rem", marginBottom: "1rem" }}>
            <div>
              <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.org.spaces.nameLabel")}</label>
              <input
                value={spaceName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSpaceName(e.target.value)}
                placeholder={t(props.locale, "admin.org.spaces.namePlaceholder")}
                style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
              />
            </div>
            <div style={{ marginTop: "1rem" }}>
              <button onClick={createSpace} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
                {t(props.locale, "admin.org.spaces.confirmCreate")}
              </button>
            </div>
          </div>
        )}

        {spaceItems.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2rem", color: "var(--sl-muted)" }}>{t(props.locale, "admin.org.spaces.noSpacesHint")}</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t(props.locale, "admin.org.spaces.col.id")}</th>
                <th>{t(props.locale, "admin.org.spaces.col.name")}</th>
                <th>{t(props.locale, "admin.org.spaces.col.createdAt")}</th>
                <th>{t(props.locale, "admin.org.spaces.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {spaceItems.map((s) => (
                <tr key={s.id}>
                  <td><code style={{ fontSize: 12 }}>{s.id}</code></td>
                  <td>{s.name || "—"}</td>
                  <td>{fmtDateTime(s.createdAt, props.locale)}</td>
                  <td>
                    <button
                      onClick={() => deleteSpace(s.id)}
                      style={{ padding: "4px 12px", borderRadius: 6, background: "var(--sl-danger, #dc2626)", color: "#fff", border: "none", cursor: "pointer", fontSize: 12 }}
                    >
                      {t(props.locale, "admin.org.spaces.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );

  const membersTab = (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16 }}>
      <Card title={t(props.locale, "admin.org.spaces.selectSpace")}>
        {spaceItems.length === 0 ? (
          <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(props.locale, "admin.org.spaces.noSpacesCreateHint")}</p>
        ) : (
          <ul style={{ paddingLeft: 0, margin: 0, listStyle: "none", display: "grid", gap: 4 }}>
            {spaceItems.map((s) => (
              <li key={s.id}>
                <button
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: selectedSpaceId === s.id ? "var(--sl-accent-bg)" : "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "8px 12px",
                    borderRadius: 6,
                    fontWeight: selectedSpaceId === s.id ? 600 : 400,
                    color: selectedSpaceId === s.id ? "var(--sl-accent)" : "var(--sl-fg)",
                  }}
                  onClick={() => loadSpaceMembers(s.id)}
                >
                  {s.name || s.id}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={selectedSpaceId ? t(props.locale, "admin.org.members.title") : t(props.locale, "admin.org.members.selectSpace")}>
        {selectedSpaceId ? (
          <>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
              <button
                onClick={() => setShowMemberForm(!showMemberForm)}
                style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
              >
                {showMemberForm ? t(props.locale, "common.cancel") : t(props.locale, "admin.org.members.add")}
              </button>
            </div>

            {showMemberForm && (
              <div style={{ padding: "1rem", background: "rgba(15,23,42,0.03)", borderRadius: "0.5rem", marginBottom: "1rem" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                  <div>
                    <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.org.members.form.subjectId")}</label>
                    <input
                      value={memberSubjectId}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMemberSubjectId(e.target.value)}
                      placeholder="user_xxx"
                      style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.org.members.form.role")}</label>
                    <select
                      value={memberRole}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setMemberRole(e.target.value)}
                      style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                    >
                      <option value="owner">{t(props.locale, "admin.org.members.role.owner")}</option>
                      <option value="admin">{t(props.locale, "admin.org.members.role.admin")}</option>
                      <option value="member">{t(props.locale, "admin.org.members.role.member")}</option>
                      <option value="viewer">{t(props.locale, "admin.org.members.role.viewer")}</option>
                    </select>
                  </div>
                </div>
                <div style={{ marginTop: "1rem" }}>
                  <button onClick={addSpaceMember} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
                    {t(props.locale, "common.add")}
                  </button>
                </div>
              </div>
            )}

            {memberItems.length === 0 ? (
              <div style={{ textAlign: "center", padding: "2rem", color: "var(--sl-muted)" }}>
                {t(props.locale, "admin.org.members.noMembers")}
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>{t(props.locale, "admin.org.members.table.subjectId")}</th>
                    <th>{t(props.locale, "admin.org.members.table.role")}</th>
                    <th>{t(props.locale, "admin.org.members.table.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {memberItems.map((m) => (
                    <tr key={m.memberId}>
                      <td><code style={{ fontSize: 12 }}>{m.subjectId}</code></td>
                      <td>
                        <Badge tone={m.role === "owner" ? "warning" : m.role === "admin" ? "success" : "neutral"}>
                          {m.role}
                        </Badge>
                      </td>
                      <td>
                        <button
                          onClick={() => removeMember(m.memberId)}
                          style={{ padding: "4px 12px", borderRadius: 6, background: "var(--sl-danger)", color: "#fff", border: "none", cursor: "pointer", fontSize: 12 }}
                        >
                          {t(props.locale, "common.remove")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        ) : (
          <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(props.locale, "admin.org.members.selectSpaceHint")}</p>
        )}
      </Card>
    </div>
  );

  return (
    <div style={{ padding: "1.5rem" }}>
      <PageHeader
        title={t(props.locale, "admin.org.title")}
        description={t(props.locale, "admin.org.desc")}
        helpHref={getHelpHref("/admin/organizations", props.locale) ?? undefined}
      />

      {error && (
        <div style={{ color: "var(--sl-danger)", marginBottom: "1rem", padding: "0.75rem", background: "rgba(220,38,38,0.1)", borderRadius: "0.5rem" }}>
          {error}
        </div>
      )}

      <TabNav
        tabs={[
          { key: "units", label: t(props.locale, "admin.org.tab.units"), content: unitsTab },
          { key: "spaces", label: t(props.locale, "admin.org.spaces.tab"), content: spacesTab },
          { key: "members", label: t(props.locale, "admin.org.members.tab"), content: membersTab },
        ]}
        defaultTab="units"
      />
    </div>
  );
}
