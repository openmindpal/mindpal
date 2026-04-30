/**
 * 统一设备协议类型定义 — OS级设备抽象层
 *
 * 设计原则：
 * - 零外部依赖，纯类型定义
 * - 元数据驱动：设备能力通过描述符声明，非硬编码枚举
 * - 与现有 DeviceMultimodalCapabilities / DeviceStreamEvent 兼容
 */

/* ================================================================== */
/*  设备能力描述符 — OS级设备抽象                                        */
/* ================================================================== */

/** 传感器能力声明 */
export interface SensorCapability {
  /** 传感器类型（"camera" | "microphone" | "lidar" | "beidou" | "gps" | "imu" | 自定义） */
  type: string;
  /** 唯一标识 */
  id: string;
  /** 元数据驱动参数（分辨率/采样率/精度等） */
  config: Record<string, unknown>;
}

/** 执行器能力声明 */
export interface ActuatorCapability {
  /** 执行器类型（"motor" | "speaker" | "display" | "gripper" | 自定义） */
  type: string;
  /** 唯一标识 */
  id: string;
  /** 元数据驱动参数 */
  config: Record<string, unknown>;
}

/** 设备能力描述符 — 设备连接时上报 */
export interface DeviceCapabilityDescriptor {
  /** 设备类型 */
  deviceType: "robot" | "vehicle" | "glasses" | "iot" | "generic";
  /** 能力声明 */
  capabilities: {
    sensors: SensorCapability[];
    actuators: ActuatorCapability[];
    compute: { edgeInferenceMs?: number };
  };
  /** 支持的命令协议版本，如 ["v1", "v1.1"] */
  protocols: string[];
}

/* ================================================================== */
/*  统一设备命令协议                                                     */
/* ================================================================== */

/** 云端→设备 命令 */
export interface DeviceCommand {
  /** 命令唯一标识 */
  commandId: string;
  /** 目标设备 ID */
  targetDeviceId: string;
  /** 动作名称（由设备能力元数据决定可用 action，非硬编码枚举） */
  action: string;
  /** 命令参数 */
  params: Record<string, unknown>;
  /** 优先级 */
  priority: "normal" | "high" | "emergency";
  /** 命令超时（毫秒） */
  ttlMs?: number;
}

/** 设备→云端 命令确认 */
export interface DeviceCommandAck {
  /** 对应的命令 ID */
  commandId: string;
  /** 确认状态 */
  status: "accepted" | "rejected" | "completed" | "failed";
  /** 执行结果 */
  result?: Record<string, unknown>;
  /** 端到端延迟（毫秒） */
  latencyMs: number;
}

/* ================================================================== */
/*  视频流 WebSocket 消息协议                                            */
/* ================================================================== */

/** 客户端→服务端 视频流消息 */
export interface VideoStreamClientMessage {
  /** 消息类型 */
  type: "video_frame" | "config" | "finish";
  /** base64 JPEG 帧数据 */
  data?: string;
  /** 帧时间戳（毫秒） */
  timestamp?: number;
  /** 流配置（type="config" 时使用） */
  config?: {
    /** 帧率 */
    frameRate?: number;
    /** 分辨率，如 "640x480" */
    resolution?: string;
    /** JPEG 质量 0-1 */
    quality?: number;
  };
}

/** 服务端→客户端 视频流消息 */
export interface VideoStreamServerMessage {
  /** 消息类型 */
  type: "ack" | "analysis" | "error";
  /** 帧序号 */
  frameId?: number;
  /** 分析结果（type="analysis" 时） */
  analysis?: {
    description?: string;
    objects?: unknown[];
    emotion?: string;
  };
  /** 错误信息（type="error" 时） */
  error?: string;
}
