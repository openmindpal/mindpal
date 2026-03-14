import Link from "next/link";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { AppShell, AppShellContent, AppShellHeader, AppShellSideNav } from "./AppShell";
import styles from "./ConsoleShell.module.css";

export function ConsoleShell(props: { locale: string; children: ReactNode }) {
  const homeHref = `/?lang=${encodeURIComponent(props.locale)}`;
  const settingsHref = `/settings?lang=${encodeURIComponent(props.locale)}`;
  const runsHref = `/runs?lang=${encodeURIComponent(props.locale)}`;
  const tasksHref = `/tasks?lang=${encodeURIComponent(props.locale)}`;
  const chatHref = `/chat?lang=${encodeURIComponent(props.locale)}`;
  const orchestratorHref = `/orchestrator?lang=${encodeURIComponent(props.locale)}`;
  const adminUiHref = `/admin/ui?lang=${encodeURIComponent(props.locale)}`;
  const adminRbacHref = `/admin/rbac?lang=${encodeURIComponent(props.locale)}`;
  const adminWorkbenchesHref = `/admin/workbenches?lang=${encodeURIComponent(props.locale)}`;
  const govChangeSetsHref = `/gov/changesets?lang=${encodeURIComponent(props.locale)}`;
  const govToolsHref = `/gov/tools?lang=${encodeURIComponent(props.locale)}`;
  const govApprovalsHref = `/gov/approvals?lang=${encodeURIComponent(props.locale)}`;
  const govWorkflowDeadlettersHref = `/gov/workflow/deadletters?lang=${encodeURIComponent(props.locale)}`;
  const govAuditHref = `/gov/audit?lang=${encodeURIComponent(props.locale)}`;
  const govObservabilityHref = `/gov/observability?lang=${encodeURIComponent(props.locale)}`;
  const govPolicySnapshotsHref = `/gov/policy-snapshots?lang=${encodeURIComponent(props.locale)}`;
  const govPolicyDebuggerHref = `/gov/policy-debugger?lang=${encodeURIComponent(props.locale)}`;
  const govSyncConflictsHref = `/gov/sync-conflicts?lang=${encodeURIComponent(props.locale)}`;
  const govSkillPackagesHref = `/gov/skill-packages?lang=${encodeURIComponent(props.locale)}`;
  const govModelGatewayHref = `/gov/model-gateway?lang=${encodeURIComponent(props.locale)}`;
  const govRoutingHref = `/gov/routing?lang=${encodeURIComponent(props.locale)}`;
  const govQuotasHref = `/gov/quotas?lang=${encodeURIComponent(props.locale)}`;
  const govArtifactPolicyHref = `/gov/artifact-policy?lang=${encodeURIComponent(props.locale)}`;
  const govModelsHref = `/gov/models?lang=${encodeURIComponent(props.locale)}`;
  const govChannelsHref = `/gov/channels?lang=${encodeURIComponent(props.locale)}`;
  const govTriggersHref = `/gov/triggers?lang=${encodeURIComponent(props.locale)}`;
  const govKnowledgeLogsHref = `/gov/knowledge/retrieval-logs?lang=${encodeURIComponent(props.locale)}`;
  const govKnowledgeJobsHref = `/gov/knowledge/jobs?lang=${encodeURIComponent(props.locale)}`;
  const govKnowledgeQualityHref = `/gov/knowledge/quality?lang=${encodeURIComponent(props.locale)}`;
  const govSyncHref = `/gov/sync?lang=${encodeURIComponent(props.locale)}`;
  const govIntegrationsHref = `/gov/integrations?lang=${encodeURIComponent(props.locale)}`;

  return (
    <AppShell
      header={
        <AppShellHeader>
          <div className={styles.headerRow}>
            <div className={styles.headerLeft}>
              <Link className={styles.appTitle} href={homeHref}>
                {t(props.locale, "app.title")}
              </Link>
            </div>
            <div className={styles.headerRight}>
              <details className={styles.mobileMenu}>
                <summary>{t(props.locale, "shell.nav.menu")}</summary>
                <div className={styles.mobileMenuPanel}>
                  <Link href={runsHref}>{t(props.locale, "shell.nav.runs")}</Link>
                  <Link href={tasksHref}>{t(props.locale, "shell.nav.tasks")}</Link>
                  <Link href={chatHref}>{t(props.locale, "shell.nav.chat")}</Link>
                  <Link href={orchestratorHref}>{t(props.locale, "shell.nav.orchestrator")}</Link>
                  <Link href={govChangeSetsHref}>{t(props.locale, "gov.nav.changesets")}</Link>
                  <Link href={govToolsHref}>{t(props.locale, "gov.nav.tools")}</Link>
                  <Link href={govSkillPackagesHref}>{t(props.locale, "gov.nav.skillPackages")}</Link>
                  <Link href={govPolicyDebuggerHref}>{t(props.locale, "gov.nav.policyDebugger")}</Link>
                  <Link href={govObservabilityHref}>{t(props.locale, "gov.nav.observability")}</Link>
                  <Link href={adminUiHref}>{t(props.locale, "home.adminUi")}</Link>
                  <Link href={adminRbacHref}>{t(props.locale, "home.adminRbac")}</Link>
                  <Link href={adminWorkbenchesHref}>{t(props.locale, "home.adminWorkbenches")}</Link>
                  <Link href={settingsHref}>{t(props.locale, "home.settings")}</Link>
                </div>
              </details>
              <Link href={settingsHref}>{t(props.locale, "home.settings")}</Link>
              <Link href={govChangeSetsHref}>{t(props.locale, "home.governanceConsole")}</Link>
            </div>
          </div>
        </AppShellHeader>
      }
      sideNav={
        <AppShellSideNav>
          <div className={styles.navGroup}>
            <div className={styles.navGroupTitle}>{t(props.locale, "shell.nav.console")}</div>
            <ul className={styles.navList}>
              <li>
                <Link className={styles.navLink} href={runsHref}>
                  {t(props.locale, "shell.nav.runs")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={tasksHref}>
                  {t(props.locale, "shell.nav.tasks")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={chatHref}>
                  {t(props.locale, "shell.nav.chat")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={orchestratorHref}>
                  {t(props.locale, "shell.nav.orchestrator")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={settingsHref}>
                  {t(props.locale, "shell.nav.settings")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={`${settingsHref}#model-bindings`}>
                  {t(props.locale, "settings.section.modelBindings")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={`${settingsHref}#channels`}>
                  {t(props.locale, "settings.section.channels")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={`${settingsHref}#schedules`}>
                  {t(props.locale, "settings.section.schedules")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={`${settingsHref}#tools`}>
                  {t(props.locale, "settings.section.tools")}
                </Link>
              </li>
            </ul>
          </div>

          <div className={styles.navGroup}>
            <div className={styles.navGroupTitle}>{t(props.locale, "shell.nav.governance")}</div>
            <ul className={styles.navList}>
              <li>
                <Link className={styles.navLink} href={govChangeSetsHref}>
                  {t(props.locale, "gov.nav.changesets")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govToolsHref}>
                  {t(props.locale, "gov.nav.tools")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govSkillPackagesHref}>
                  {t(props.locale, "gov.nav.skillPackages")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govChannelsHref}>
                  {t(props.locale, "gov.nav.channels")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govTriggersHref}>
                  {t(props.locale, "gov.nav.triggers")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govModelsHref}>
                  {t(props.locale, "gov.nav.models")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govArtifactPolicyHref}>
                  {t(props.locale, "gov.nav.artifactPolicy")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govApprovalsHref}>
                  {t(props.locale, "gov.nav.approvals")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govWorkflowDeadlettersHref}>
                  {t(props.locale, "gov.nav.workflowDeadletters")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govAuditHref}>
                  {t(props.locale, "gov.nav.audit")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govObservabilityHref}>
                  {t(props.locale, "gov.nav.observability")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govPolicySnapshotsHref}>
                  {t(props.locale, "gov.nav.policySnapshots")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govPolicyDebuggerHref}>
                  {t(props.locale, "gov.nav.policyDebugger")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govSyncConflictsHref}>
                  {t(props.locale, "gov.nav.syncConflicts")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govModelGatewayHref}>
                  {t(props.locale, "gov.nav.modelGateway")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govRoutingHref}>
                  {t(props.locale, "gov.nav.routing")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govQuotasHref}>
                  {t(props.locale, "gov.nav.quotas")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govKnowledgeLogsHref}>
                  {t(props.locale, "gov.nav.knowledgeLogs")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govKnowledgeJobsHref}>
                  {t(props.locale, "gov.nav.knowledgeJobs")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govKnowledgeQualityHref}>
                  {t(props.locale, "gov.nav.knowledgeQuality")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govSyncHref}>
                  {t(props.locale, "gov.nav.sync")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={govIntegrationsHref}>
                  {t(props.locale, "gov.nav.integrations")}
                </Link>
              </li>
            </ul>
          </div>

          <div className={styles.navGroup}>
            <div className={styles.navGroupTitle}>{t(props.locale, "home.adminRbac")}</div>
            <ul className={styles.navList}>
              <li>
                <Link className={styles.navLink} href={adminUiHref}>
                  {t(props.locale, "home.adminUi")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={adminRbacHref}>
                  {t(props.locale, "home.adminRbac")}
                </Link>
              </li>
              <li>
                <Link className={styles.navLink} href={adminWorkbenchesHref}>
                  {t(props.locale, "home.adminWorkbenches")}
                </Link>
              </li>
            </ul>
          </div>
        </AppShellSideNav>
      }
    >
      <AppShellContent>{props.children}</AppShellContent>
    </AppShell>
  );
}
