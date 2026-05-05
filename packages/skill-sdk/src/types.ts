/**
 * @mindpal/skill-sdk — 核心执行类型
 *
 * 面向 Skill 开发者的类型定义，描述 Runner 与 Skill 之间的交互数据结构。
 */

/* ================================================================== */
/*  Skill 执行上下文                                                     */
/* ================================================================== */

/** Skill 执行上下文（由 Runner 在初始化时传入） */
export interface SkillContext {
  /** 租户 ID */
  tenantId: string;
  /** 空间 ID */
  spaceId: string;
  /** 用户/主体 ID */
  userId: string;
  /** 本次运行 ID（追踪链路） */
  runId: string;
  /** 国际化 locale（如 "zh-CN", "en-US"） */
  locale: string;
}

/* ================================================================== */
/*  Skill 能力声明                                                       */
/* ================================================================== */

/** Skill 能力包络 */
export interface SkillCapabilities {
  /** 是否支持流式输出 */
  streaming: boolean;
  /** 是否支持多模态输入/输出 */
  multimodal: boolean;
  /** 是否有状态（需要持久化会话） */
  stateful: boolean;
}

/* ================================================================== */
/*  初始化                                                               */
/* ================================================================== */

/** Runner → Skill: 初始化参数 */
export interface SkillInitializeParams {
  /** RPC 协议版本 */
  protocolVersion: string;
  /** 执行上下文 */
  context: SkillContext;
  /** 能力包络 */
  capabilities: SkillCapabilities;
  /** 资源限制 */
  limits: {
    /** 最大内存使用（MB） */
    maxMemoryMB: number;
    /** 执行超时（ms） */
    timeoutMs: number;
  };
}

/* ================================================================== */
/*  执行                                                                 */
/* ================================================================== */

/** Runner → Skill: 执行请求参数 */
export interface SkillExecuteParams {
  /** 要调用的方法名 */
  method: string;
  /** 方法参数 */
  args: Record<string, unknown>;
  /** 可选的执行上下文覆盖 */
  context?: SkillContext;
}

/** Skill → Runner: 执行结果 */
export interface SkillExecuteResult {
  /** 执行状态 */
  status: 'success' | 'error';
  /** 成功时的返回数据 */
  data?: unknown;
  /** 失败时的错误信息 */
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/* ================================================================== */
/*  进度通知                                                             */
/* ================================================================== */

/** Skill → Runner: 进度通知 */
export interface SkillProgressNotification {
  /** 进度百分比（0-100） */
  percentage?: number;
  /** 用户可读的进度消息 */
  message?: string;
  /** 当前阶段标识 */
  stage?: string;
}

/* ================================================================== */
/*  Skill 定义辅助类型                                                    */
/* ================================================================== */

/** Skill 方法处理器 */
export type SkillMethodHandler = (
  args: Record<string, unknown>,
  context: SkillContext,
) => Promise<unknown>;

/** Skill 方法映射表 */
export interface SkillMethodMap {
  [method: string]: SkillMethodHandler;
}
