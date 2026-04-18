/**
 * dispatch.streamTaskQueue.ts — TaskQueue 集成辅助
 *
 * 从 dispatch.stream.ts 提取的 TaskQueueSystem 工厂获取函数。
 */
import { getOrCreateTaskQueueSystem } from "../../kernel/taskQueueFactory";
import type { AgentLoopTaskExecutor } from "../../kernel/agentLoopTaskExecutor";

/** 获取会话任务队列管理器 */
export function getQueueManager(app: any) {
  return getOrCreateTaskQueueSystem(app).manager;
}

/** 获取 AgentLoop 任务执行器 */
export function getTaskExecutor(app: any): AgentLoopTaskExecutor {
  return getOrCreateTaskQueueSystem(app).executor;
}
