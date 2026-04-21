# Go Skill 开发模板

## 概述

本模板演示如何使用 Go 语言开发 MindPal Skill。Skill 通过 **JSON-RPC 2.0 over stdio** 协议与 Runner 通信，仅使用 Go 标准库，无需任何第三方依赖。

## 协议规范

| 项目 | 说明 |
|------|------|
| 协议 | JSON-RPC 2.0 |
| 传输层 | stdio（stdin 读取请求，stdout 写入响应） |
| 消息格式 | NDJSON（每条消息占一行，以 `\n` 分隔） |
| 日志输出 | 仅通过 stderr 输出日志，**禁止**向 stdout 写入非协议内容 |

## 必须实现的方法

### 1. `skill.initialize`

Runner 启动 Skill 进程后调用，用于初始化资源。

**请求：**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "skill.initialize",
  "params": {
    "config": {}
  }
}
```

**响应：**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "status": "ready",
    "info": { "name": "example.go", "version": "0.1.0", "lang": "go" }
  }
}
```

### 2. `skill.execute`

执行 Skill 的核心业务逻辑。

**请求：**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "skill.execute",
  "params": {
    "input": {
      "message": "hello world"
    }
  }
}
```

**响应：**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "output": {
      "reply": "[2026-04-20 10:00:00] HELLO WORLD"
    }
  }
}
```

### 3. `skill.shutdown`

Runner 通知 Skill 即将停止，Skill 应释放资源后退出。

**请求：**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "skill.shutdown",
  "params": {}
}
```

**响应：**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "status": "stopped"
  }
}
```

## 编译

```bash
# 当前平台编译
go build -o dist/skill .

# 跨平台编译（Windows）
GOOS=windows GOARCH=amd64 go build -o dist/skill.exe .

# 跨平台编译（Linux）
GOOS=linux GOARCH=amd64 go build -o dist/skill .

# 跨平台编译（macOS）
GOOS=darwin GOARCH=amd64 go build -o dist/skill .
```

## 部署

将以下文件放入 `skills/<your-skill-name>/` 目录：

```
skills/your-skill-name/
├── manifest.json      # Skill 元数据声明
└── dist/
    └── skill          # 编译产物（Linux/macOS）或 skill.exe（Windows）
```

## 本地测试

```bash
# 测试 initialize
echo '{"jsonrpc":"2.0","id":1,"method":"skill.initialize","params":{"config":{}}}' | ./dist/skill

# 测试 execute
echo '{"jsonrpc":"2.0","id":2,"method":"skill.execute","params":{"input":{"message":"hello world"}}}' | ./dist/skill

# 多条消息联合测试（通过管道发送多行 NDJSON）
printf '{"jsonrpc":"2.0","id":1,"method":"skill.initialize","params":{"config":{}}}\n{"jsonrpc":"2.0","id":2,"method":"skill.execute","params":{"input":{"message":"test"}}}\n{"jsonrpc":"2.0","id":3,"method":"skill.shutdown","params":{}}\n' | ./dist/skill
```

## 文件说明

| 文件 | 说明 |
|------|------|
| `manifest.json` | Skill 元数据：名称、版本、IO Schema、安全契约 |
| `main.go` | Skill 入口源码，实现 JSON-RPC over stdio 协议 |
| `dist/skill` | 编译产物（需先执行 `go build`） |
