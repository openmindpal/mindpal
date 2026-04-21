/**
 * Device-Agent Executor — 统一入口
 *
 * 委托给 kernel/taskExecutor 的单一实现，消除代码重复。
 */
export { executeDeviceTool } from "./kernel/taskExecutor";
export type { DeviceClaimEnvelope } from "./kernel/types";

/**
 * 别名→标准名转换。
 * 委托给 kernel/capabilityRegistry 的动态别名注册表。
 */
export { resolveToolAlias as normalizeToolName } from "./kernel/capabilityRegistry";
