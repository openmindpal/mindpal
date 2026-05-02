/**
 * 设备能力注册表 — OS级设备能力动态发现、注册与协商
 *
 * 设计原则：
 * - 元数据驱动：设备能力通过 DeviceCapabilityDescriptor 声明，非硬编码
 * - 内存级注册表：随 WebSocket 连接生命周期管理，不持久化
 * - 分层自治：端侧自主探测能力，云端协商策略
 */
import type { DeviceCapabilityDescriptor } from "@mindpal/shared";
import type { DeviceMultimodalPolicy } from "@mindpal/shared";

/** 注册表中的设备条目 */
export interface DeviceEntry {
  deviceId: string;
  descriptor: DeviceCapabilityDescriptor;
  connectedAt: number;
  lastHeartbeat: number;
}

export class DeviceCapabilityRegistry {
  private devices = new Map<string, DeviceEntry>();

  /** 设备连接时注册能力 */
  register(deviceId: string, descriptor: DeviceCapabilityDescriptor): void {
    this.devices.set(deviceId, {
      deviceId,
      descriptor,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
  }

  /** 设备断开时注销 */
  unregister(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  /** 更新心跳 */
  heartbeat(deviceId: string): void {
    const entry = this.devices.get(deviceId);
    if (entry) entry.lastHeartbeat = Date.now();
  }

  /** 按传感器能力查找设备 */
  findByCapability(sensorType: string): DeviceEntry[] {
    return [...this.devices.values()].filter(e =>
      e.descriptor.capabilities.sensors.some(s => s.type === sensorType),
    );
  }

  /** 按设备类型查找 */
  findByType(deviceType: string): DeviceEntry[] {
    return [...this.devices.values()].filter(e =>
      e.descriptor.deviceType === deviceType,
    );
  }

  /** 获取设备能力描述 */
  getDescriptor(deviceId: string): DeviceCapabilityDescriptor | undefined {
    return this.devices.get(deviceId)?.descriptor;
  }

  /** 获取所有已注册设备 */
  listAll(): DeviceEntry[] {
    return [...this.devices.values()];
  }

  /**
   * 能力协商：根据设备描述符生成服务端策略
   *
   * 协商结果是建议性的（设备端可选择遵守或使用默认值）。
   * 返回 Partial<DeviceMultimodalPolicy>，调用方合并到 handshake ack 中下发。
   */
  negotiatePolicy(deviceId: string): Partial<DeviceMultimodalPolicy> {
    const entry = this.devices.get(deviceId);
    if (!entry) return {};

    const { descriptor } = entry;
    const policy: Partial<DeviceMultimodalPolicy> = {};

    // ── 根据设备传感器能力协商 videoStream 参数 ──────────────
    const camera = descriptor.capabilities.sensors.find(s => s.type === "camera");
    if (camera) {
      const edgeMs = descriptor.capabilities.compute.edgeInferenceMs ?? 100;
      // 端侧算力越强，帧间隔越小（帧率越高）
      const frameIntervalMs = edgeMs < 50 ? 200 : edgeMs < 100 ? 500 : 1000;
      policy.videoStream = {
        supported: true,
        frameIntervalMs,
        maxFrameWidth: 640,
        format: "jpeg",
      };
    }

    // ── 根据设备类型协商 VAD 策略 ─────────────────────────────
    const mic = descriptor.capabilities.sensors.find(s => s.type === "microphone");
    if (mic) {
      const profileMap: Record<string, "quiet" | "normal" | "noisy" | "auto"> = {
        vehicle: "noisy",
        glasses: "normal",
        robot: "auto",
        iot: "quiet",
        generic: "auto",
      };
      const sensitivityProfile = profileMap[descriptor.deviceType] ?? "auto";
      policy.vad = {
        enabled: true,
        sensitivityProfile,
        silenceThresholdMs: sensitivityProfile === "noisy" ? 800 : 500,
        adaptiveThreshold: sensitivityProfile === "auto",
      };
    }

    // ── 根据设备能力协商 allowedModalities ─────────────────────
    const modalities: ("image" | "audio" | "video")[] = [];
    if (mic) modalities.push("audio");
    if (camera) modalities.push("image", "video");
    if (modalities.length > 0) {
      policy.allowedModalities = modalities;
    }

    return policy;
  }
}

/** 单例导出 */
export const deviceCapabilityRegistry = new DeviceCapabilityRegistry();
