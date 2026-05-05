# @mindpal/protocol

**MindPal Agent OS 协议层标准定义包**

智能体操作系统的协议基座，定义了 Skill RPC、协作消息、设备握手、审计系统和状态机的标准类型、接口和工具函数。

## 特性

- **零依赖** — 仅 TypeScript 类型 + 纯函数工具，无任何外部 npm 依赖
- **协议级抽象** — 纯接口/类型/常量/工具函数，不包含业务逻辑
- **独立可用** — 每个子模块可单独导入，支持 tree-shaking

## 安装

```bash
pnpm add @mindpal/protocol
```

## 模块概览

| 子模块 | 导入路径 | 说明 |
|--------|---------|------|
| Skill RPC | `@mindpal/protocol/skill-rpc` | JSON-RPC 2.0 over stdio 协议：请求/响应/通知类型、序列化、版本协商 |
| Skill Manifest | `@mindpal/protocol/skill-manifest` | Skill 清单定义与校验：内置/外部 Manifest、工具声明 |
| Collab Message | `@mindpal/protocol/collab-message` | 多智能体协作协议：5层消息类型、共识投票、能力发现、辩论 |
| Device Handshake | `@mindpal/protocol/device-handshake` | 设备握手安全协议：ECDH密钥交换类型、安全策略、会话状态 |
| Audit Event | `@mindpal/protocol/audit-event` | 审计事件标准：事件输入接口、错误分类、摘要生成 |
| State Machine | `@mindpal/protocol/state-machine` | 统一运行时状态机：Step/Run/Collab/Agent 状态转换表 |
| Errors | `@mindpal/protocol/errors` | 标准错误码集合：RPC错误码、协议错误码、审计错误分类 |

## 使用示例

```typescript
// 统一入口导入
import { createRpcRequest, SKILL_RPC_METHODS, transitionStep } from "@mindpal/protocol";

// 创建 Skill RPC 请求
const req = createRpcRequest("req-1", SKILL_RPC_METHODS.EXECUTE, {
  requestId: "r1",
  input: { text: "hello" },
  inputDigest: { sha256_8: "abc12345", bytes: 5 },
});

// 状态转换
const newStatus = transitionStep("pending", "running"); // "running"

// 子模块独立导入
import { validateManifest } from "@mindpal/protocol/skill-manifest";
import type { CollabMessageEnvelope } from "@mindpal/protocol/collab-message";

const result = validateManifest({
  identity: { name: "example.skill", version: "1.0.0" },
  entry: "index.js",
});
console.log(result.valid); // true
```

## 许可证

MIT
