/**
 * 命令注册集成测试 — 验证全部 27 个命令组注册 + 子命令结构 + 代表性端到端执行
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { addGlobalOptions } from "../lib/globalOptions";

// ── 导入全部命令注册函数 ──────────────────────────────────────────
import { registerHealthCommands } from "../commands/health";
import { registerDiagnosticsCommands } from "../commands/diagnostics";
import { registerAuthCommands } from "../commands/auth";
import { registerRbacCommands } from "../commands/rbac";
import { registerScimCommands } from "../commands/scim";
import { registerSpacesCommands } from "../commands/spaces";
import { registerSchemasCommands, registerEntitiesCommands, registerToolsCommands } from "../commands/modeling";
import { registerChangesetsCommands, registerEvalsCommands, registerPolicyCommands, registerApprovalsCommands } from "../commands/governance";
import { registerRunsCommands } from "../commands/runs";
import { registerJobsCommands } from "../commands/jobs";
import { registerSecretsCommands } from "../commands/secrets";
import { registerKeyringCommands } from "../commands/keyring";
import { registerAuditCommands } from "../commands/audit";
import { registerSettingsCommands } from "../commands/settings";
import { registerNotificationsCommands } from "../commands/notifications";
import { registerSkillsCommands } from "../commands/skills";
import { registerKnowledgeCommands } from "../commands/knowledge";
import { registerFederationCommands } from "../commands/federation";
import { registerUiCommands } from "../commands/ui";
import { registerConfigCommands } from "../commands/config";
import { registerArtifactPolicyCommands } from "../commands/artifactPolicy";
import { registerIntegrationsCommands } from "../commands/integrations";
import { registerCollabCommands } from "../commands/collab";
import { registerObservabilityCommands } from "../commands/observability";
import { registerBackupsCommands } from "../commands/backups";
import { registerModelsCommands } from "../commands/models";
import { registerMeCommands } from "../commands/me";

/** 构建完整 CLI program 实例（与 index.ts 一致） */
function buildProgram(): Command {
  const program = new Command();
  program.name("mindpal-admin").version("0.1.0").exitOverride(); // exitOverride 防止测试中退出进程
  addGlobalOptions(program);

  registerHealthCommands(program);
  registerDiagnosticsCommands(program);
  registerMeCommands(program);
  registerAuthCommands(program);
  registerRbacCommands(program);
  registerScimCommands(program);
  registerSpacesCommands(program);
  registerSchemasCommands(program);
  registerEntitiesCommands(program);
  registerToolsCommands(program);
  registerChangesetsCommands(program);
  registerEvalsCommands(program);
  registerPolicyCommands(program);
  registerApprovalsCommands(program);
  registerAuditCommands(program);
  registerSettingsCommands(program);
  registerConfigCommands(program);
  registerArtifactPolicyCommands(program);
  registerUiCommands(program);
  registerRunsCommands(program);
  registerJobsCommands(program);
  registerSecretsCommands(program);
  registerKeyringCommands(program);
  registerNotificationsCommands(program);
  registerSkillsCommands(program);
  registerModelsCommands(program);
  registerKnowledgeCommands(program);
  registerFederationCommands(program);
  registerIntegrationsCommands(program);
  registerCollabCommands(program);
  registerObservabilityCommands(program);
  registerBackupsCommands(program);

  return program;
}

/** 获取 command 的所有直接子命令名称 */
function getSubcommandNames(cmd: Command): string[] {
  return cmd.commands.map((c) => c.name());
}

function findCommand(program: Command, path: string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (!current) return undefined;
  }
  return current;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*  Part 1: 命令注册完整性测试                                      */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe("命令注册完整性", () => {
  let program: Command;

  beforeEach(() => {
    program = buildProgram();
  });

  const EXPECTED_TOP_LEVEL = [
    "health", "diagnostics", "me", "auth", "rbac", "scim", "spaces",
    "schemas", "entities", "tools", "changesets", "evals", "policy",
    "approvals", "audit", "settings", "config", "artifact-policy", "ui",
    "runs", "jobs", "secrets", "keyring", "notifications", "skills",
    "models", "knowledge", "federation", "integrations", "collab",
    "observability", "backups",
  ];

  it("注册全部 27+ 个顶级命令", () => {
    const names = getSubcommandNames(program);
    for (const expected of EXPECTED_TOP_LEVEL) {
      expect(names, `缺少顶级命令: ${expected}`).toContain(expected);
    }
  });

  // spaces 有嵌套子命令 org（从 spaces 模块注册）
  it("spaces 下注册 org 顶级命令", () => {
    // org 作为独立顶级命令注册
    expect(getSubcommandNames(program)).toContain("org");
  });

  /* ── health 子命令 ─────────────────────────── */
  it("health 包含 live/ready/full/db-pool/system", () => {
    const health = findCommand(program, ["health"])!;
    const subs = getSubcommandNames(health);
    expect(subs).toContain("live");
    expect(subs).toContain("ready");
    expect(subs).toContain("full");
    expect(subs).toContain("db-pool");
    expect(subs).toContain("system");
  });

  /* ── me 子命令 ──────────────────────────────── */
  it("me 包含 info/prefs-get/prefs-set", () => {
    const me = findCommand(program, ["me"])!;
    const subs = getSubcommandNames(me);
    expect(subs).toContain("info");
    expect(subs).toContain("prefs-get");
    expect(subs).toContain("prefs-set");
  });

  /* ── runs 深层子命令 ────────────────────────── */
  it("runs 包含 list/get/cancel/retry/deadletters/steps/compensations 等", () => {
    const runs = findCommand(program, ["runs"])!;
    const subs = getSubcommandNames(runs);
    for (const name of ["list", "active", "get", "cancel", "retry", "pause", "resume", "skip",
      "reexec", "approve", "reject", "replan", "deadletters", "steps", "compensations"]) {
      expect(subs, `runs 缺少子命令: ${name}`).toContain(name);
    }
  });

  it("runs deadletters 包含 list/retry/cancel", () => {
    const dl = findCommand(program, ["runs", "deadletters"])!;
    const subs = getSubcommandNames(dl);
    expect(subs).toContain("list");
    expect(subs).toContain("retry");
    expect(subs).toContain("cancel");
  });

  /* ── models 深层子命令 ──────────────────────── */
  it("models 包含 catalog/bindings/onboard/chat/routing", () => {
    const models = findCommand(program, ["models"])!;
    const subs = getSubcommandNames(models);
    expect(subs).toContain("catalog");
    expect(subs).toContain("bindings");
    expect(subs).toContain("onboard");
    expect(subs).toContain("chat");
    expect(subs).toContain("routing");
  });

  it("models catalog 包含 list/db-list/db-get/db-upsert/db-set-status/db-delete", () => {
    const catalog = findCommand(program, ["models", "catalog"])!;
    const subs = getSubcommandNames(catalog);
    for (const name of ["list", "db-list", "db-get", "db-upsert", "db-set-status", "db-delete"]) {
      expect(subs, `models catalog 缺少: ${name}`).toContain(name);
    }
  });

  /* ── audit 深层子命令 ───────────────────────── */
  it("audit 包含 list/verify/hashchain-verify/legal-holds/exports/siem", () => {
    const audit = findCommand(program, ["audit"])!;
    const subs = getSubcommandNames(audit);
    for (const name of ["list", "verify", "hashchain-verify", "legal-holds", "exports", "siem"]) {
      expect(subs, `audit 缺少: ${name}`).toContain(name);
    }
  });

  /* ── knowledge 深层子命令 ───────────────────── */
  it("knowledge 包含 documents/strategies/ingest-jobs/quality 等", () => {
    const knowledge = findCommand(program, ["knowledge"])!;
    const subs = getSubcommandNames(knowledge);
    for (const name of ["documents", "strategies", "ingest-jobs", "quality"]) {
      expect(subs, `knowledge 缺少: ${name}`).toContain(name);
    }
  });

  /* ── rbac 深层子命令 ────────────────────────── */
  it("rbac 包含 roles/permissions/bindings/check/abac", () => {
    const rbac = findCommand(program, ["rbac"])!;
    const subs = getSubcommandNames(rbac);
    for (const name of ["roles", "permissions", "bindings", "check", "abac"]) {
      expect(subs, `rbac 缺少: ${name}`).toContain(name);
    }
  });

  /* ── secrets 子命令 ─────────────────────────── */
  it("secrets 包含 list/get/create/revoke/rotate/usage/plaintext", () => {
    const secrets = findCommand(program, ["secrets"])!;
    const subs = getSubcommandNames(secrets);
    for (const name of ["list", "get", "create", "revoke", "rotate", "usage", "plaintext"]) {
      expect(subs, `secrets 缺少: ${name}`).toContain(name);
    }
  });

  /* ── federation 深层子命令 ──────────────────── */
  it("federation 包含 nodes/permission-grants/user-grants/content-policies 等", () => {
    const fed = findCommand(program, ["federation"])!;
    const subs = getSubcommandNames(fed);
    for (const name of ["status", "nodes", "permission-grants", "user-grants", "content-policies"]) {
      expect(subs, `federation 缺少: ${name}`).toContain(name);
    }
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*  Part 2: 代表性命令端到端执行测试 (fetch mock)                    */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe("命令端到端执行", () => {
  let program: Command;
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    program = buildProgram();
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });
    globalThis.fetch = fetchMock as any;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = undefined as any;
  });

  async function run(...args: string[]) {
    await program.parseAsync(["--token", "test-tok", ...args], { from: "user" });
  }

  it("health live → GET /health/live", async () => {
    await run("health", "live");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/health/live");
    expect(init.method).toBe("GET");
  });

  it("me info → GET /me", async () => {
    await run("me", "info");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/me");
  });

  it("me prefs-set --locale zh-CN → PUT /me/preferences", async () => {
    await run("me", "prefs-set", "--locale", "zh-CN");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/me/preferences");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ locale: "zh-CN" });
  });

  it("secrets list → GET /secrets", async () => {
    await run("secrets", "list");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/secrets");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("backups create <spaceId> → POST /spaces/:spaceId/backups", async () => {
    await run("backups", "create", "space_1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/spaces/space_1/backups");
    expect(init.method).toBe("POST");
  });

  it("models catalog list → GET /models/catalog", async () => {
    await run("models", "catalog", "list");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/models/catalog");
  });

  it("models routing list → GET /governance/model-gateway/routing", async () => {
    await run("models", "routing", "list");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/governance/model-gateway/routing");
  });

  it("jobs get my-job-123 → GET /jobs/my-job-123", async () => {
    await run("jobs", "get", "my-job-123");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/jobs/my-job-123");
  });

  it("config registry → GET /governance/config/registry", async () => {
    await run("config", "registry");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/governance/config/registry");
  });

  it("keyring init --scope-type tenant → POST /keyring/keys/init", async () => {
    await run("keyring", "init", "--scope-type", "tenant");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/keyring/keys/init");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).scopeType).toBe("tenant");
  });

  it("正确传递 token 和 tenant-id headers", async () => {
    await program.parseAsync(
      ["--token", "my-secret", "--tenant-id", "tenant_abc", "health", "live"],
      { from: "user" },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.authorization).toBe("Bearer my-secret");
    expect(headers["x-tenant-id"]).toBe("tenant_abc");
  });

  it("API 错误时设置 exitCode=1", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 500,
      ok: false,
      text: () => Promise.resolve(JSON.stringify({ errorCode: "INTERNAL" })),
    });
    await run("health", "live");
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("成功时 JSON 打印到 stdout", async () => {
    await run("health", "ready");
    expect(logSpy).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output).toEqual({ success: true });
  });
});
