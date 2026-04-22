import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import styles from "@/styles/ui.module.css";

/** Map of page path prefixes to documentation anchors */
const HELP_LINKS: Record<string, string> = {
  "/runs": "/docs#runs",
  "/tasks": "/docs#tasks",
  "/settings": "/docs#settings",
  "/orchestrator": "/docs#orchestrator",
  "/gov/changesets": "/docs#changesets",
  "/gov/schemas": "/docs#schemas",
  "/gov/tools": "/docs#tools",
  "/gov/models": "/docs#models",
  "/gov/safety-policies": "/docs#safety-policies",
  "/gov/policy-debugger": "/docs#policy-debugger",
  "/gov/audit": "/docs#audit",
  "/gov/observability": "/docs#observability",
  "/gov/workflow/deadletters": "/docs#deadletters",
  "/gov/knowledge": "/docs#knowledge",
  "/gov/federation": "/docs#federation",
  "/admin/rbac": "/docs#rbac",
  "/admin/sso": "/docs#sso",
  "/admin/scim": "/docs#scim",
  "/admin/organizations": "/docs#organizations",
  "/admin/backups": "/docs#backups",
};

export function getHelpHref(pathname: string, locale: string): string | null {
  for (const [prefix, anchor] of Object.entries(HELP_LINKS)) {
    if (pathname.startsWith(prefix)) {
      return `${anchor}?lang=${encodeURIComponent(locale)}`;
    }
  }
  return null;
}

export function PageHeader(props: { title: ReactNode; description?: ReactNode; actions?: ReactNode; helpHref?: string }) {
  const helpLocale = props.helpHref ? new URL(props.helpHref, "http://localhost").searchParams.get("lang") ?? "zh-CN" : "zh-CN";
  return (
    <div className={styles.pageHeader}>
      <div className={styles.pageHeaderMain}>
        <div className={styles.pageHeaderTitle}>
          {props.title}
          {props.helpHref && (
            <a
              href={props.helpHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: 8, fontSize: 13, fontWeight: 400, color: "var(--sl-accent)", textDecoration: "none", verticalAlign: "middle" }}
              title={t(helpLocale, "shell.help.button")}
            >
              ?
            </a>
          )}
        </div>
        {props.description ? <div className={styles.pageHeaderDesc}>{props.description}</div> : null}
      </div>
      {props.actions ? <div className={styles.pageHeaderActions}>{props.actions}</div> : null}
    </div>
  );
}
