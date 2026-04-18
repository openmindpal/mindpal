/**
 * Model Prober — 模型能力探测器
 *
 * P2-5: 定时探测已注册模型的能力和性能：
 * - tool_call 能力测试
 * - 结构化输出测试
 * - 延迟基准测试
 * - 视觉能力测试（可选）
 *
 * 探测结果更新 model_catalog 的 capabilities 和 performance_stats。
 * 异常时触发退化告警和自动降级。
 */
import type { Pool } from "pg";

// ── 探测类型 ────────────────────────────────────────────────

export type ProbeType = "tool_call" | "structured_output" | "latency" | "vision" | "audio" | "video" | "context_window";

export interface ProbeResult {
  probeType: ProbeType;
  success: boolean;
  latencyMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

// ── 探测执行 ────────────────────────────────────────────────

/**
 * 执行全套模型探测。
 * 对指定租户下所有 active/degraded 模型逐个探测。
 */
export async function runModelProbing(params: {
  pool: Pool;
  tenantId: string;
  probeTypes?: ProbeType[];
  config?: {
    maxModelsPerRun?: number;
    probeTimeoutMs?: number;
  };
}): Promise<{ probed: number; succeeded: number; failed: number; errors: string[] }> {
  const { pool, tenantId } = params;
  const probeTypes = params.probeTypes ?? ["latency", "tool_call", "structured_output", "vision", "audio", "video"];
  const maxModels = params.config?.maxModelsPerRun ?? 20;
  const timeoutMs = params.config?.probeTimeoutMs ?? 15000;

  // 查询需要探测的模型
  const res = await pool.query(
    `SELECT model_ref, provider, capabilities, endpoint_host
     FROM model_catalog
     WHERE tenant_id = $1 AND status IN ('active', 'degraded')
     ORDER BY COALESCE(last_probed_at, '2000-01-01') ASC
     LIMIT $2`,
    [tenantId, maxModels],
  );

  let probed = 0, succeeded = 0, failed = 0;
  const errors: string[] = [];

  for (const row of res.rows) {
    const model = row as any;
    probed++;

    for (const probeType of probeTypes) {
      try {
        const result = await executeProbe({
          pool, tenantId, modelRef: model.model_ref,
          provider: model.provider, probeType, timeoutMs,
          endpointHost: model.endpoint_host,
        });

        // 记录探测结果
        await recordProbeResult({
          pool, tenantId, modelRef: model.model_ref,
          probeType, success: result.success,
          latencyMs: result.latencyMs,
          probeOutput: result.details,
          errorMessage: result.error,
        });

        if (result.success) {
          succeeded++;
          // 更新性能统计（延迟探测）
          if (probeType === "latency") {
            await updateLatencyStats({ pool, tenantId, modelRef: model.model_ref, latencyMs: result.latencyMs });
          }
          // 更新能力（tool_call/structured_output/vision 探测）
          if (probeType !== "latency") {
            await updateCapabilityFromProbe({ pool, tenantId, modelRef: model.model_ref, probeType, result });
          }
        } else {
          failed++;
          errors.push(`${model.model_ref}/${probeType}: ${result.error ?? "unknown"}`);
          // 触发退化检测
          await checkDegradationFromProbe({ pool, tenantId, modelRef: model.model_ref, probeType });
        }
      } catch (e: any) {
        failed++;
        errors.push(`${model.model_ref}/${probeType}: ${e?.message ?? "exception"}`);
      }
    }
  }

  return { probed, succeeded, failed, errors };
}

// ── 探测实现 ────────────────────────────────────────────────

async function executeProbe(params: {
  pool: Pool; tenantId: string; modelRef: string;
  provider: string; probeType: ProbeType;
  timeoutMs: number; endpointHost?: string;
}): Promise<ProbeResult> {
  const start = Date.now();
  const { probeType } = params;

  try {
    // 获取模型调用凭证
    const binding = await findProviderBinding(params.pool, params.tenantId, params.modelRef);
    if (!binding) {
      return { probeType, success: false, latencyMs: 0, error: "no_binding" };
    }

    switch (probeType) {
      case "latency":
        return await probeLatency(binding, start, params.timeoutMs);
      case "tool_call":
        return await probeToolCall(binding, start, params.timeoutMs);
      case "structured_output":
        return await probeStructuredOutput(binding, start, params.timeoutMs);
      case "vision":
        return await probeVision(binding, start, params.timeoutMs);
      case "audio":
        return await probeAudio(binding, start, params.timeoutMs);
      case "video":
        return await probeVideo(binding, start, params.timeoutMs);
      case "context_window":
        return await probeContextWindow(binding, start, params.timeoutMs);
      default:
        return { probeType, success: false, latencyMs: Date.now() - start, error: "unknown_probe_type" };
    }
  } catch (e: any) {
    return { probeType, success: false, latencyMs: Date.now() - start, error: e?.message ?? "exception" };
  }
}

/** 延迟基准探测：发送简单请求测量 TTFT */
async function probeLatency(binding: ProviderBinding, start: number, timeoutMs: number): Promise<ProbeResult> {
  try {
    const response = await sendProbeRequest(binding, timeoutMs, {
      openai: {
        model: binding.modelName,
        messages: [{ role: "user", content: "Say hello." }],
        max_tokens: 5,
        temperature: 0,
      },
      anthropic: {
        model: binding.modelName,
        messages: [{ role: "user", content: "Say hello." }],
        max_tokens: 16,
        temperature: 0,
      },
      gemini: {
        contents: [{ role: "user", parts: [{ text: "Say hello." }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      },
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return { probeType: "latency", success: false, latencyMs, error: `HTTP ${response.status}` };
    }
    return { probeType: "latency", success: true, latencyMs };
  } catch (e: any) {
    return { probeType: "latency", success: false, latencyMs: Date.now() - start, error: e?.message };
  }
}

/** 工具调用能力探测 */
async function probeToolCall(binding: ProviderBinding, start: number, timeoutMs: number): Promise<ProbeResult> {
  try {
    const response = await sendProbeRequest(binding, timeoutMs, {
      openai: {
        model: binding.modelName,
        messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
        tools: [{
          type: "function",
          function: {
            name: "calculator",
            description: "Performs arithmetic",
            parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
          },
        }],
        max_tokens: 100,
        temperature: 0,
      },
      anthropic: {
        model: binding.modelName,
        messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
        tools: [{
          name: "calculator",
          description: "Performs arithmetic",
          input_schema: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
        }],
        max_tokens: 128,
        temperature: 0,
      },
      gemini: {
        contents: [{ role: "user", parts: [{ text: "What is 2+2? Use the calculator tool." }] }],
        tools: [{
          functionDeclarations: [{
            name: "calculator",
            description: "Performs arithmetic",
            parameters: {
              type: "OBJECT",
              properties: { expression: { type: "STRING" } },
              required: ["expression"],
            },
          }],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 64 },
      },
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return { probeType: "tool_call", success: false, latencyMs, error: `HTTP ${response.status}` };
    }

    const json = await response.json() as any;
    const family = getProviderFamily(binding.provider);
    const hasToolCall = family === "gemini"
      ? geminiHasFunctionCall(json)
      : family === "anthropic"
        ? anthropicHasToolUse(json)
        : json?.choices?.[0]?.message?.tool_calls?.length > 0;
    return { probeType: "tool_call", success: hasToolCall, latencyMs, details: { hasToolCall } };
  } catch (e: any) {
    return { probeType: "tool_call", success: false, latencyMs: Date.now() - start, error: e?.message };
  }
}

/** 结构化输出能力探测 */
async function probeStructuredOutput(binding: ProviderBinding, start: number, timeoutMs: number): Promise<ProbeResult> {
  try {
    const response = await sendProbeRequest(binding, timeoutMs, {
      openai: {
        model: binding.modelName,
        messages: [{ role: "user", content: "Return a JSON with name and age." }],
        response_format: { type: "json_object" },
        max_tokens: 100,
        temperature: 0,
      },
      anthropic: {
        model: binding.modelName,
        messages: [{ role: "user", content: "Return valid JSON with fields name and age only." }],
        max_tokens: 128,
        temperature: 0,
      },
      gemini: {
        contents: [{ role: "user", parts: [{ text: "Return valid JSON with fields name and age only." }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 128, responseMimeType: "application/json" },
      },
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return { probeType: "structured_output", success: false, latencyMs, error: `HTTP ${response.status}` };
    }

    const json = await response.json() as any;
    const content = getTextResponse(binding.provider, json);
    let validJson = false;
    try { JSON.parse(content); validJson = true; } catch { /* not json */ }
    return { probeType: "structured_output", success: validJson, latencyMs, details: { validJson } };
  } catch (e: any) {
    return { probeType: "structured_output", success: false, latencyMs: Date.now() - start, error: e?.message };
  }
}

/** P2-模型: 视觉能力探测 — 发送带 image_url 的消息检测模型是否支持多模态 */
async function probeVision(binding: ProviderBinding, start: number, timeoutMs: number): Promise<ProbeResult> {
  try {
    const tinyPngDataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const response = await sendProbeRequest(binding, timeoutMs, {
      openai: {
        model: binding.modelName,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this image in one word." },
            { type: "image_url", image_url: { url: tinyPngDataUri } },
          ],
        }],
        max_tokens: 10,
        temperature: 0,
      },
      anthropic: {
        model: binding.modelName,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this image in one word." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: tinyPngDataUri.split(",")[1] },
            },
          ],
        }],
        max_tokens: 32,
        temperature: 0,
      },
      gemini: {
        contents: [{
          role: "user",
          parts: [
            { text: "Describe this image in one word." },
            { inlineData: { mimeType: "image/png", data: tinyPngDataUri.split(",")[1] } },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      },
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      const status = response.status;
      const unsupported = status === 400 || status === 422;
      return {
        probeType: "vision",
        success: false,
        latencyMs,
        details: { unsupported, httpStatus: status },
        error: unsupported ? "model_does_not_support_vision" : `HTTP ${status}`,
      };
    }

    const json = await response.json() as any;
    const content = getTextResponse(binding.provider, json);
    const supportsVision = content.length > 0;
    return {
      probeType: "vision",
      success: supportsVision,
      latencyMs,
      details: { supportsVision, responseLength: content.length },
    };
  } catch (e: any) {
    return { probeType: "vision", success: false, latencyMs: Date.now() - start, error: e?.message };
  }
}

async function probeAudio(binding: ProviderBinding, start: number, timeoutMs: number): Promise<ProbeResult> {
  try {
    if (getProviderFamily(binding.provider) === "anthropic") {
      return { probeType: "audio", success: false, latencyMs: Date.now() - start, error: "audio_not_supported_for_anthropic_probe" };
    }
    const tinyWavBase64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
    const response = await sendProbeRequest(binding, timeoutMs, {
      openai: {
        model: binding.modelName,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Transcribe or describe this audio briefly." },
            { type: "input_audio", input_audio: { data: tinyWavBase64, format: "wav" } },
          ],
        }],
        max_tokens: 16,
        temperature: 0,
      },
      gemini: {
        contents: [{
          role: "user",
          parts: [
            { text: "Transcribe or describe this audio briefly." },
            { inlineData: { mimeType: "audio/wav", data: tinyWavBase64 } },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      },
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      const status = response.status;
      const unsupported = status === 400 || status === 422;
      return { probeType: "audio", success: false, latencyMs, details: { unsupported, httpStatus: status }, error: unsupported ? "model_does_not_support_audio" : `HTTP ${status}` };
    }
    const json = await response.json() as any;
    const content = getTextResponse(binding.provider, json);
    const supportsAudio = content.length > 0;
    return { probeType: "audio", success: supportsAudio, latencyMs, details: { supportsAudio, responseLength: content.length } };
  } catch (e: any) {
    return { probeType: "audio", success: false, latencyMs: Date.now() - start, error: e?.message };
  }
}

async function probeVideo(binding: ProviderBinding, start: number, timeoutMs: number): Promise<ProbeResult> {
  try {
    if (getProviderFamily(binding.provider) === "anthropic") {
      return { probeType: "video", success: false, latencyMs: Date.now() - start, error: "video_not_supported_for_anthropic_probe" };
    }
    const tinyMp4Base64 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAIKbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9ABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACVnRyYWsAAABcdGtoZAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAABAAAAAAAABAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKQAAAAWgAAAAAAAkdWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAH0AABAAAAAAEAAAAAAAABAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAABpb2RzAAAAAmlsc3QAAAAUdG9vAAAAAAAAAABMYXZmNTcuODMuMTAw";
    const response = await sendProbeRequest(binding, timeoutMs, {
      openai: {
        model: binding.modelName,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this video in one word." },
            { type: "video_url", video_url: { url: `data:video/mp4;base64,${tinyMp4Base64}` } },
          ],
        }],
        max_tokens: 16,
        temperature: 0,
      },
      gemini: {
        contents: [{
          role: "user",
          parts: [
            { text: "Describe this video in one word." },
            { inlineData: { mimeType: "video/mp4", data: tinyMp4Base64 } },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      },
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      const status = response.status;
      const unsupported = status === 400 || status === 422;
      return { probeType: "video", success: false, latencyMs, details: { unsupported, httpStatus: status }, error: unsupported ? "model_does_not_support_video" : `HTTP ${status}` };
    }
    const json = await response.json() as any;
    const content = getTextResponse(binding.provider, json);
    const supportsVideo = content.length > 0;
    return { probeType: "video", success: supportsVideo, latencyMs, details: { supportsVideo, responseLength: content.length } };
  } catch (e: any) {
    return { probeType: "video", success: false, latencyMs: Date.now() - start, error: e?.message };
  }
}

/** P2-模型: 上下文窗口探测 — 发送递增长度的 prompt 检测实际可处理的上下文边界 */
async function probeContextWindow(binding: ProviderBinding, start: number, timeoutMs: number): Promise<ProbeResult> {
  try {
    const longText = "The quick brown fox jumps over the lazy dog. ".repeat(400);
    const response = await sendProbeRequest(binding, timeoutMs, {
      openai: {
        model: binding.modelName,
        messages: [
          { role: "system", content: "Reply with exactly: OK" },
          { role: "user", content: `Read the following and reply OK:\n${longText}` },
        ],
        max_tokens: 5,
        temperature: 0,
      },
      anthropic: {
        model: binding.modelName,
        system: "Reply with exactly: OK",
        messages: [{ role: "user", content: `Read the following and reply OK:\n${longText}` }],
        max_tokens: 16,
        temperature: 0,
      },
      gemini: {
        contents: [{ role: "user", parts: [{ text: `Reply with exactly OK after reading:\n${longText}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 8 },
      },
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      const status = response.status;
      let errorBody = "";
      try { errorBody = await response.text(); } catch { /* ignore */ }
      const contextExceeded = errorBody.includes("context_length") || errorBody.includes("max_tokens") || errorBody.includes("too long");
      return {
        probeType: "context_window",
        success: false,
        latencyMs,
        details: { contextExceeded, httpStatus: status, estimatedTokens: 4000 },
        error: contextExceeded ? "context_length_exceeded" : `HTTP ${status}`,
      };
    }

    // 成功表示至少支持 4k context
    return {
      probeType: "context_window",
      success: true,
      latencyMs,
      details: { estimatedMinContext: 4000, testedTokens: 4000 },
    };
  } catch (e: any) {
    return { probeType: "context_window", success: false, latencyMs: Date.now() - start, error: e?.message };
  }
}

// ── 辅助函数 ────────────────────────────────────────────────

type ProviderBinding = { baseUrl: string; apiKey: string; modelName: string; provider: string };

async function findProviderBinding(pool: Pool, tenantId: string, modelRef: string): Promise<ProviderBinding | null> {
  // 从 provider_bindings + secrets 表解析调用凭证
  const res = await pool.query(
    `SELECT pb.base_url, pb.model_ref, pb.provider, s.encrypted_payload
     FROM provider_bindings pb
     LEFT JOIN secrets s ON s.owner_scope = 'tenant' AND s.owner_id = pb.tenant_id AND s.connector_ref = pb.model_ref
     WHERE pb.tenant_id = $1 AND pb.model_ref = $2 AND pb.status = 'enabled'
     LIMIT 1`,
    [tenantId, modelRef],
  );
  if (!res.rowCount) return null;
  const row = res.rows[0] as any;
  const baseUrl = String(row.base_url ?? "").replace(/\/+$/, "");
  // 简化处理：实际应通过密钥管理解密
  const apiKey = row.encrypted_payload?.api_key ?? row.encrypted_payload?.apiKey ?? "";
  const modelName = modelRef.includes(":") ? modelRef.split(":").slice(1).join(":") : modelRef;
  const provider = String(row.provider ?? modelRef.split(":")[0] ?? "").trim();
  return { baseUrl, apiKey, modelName, provider };
}

function getProviderFamily(provider: string) {
  if (provider === "anthropic" || provider === "custom_anthropic") return "anthropic";
  if (provider === "gemini" || provider === "custom_gemini") return "gemini";
  return "openai";
}

async function sendProbeRequest(
  binding: ProviderBinding,
  timeoutMs: number,
  bodies: {
    openai?: Record<string, unknown>;
    anthropic?: Record<string, unknown>;
    gemini?: Record<string, unknown>;
  },
) {
  const family = getProviderFamily(binding.provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (family === "anthropic") {
      return await fetch(`${binding.baseUrl.replace(/\/+$/g, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": binding.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(bodies.anthropic ?? {}),
        signal: controller.signal,
      });
    }
    if (family === "gemini") {
      const baseUrl = binding.baseUrl.replace(/\/+$/g, "");
      const baseWithVersion = /\/v1(beta)?$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1beta`;
      return await fetch(`${baseWithVersion}/models/${encodeURIComponent(binding.modelName)}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": binding.apiKey,
        },
        body: JSON.stringify(bodies.gemini ?? {}),
        signal: controller.signal,
      });
    }
    return await fetch(`${binding.baseUrl.replace(/\/+$/g, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${binding.apiKey}` },
      body: JSON.stringify(bodies.openai ?? {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function getTextResponse(provider: string, json: any) {
  const family = getProviderFamily(provider);
  if (family === "anthropic") {
    return Array.isArray(json?.content)
      ? json.content.filter((block: any) => block?.type === "text").map((block: any) => String(block.text ?? "")).join("")
      : "";
  }
  if (family === "gemini") {
    return Array.isArray(json?.candidates)
      ? json.candidates.flatMap((candidate: any) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []).map((part: any) => String(part?.text ?? "")).join("")
      : "";
  }
  return String(json?.choices?.[0]?.message?.content ?? "");
}

function geminiHasFunctionCall(json: any) {
  if (!Array.isArray(json?.candidates)) return false;
  return json.candidates.some((candidate: any) =>
    Array.isArray(candidate?.content?.parts) &&
    candidate.content.parts.some((part: any) => part && typeof part === "object" && "functionCall" in part),
  );
}

function anthropicHasToolUse(json: any) {
  if (!Array.isArray(json?.content)) return false;
  return json.content.some((block: any) => block?.type === "tool_use");
}

async function recordProbeResult(params: {
  pool: Pool; tenantId: string; modelRef: string;
  probeType: string; success: boolean; latencyMs: number;
  probeOutput?: any; errorMessage?: string;
}) {
  await params.pool.query(
    `INSERT INTO model_probe_log (tenant_id, model_ref, probe_type, probe_output, success, latency_ms, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [params.tenantId, params.modelRef, params.probeType,
     params.probeOutput ? JSON.stringify(params.probeOutput) : null,
     params.success, params.latencyMs, params.errorMessage ?? null],
  );
  await params.pool.query(
    `UPDATE model_catalog SET last_probed_at = now(),
       probe_result = $3::jsonb
     WHERE tenant_id = $1 AND model_ref = $2`,
    [params.tenantId, params.modelRef,
     JSON.stringify({ type: params.probeType, success: params.success, latencyMs: params.latencyMs })],
  );
}

async function updateLatencyStats(params: { pool: Pool; tenantId: string; modelRef: string; latencyMs: number }) {
  // 简化：直接更新 P50 为最新测量值（生产环境应维护滑动窗口）
  await params.pool.query(
    `UPDATE model_catalog SET
       performance_stats = jsonb_set(
         jsonb_set(performance_stats, '{latencyP50Ms}', to_jsonb($3::int)),
         '{lastMeasuredAt}', to_jsonb(now()::text)
       ),
       updated_at = now()
     WHERE tenant_id = $1 AND model_ref = $2`,
    [params.tenantId, params.modelRef, params.latencyMs],
  );
}

async function updateCapabilityFromProbe(params: {
  pool: Pool; tenantId: string; modelRef: string; probeType: ProbeType; result: ProbeResult;
}) {
  const { pool, tenantId, modelRef, probeType, result } = params;
  let capUpdate: Record<string, unknown> = {};
  const addModalities = (modalities: string[]) => Array.from(new Set(["text", ...modalities]));

  if (probeType === "tool_call") {
    capUpdate = { toolCallAbility: result.success ? "native" : "none" };
  } else if (probeType === "structured_output") {
    capUpdate = { structuredOutputAbility: result.success ? "json" : "none" };
  } else if (probeType === "vision") {
    capUpdate = { visionSupport: result.success };
    if (result.success) {
      capUpdate.supportedModalities = addModalities(["image"]);
    }
  } else if (probeType === "audio" && result.success) {
    capUpdate = { audioSupport: true, supportedModalities: addModalities(["audio"]) };
  } else if (probeType === "video" && result.success) {
    capUpdate = { videoSupport: true, supportedModalities: addModalities(["video"]) };
  } else if (probeType === "context_window" && result.success) {
    const testedTokens = (result.details as any)?.testedTokens ?? 4000;
    capUpdate = { contextWindow: Math.max(testedTokens, 4096) };
  }

  if (Object.keys(capUpdate).length > 0) {
    await pool.query(
      `UPDATE model_catalog SET capabilities = capabilities || $3::jsonb, updated_at = now()
       WHERE tenant_id = $1 AND model_ref = $2`,
      [tenantId, modelRef, JSON.stringify(capUpdate)],
    );
  }
}

async function checkDegradationFromProbe(params: {
  pool: Pool; tenantId: string; modelRef: string; probeType: string;
}) {
  const { pool, tenantId, modelRef, probeType } = params;
  // 查询最近 5 次探测的失败率
  const res = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE NOT success) as failures, COUNT(*) as total
     FROM (SELECT success FROM model_probe_log
           WHERE tenant_id = $1 AND model_ref = $2 AND probe_type = $3
           ORDER BY created_at DESC LIMIT 5) sub`,
    [tenantId, modelRef, probeType],
  );
  const row = res.rows[0] as any;
  const failures = Number(row?.failures ?? 0);
  const total = Number(row?.total ?? 0);

  if (total >= 3 && failures / total > 0.5) {
    // 超过半数失败，标记退化
    await pool.query(
      `UPDATE model_catalog SET
         degradation_score = LEAST(1.0, degradation_score + 0.2),
         status = CASE WHEN degradation_score + 0.2 > 0.7 THEN 'unavailable' WHEN degradation_score + 0.2 > 0.3 THEN 'degraded' ELSE status END,
         updated_at = now()
       WHERE tenant_id = $1 AND model_ref = $2`,
      [tenantId, modelRef],
    );
  }
}
