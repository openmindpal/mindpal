#!/usr/bin/env tsx
/**
 * P0-3: 离线评测 CI 脚本
 *
 * 功能：
 * 1. 执行 intent / nl2ui / knowledge / decompose 全量评测
 * 2. 生成 JSON 报告 + 文本摘要
 * 3. 支持基线对比（--baseline <path>）输出回归 delta
 * 4. 支持回归门禁（--gate）失败时 exit(1)
 * 5. 输出分类混淆矩阵 + 误判看板
 *
 * 用法：
 *   npx tsx scripts/run-eval-ci.ts
 *   npx tsx scripts/run-eval-ci.ts --baseline ./eval-baseline.json --gate
 *   npx tsx scripts/run-eval-ci.ts --output ./reports/eval-report.json
 */

import {
  runEvalSuite,
  judgeEvalCase,
  buildMisclassificationReport,
  type EvalCase,
  type EvalSuiteResult,
  type IntentEvalCase,
  type MisclassificationReport,
} from "../src/modules/eval/evalSuite";

import {
  intentEvalCases,
  nl2uiEvalCases,
  knowledgeEvalCases,
  decomposeEvalCases,
  allEvalCases,
} from "../src/modules/eval/evalCases";

import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { buildServer } from "../src/server";
import { processKnowledgeIndexJob } from "../../worker/src/knowledge/processor";
import { decomposeGoal } from "../src/kernel/goalDecomposer";
import { discoverEnabledTools } from "../src/modules/agentContext";
import { analyzeIntent } from "../src/skills/intent-analyzer/modules/analyzer";
import {
  listActiveToolOverrides,
  listToolRollouts,
  setActiveToolOverride,
  setToolRollout,
} from "../src/modules/governance/toolGovernanceRepo";
import { upsertRoutingPolicyOverride } from "../src/modules/modelGateway/routingPolicyRepo";
import {
  computeRetrievalMetrics,
  aggregateMetrics,
  checkRegression,
  resolveKnowledgeEvalCIConfig,
  formatKnowledgeEvalSummary,
  type RankedItem,
  type RetrievalMetrics,
  type KnowledgeEvalCIReport,
} from "../src/skills/knowledge-rag/modules/evalEnhanced";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

/* ================================================================== */
/*  CLI 参数解析                                                       */
/* ================================================================== */

interface CliOptions {
  baseline?: string;
  output?: string;
  gate: boolean;
  verbose: boolean;
  executorMode: "mock" | "real";
}

interface RealEvalBootstrapInfo {
  executionPath: "isolated_local_integration";
  tenantId: string;
  sourceScopeType: "tenant" | "space";
  sourceScopeId: string;
  provider: string;
  modelRef: string;
  syntheticModel: boolean;
  evalSpaceId: string;
  evalSubjectId: string;
  seededKnowledgeDocs: number;
}

interface RealExecutorHandle {
  execute: (evalCase: EvalCase) => Promise<{ output: any; latencyMs: number }>;
  close: () => Promise<void>;
  bootstrapInfo: RealEvalBootstrapInfo;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = { gate: false, verbose: false, executorMode: "mock" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--baseline" && args[i + 1]) opts.baseline = args[++i];
    else if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    else if (args[i] === "--gate") opts.gate = true;
    else if (args[i] === "--verbose" || args[i] === "-v") opts.verbose = true;
    else if (args[i] === "--executor" && (args[i + 1] === "mock" || args[i + 1] === "real")) {
      opts.executorMode = args[++i] as "mock" | "real";
    }
  }
  return opts;
}

/* ================================================================== */
/*  P3-5: 回归门禁阈值                                                 */
/* ================================================================== */

const REGRESSION_GATES = {
  /** 意图准确率下降超过此值 → 禁止合入 */
  intentAccuracyDropThreshold: 0.005,
  /** 高风险误执行率上升 → 禁止合入 */
  highRiskExecuteRateThreshold: 0.01,
  /** 规划失败率上升超过此值 → 禁止合入 */
  planFailureRateRiseThreshold: 0.02,
};

/* ================================================================== */
/*  Mock Executor（离线模式：直接返回占位输出）                            */
/* ================================================================== */

/**
 * 离线模式下的 Mock Executor
 * 在 CI 中如果没有可用的模型服务，使用 mock 返回固定输出。
 * 对接真实服务时替换此函数即可。
 */
function createMockExecutor() {
  return async (evalCase: EvalCase): Promise<{ output: any; latencyMs: number }> => {
    const start = Date.now();

    switch (evalCase.category) {
      case "intent": {
        const ic = evalCase as IntentEvalCase;
        // Mock: 直接返回期望值作为"理想输出"，用于验证评测管道完整性
        return {
          output: {
            intent: ic.expected.intent,
            confidence: (ic.expected.minConfidence ?? 0.5) + 0.1,
            suggestedTools: ic.expected.suggestedToolRefs?.map(ref => ({ toolRef: ref })) ?? [],
            requiresConfirmation: ic.expected.requiresConfirmation ?? false,
          },
          latencyMs: Date.now() - start,
        };
      }
      case "nl2ui":
        return {
          output: {
            layout: (evalCase as any).expected.layout ?? "single-column",
            panels: ((evalCase as any).expected.containsComponents ?? []).map((c: string) => ({
              components: [{ componentId: c }],
            })),
            dataBindings: ((evalCase as any).expected.dataBindingEntities ?? []).map((e: string) => ({
              entityName: e,
            })),
            metadata: { confidence: ((evalCase as any).expected.minConfidence ?? 0.5) + 0.1 },
          },
          latencyMs: Date.now() - start,
        };
      case "knowledge":
        return {
          output: {
            results: ((evalCase as any).expected.minResults ?? 0) > 0
              ? [{ content: ((evalCase as any).expected.containsKeywords ?? []).join(" ") }]
              : [],
          },
          latencyMs: Date.now() - start,
        };
      case "decompose":
        return {
          output: {
            subGoals: Array.from({ length: (evalCase as any).expected.minSubGoals ?? 1 }, (_, i) => ({
              id: `sg-${i}`,
              toolCandidates: (evalCase as any).expected.expectedToolRefs ?? [],
              requiresApproval: (evalCase as any).expected.requiresApproval ?? false,
              isWrite: (evalCase as any).expected.hasWriteOperation ?? false,
            })),
            dagValid: (evalCase as any).expected.dagValid ?? true,
            earlyExit: (evalCase as any).expected.shouldEarlyExit ?? false,
          },
          latencyMs: Date.now() - start,
        };
      default:
        return { output: {}, latencyMs: Date.now() - start };
    }
  };
}

async function ensureEvalAdminAccess(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  spaceId: string;
}) {
  const { pool, tenantId, subjectId } = params;
  await pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [tenantId]);
  await pool.query(
    "INSERT INTO spaces (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [params.spaceId, tenantId],
  );
  await pool.query(
    "INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [subjectId, tenantId],
  );
  await pool.query(
    "INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    ["role_eval_admin", tenantId, "Eval Admin"],
  );
  const permRes = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["*", "*"],
  );
  const permId = String(permRes.rows[0].id);
  await pool.query(
    "INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    ["role_eval_admin", permId],
  );
  await pool.query(
    "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
    [subjectId, "role_eval_admin", tenantId],
  );
}

async function resolveRealModelSource(params: {
  pool: Pool;
  tenantIdHint?: string;
  sourceScopeIdHint?: string;
  allowSyntheticModel: boolean;
  excludeScopeId?: string;
}) {
  const conditions = ["status = 'enabled'"];
  const values: string[] = [];
  if (params.tenantIdHint) {
    values.push(params.tenantIdHint);
    conditions.push(`tenant_id = $${values.length}`);
  }
  if (params.sourceScopeIdHint) {
    values.push(params.sourceScopeIdHint);
    conditions.push(`scope_id = $${values.length}`);
  }
  if (params.excludeScopeId && !params.sourceScopeIdHint) {
    values.push(params.excludeScopeId);
    conditions.push(`scope_id <> $${values.length}`);
  }
  if (!params.allowSyntheticModel) {
    conditions.push("provider <> 'mock'");
    conditions.push("model_ref NOT LIKE 'mock:%'");
  }
  const sql = `
    SELECT tenant_id, scope_type, scope_id, model_ref, provider
      FROM provider_bindings
     WHERE ${conditions.join(" AND ")}
     ORDER BY
       CASE WHEN scope_type = 'space' THEN 0 ELSE 1 END,
       updated_at DESC
     LIMIT 1
  `;
  const res = await params.pool.query(sql, values);
  if (!res.rowCount) {
    throw new Error(
      params.allowSyntheticModel
        ? "no enabled provider binding found for real eval bootstrap"
        : "no non-mock provider binding found. Configure a real model binding or set EVAL_REAL_ALLOW_SYNTHETIC_MODEL=1 for diagnostics only.",
    );
  }
  return {
    tenantId: String(res.rows[0].tenant_id),
    sourceScopeType: String(res.rows[0].scope_type) as "tenant" | "space",
    sourceScopeId: String(res.rows[0].scope_id),
    modelRef: String(res.rows[0].model_ref),
    provider: String(res.rows[0].provider),
  };
}

async function cloneBindingsIntoEvalSpace(params: {
  pool: Pool;
  tenantId: string;
  sourceScopeType: "tenant" | "space";
  sourceScopeId: string;
  evalSpaceId: string;
}) {
  const sourceBindings = await params.pool.query(
    `
      SELECT model_ref, provider, model, connector_instance_id, secret_id, secret_ids, base_url, chat_completions_path, status
        FROM provider_bindings
       WHERE tenant_id = $1
         AND scope_type = $2
         AND scope_id = $3
         AND status = 'enabled'
    `,
    [params.tenantId, params.sourceScopeType, params.sourceScopeId],
  );
  for (const row of sourceBindings.rows) {
    await params.pool.query(
      `
        INSERT INTO provider_bindings (
          tenant_id, scope_type, scope_id, model_ref, provider, model,
          connector_instance_id, secret_id, secret_ids, base_url, chat_completions_path, status
        )
        VALUES ($1, 'space', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 'enabled')
        ON CONFLICT (tenant_id, scope_type, scope_id, model_ref)
        DO UPDATE SET
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          connector_instance_id = EXCLUDED.connector_instance_id,
          secret_id = EXCLUDED.secret_id,
          secret_ids = EXCLUDED.secret_ids,
          base_url = EXCLUDED.base_url,
          chat_completions_path = EXCLUDED.chat_completions_path,
          status = 'enabled',
          updated_at = now()
      `,
      [
        params.tenantId,
        params.evalSpaceId,
        row.model_ref,
        row.provider,
        row.model,
        row.connector_instance_id,
        row.secret_id,
        JSON.stringify(row.secret_ids ?? []),
        row.base_url,
        row.chat_completions_path,
      ],
    );
  }
}

async function cloneSpaceGovernanceIntoEvalSpace(params: {
  pool: Pool;
  tenantId: string;
  sourceScopeType: "tenant" | "space";
  sourceScopeId: string;
  evalSpaceId: string;
}) {
  if (params.sourceScopeType !== "space" || params.sourceScopeId === params.evalSpaceId) {
    return;
  }
  const rollouts = await listToolRollouts({
    pool: params.pool,
    tenantId: params.tenantId,
    scopeType: "space",
    scopeId: params.sourceScopeId,
  });
  for (const rollout of rollouts) {
    await setToolRollout({
      pool: params.pool,
      tenantId: params.tenantId,
      scopeType: "space",
      scopeId: params.evalSpaceId,
      toolRef: rollout.toolRef,
      enabled: rollout.enabled,
      disableMode: rollout.disableMode,
      graceDeadline: rollout.graceDeadline ? new Date(rollout.graceDeadline) : null,
    });
  }

  const activeOverrides = await listActiveToolOverrides({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.sourceScopeId,
  });
  for (const override of activeOverrides) {
    await setActiveToolOverride({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.evalSpaceId,
      name: override.name,
      toolRef: override.activeToolRef,
    });
  }
}

async function cloneRoutingOverridesIntoEvalSpace(params: {
  pool: Pool;
  tenantId: string;
  sourceScopeType: "tenant" | "space";
  sourceScopeId: string;
  evalSpaceId: string;
}) {
  if (params.sourceScopeType !== "space" || params.sourceScopeId === params.evalSpaceId) {
    return;
  }
  const res = await params.pool.query(
    `
      SELECT purpose, primary_model_ref, fallback_model_refs, enabled
      FROM routing_policies_overrides
      WHERE tenant_id = $1 AND space_id = $2
    `,
    [params.tenantId, params.sourceScopeId],
  );
  for (const row of res.rows) {
    await upsertRoutingPolicyOverride({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.evalSpaceId,
      purpose: String(row.purpose),
      primaryModelRef: String(row.primary_model_ref),
      fallbackModelRefs: Array.isArray(row.fallback_model_refs) ? row.fallback_model_refs.map(String) : [],
      enabled: Boolean(row.enabled),
    });
  }
}

async function pinEvalSpaceRoutingPurposes(params: {
  pool: Pool;
  tenantId: string;
  evalSpaceId: string;
  modelRef: string;
}) {
  const purposes = [
    "intent.analyze",
    "intent.classify",
    "nl2ui.generate",
    "agent.loop.decompose",
    "agent.loop.decompose.fast",
  ];
  for (const purpose of purposes) {
    await upsertRoutingPolicyOverride({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.evalSpaceId,
      purpose,
      primaryModelRef: params.modelRef,
      fallbackModelRefs: [],
      enabled: true,
    });
  }
}

function evalHeaders(params: { tenantId: string; spaceId: string; subjectId: string }) {
  return {
    authorization: `Bearer ${params.subjectId}`,
    "x-tenant-id": params.tenantId,
    "x-space-id": params.spaceId,
    "content-type": "application/json",
  };
}

async function injectJson<T>(params: {
  app: FastifyInstance;
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  payload?: Record<string, unknown>;
}): Promise<{ body: T; latencyMs: number }> {
  const startedAt = Date.now();
  const response = await params.app.inject({
    method: params.method,
    url: params.url,
    headers: {
      ...params.headers,
      "x-trace-id": `eval-real-${crypto.randomUUID()}`,
    },
    payload: params.payload ? JSON.stringify(params.payload) : undefined,
  });
  if (response.statusCode >= 400) {
    throw new Error(`${params.method} ${params.url} failed with ${response.statusCode}: ${response.body.slice(0, 400)}`);
  }
  return {
    body: response.json() as T,
    latencyMs: Date.now() - startedAt,
  };
}

function normalizeNl2UiOutput(raw: any) {
  const config = raw?.config;
  const areas = Array.isArray(config?.ui?.layout?.areas) ? config.ui.layout.areas : [];
  const dataBindings = Array.isArray(config?.dataBindings) ? config.dataBindings : [];
  const toEvalComponentId = (componentId: string) => {
    if (componentId === "EntityList.Table") return "DataGrid";
    if (componentId === "EntityForm.Single") return "FormPanel";
    if (componentId.startsWith("Chart.")) return "ChartPanel";
    return componentId;
  };
  return {
    layout: config?.ui?.layout?.variant ?? null,
    panels: areas.map((area: any) => ({
      components: [{ componentId: toEvalComponentId(String(area?.componentId ?? "")) }],
    })),
    dataBindings: dataBindings.map((binding: any) => ({
      entityName: binding?.params?.entityName ?? binding?.entityName ?? "",
    })),
    metadata: config?.metadata ?? {},
  };
}

function normalizeKnowledgeOutput(raw: any) {
  const evidence = Array.isArray(raw?.evidence) ? raw.evidence : [];
  return {
    results: evidence.map((item: any) => ({
      content: item?.snippet ?? "",
      sourceRef: item?.sourceRef ?? null,
      rankReason: item?.rankReason ?? null,
    })),
  };
}

function inferGoalFlags(subGoal: {
  description?: string;
  suggestedToolRefs?: string[];
  preconditions?: Array<{ description?: string }>;
  postconditions?: Array<{ description?: string }>;
}) {
  const normalized = [
    subGoal.description ?? "",
    ...(subGoal.suggestedToolRefs ?? []),
    ...(subGoal.preconditions ?? []).map((item) => item?.description ?? ""),
    ...(subGoal.postconditions ?? []).map((item) => item?.description ?? ""),
  ].join(" ").toLowerCase();
  return {
    requiresApproval: /审批|审核|approve|reject|删除|回滚|生产|发布|采购|合规/.test(normalized),
    isWrite: /创建|修改|更新|删除|导入|发货|审批|approve|reject|create|update|delete|import|rollback|写入/.test(normalized),
  };
}

function normalizeDecomposeOutput(result: Awaited<ReturnType<typeof decomposeGoal>>) {
  const graph = result.graph;
  const graphText = JSON.stringify(graph);
  return {
    subGoals: graph.subGoals.map((subGoal) => {
      const flags = inferGoalFlags(subGoal);
      return {
        id: subGoal.goalId,
        description: subGoal.description,
        toolCandidates: subGoal.suggestedToolRefs ?? [],
        dependsOn: subGoal.dependsOn,
        preconditions: subGoal.preconditions.map((condition) => condition.description),
        postconditions: subGoal.postconditions.map((condition) => condition.description),
        successCriteria: subGoal.successCriteria.map((criterion) => criterion.description),
        completionEvidence: subGoal.completionEvidence.map((evidence) => evidence.summary),
        requiresApproval: flags.requiresApproval,
        isWrite: flags.isWrite,
      };
    }),
    dagValid: result.planningQualityReport?.dimensions?.dagValidity
      ? result.planningQualityReport.dimensions.dagValidity >= 1
      : !/invalid/i.test(graphText),
    earlyExit: /early_exit|template|single-goal|single_goal/i.test(String(graph.decompositionReasoning ?? "")),
    reasoning: graph.decompositionReasoning ?? "",
  };
}

async function seedEvalKnowledgeDocs(params: {
  app: FastifyInstance;
  pool: Pool;
  headers: Record<string, string>;
  tenantId: string;
  spaceId: string;
}) {
  const docs = [
    {
      title: "eval-auth-model",
      sourceType: "manual",
      contentText: [
        "用户认证流程是什么：用户认证流程 auth 采用 bearer token 与 RBAC 权限模型。",
        "用户认证流程 auth 采用 bearer token 与 RBAC 权限模型。",
        "How to set up authentication: configure auth bearer token, RBAC role binding and login middleware.",
        "What is the data model: the core data model is organized by model, schema and entity definitions.",
        "数据 model schema entity 定义由统一 schema 管理。",
      ].join("\n"),
    },
    {
      title: "eval-api-architecture",
      sourceType: "manual",
      contentText: [
        "API 接口文档在哪里：API 接口文档位于内部知识库与服务路由清单中。",
        "API 接口文档和系统 architecture 架构说明都记录在内部知识库中。",
        "系统架构概述：系统 architecture 架构由 web、api、worker 和治理模块组成。",
      ].join("\n"),
    },
    {
      title: "eval-db-workflow",
      sourceType: "manual",
      contentText: [
        "如何配置数据库连接：数据库 database 连接通过环境变量配置。",
        "数据库 database 连接通过环境变量配置。",
        "工作流引擎支持哪些触发器：workflow 引擎支持 trigger 触发器、审批、执行恢复与告警。",
        "workflow 引擎支持 trigger 触发器、审批、执行恢复与告警。",
        "怎么部署这个系统：部署 deploy 流程需要先迁移数据库再启动服务。",
        "部署 deploy 流程需要先迁移数据库再启动服务。",
      ].join("\n"),
    },
    {
      title: "eval-audit-rbac",
      sourceType: "manual",
      contentText: [
        "RBAC 权限模型如何工作：RBAC 权限 role model 控制读写审批。",
        "RBAC 权限 role model 控制读写审批。",
        "审计日志的保留策略：审计 audit 日志保留策略会记录关键操作与证据链。",
        "审计 audit 日志保留策略会记录关键操作与证据链。",
        "性能优化建议：性能优化建议包括缓存、索引、并发控制与分层治理。",
        "性能优化建议包括缓存、索引、并发控制与分层治理。",
      ].join("\n"),
    },
  ];
  await params.pool.query(
    "DELETE FROM knowledge_documents WHERE tenant_id = $1 AND space_id = $2 AND title = ANY($3::text[])",
    [params.tenantId, params.spaceId, docs.map((doc) => doc.title)],
  );
  for (const doc of docs) {
    const created = await injectJson<{ documentId: string; indexJobId: string }>({
      app: params.app,
      method: "POST",
      url: "/knowledge/documents",
      headers: params.headers,
      payload: doc,
    });
    await processKnowledgeIndexJob({ pool: params.pool, indexJobId: String(created.body.indexJobId) });
  }
  return docs.length;
}

async function createRealExecutor(): Promise<RealExecutorHandle> {
  const allowSyntheticModel = process.env.EVAL_REAL_ALLOW_SYNTHETIC_MODEL === "1";
  if (!process.env.FASTIFY_PLUGIN_TIMEOUT_MS) {
    process.env.FASTIFY_PLUGIN_TIMEOUT_MS = "300000";
  }
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg);
  const app = buildServer(cfg, {
    db: pool,
    queue: { add: async () => ({}) } as any,
  });

  const evalSubjectId = process.env.EVAL_REAL_SUBJECT_ID ?? "eval_real_admin";
  const evalSpaceId = process.env.EVAL_REAL_SPACE_ID ?? "space_eval_real";
  const requestedTenantId = process.env.EVAL_REAL_TENANT_ID;
  const requestedSourceScopeId = process.env.EVAL_REAL_SOURCE_SCOPE_ID;
  const allowSourceSpaceMutation = process.env.EVAL_REAL_ALLOW_SOURCE_SPACE_MUTATION === "1";

  let bootstrapInfo: RealEvalBootstrapInfo | null = null;

  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    await migrate(pool, path.resolve(scriptDir, "../migrations"));
    const source = await resolveRealModelSource({
      pool,
      tenantIdHint: requestedTenantId,
      sourceScopeIdHint: requestedSourceScopeId,
      allowSyntheticModel,
      excludeScopeId: evalSpaceId,
    });
    if (source.sourceScopeType === "space" && source.sourceScopeId === evalSpaceId && !allowSourceSpaceMutation) {
      throw new Error("eval real channel refuses to reuse the source space by default. Set EVAL_REAL_ALLOW_SOURCE_SPACE_MUTATION=1 only if you intentionally want to mutate that space.");
    }
    await ensureEvalAdminAccess({
      pool,
      tenantId: source.tenantId,
      subjectId: evalSubjectId,
      spaceId: evalSpaceId,
    });
    if (source.sourceScopeType !== "space" || source.sourceScopeId !== evalSpaceId) {
      await cloneBindingsIntoEvalSpace({
        pool,
        tenantId: source.tenantId,
        sourceScopeType: source.sourceScopeType,
        sourceScopeId: source.sourceScopeId,
        evalSpaceId,
      });
    }
    await cloneSpaceGovernanceIntoEvalSpace({
      pool,
      tenantId: source.tenantId,
      sourceScopeType: source.sourceScopeType,
      sourceScopeId: source.sourceScopeId,
      evalSpaceId,
    });
    await cloneRoutingOverridesIntoEvalSpace({
      pool,
      tenantId: source.tenantId,
      sourceScopeType: source.sourceScopeType,
      sourceScopeId: source.sourceScopeId,
      evalSpaceId,
    });
    await pinEvalSpaceRoutingPurposes({
      pool,
      tenantId: source.tenantId,
      evalSpaceId,
      modelRef: source.modelRef,
    });

    await app.ready();
    const headers = evalHeaders({
      tenantId: source.tenantId,
      spaceId: evalSpaceId,
      subjectId: evalSubjectId,
    });
    const seededKnowledgeDocs = await seedEvalKnowledgeDocs({
      app,
      pool,
      headers,
      tenantId: source.tenantId,
      spaceId: evalSpaceId,
    });
    const toolDiscovery = await discoverEnabledTools({
      pool,
      tenantId: source.tenantId,
      spaceId: evalSpaceId,
      locale: "zh-CN",
    });

    bootstrapInfo = {
      executionPath: "isolated_local_integration",
      tenantId: source.tenantId,
      sourceScopeType: source.sourceScopeType,
      sourceScopeId: source.sourceScopeId,
      provider: source.provider,
      modelRef: source.modelRef,
      syntheticModel: source.provider === "mock" || source.modelRef.startsWith("mock:"),
      evalSpaceId,
      evalSubjectId,
      seededKnowledgeDocs,
    };

    const execute = async (evalCase: EvalCase): Promise<{ output: any; latencyMs: number }> => {
      switch (evalCase.category) {
        case "intent": {
          if (!evalCase.input.trim()) {
            return {
              output: {
                intent: "chat",
                confidence: 0,
                reasoning: "empty_input",
                suggestedTools: [],
                requiresConfirmation: false,
              },
              latencyMs: 0,
            };
          }
          const startedAt = Date.now();
          const output = await analyzeIntent(pool, {
            message: evalCase.input,
            context: {
              tenantId: bootstrapInfo.tenantId,
              spaceId: bootstrapInfo.evalSpaceId,
              userId: bootstrapInfo.evalSubjectId,
              conversationHistory: evalCase.context?.conversationHistory,
              availableTools: toolDiscovery.tools.map((tool) => tool.toolRef),
            },
          }, {
            app,
            defaultModelRef: bootstrapInfo.modelRef,
          });
          return { output, latencyMs: Date.now() - startedAt };
        }
        case "nl2ui": {
          const response = await injectJson<any>({
            app,
            method: "POST",
            url: "/nl2ui/generate",
            headers,
            payload: {
              userInput: evalCase.input,
            },
          });
          return { output: normalizeNl2UiOutput(response.body), latencyMs: response.latencyMs };
        }
        case "knowledge": {
          if (!evalCase.input.trim()) {
            return { output: { results: [] }, latencyMs: 0 };
          }
          const response = await injectJson<any>({
            app,
            method: "POST",
            url: "/knowledge/search",
            headers,
            payload: {
              query: evalCase.input,
              limit: 5,
            },
          });
          return { output: normalizeKnowledgeOutput(response.body), latencyMs: response.latencyMs };
        }
        case "decompose": {
          const startedAt = Date.now();
          const result = await decomposeGoal({
            app,
            pool,
            subject: {
              tenantId: bootstrapInfo.tenantId,
              spaceId: bootstrapInfo.evalSpaceId,
              subjectId: bootstrapInfo.evalSubjectId,
            },
            locale: "zh-CN",
            authorization: headers.authorization,
            traceId: `eval-real-${crypto.randomUUID()}`,
            goal: evalCase.input,
            runId: `eval-run-${crypto.randomUUID()}`,
            toolCatalog: toolDiscovery.catalog,
            defaultModelRef: process.env.EVAL_REAL_MODEL_REF ?? bootstrapInfo.modelRef,
          });
          return {
            output: normalizeDecomposeOutput(result),
            latencyMs: Date.now() - startedAt,
          };
        }
        default:
          return { output: {}, latencyMs: 0 };
      }
    };

    return {
      execute,
      close: async () => {
        await app.close();
        await pool.end();
      },
      bootstrapInfo,
    };
  } catch (error) {
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/* ================================================================== */
/*  P3-6: 混淆矩阵                                                    */
/* ================================================================== */

interface ConfusionMatrix {
  labels: string[];
  matrix: number[][];
}

function buildIntentConfusionMatrix(
  cases: IntentEvalCase[],
  results: EvalSuiteResult,
): ConfusionMatrix {
  const labels = ["chat", "ui", "query", "task", "collab"];
  const labelIdx = Object.fromEntries(labels.map((l, i) => [l, i]));
  const matrix = labels.map(() => labels.map(() => 0));

  for (const r of results.cases) {
    const evalCase = cases.find(c => c.id === r.caseId);
    if (!evalCase) continue;
    const expected = evalCase.expected.intent;
    const actual = r.actualOutput?.intent ?? "chat";
    const ei = labelIdx[expected] ?? 0;
    const ai = labelIdx[actual] ?? 0;
    matrix[ei][ai]++;
  }

  return { labels, matrix };
}

function formatConfusionMatrix(cm: ConfusionMatrix): string {
  const colWidth = 8;
  const lines: string[] = [];
  lines.push("\n📊 Intent Confusion Matrix (Expected ↓ / Actual →):");
  lines.push("".padStart(colWidth) + cm.labels.map(l => l.padStart(colWidth)).join(""));
  for (let i = 0; i < cm.labels.length; i++) {
    const row = cm.labels[i].padStart(colWidth) + cm.matrix[i].map(v => String(v).padStart(colWidth)).join("");
    lines.push(row);
  }
  return lines.join("\n");
}

/* ================================================================== */
/*  P3-1: 分类统计指标                                                  */
/* ================================================================== */

interface ClassificationMetrics {
  totalAccuracy: number;
  macroF1: number;
  perClass: Record<string, { precision: number; recall: number; f1: number }>;
}

function computeClassificationMetrics(cm: ConfusionMatrix): ClassificationMetrics {
  const n = cm.labels.length;
  let correctTotal = 0;
  let totalSamples = 0;
  const perClass: ClassificationMetrics["perClass"] = {};

  for (let i = 0; i < n; i++) {
    const rowSum = cm.matrix[i].reduce((a, b) => a + b, 0);
    totalSamples += rowSum;
    correctTotal += cm.matrix[i][i];
  }

  let f1Sum = 0;
  for (let i = 0; i < n; i++) {
    const tp = cm.matrix[i][i];
    const colSum = cm.matrix.reduce((s, row) => s + row[i], 0); // predicted as i
    const rowSum = cm.matrix[i].reduce((a, b) => a + b, 0);     // actual is i
    const precision = colSum > 0 ? tp / colSum : 0;
    const recall = rowSum > 0 ? tp / rowSum : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    perClass[cm.labels[i]] = { precision, recall, f1 };
    f1Sum += f1;
  }

  return {
    totalAccuracy: totalSamples > 0 ? correctTotal / totalSamples : 0,
    macroF1: n > 0 ? f1Sum / n : 0,
    perClass,
  };
}

/* ================================================================== */
/*  报告输出                                                            */
/* ================================================================== */

interface CIReport {
  timestamp: string;
  executorMode: "mock" | "real";
  evidenceLevel: "synthetic" | "production";
  bootstrapInfo?: RealEvalBootstrapInfo;
  suiteResult: EvalSuiteResult;
  confusionMatrix: ConfusionMatrix;
  classificationMetrics: ClassificationMetrics;
  misclassificationReport: MisclassificationReport;
  regression?: {
    intentAccuracyDelta: number;
    highRiskExecuteRateDelta: number;
    planFailureRateDelta: number;
    gateResult: "passed" | "blocked";
    blockedReasons: string[];
  };
}

function formatSummary(report: CIReport): string {
  const s = report.suiteResult;
  const m = report.classificationMetrics;
  const mc = report.misclassificationReport;
  const lines: string[] = [
    "═══════════════════════════════════════════════════════",
    "  灵智 MindPal Eval Suite — CI Report",
    `  ${report.timestamp}`,
    "═══════════════════════════════════════════════════════",
    "",
    `🧪 Executor: ${report.executorMode}`,
    `🔎 Evidence: ${report.evidenceLevel}`,
    "",
    `📋 Total Cases: ${s.totalCases}  |  ✅ Passed: ${s.passedCases}  |  ❌ Failed: ${s.failedCases}  |  Pass Rate: ${(s.passRate * 100).toFixed(1)}%`,
    "",
    "── Category Pass Rates ──",
  ];
  if (report.bootstrapInfo) {
    lines.splice(7, 0,
      `🧭 Scope: ${report.bootstrapInfo.tenantId}/${report.bootstrapInfo.evalSpaceId}`,
      `🤖 Model: ${report.bootstrapInfo.modelRef} (${report.bootstrapInfo.provider})`,
      `📚 Seeded docs: ${report.bootstrapInfo.seededKnowledgeDocs}`,
      "",
    );
  }
  if (report.evidenceLevel === "synthetic") {
    lines.push("⚠️  This run uses a synthetic mock executor. Use it for regression smoke checks only, not production-readiness claims.");
    lines.push("");
  }
  for (const [cat, v] of Object.entries(s.categoryPassRates)) {
    lines.push(`  ${cat.padEnd(12)} ${v.passed}/${v.total} (${(v.rate * 100).toFixed(1)}%)`);
  }
  lines.push("");
  lines.push(`⏱  Avg Latency: ${s.avgLatencyMs.toFixed(1)} ms`);
  lines.push("");
  lines.push("── Classification Metrics ──");
  lines.push(`  Total Accuracy: ${(m.totalAccuracy * 100).toFixed(1)}%`);
  lines.push(`  Macro F1:       ${(m.macroF1 * 100).toFixed(1)}%`);
  for (const [cls, v] of Object.entries(m.perClass)) {
    lines.push(`  ${cls.padEnd(8)} P=${(v.precision * 100).toFixed(1)}%  R=${(v.recall * 100).toFixed(1)}%  F1=${(v.f1 * 100).toFixed(1)}%`);
  }
  lines.push("");
  lines.push("── Misclassification Report ──");
  lines.push(`  false_execute:     ${mc.categories.false_execute.count} (${(mc.categories.false_execute.rate * 100).toFixed(2)}%)`);
  lines.push(`  false_answer:      ${mc.categories.false_answer.count} (${(mc.categories.false_answer.rate * 100).toFixed(2)}%)`);
  lines.push(`  bad_decomposition: ${mc.categories.bad_decomposition.count} (${(mc.categories.bad_decomposition.rate * 100).toFixed(2)}%)`);
  lines.push(`  tool_hallucination:${mc.categories.tool_hallucination.count} (${(mc.categories.tool_hallucination.rate * 100).toFixed(2)}%)`);
  lines.push(`  unsafe_downgrade:  ${mc.categories.unsafe_downgrade.count} (${(mc.categories.unsafe_downgrade.rate * 100).toFixed(2)}%)`);
  lines.push(`  High-risk execute rate: ${(mc.highRiskExecuteRate * 100).toFixed(2)}%`);
  lines.push(`  Low-recall execute miss: ${(mc.lowRecallExecuteMissRate * 100).toFixed(2)}%`);

  if (report.regression) {
    lines.push("");
    lines.push("── Regression Gate ──");
    lines.push(`  Intent accuracy delta: ${(report.regression.intentAccuracyDelta * 100).toFixed(2)}%`);
    lines.push(`  High-risk execute rate delta: ${(report.regression.highRiskExecuteRateDelta * 100).toFixed(2)}%`);
    lines.push(`  Plan failure rate delta: ${(report.regression.planFailureRateDelta * 100).toFixed(2)}%`);
    lines.push(`  Gate: ${report.regression.gateResult === "passed" ? "✅ PASSED" : "❌ BLOCKED"}`);
    if (report.regression.blockedReasons.length > 0) {
      for (const r of report.regression.blockedReasons) lines.push(`    ⛔ ${r}`);
    }
  }

  lines.push(formatConfusionMatrix(report.confusionMatrix));

  // Top-5 failed cases
  const failedCases = s.cases.filter(c => !c.passed).slice(0, 5);
  if (failedCases.length > 0) {
    lines.push("\n── Top Failed Cases ──");
    for (const f of failedCases) {
      lines.push(`  ${f.caseId}: ${f.failureReasons.join("; ")}`);
    }
  }

  lines.push("\n═══════════════════════════════════════════════════════");
  return lines.join("\n");
}

/* ================================================================== */
/*  Main                                                               */
/* ================================================================== */

async function main() {
  const opts = parseArgs();
  if (opts.gate && (!opts.baseline || !fs.existsSync(opts.baseline))) {
    console.error("Regression gate requires an existing --baseline report file.");
    process.exit(1);
  }
  console.log("🚀 Starting Eval Suite CI run...\n");

  const realExecutor = opts.executorMode === "real" ? await createRealExecutor() : null;
  try {
    const executor = realExecutor?.execute ?? createMockExecutor();
    const suiteResult = await runEvalSuite({
      suiteName: "mindpal-core-eval",
      cases: allEvalCases,
      executor,
      judge: judgeEvalCase,
    });

    // 构建混淆矩阵
    const intentResults = suiteResult.cases.filter(c => c.category === "intent");
    const decomposeResults = suiteResult.cases.filter(c => c.category === "decompose");
    const cm = buildIntentConfusionMatrix(intentEvalCases, { ...suiteResult, cases: intentResults });
    const classMetrics = computeClassificationMetrics(cm);

    // 构建误判看板
    const misReport = buildMisclassificationReport(intentResults, intentEvalCases, decomposeResults);

    // 构建报告
    const report: CIReport = {
      timestamp: new Date().toISOString(),
      executorMode: opts.executorMode,
      evidenceLevel: opts.executorMode === "real" && !realExecutor?.bootstrapInfo.syntheticModel ? "production" : "synthetic",
      bootstrapInfo: realExecutor?.bootstrapInfo,
      suiteResult,
      confusionMatrix: cm,
      classificationMetrics: classMetrics,
      misclassificationReport: misReport,
    };

    // 基线对比
    if (opts.baseline && fs.existsSync(opts.baseline)) {
      const baseline: CIReport = JSON.parse(fs.readFileSync(opts.baseline, "utf-8"));
      const baselineIntentRate = baseline.suiteResult.categoryPassRates["intent"]?.rate ?? 0;
      const currentIntentRate = suiteResult.categoryPassRates["intent"]?.rate ?? 0;
      const intentDelta = currentIntentRate - baselineIntentRate;

      const baselineHighRisk = baseline.misclassificationReport?.highRiskExecuteRate ?? 0;
      const currentHighRisk = misReport.highRiskExecuteRate;
      const highRiskDelta = currentHighRisk - baselineHighRisk;

      const baselinePlanFailureRate = 1 - (baseline.suiteResult.categoryPassRates["decompose"]?.rate ?? 1);
      const currentPlanFailureRate = 1 - (suiteResult.categoryPassRates["decompose"]?.rate ?? 1);
      const planFailureRateDelta = currentPlanFailureRate - baselinePlanFailureRate;

      const blockedReasons: string[] = [];
      if (intentDelta < -REGRESSION_GATES.intentAccuracyDropThreshold) {
        blockedReasons.push(`Intent accuracy dropped by ${(Math.abs(intentDelta) * 100).toFixed(2)}% (threshold: ${(REGRESSION_GATES.intentAccuracyDropThreshold * 100).toFixed(2)}%)`);
      }
      if (highRiskDelta > REGRESSION_GATES.highRiskExecuteRateThreshold) {
        blockedReasons.push(`High-risk execute rate rose by ${(highRiskDelta * 100).toFixed(2)}% (threshold: ${(REGRESSION_GATES.highRiskExecuteRateThreshold * 100).toFixed(2)}%)`);
      }
      if (planFailureRateDelta > REGRESSION_GATES.planFailureRateRiseThreshold) {
        blockedReasons.push(`Plan failure rate rose by ${(planFailureRateDelta * 100).toFixed(2)}% (threshold: ${(REGRESSION_GATES.planFailureRateRiseThreshold * 100).toFixed(2)}%)`);
      }

      report.regression = {
        intentAccuracyDelta: intentDelta,
        highRiskExecuteRateDelta: highRiskDelta,
        planFailureRateDelta,
        gateResult: blockedReasons.length > 0 ? "blocked" : "passed",
        blockedReasons,
      };
    }

    // 输出
    const summary = formatSummary(report);
    console.log(summary);

    // 写入报告文件
    const outputPath = opts.output ?? path.join(process.cwd(), "eval-report.json");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\n📄 Report saved to: ${outputPath}`);

    // 门禁检查
    if (opts.gate && report.regression?.gateResult === "blocked") {
      console.error("\n⛔ Regression gate BLOCKED — merge not allowed.");
      process.exit(1);
    }

    // ── P1-3e: 知识检索专项评测 ──────────────────────────────────
    const knowledgeResults = suiteResult.cases.filter(c => c.category === "knowledge");
    if (knowledgeResults.length > 0) {
      console.log("\n── Knowledge RAG Metrics ──");
      const knCfg = resolveKnowledgeEvalCIConfig();

      // 为每个知识检索用例计算高级指标
      const perQueryMetrics: KnowledgeEvalCIReport["perQueryMetrics"] = [];
      const allMetrics: RetrievalMetrics[] = [];

      for (const result of knowledgeResults) {
        const evalCase = knowledgeEvalCases.find(c => c.id === result.caseId);
        if (!evalCase) continue;

        const actualResults = Array.isArray(result.actualOutput?.results) ? result.actualOutput.results : [];
        const expectedDocIds = evalCase.expected.containsKeywords ?? [];

        // 构建排序项
        const rankedItems: RankedItem[] = actualResults.map((r: any, idx: number) => {
          const text = JSON.stringify(r).toLowerCase();
          const relevant = expectedDocIds.length === 0 || expectedDocIds.some(kw => text.includes(kw.toLowerCase()));
          return { documentId: r.documentId ?? `result_${idx}`, relevant, rank: idx };
        });

        const totalRelevant = Math.max(1, expectedDocIds.length);
        const metrics = computeRetrievalMetrics({ rankedItems, totalRelevant, k: knCfg.k });
        allMetrics.push(metrics);

        perQueryMetrics.push({
          query: evalCase.input,
          metrics,
          expectedDocumentIds: expectedDocIds,
          actualDocumentIds: actualResults.map((r: any, i: number) => r.documentId ?? `result_${i}`),
        });
      }

      const agg = aggregateMetrics(allMetrics);
      console.log(`  Queries: ${agg.queryCount}`);
      console.log(`  Hit@${agg.k}: ${(agg.hitAtK * 100).toFixed(1)}%`);
      console.log(`  MRR@${agg.k}: ${(agg.mrrAtK * 100).toFixed(1)}%`);
      console.log(`  NDCG@${agg.k}: ${(agg.ndcgAtK * 100).toFixed(1)}%`);
      console.log(`  MAP@${agg.k}: ${(agg.mapAtK * 100).toFixed(1)}%`);
      console.log(`  Precision@${agg.k}: ${(agg.precisionAtK * 100).toFixed(1)}%`);
      console.log(`  Recall@${agg.k}: ${(agg.recallAtK * 100).toFixed(1)}%`);
      console.log(`  F1@${agg.k}: ${(agg.f1AtK * 100).toFixed(1)}%`);
      console.log(`  Hallucination: ${(agg.hallucinationRate * 100).toFixed(1)}%`);

      // 知识检索专项报告
      const knowledgeReport: KnowledgeEvalCIReport = {
        timestamp: new Date().toISOString(),
        evalSetId: null,
        goldenDatasetName: null,
        aggregateMetrics: agg,
        perQueryMetrics,
        regression: null,
        environment: {
          vectorStoreProvider: process.env.VECTOR_STORE_PROVIDER ?? "fallback",
          chunkStrategy: process.env.CHUNK_STRATEGY ?? "fixed",
          retrieverName: process.env.KNOWLEDGE_DEFAULT_RETRIEVER ?? "hybrid",
        },
      };

      // 知识检索基线对比
      const knBaselinePath = knCfg.baselinePath;
      if (knBaselinePath && fs.existsSync(knBaselinePath)) {
        try {
          const knBaseline: KnowledgeEvalCIReport = JSON.parse(fs.readFileSync(knBaselinePath, "utf-8"));
          knowledgeReport.regression = checkRegression({
            baseline: knBaseline.aggregateMetrics,
            current: agg,
          });
          if (knowledgeReport.regression.gateResult === "blocked") {
            console.error("\n⛔ Knowledge Regression BLOCKED:");
            for (const reason of knowledgeReport.regression.blockedReasons) {
              console.error(`  - ${reason}`);
            }
          }
        } catch { /* baseline parse error — skip */ }
      }

      // 写入知识检索专项报告
      const knOutputPath = knCfg.outputPath;
      fs.mkdirSync(path.dirname(knOutputPath), { recursive: true });
      fs.writeFileSync(knOutputPath, JSON.stringify(knowledgeReport, null, 2), "utf-8");
      console.log(`\n📄 Knowledge eval report: ${knOutputPath}`);
      console.log(formatKnowledgeEvalSummary(knowledgeReport));
    }

    console.log("\n✅ Eval CI completed successfully.");
  } finally {
    if (realExecutor) {
      await realExecutor.close();
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
