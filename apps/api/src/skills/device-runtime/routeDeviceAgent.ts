import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { getDevicePolicy, upsertDevicePolicy } from "./modules/devicePolicyRepo";
import { activateDeviceWithToken, getDeviceRecord, revokeDeviceRecord, rotateDeviceRecordToken, updateDeviceLastSeen } from "./modules/deviceRepo";
import { consumeDevicePairing } from "./modules/pairingRepo";
import { randomCode, sha256Hex } from "./modules/crypto";
import crypto from "node:crypto";
import { createArtifact } from "../artifact-manager/modules/artifactRepo";
import { transcribeAudio, synthesizeSpeech } from "../../modules/audioService";
import { DEVICE_TYPE_PLUGIN_POLICY } from "@mindpal/shared";

function requireDevice(req: any) {
  const device = req.ctx.device;
  if (!device) throw Errors.unauthorized(req.ctx.locale);
  return device as { deviceId: string; tenantId: string; spaceId: string | null; ownerScope: string; ownerSubjectId: string | null };
}

export const deviceAgentRoutes: FastifyPluginAsync = async (app) => {
  app.post("/device-agent/pair", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "pair" });
    const body = z
      .object({
        pairingCode: z.string().min(10),
        deviceType: z.enum(["desktop", "mobile", "iot", "robot", "vehicle", "home", "gateway"]),
        os: z.string().min(1).max(100),
        agentVersion: z.string().min(1).max(100),
        // 端侧能力上报（可选）
        capabilities: z.array(z.object({
          toolRef: z.string().min(1),
          pluginName: z.string().optional(),
          version: z.string().optional(),
        })).optional(),
        pluginNames: z.array(z.string()).optional(),
      })
      .parse(req.body);

    const codeHash = sha256Hex(body.pairingCode);
    const pairing = await consumeDevicePairing({ pool: app.db, codeHash });
    if (!pairing) throw Errors.badRequest("配对码无效或已过期");

    const device = await getDeviceRecord({ pool: app.db, tenantId: pairing.tenantId, deviceId: pairing.deviceId });
    if (!device) throw Errors.badRequest("Device 不存在");
    if (device.status !== "pending") throw Errors.badRequest("Device 状态不允许配对");

    const subject = req.ctx.subject;
    if (subject && (subject.tenantId !== device.tenantId || subject.spaceId !== (device.spaceId ?? undefined))) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const deviceToken = randomCode("devtok_");
    const activated = await activateDeviceWithToken({
      pool: app.db,
      tenantId: device.tenantId,
      deviceId: device.deviceId,
      deviceTokenHash: sha256Hex(deviceToken),
      deviceType: body.deviceType,
      os: body.os,
      agentVersion: body.agentVersion,
    });
    if (!activated) throw Errors.badRequest("Device 状态不允许配对");

    // 检查现有策略
    let policy = await getDevicePolicy({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId });
    let policyAutoPopulated: { allowedToolsCount: number } | null = null;

    // 如果端侧上报了能力且策略中尚无 allowedTools，自动填充
    const reportedCapabilities = body.capabilities ?? [];
    if (reportedCapabilities.length > 0) {
      const hasExistingAllowedTools = policy?.allowedTools && Array.isArray(policy.allowedTools) && policy.allowedTools.length > 0;
      if (!hasExistingAllowedTools) {
        const autoAllowedTools = [...new Set(reportedCapabilities.map((c) => c.toolRef))];
        policy = await upsertDevicePolicy({
          pool: app.db,
          tenantId: device.tenantId,
          deviceId: device.deviceId,
          allowedTools: autoAllowedTools,
          // 保留其他策略字段不变
          filePolicy: policy?.filePolicy ?? null,
          networkPolicy: policy?.networkPolicy ?? null,
          uiPolicy: policy?.uiPolicy ?? null,
          evidencePolicy: policy?.evidencePolicy ?? { allowUpload: true, allowedTypes: ["text/plain", "image/png"], retentionDays: 7 },
          limits: policy?.limits ?? null,
        });
        policyAutoPopulated = { allowedToolsCount: autoAllowedTools.length };
        (req as any).log?.info?.({ deviceId: device.deviceId, autoAllowedTools }, "[pair] 自动填充 allowedTools");
      }
    }

    req.ctx.audit!.outputDigest = {
      deviceId: device.deviceId,
      token: { sha256_8: sha256Hex(deviceToken).slice(0, 8) },
      reportedCapabilities: reportedCapabilities.length,
      policyAutoPopulated: Boolean(policyAutoPopulated),
    };

    // ── 元数据驱动：根据设备类型下发插件策略 ────────────────
    // 使用 @mindpal/shared 中的统一策略映射（Single Source of Truth）
    const pluginPolicy = {
      builtinPlugins: DEVICE_TYPE_PLUGIN_POLICY.get(body.deviceType) ?? [],
    };

    return { deviceId: device.deviceId, deviceToken, policy, policyAutoPopulated, pluginPolicy };
  });

  app.post("/device-agent/heartbeat", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "heartbeat" });
    const body = z.object({
      os: z.string().min(1).max(100),
      agentVersion: z.string().min(1).max(100),
      capabilitySnapshot: z.array(z.object({
        toolRef: z.string(),
        riskLevel: z.string().optional(),
        version: z.string().optional(),
        tags: z.array(z.string()).optional(),
        description: z.string().optional(),
        pluginName: z.string().optional(),
      })).optional(),
      deviceCapabilityReport: z.object({
        probedAt: z.string().optional(),
        platform: z.string().optional(),
        arch: z.string().optional(),
        totalMemoryMb: z.number().optional(),
        freeMemoryMb: z.number().optional(),
        cpuCores: z.number().optional(),
        hardware: z.object({
          hasCamera: z.boolean().optional(),
          hasGpu: z.boolean().optional(),
          gpuDescription: z.string().optional(),
          screen: z.object({ width: z.number(), height: z.number() }).nullable().optional(),
          hasMicrophone: z.boolean().optional(),
          hasTouchscreen: z.boolean().optional(),
        }).optional(),
        software: z.object({
          hasBrowser: z.boolean().optional(),
          browserPath: z.string().optional(),
          hasDesktopGui: z.boolean().optional(),
          hasClipboard: z.boolean().optional(),
          nodeVersion: z.string().optional(),
        }).optional(),
        network: z.object({
          hasNetwork: z.boolean().optional(),
          interfaceCount: z.number().optional(),
        }).optional(),
        warnings: z.array(z.string()).optional(),
      }).optional(),
    }).parse(req.body);

    const device = requireDevice(req);
    const updated = await updateDeviceLastSeen({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId, os: body.os, agentVersion: body.agentVersion });
    if (!updated) throw Errors.unauthorized(req.ctx.locale);

    // 将能力快照和设备能力报告写入 device_sessions（如果有上报）
    if (body.capabilitySnapshot && body.capabilitySnapshot.length > 0) {
      try {
        await app.db.query(
          `UPDATE device_sessions SET capabilities = $1::jsonb, last_activity_at = now()
           WHERE tenant_id = $2 AND device_id = $3 AND status = 'active'`,
          [JSON.stringify(body.capabilitySnapshot), device.tenantId, device.deviceId]
        );
      } catch (capErr: any) {
        (req as any).log?.warn?.({ err: capErr }, "[heartbeat] 写入 capabilitySnapshot 失败（非致命）");
      }
    }

    // 将设备能力探测报告写入 device_records.metadata（供 hybridDispatcher 路由时参考）
    if (body.deviceCapabilityReport) {
      try {
        await app.db.query(
          `UPDATE device_records
           SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('capabilityReport', $1::jsonb)
           WHERE tenant_id = $2 AND device_id = $3`,
          [JSON.stringify(body.deviceCapabilityReport), device.tenantId, device.deviceId]
        );
      } catch (reportErr: any) {
        (req as any).log?.warn?.({ err: reportErr }, "[heartbeat] 写入 deviceCapabilityReport 失败（非致命）");
      }
    }

    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, ok: true, capabilityCount: body.capabilitySnapshot?.length ?? 0, hasCapabilityReport: Boolean(body.deviceCapabilityReport) };
    return { ok: true };
  });

  app.post("/device-agent/revoke", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "revoke.self" });
    const device = requireDevice(req);
    const body = z.object({ deviceId: z.string().uuid().optional() }).parse(req.body ?? {});
    if (body.deviceId && body.deviceId !== device.deviceId) throw Errors.forbidden();
    const revoked = await revokeDeviceRecord({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId });
    if (!revoked) throw Errors.unauthorized(req.ctx.locale);
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, revoked: true };
    return { ok: true };
  });

  app.post("/device-agent/token/rotate", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "token.rotate" });
    const device = requireDevice(req);
    const body = z.object({ deviceId: z.string().uuid().optional() }).parse(req.body ?? {});
    if (body.deviceId && body.deviceId !== device.deviceId) throw Errors.forbidden();
    const deviceToken = randomCode("devtok_");
    const rotated = await rotateDeviceRecordToken({
      pool: app.db,
      tenantId: device.tenantId,
      deviceId: device.deviceId,
      deviceTokenHash: sha256Hex(deviceToken),
    });
    if (!rotated) throw Errors.unauthorized(req.ctx.locale);
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, token: { sha256_8: sha256Hex(deviceToken).slice(0, 8) } };
    return { ok: true, deviceToken };
  });

  // 接收端侧同步的本地禁用工具列表
  app.post("/device-agent/sync-disabled-tools", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "sync.disabled_tools" });
    const device = requireDevice(req);
    const body = z
      .object({
        disabledTools: z.array(z.string()).max(500),
        highRiskConfirmEnabled: z.boolean().optional(),
        stats: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    // 存储到 device_records 的扩展字段（使用 JSONB 存储在 metadata 中）
    await app.db.query(
      `UPDATE device_records
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
           last_seen_at = now()
       WHERE tenant_id = $1 AND device_id = $2`,
      [
        device.tenantId,
        device.deviceId,
        JSON.stringify({
          localDisabledTools: body.disabledTools,
          highRiskConfirmEnabled: body.highRiskConfirmEnabled ?? true,
          executionStats: body.stats ?? null,
          lastSyncAt: new Date().toISOString(),
        }),
      ],
    );

    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, disabledToolsCount: body.disabledTools.length };
    return { ok: true, synced: body.disabledTools.length };
  });

  // ── STT：语音转文本 ──────────────────────────────────────────
  app.post("/device-agent/dialog/transcribe", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "dialog.transcribe" });
    const device = requireDevice(req);
    const body = z.object({
      audioBase64: z.string().min(8),
      format: z.string().max(20).optional(),
      sampleRate: z.number().int().positive().optional(),
    }).parse(req.body);
    const result = await transcribeAudio({
      audioBase64: body.audioBase64,
      format: body.format,
      sampleRate: body.sampleRate,
    });
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, hasTranscript: Boolean(result.transcript) };
    return result;
  });

  // ── TTS：文本转语音 ──────────────────────────────────────────
  app.post("/device-agent/dialog/tts", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "dialog.tts" });
    const device = requireDevice(req);
    const body = z.object({ text: z.string().min(1).max(5000) }).parse(req.body);
    const result = await synthesizeSpeech({ text: body.text });
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, textLen: body.text.length, hasAudio: Boolean(result.audioBase64) };
    return result;
  });

  app.post("/device-agent/evidence/upload", async (req, reply) => {
    setAuditContext(req, { resourceType: "device", action: "evidence.upload" });
    const device = requireDevice(req);
    const body = z
      .object({
        deviceExecutionId: z.string().uuid().optional(),
        contentBase64: z.string().min(8),
        contentType: z.string().min(3).max(200),
        format: z.string().min(1).max(50).optional(),
      })
      .parse(req.body);

    const policy = await getDevicePolicy({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId });
    const ep = policy?.evidencePolicy ?? null;
    const allowUpload = Boolean(ep && typeof ep === "object" && (ep as any).allowUpload);
    if (!allowUpload) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (!device.spaceId) throw Errors.badRequest("缺少 spaceId");
    const allowedTypes = Array.isArray((ep as any)?.allowedTypes) ? ((ep as any).allowedTypes as any[]).map((x) => String(x)) : [];
    if (allowedTypes.length && !allowedTypes.includes(body.contentType)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const base64 = body.contentBase64.trim();
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      throw Errors.badRequest("contentBase64 非法");
    }
    const maxBytes = Math.max(1, Number(process.env.DEVICE_EVIDENCE_MAX_UPLOAD_BYTES ?? "1048576") || 1048576);
    if (bytes.byteLength > maxBytes) throw Errors.badRequest("证据过大");

    const retentionDaysRaw = Number((ep as any)?.retentionDays ?? 7);
    const retentionDays = Number.isFinite(retentionDaysRaw) ? Math.max(1, Math.min(365, Math.floor(retentionDaysRaw))) : 7;
    const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const artifactId = crypto.randomUUID();
    const art = await createArtifact({
      pool: app.db,
      artifactId,
      tenantId: device.tenantId,
      spaceId: device.spaceId,
      type: "device_evidence",
      format: body.format ?? "base64",
      contentType: body.contentType,
      contentText: base64,
      source: { kind: "device_evidence", deviceId: device.deviceId, deviceExecutionId: body.deviceExecutionId ?? null },
      createdBySubjectId: null,
      expiresAt,
    });
    req.ctx.audit!.inputDigest = { contentType: body.contentType, byteSize: bytes.byteLength, deviceExecutionId: body.deviceExecutionId ?? null };
    req.ctx.audit!.outputDigest = { artifactId: art.artifactId, expiresAt: art.expiresAt, type: art.type, format: art.format };
    return reply.status(200).send({ artifactId: art.artifactId, evidenceRef: `artifact:${art.artifactId}`, expiresAt: art.expiresAt });
  });
};
