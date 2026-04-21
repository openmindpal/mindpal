//! OpenSlin Rust Skill 开发模板
//!
//! 本示例展示如何使用 Rust 实现 MindPal 的 JSON-RPC over stdio 协议。
//! 通信方式：从 stdin 逐行读取 JSON-RPC 请求，处理后将响应写入 stdout（NDJSON 格式）。

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};

// ─── JSON-RPC 请求结构 ───────────────────────────────────────────────────────

/// JSON-RPC 2.0 请求
#[derive(Debug, Deserialize)]
struct RpcRequest {
    /// JSON-RPC 版本，固定为 "2.0"
    jsonrpc: String,
    /// 请求 ID，用于关联响应
    id: serde_json::Value,
    /// 方法名：skill.initialize / skill.execute / skill.shutdown
    method: String,
    /// 方法参数（可选）
    #[serde(default)]
    params: serde_json::Value,
}

// ─── JSON-RPC 响应结构 ───────────────────────────────────────────────────────

/// JSON-RPC 2.0 成功响应
#[derive(Debug, Serialize)]
struct RpcResponse {
    jsonrpc: &'static str,
    id: serde_json::Value,
    result: serde_json::Value,
}

/// JSON-RPC 2.0 错误响应
#[derive(Debug, Serialize)]
struct RpcErrorResponse {
    jsonrpc: &'static str,
    id: serde_json::Value,
    error: RpcError,
}

/// JSON-RPC 错误对象
#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/// 构造成功响应
fn ok_response(id: serde_json::Value, result: serde_json::Value) -> String {
    let resp = RpcResponse {
        jsonrpc: "2.0",
        id,
        result,
    };
    serde_json::to_string(&resp).expect("序列化响应失败")
}

/// 构造错误响应
fn err_response(id: serde_json::Value, code: i32, message: &str) -> String {
    let resp = RpcErrorResponse {
        jsonrpc: "2.0",
        id,
        error: RpcError {
            code,
            message: message.to_string(),
        },
    };
    serde_json::to_string(&resp).expect("序列化错误响应失败")
}

/// 将响应写入 stdout 并 flush，确保消息立即发送
fn send(stdout: &mut io::StdoutLock, line: &str) {
    writeln!(stdout, "{}", line).expect("写入 stdout 失败");
    stdout.flush().expect("flush stdout 失败");
}

// ─── 方法处理器 ───────────────────────────────────────────────────────────────

/// 处理 skill.initialize
/// 返回 Skill 的元信息，Runner 据此完成初始化握手。
fn handle_initialize(id: serde_json::Value) -> String {
    let result = serde_json::json!({
        "name": "example.rust",
        "version": "0.1.0",
        "ready": true
    });
    ok_response(id, result)
}

/// 处理 skill.execute
/// 示例逻辑：将输入 message 字符串反转后返回。
fn handle_execute(id: serde_json::Value, params: &serde_json::Value) -> String {
    // 从 params 中提取 message 字段
    let message = params
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // 核心业务逻辑：反转字符串（支持 Unicode）
    let reversed: String = message.chars().rev().collect();

    let result = serde_json::json!({
        "reply": reversed
    });
    ok_response(id, result)
}

/// 处理 skill.shutdown
/// 执行清理工作后返回确认。
fn handle_shutdown(id: serde_json::Value) -> String {
    let result = serde_json::json!({
        "success": true
    });
    ok_response(id, result)
}

// ─── 主循环 ───────────────────────────────────────────────────────────────────

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    // 逐行读取 stdin，每行是一个完整的 JSON-RPC 请求（NDJSON 格式）
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // stdin 关闭，退出
        };

        // 跳过空行
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // 解析 JSON-RPC 请求
        let req: RpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                // 解析失败：返回 JSON-RPC Parse Error (-32700)
                let resp = err_response(
                    serde_json::Value::Null,
                    -32700,
                    &format!("JSON 解析错误: {}", e),
                );
                send(&mut stdout, &resp);
                continue;
            }
        };

        // 校验 jsonrpc 版本
        if req.jsonrpc != "2.0" {
            let resp = err_response(
                req.id,
                -32600,
                "不支持的 JSON-RPC 版本，仅支持 2.0",
            );
            send(&mut stdout, &resp);
            continue;
        }

        // 根据方法名分发到对应处理器
        let response = match req.method.as_str() {
            "skill.initialize" => handle_initialize(req.id),
            "skill.execute" => handle_execute(req.id, &req.params),
            "skill.shutdown" => {
                let resp = handle_shutdown(req.id);
                send(&mut stdout, &resp);
                break; // shutdown 后退出主循环
            }
            _ => {
                // 未知方法：返回 Method Not Found (-32601)
                err_response(
                    req.id,
                    -32601,
                    &format!("未知方法: {}", req.method),
                )
            }
        };

        send(&mut stdout, &response);
    }
}
