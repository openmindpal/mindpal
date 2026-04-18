/**
 * Dispatch Schema & Types
 *
 * 统一分流路由的请求/响应 Schema、类型定义、共享上下文接口
 */
import { z } from "zod";
import type { IntentMode, IntentClassification } from "./modules/intentClassifier";
import type { ExecutionClass } from "./dispatch.executionPolicy";

/* ------------------------------------------------------------------ */
/*  请求 Schema                                                        */
/* ------------------------------------------------------------------ */

/** 分流请求 Schema */
export const dispatchRequestSchema = z.object({
  /** 用户消息 */
  message: z.string().min(1), // P2-2 FIX: 移除输入字数限制，支持大模型长上下文
  /** 会话 ID（可选，用于维持对话上下文） */
  conversationId: z.string().min(1).max(200).optional(),
  /** 用户显式指定的模式 */
  mode: z.enum(["auto", "answer", "execute", "collab"]).optional(),
  /** 语言 */
  locale: z.string().optional(),
  /** 用户选择的默认模型（可选） */
  defaultModelRef: z.string().min(1).max(200).optional(),
  /** 执行约束（仅 execute/collab 模式） */
  constraints: z.object({
    allowedTools: z.array(z.string().min(1).max(200)).max(200).optional(),
    allowWrites: z.boolean().optional(),
    maxSteps: z.number().int().positive().max(20).optional(),
    maxWallTimeMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
  }).optional(),
  /** 协作配置（仅 collab 模式） */
  collabConfig: z.object({
    roles: z.array(z.object({
      roleName: z.string().min(1).max(50),
      mode: z.enum(["auto", "assist"]).optional(),
    })).max(10).optional(),
  }).optional(),
  /** 活动任务上下文（用于 intervene 意图识别） */
  activeRunContext: z.object({
    runId: z.string().min(1),
    taskId: z.string().min(1),
    taskTitle: z.string().optional(),
    phase: z.string().optional(),
  }).optional(),
  /** 多任务上下文：当前会话中所有活跃任务的 ID 列表（多任务并发支持） */
  activeTaskIds: z.array(z.object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    entryId: z.string().optional(),
    goal: z.string().optional(),
    phase: z.string().optional(),
  })).optional(),
  /** 会话队列上下文（前端传入当前队列状态） */
  sessionQueueContext: z.object({
    sessionId: z.string().min(1),
    activeCount: z.number().int().min(0).optional(),
    queuedCount: z.number().int().min(0).optional(),
    foregroundEntryId: z.string().optional(),
  }).optional(),
  /** 是否使用快速分类（不调用 LLM） */
  fastClassify: z.boolean().optional(),
  /** 预生成的工具建议（由 answer 层保留或用户确认后传入，后端直接创建 steps 执行） */
  toolSuggestions: z.array(z.object({
    toolRef: z.string().min(1).max(200),
    inputDraft: z.record(z.string(), z.any()).optional(),
  })).max(50).optional(),
  /** 多模态附件（图片 base64 data URL 等） */
  attachments: z.array(z.object({
    type: z.enum(["image", "document", "voice", "video"]),
    mimeType: z.string().min(1).max(200),
    name: z.string().max(500).optional(),
    /** base64 data URL，例如 data:image/png;base64,... */
    dataUrl: z.string().min(1).max(20_000_000).optional(),
    /** 文本文件内容（.txt/.csv 等） */
    textContent: z.string().max(500_000).optional(),
  })).max(10).optional(),
});

export type DispatchRequest = z.infer<typeof dispatchRequestSchema>;

/* ------------------------------------------------------------------ */
/*  响应类型                                                            */
/* ------------------------------------------------------------------ */

/** 分流响应 */
export interface DispatchResponse {
  /** 分流模式 */
  mode: IntentMode;
  /** 实际执行层级 */
  executionClass?: ExecutionClass;
  /** 分类详情 */
  classification: IntentClassification;
  /** 会话 ID */
  conversationId: string;
  /** 回复文本（answer 模式） */
  replyText?: string;
  /** 工具建议（answer 模式可能有） */
  toolSuggestions?: any[];
  /** 任务 ID（execute/collab 模式） */
  taskId?: string;
  /** 运行 ID（execute/collab 模式） */
  runId?: string;
  /** 作业 ID（execute 模式） */
  jobId?: string;
  /** 协作运行 ID（collab 模式） */
  collabRunId?: string;
  /** 当前阶段 */
  phase?: string;
  /** 任务状态（统一视图） */
  taskState?: {
    phase: string;
    stepCount?: number;
    currentStep?: number;
    needsApproval?: boolean;
    blockReason?: string;
  };
  /** Turn ID（用于审计追溯） */
  turnId?: string;
  /** UI 指令 */
  uiDirective?: any;
  /** NL2UI 生成结果（内联执行时返回） */
  nl2uiResult?: any;
  /** 即时动作回执（不创建 workflow） */
  actionReceipt?: {
    status: "completed" | "suggested";
    toolCount?: number;
    summary?: string;
  };
  /** 多任务队列信息 */
  queueInfo?: {
    entryId: string;
    position: number;
    activeCount: number;
    estimatedWaitMs?: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Handler 共享上下文                                                  */
/* ------------------------------------------------------------------ */

/** 非流式 dispatch handler 共享上下文 */
export interface DispatchContext {
  app: any;
  req: any;
  subject: { tenantId: string; spaceId: string; subjectId: string };
  body: DispatchRequest;
  locale: string;
  message: string;
  conversationId: string;
  classification: IntentClassification;
  messageDigest: { len: number; sha256_8: string };
  piSummary: any;
  authorization: string | null;
  traceId: string;
}
