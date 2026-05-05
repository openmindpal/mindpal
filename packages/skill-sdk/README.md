# @mindpal/skill-sdk

MindPal Skill 开发者工具包 —— 开发、测试和发布 MindPal Skill 所需的一切。

## 安装

```bash
npm install @mindpal/skill-sdk @mindpal/protocol
# 或
pnpm add @mindpal/skill-sdk @mindpal/protocol
```

## 快速上手

以下是一个完整的 Echo Skill 实现：

```typescript
import {
  createStdioTransport,
  createRpcSuccess,
  createRpcError,
  createLogNotification,
  SKILL_RPC_ERRORS,
} from '@mindpal/skill-sdk';

// 1. 创建 stdio 传输层
const transport = createStdioTransport();

// 2. 注册消息处理
transport.onMessage((raw) => {
  const msg = raw as any;

  // 处理 initialize 请求
  if (msg.method === 'skill.initialize') {
    transport.send(createRpcSuccess(msg.id, {
      name: 'community.echo',
      version: '1.0.0',
      runtime: 'node',
    }));
    return;
  }

  // 处理 execute 请求
  if (msg.method === 'skill.execute') {
    const input = msg.params?.input ?? {};
    transport.send(createRpcSuccess(msg.id, {
      output: { echo: input.message ?? 'Hello, MindPal!' },
    }));
    return;
  }

  // 处理 heartbeat
  if (msg.method === 'skill.heartbeat') {
    transport.send(createRpcSuccess(msg.id, { ts: Date.now(), status: 'alive' }));
    return;
  }

  // 处理 shutdown
  if (msg.method === 'skill.shutdown') {
    transport.send(createRpcSuccess(msg.id, {}));
    transport.close();
    process.exit(0);
  }

  // 未知方法
  if (msg.id) {
    transport.send(createRpcError(msg.id, SKILL_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${msg.method}`));
  }
});

// 3. 发送启动日志
transport.send(createLogNotification('info', 'Echo skill started'));
```

## 模块说明

### `@mindpal/skill-sdk` (主入口)

统一导出所有子模块，适合大多数场景。

### `@mindpal/skill-sdk/manifest`

Skill 清单定义与校验工具：

```typescript
import { defineSkill, validateManifest } from '@mindpal/skill-sdk/manifest';

const manifest = defineSkill({
  identity: { name: 'community.echo', version: '1.0.0' },
  entry: 'dist/index.js',
  category: 'utility',
  tags: ['echo', 'demo'],
});
```

### `@mindpal/skill-sdk/rpc`

JSON-RPC 2.0 消息创建工具：

```typescript
import { createRpcSuccess, createRpcError, createProgressNotification } from '@mindpal/skill-sdk/rpc';

// 成功响应
const success = createRpcSuccess('req-1', { data: 'result' });

// 错误响应
const error = createRpcError('req-1', -32602, 'Invalid params');

// 进度通知
const progress = createProgressNotification({ percentage: 50, message: 'Processing...' });
```

### `@mindpal/skill-sdk/ndjson`

NDJSON 序列化和 stdio 传输层：

```typescript
import { serializeMessage, parseMessage, createStdioTransport } from '@mindpal/skill-sdk/ndjson';

// 手动序列化/反序列化
const line = serializeMessage({ hello: 'world' }); // '{"hello":"world"}\n'
const obj = parseMessage('{"hello":"world"}');       // { hello: 'world' }

// 或使用高层传输层
const transport = createStdioTransport();
```

### `@mindpal/skill-sdk/trust`

Ed25519 签名与供应链信任类型：

```typescript
import type { SkillTrustVerification, SkillSigningConfig } from '@mindpal/skill-sdk/trust';
```

## 通信流程

```
┌──────────────┐         NDJSON/stdio          ┌──────────────┐
│  Skill Runner│ ──── stdin ──────────────────▶ │    Skill     │
│  (进程管理器) │ ◀─── stdout ─────────────────── │  (子进程)    │
└──────────────┘                                └──────────────┘

消息流序列：
1. Runner → Skill:  skill.initialize (Request)
2. Skill  → Runner: initialize result (Response)
3. Runner → Skill:  skill.execute (Request)
4. Skill  → Runner: skill.progress (Notification, 可选)
5. Skill  → Runner: execute result (Response)
6. Runner → Skill:  skill.heartbeat (Request, 周期性)
7. Runner → Skill:  skill.shutdown (Request)
```

## Manifest 规范

每个 Skill 目录下必须包含 `manifest.json`：

| 字段 | 必填 | 说明 |
|------|------|------|
| `identity.name` | ✅ | 至少两段小写字母点分名，如 `community.echo` |
| `identity.version` | ✅ | 语义化版本号，如 `1.0.0` |
| `entry` | ✅ | 入口文件路径（相对于 skill 目录） |
| `category` | ❌ | 分类标签 |
| `tags` | ❌ | 搜索标签数组 |
| `io.inputSchema` | ❌ | JSON Schema 输入定义 |
| `io.outputSchema` | ❌ | JSON Schema 输出定义 |

## License

MIT
