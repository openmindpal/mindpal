# MindPal Device Agent (Rust)

灵智MindPal轻量级设备代理运行时 —— 面向机器人、智能汽车、IoT嵌入式场景。

## 架构定位

与现有 Node.js 版 `apps/device-agent/` 双轨并行：
- **Node.js 版**：桌面开发者场景（含浏览器自动化、GUI自动化等重型插件）
- **Rust 版（本项目）**：机器人/汽车/IoT 场景（轻量、无运行时依赖、支持交叉编译）

两个版本共享同一套云端 API 协议，配置文件格式完全兼容。

## 核心特性

- **元数据驱动**：插件加载、策略管理、能力声明全部由配置文件/云端下发驱动
- **协议兼容**：与现有云端 API 100% 兼容（REST + WebSocket）
- **轻量交付**：单二进制文件，release 构建约 5-8MB
- **交叉编译**：支持 x86_64/ARM64/ARMv7/RISC-V 多架构
- **双通道通信**：WebSocket 实时 + HTTP 轮询降级
- **沙箱隔离**：超时控制 + 并发限制 + 熔断器

## 内置插件

| 插件 | 工具前缀 | 适用场景 |
|------|---------|---------|
| sensor_bridge | device.sensor.* | 传感器数据采集（GPS/IMU/LiDAR/温湿度） |
| camera | device.camera.* | 摄像头帧捕获与视频流 |
| audio | device.audio.* | 音频录制与播放 |
| bluetooth | device.bluetooth.* | BLE 扫描/连接/读写 |
| file_ops | device.file.* | 文件读写与目录管理 |
| evidence | device.evidence.* | 执行证据收集与签名 |

## 快速开始

### 本地构建

```bash
# 安装 Rust 工具链
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 构建（debug）
cd apps/device-agent-rs
cargo build

# 构建（release，最小体积）
cargo build --release

# 产出位置
# target/release/mindpal-device-agent (Linux/macOS)
# target/release/mindpal-device-agent.exe (Windows)
```

### 使用

```bash
# 配对设备
./mindpal-device-agent pair --pairing-code pair_xxxxx --api-base http://your-api:3001 --device-type robot

# 运行守护进程
./mindpal-device-agent run

# 自定义参数
./mindpal-device-agent run --heartbeat-ms 30000 --poll-ms 3000

# 查看帮助
./mindpal-device-agent --help
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| API_BASE | http://localhost:3001 | API 服务地址 |
| DEVICE_AGENT_TRANSPORT | auto | 传输模式：auto/ws/http |
| DEVICE_AGENT_LIGHTWEIGHT | false | 轻量模式（跳过访问控制） |
| AUDIT_ENABLED | true | 审计日志开关 |
| SESSION_HEARTBEAT_ENABLED | true | 心跳开关 |
| POLICY_CACHE_ENABLED | true | 策略缓存开关 |
| AGENT_VERSION | 1.0.0 | 代理版本号 |

## 交叉编译

### ARM64（机器人/汽车主板）

```bash
# 安装目标工具链
rustup target add aarch64-unknown-linux-gnu
sudo apt install gcc-aarch64-linux-gnu

# 编译
cargo build --release --target aarch64-unknown-linux-gnu
```

### ARMv7（IoT 设备）

```bash
rustup target add armv7-unknown-linux-gnueabihf
sudo apt install gcc-arm-linux-gnueabihf

cargo build --release --target armv7-unknown-linux-gnueabihf
```

### RISC-V 64

```bash
rustup target add riscv64gc-unknown-linux-gnu
sudo apt install gcc-riscv64-linux-gnu

cargo build --release --target riscv64gc-unknown-linux-gnu
```

### Docker 多阶段构建

```dockerfile
# 构建阶段
FROM rust:1.77-slim AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

# 运行阶段
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/mindpal-device-agent /usr/local/bin/
ENTRYPOINT ["mindpal-device-agent"]
CMD ["run"]
```

### ARM64 Docker 构建

```dockerfile
FROM rust:1.77-slim AS builder
RUN apt-get update && apt-get install -y gcc-aarch64-linux-gnu
RUN rustup target add aarch64-unknown-linux-gnu
WORKDIR /app
COPY . .
RUN cargo build --release --target aarch64-unknown-linux-gnu

FROM arm64v8/debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/aarch64-unknown-linux-gnu/release/mindpal-device-agent /usr/local/bin/
ENTRYPOINT ["mindpal-device-agent"]
CMD ["run"]
```

## 配置文件

配对成功后自动生成 `~/.mindpal/device-agent.json`：

```json
{
  "apiBase": "http://your-api:3001",
  "deviceId": "uuid-xxx",
  "deviceToken": "token-xxx",
  "enrolledAt": "2026-01-01T00:00:00Z",
  "deviceType": "robot",
  "os": "linux-6.1.0",
  "agentVersion": "1.0.0",
  "pluginConfig": {
    "builtinPlugins": ["sensor_bridge", "camera", "audio", "bluetooth", "file_ops", "evidence"],
    "source": "cloud",
    "updatedAt": "2026-01-01T00:00:00Z"
  }
}
```

## 项目结构

```
src/
├── main.rs              # CLI 入口
├── lib.rs               # 模块声明
├── types.rs             # 核心类型（DevicePlugin trait 等）
├── config.rs            # 配置加载/保存/锁管理
├── env.rs               # 环境变量解析
├── pair.rs              # 配对流程
├── runtime.rs           # 运行时主循环
├── transport/           # 通信传输层
│   ├── mod.rs           # Transport trait
│   ├── ws.rs            # WebSocket
│   ├── http_poll.rs     # HTTP 轮询
│   └── http_client.rs   # HTTP 客户端
├── security/            # 安全层
│   ├── token.rs         # Token 管理
│   ├── audit.rs         # 审计日志
│   └── access.rs        # 访问控制
├── session/             # 会话管理
│   ├── heartbeat.rs     # 心跳
│   ├── task_queue.rs    # 任务队列
│   └── policy_cache.rs  # 策略缓存
└── plugin/              # 插件系统
    ├── mod.rs           # 别名展开 + 默认插件
    ├── registry.rs      # 插件注册表
    ├── sandbox.rs       # 沙箱 + 熔断器
    ├── sensor_bridge.rs # 传感器桥接
    ├── camera.rs        # 摄像头
    ├── audio.rs         # 音频
    ├── bluetooth.rs     # 蓝牙 BLE
    ├── file_ops.rs      # 文件操作
    └── evidence.rs      # 证据收集
```

## 与 Node.js 版的关系

| 维度 | Node.js 版 | Rust 版 |
|------|-----------|---------|
| 路径 | apps/device-agent/ | apps/device-agent-rs/ |
| 运行时依赖 | Node.js 18+ | 无（单二进制） |
| 包体积 | ~45MB (pkg) | ~5-8MB |
| 内存占用 | ~80-150MB | ~10-30MB |
| 启动时间 | 2-4秒 | <200ms |
| 桌面插件 | browser/desktop-control/GUI | 无（不需要） |
| 嵌入式插件 | sensor/camera/audio/bluetooth | sensor/camera/audio/bluetooth |
| 配置格式 | JSON (camelCase) | 完全相同 |
| 云端协议 | REST + WebSocket | 完全相同 |
