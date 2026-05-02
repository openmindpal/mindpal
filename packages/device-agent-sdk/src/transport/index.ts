/**
 * Transport Layer — 通信层统一导出
 *
 * 导出所有通信模块的公共 API，供第三方集成方使用。
 */

// WebSocket 客户端
export * from './websocketClient';

// 安全会话管理
export * from './deviceSessionSecurity';

// 流式消息路由
export * from './streamingMessageRouter';

// HTTP 轮询代理（DeviceExecution 已由 websocketClient 导出，AgentState 独有于此模块）
export {
  runOnce, heartbeatOnce, runLoop,
  type AgentState,
} from './httpPollingAgent';

// WebSocket 消息处理器
export * from './wsMessageHandlers';

// 流式执行器
export * from './streamingExecutor';

// HTTP 客户端
export * from './httpClient';
