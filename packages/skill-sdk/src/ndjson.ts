/**
 * @mindpal/skill-sdk — NDJSON 序列化/反序列化工具
 *
 * Skill 通过 stdio（stdin/stdout）与 Runner 通信，使用 NDJSON（Newline Delimited JSON）格式。
 * 本模块提供序列化、反序列化和 stdio 传输层的完整实现。
 */

/* ================================================================== */
/*  序列化/反序列化                                                       */
/* ================================================================== */

/**
 * 将消息对象序列化为 NDJSON 行（以 \n 结尾）
 *
 * @example
 * ```ts
 * const line = serializeMessage({ jsonrpc: '2.0', id: '1', result: 'ok' });
 * // '{"jsonrpc":"2.0","id":"1","result":"ok"}\n'
 * ```
 */
export function serializeMessage(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}

/**
 * 解析单行 NDJSON 为 JS 对象
 * 如果解析失败或输入为空行，返回 null
 *
 * @example
 * ```ts
 * const msg = parseMessage('{"jsonrpc":"2.0","id":"1","result":"ok"}');
 * ```
 */
export function parseMessage(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/* ================================================================== */
/*  Stdio Transport 接口                                                */
/* ================================================================== */

/** Stdio 传输层接口 */
export interface StdioTransport {
  /** 注册消息接收处理器 */
  onMessage(handler: (msg: unknown) => void): void;
  /** 发送消息到 stdout */
  send(msg: unknown): void;
  /** 关闭传输层 */
  close(): void;
}

/* ================================================================== */
/*  Stdio Transport 实现                                                */
/* ================================================================== */

/**
 * 创建基于 process.stdin/stdout 的 NDJSON 传输层
 *
 * 用于 Skill 进程与 Runner 之间的通信。
 * 注意：此函数依赖 Node.js 的 process.stdin/stdout，仅在 Node.js 运行时可用。
 *
 * @example
 * ```ts
 * const transport = createStdioTransport();
 *
 * transport.onMessage((msg) => {
 *   console.error('Received:', msg);
 *   // 处理请求并响应
 *   transport.send({ jsonrpc: '2.0', id: msg.id, result: 'pong' });
 * });
 *
 * // 程序退出时清理
 * process.on('SIGTERM', () => transport.close());
 * ```
 */
export function createStdioTransport(): StdioTransport {
  const handlers: Array<(msg: unknown) => void> = [];
  let buffer = '';
  let closed = false;

  // 从 stdin 读取 NDJSON 流
  const onData = (chunk: Buffer | string): void => {
    if (closed) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

    // 按换行符分割，处理完整的行
    const lines = buffer.split('\n');
    // 最后一个元素可能是不完整的行，保留在 buffer 中
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const msg = parseMessage(line);
      if (msg !== null) {
        for (const handler of handlers) {
          handler(msg);
        }
      }
    }
  };

  // 绑定 stdin
  if (typeof process !== 'undefined' && process.stdin) {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', onData);
    process.stdin.resume();
  }

  return {
    onMessage(handler: (msg: unknown) => void): void {
      handlers.push(handler);
    },

    send(msg: unknown): void {
      if (closed) return;
      if (typeof process !== 'undefined' && process.stdout) {
        process.stdout.write(serializeMessage(msg));
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      handlers.length = 0;
      if (typeof process !== 'undefined' && process.stdin) {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
      }
    },
  };
}
