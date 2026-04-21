// Go Skill 开发模板
// 本文件演示如何使用 Go 标准库实现 MindPal 的 JSON-RPC 2.0 over stdio 协议。
// 协议要求：每条 JSON-RPC 消息占一行（NDJSON），通过 stdin 读取请求，通过 stdout 写入响应。
// 必须实现三个方法：skill.initialize、skill.execute、skill.shutdown

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// ==================== JSON-RPC 消息结构体 ====================

// RPCRequest 表示一条 JSON-RPC 2.0 请求
type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`         // 固定为 "2.0"
	ID      json.RawMessage `json:"id"`              // 请求 ID（数字或字符串）
	Method  string          `json:"method"`          // 方法名
	Params  json.RawMessage `json:"params,omitempty"` // 方法参数（可选）
}

// RPCResponse 表示一条 JSON-RPC 2.0 响应
type RPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`          // 固定为 "2.0"
	ID      json.RawMessage `json:"id"`               // 对应请求的 ID
	Result  interface{}     `json:"result,omitempty"` // 成功时的返回值
	Error   *RPCError       `json:"error,omitempty"`  // 失败时的错误信息
}

// RPCError 表示 JSON-RPC 错误对象
type RPCError struct {
	Code    int         `json:"code"`              // 错误码
	Message string      `json:"message"`           // 错误描述
	Data    interface{} `json:"data,omitempty"`    // 附加数据（可选）
}

// ==================== skill.execute 的输入/输出结构 ====================

// ExecuteParams 对应 manifest.json 中的 inputSchema
type ExecuteParams struct {
	Input ExecuteInput `json:"input"`
}

// ExecuteInput 是 skill.execute 的实际输入
type ExecuteInput struct {
	Message string `json:"message"`
}

// ExecuteResult 对应 manifest.json 中的 outputSchema
type ExecuteResult struct {
	Output ExecuteOutput `json:"output"`
}

// ExecuteOutput 是 skill.execute 的实际输出
type ExecuteOutput struct {
	Reply string `json:"reply"`
}

// ==================== 主逻辑 ====================

func main() {
	// 使用 bufio.Scanner 从 stdin 逐行读取 JSON-RPC 请求
	scanner := bufio.NewScanner(os.Stdin)

	// 增大缓冲区以支持较大的请求体（默认 64KB，这里设为 1MB）
	scanner.Buffer(make([]byte, 0, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()

		// 跳过空行
		if strings.TrimSpace(line) == "" {
			continue
		}

		// 解析 JSON-RPC 请求
		var req RPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			// 解析失败：返回 Parse error（错误码 -32700）
			writeError(nil, -32700, fmt.Sprintf("JSON 解析失败: %v", err))
			continue
		}

		// 根据方法名分发处理
		switch req.Method {
		case "skill.initialize":
			handleInitialize(req)
		case "skill.execute":
			handleExecute(req)
		case "skill.shutdown":
			handleShutdown(req)
		default:
			// 未知方法：返回 Method not found（错误码 -32601）
			writeError(req.ID, -32601, fmt.Sprintf("未知方法: %s", req.Method))
		}
	}

	// 如果 stdin 读取出错，将错误输出到 stderr（不影响 stdout 协议流）
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stdin 读取错误: %v\n", err)
		os.Exit(1)
	}
}

// ==================== 方法处理函数 ====================

// handleInitialize 处理 skill.initialize 请求
// 用途：Skill 启动后由 Runner 调用，用于初始化资源、建立连接等
// 返回：ready 状态，表示 Skill 已就绪
func handleInitialize(req RPCRequest) {
	result := map[string]interface{}{
		"status": "ready",
		"info": map[string]string{
			"name":    "example.go",
			"version": "0.1.0",
			"lang":    "go",
		},
	}
	writeResult(req.ID, result)
}

// handleExecute 处理 skill.execute 请求
// 用途：执行 Skill 的核心业务逻辑
// 本示例：将输入消息转为大写并附带时间戳返回
func handleExecute(req RPCRequest) {
	// 解析输入参数
	var params ExecuteParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		writeError(req.ID, -32602, fmt.Sprintf("参数解析失败: %v", err))
		return
	}

	// 校验必填字段
	if params.Input.Message == "" {
		writeError(req.ID, -32602, "缺少必填参数: input.message")
		return
	}

	// ====== 核心业务逻辑（示例：转大写 + 时间戳）======
	upper := strings.ToUpper(params.Input.Message)
	reply := fmt.Sprintf("[%s] %s", time.Now().Format("2006-01-02 15:04:05"), upper)

	// 构造输出
	result := ExecuteResult{
		Output: ExecuteOutput{
			Reply: reply,
		},
	}
	writeResult(req.ID, result)
}

// handleShutdown 处理 skill.shutdown 请求
// 用途：Runner 通知 Skill 即将停止，Skill 应在此释放资源、关闭连接
// 返回：确认已关闭
func handleShutdown(req RPCRequest) {
	result := map[string]interface{}{
		"status": "stopped",
	}
	writeResult(req.ID, result)

	// 正常退出进程
	os.Exit(0)
}

// ==================== 响应输出辅助函数 ====================

// writeResult 向 stdout 写入成功响应（NDJSON 格式：一行 JSON + 换行符）
func writeResult(id json.RawMessage, result interface{}) {
	resp := RPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	}
	data, _ := json.Marshal(resp)
	fmt.Fprintf(os.Stdout, "%s\n", data)
}

// writeError 向 stdout 写入错误响应
func writeError(id json.RawMessage, code int, message string) {
	resp := RPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &RPCError{
			Code:    code,
			Message: message,
		},
	}
	data, _ := json.Marshal(resp)
	fmt.Fprintf(os.Stdout, "%s\n", data)
}
