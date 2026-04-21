# Rust Skill 开发模板

> 基于 JSON-RPC 2.0 over stdio 协议的 MindPal Skill 开发模板（Rust 实现）。

## 概述

本模板展示如何使用 Rust 开发一个符合 MindPal Skill 协议的技能模块。Skill 进程通过 **stdin/stdout** 与 Runner 通信，采用 **NDJSON**（Newline-Delimited JSON）格式——每行一个完整的 JSON-RPC 2.0 消息。

示例逻辑：接收一条消息，将其字符串反转后返回。

## 协议规范

| 项目       | 说明                                      |
| ---------- | ----------------------------------------- |
| 协议       | JSON-RPC 2.0                              |
| 传输层     | stdio（stdin 读取请求，stdout 写入响应）   |
| 消息格式   | NDJSON — 每条消息占一行，以 `\n` 分隔      |
| 编码       | UTF-8                                     |

## 必须实现的方法

### 1. `skill.initialize`

Runner 启动 Skill 进程后发送的第一条消息，用于完成初始化握手。

**请求：**
```json
{"jsonrpc":"2.0","id":1,"method":"skill.initialize","params":{}}
```

**响应：**
```json
{"jsonrpc":"2.0","id":1,"result":{"name":"example.rust","version":"0.1.0","ready":true}}
```

### 2. `skill.execute`

执行 Skill 的核心业务逻辑。

**请求：**
```json
{"jsonrpc":"2.0","id":2,"method":"skill.execute","params":{"message":"Hello MindPal"}}
```

**响应：**
```json
{"jsonrpc":"2.0","id":2,"result":{"reply":"laPdniM olleH"}}
```

### 3. `skill.shutdown`

通知 Skill 优雅退出，释放资源后进程结束。

**请求：**
```json
{"jsonrpc":"2.0","id":3,"method":"skill.shutdown","params":{}}
```

**响应：**
```json
{"jsonrpc":"2.0","id":3,"result":{"success":true}}
```

## 编译

```bash
cargo build --release
```

编译产物位于：`target/release/openslin-skill-template`（Linux/macOS）或 `target/release/openslin-skill-template.exe`（Windows）。

## 部署

将编译产物复制到 `dist/skill`（与 `manifest.json` 中 `entry` 字段对应）：

```bash
# Linux / macOS
cp target/release/openslin-skill-template dist/skill

# Windows
copy target\release\openslin-skill-template.exe dist\skill.exe
```

## 跨平台编译

```bash
# Windows (MSVC)
cargo build --release --target x86_64-pc-windows-msvc

# Windows (GNU)
cargo build --release --target x86_64-pc-windows-gnu

# Linux
cargo build --release --target x86_64-unknown-linux-gnu

# macOS (Intel)
cargo build --release --target x86_64-apple-darwin

# macOS (Apple Silicon)
cargo build --release --target aarch64-apple-darwin
```

> 提示：跨平台编译前需通过 `rustup target add <target>` 安装目标平台工具链。

## 本地测试

可通过管道向 Skill 进程发送 JSON-RPC 消息进行测试：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"skill.initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"skill.execute","params":{"message":"你好世界"}}
{"jsonrpc":"2.0","id":3,"method":"skill.shutdown","params":{}}' | cargo run
```

预期输出：

```
{"jsonrpc":"2.0","id":1,"result":{"name":"example.rust","version":"0.1.0","ready":true}}
{"jsonrpc":"2.0","id":2,"result":{"reply":"界世好你"}}
{"jsonrpc":"2.0","id":3,"result":{"success":true}}
```

## 依赖说明

| 依赖       | 用途                  |
| ---------- | -------------------- |
| serde      | 结构体序列化/反序列化 |
| serde_json | JSON 编解码           |

仅依赖 `serde` + `serde_json`，编译产物体积小（release 模式下通常 < 2MB），启动速度快，无需运行时环境。

## 项目结构

```
template-rust-skill/
├── manifest.json       # Skill 元数据声明
├── Cargo.toml          # Rust 项目配置
├── src/
│   └── main.rs         # Skill 入口，JSON-RPC 协议实现
├── dist/               # 部署目录（编译产物放置于此）
│   └── skill           # 可执行文件
└── README.md           # 本文档
```
