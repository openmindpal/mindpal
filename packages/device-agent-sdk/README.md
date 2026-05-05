# @mindpal/device-agent-sdk

MindPal 设备代理 SDK — 为智能设备构建 Agent 能力的开发工具包。

## 特性

- 插件化架构：通过 DeviceToolPlugin 接口扩展设备能力
- 安全握手：V2 ECDH + AES-256-GCM 加密通信
- 多模态支持：视觉、语音、屏幕交互能力声明
- 双通道通信：WebSocket（实时指令）+ HTTP 轮询（状态同步）
- 七态插件生命周期：registered → initializing → ready → active → suspending → suspended → destroyed

## 安装

```bash
npm install @mindpal/device-agent-sdk @mindpal/protocol
```

## 快速开始

```typescript
import { createDeviceAgentKernel } from '@mindpal/device-agent-sdk';

const kernel = createDeviceAgentKernel({
  serverUrl: 'wss://your-mindpal-server/device',
  deviceId: 'my-device-001',
  capabilities: { camera: true, microphone: true, screen: false },
});

await kernel.connect();
```

## 插件开发

```typescript
import type { DeviceToolPlugin } from '@mindpal/device-agent-sdk/kernel';

const myPlugin: DeviceToolPlugin = {
  name: 'my-sensor-plugin',
  async registerPlugin(kernel) {
    // 注册设备能力
  },
  async unregisterPlugin() {
    // 清理资源
  },
  listCapabilities() {
    return [{ name: 'temperature.read', description: '读取温度传感器' }];
  },
};
```

## 模块导出

| 路径 | 说明 |
|------|------|
| `@mindpal/device-agent-sdk` | 主入口，包含工厂函数 |
| `@mindpal/device-agent-sdk/kernel` | 内核模块：认证、会话、插件、任务执行 |
| `@mindpal/device-agent-sdk/transport` | 传输层：WebSocket、HTTP降级 |
| `@mindpal/device-agent-sdk/config` | 配置管理 |

## 协议依赖

本SDK基于 `@mindpal/protocol` 协议基座包，遵循：
- S15 Device Plugin 七态生命周期
- S16 能力注册表与命名规范
- S17 Device 协议握手与版本协商

## License

MIT
