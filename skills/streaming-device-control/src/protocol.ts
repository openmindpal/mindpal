/**
 * 二进制协议定义
 * 
 * 用于减少序列化/反序列化延迟，支持高频低延迟通信
 * 
 * 消息格式：
 * ┌─────────┬──────────┬──────────┬──────────┬─────────┐
 * │ Magic   │ Version  │ Type     │ Length    │ Payload │
 * │ 2 bytes │ 1 byte   │ 1 byte   │ 4 bytes   │ N bytes │
 * └─────────┴──────────┴──────────┴──────────┴─────────┘
 */

// ────────────────────────────────────────────────────────────────
// 协议常量
// ────────────────────────────────────────────────────────────────

export const MAGIC_NUMBER = 0x4c5a; // "LZ" - LingZhi
export const PROTOCOL_VERSION = 0x01;

export enum MessageType {
  /** 传感器数据流 */
  SENSOR_DATA = 0x01,
  /** 控制指令 */
  CONTROL_COMMAND = 0x02,
  /** 心跳包 */
  HEARTBEAT = 0x03,
  /** 确认响应 */
  ACK = 0x04,
  /** 错误报告 */
  ERROR = 0x05,
  /** 设备状态 */
  DEVICE_STATUS = 0x06,
}

export enum SensorDataType {
  JOINT_ANGLES = 0x00,
  FORCE_SENSOR = 0x01,
  CAMERA_FRAME = 0x02,
  POSITION = 0x03,
  VELOCITY = 0x04,
  CUSTOM = 0xFF,
}

export enum CommandTypes {
  MOVE_TO = 0x00,
  ADJUST_GRIP = 0x01,
  SET_FORCE = 0x02,
  SET_VELOCITY = 0x03,
  EMERGENCY_STOP = 0x04,
  CUSTOM = 0xFF,
}

// ────────────────────────────────────────────────────────────────
// 编码函数
// ────────────────────────────────────────────────────────────────

export interface EncodedMessage {
  buffer: Buffer;
  messageType: MessageType;
}

/**
 * 编码传感器数据
 */
export function encodeSensorData(params: {
  deviceId: string;
  timestamp: number;
  dataType: SensorDataType;
  sequenceNumber: number;
  data: Float64Array | Uint8Array;
}): EncodedMessage {
  const deviceIdBytes = Buffer.from(params.deviceId.slice(0, 16).padEnd(16, '\0'), 'utf8');
  const dataBuffer = Buffer.from(params.data.buffer);
  
  // 计算总长度
  const payloadLength = 16 + // deviceId
                        8 +  // timestamp (int64)
                        1 +  // dataType
                        4 +  // sequenceNumber
                        dataBuffer.length;
  
  const header = Buffer.alloc(8);
  header.writeUInt16BE(MAGIC_NUMBER, 0);
  header.writeUInt8(PROTOCOL_VERSION, 2);
  header.writeUInt8(MessageType.SENSOR_DATA, 3);
  header.writeUInt32BE(payloadLength, 4);
  
  const payload = Buffer.alloc(payloadLength);
  deviceIdBytes.copy(payload, 0);
  payload.writeBigInt64BE(BigInt(params.timestamp), 16);
  payload.writeUInt8(params.dataType, 24);
  payload.writeUInt32BE(params.sequenceNumber, 25);
  dataBuffer.copy(payload, 29);
  
  return {
    buffer: Buffer.concat([header, payload]),
    messageType: MessageType.SENSOR_DATA,
  };
}

/**
 * 编码控制指令
 */
export function encodeControlCommand(params: {
  commandId: string;
  targetDeviceId: string;
  commandType: CommandTypes;
  params: Record<string, number>;
  runId?: string;
  stepId?: string;
}): EncodedMessage {
  const commandIdBytes = Buffer.from(params.commandId.slice(0, 16).padEnd(16, '\0'), 'utf8');
  const targetDeviceIdBytes = Buffer.from(params.targetDeviceId.slice(0, 16).padEnd(16, '\0'), 'utf8');
  
  // 参数字段（简化为固定数量的 float64）
  const paramKeys = Object.keys(params.params);
  const paramValues = Object.values(params.params);
  const paramsBuffer = Buffer.alloc(paramKeys.length * 8);
  for (let i = 0; i < paramValues.length; i++) {
    paramsBuffer.writeFloatLE(Number(paramValues[i]), i * 8);
  }
  
  const payloadLength = 16 + // commandId
                        16 + // targetDeviceId
                        1 +  // commandType
                        1 +  // paramCount
                        paramKeys.length + // paramKeys (单字节值)
                        paramValues.length * 8; // paramValues (float64)
  
  const header = Buffer.alloc(8);
  header.writeUInt16BE(MAGIC_NUMBER, 0);
  header.writeUInt8(PROTOCOL_VERSION, 2);
  header.writeUInt8(MessageType.CONTROL_COMMAND, 3);
  header.writeUInt32BE(payloadLength, 4);
  
  const payload = Buffer.alloc(payloadLength);
  commandIdBytes.copy(payload, 0);
  targetDeviceIdBytes.copy(payload, 16);
  payload.writeUInt8(params.commandType, 32);
  payload.writeUInt8(paramKeys.length, 33);
  
  let offset = 34;
  for (const key of paramKeys) {
    payload.writeUInt8(key.charCodeAt(0), offset++);
  }
  for (let i = 0; i < paramValues.length; i++) {
    payload.writeFloatLE(Number(paramValues[i]), offset);
    offset += 8;
  }
  
  return {
    buffer: Buffer.concat([header, payload]),
    messageType: MessageType.CONTROL_COMMAND,
  };
}

/**
 * 编码紧急停止命令（特殊优化：最小化延迟）
 */
export function encodeEmergencyStop(deviceId: string): EncodedMessage {
  const deviceIdBytes = Buffer.from(deviceId.slice(0, 16).padEnd(16, '\0'), 'utf8');
  
  const payloadLength = 16; // 仅 deviceId
  
  const header = Buffer.alloc(8);
  header.writeUInt16BE(MAGIC_NUMBER, 0);
  header.writeUInt8(PROTOCOL_VERSION, 2);
  header.writeUInt8(MessageType.CONTROL_COMMAND, 3);
  header.writeUInt32BE(payloadLength, 4);
  
  const payload = Buffer.alloc(payloadLength);
  deviceIdBytes.copy(payload, 0);
  
  return {
    buffer: Buffer.concat([header, payload]),
    messageType: MessageType.CONTROL_COMMAND,
  };
}

// ────────────────────────────────────────────────────────────────
// 解码函数
// ────────────────────────────────────────────────────────────────

export interface DecodedMessage<T = unknown> {
  messageType: MessageType;
  data: T | null;
  isValid: boolean;
  error?: string;
}

/**
 * 解码接收到的消息
 */
export function decodeMessage(buffer: Buffer): DecodedMessage {
  try {
    if (buffer.length < 8) {
      return { messageType: MessageType.ERROR, data: null, isValid: false, error: '消息太短' };
    }
    
    const magic = buffer.readUInt16BE(0);
    if (magic !== MAGIC_NUMBER) {
      return { messageType: MessageType.ERROR, data: null, isValid: false, error: 'Magic number 不匹配' };
    }
    
    const version = buffer.readUInt8(2);
    if (version !== PROTOCOL_VERSION) {
      return { messageType: MessageType.ERROR, data: null, isValid: false, error: `不支持的协议版本：${version}` };
    }
    
    const messageType = buffer.readUInt8(3);
    const payloadLength = buffer.readUInt32BE(4);
    
    if (buffer.length < 8 + payloadLength) {
      return { messageType: MessageType.ERROR, data: null, isValid: false, error: '消息不完整' };
    }
    
    const payload = buffer.slice(8, 8 + payloadLength);
    
    switch (messageType) {
      case MessageType.SENSOR_DATA:
        return decodeSensorData(payload);
      case MessageType.CONTROL_COMMAND:
        return decodeControlCommand(payload);
      case MessageType.HEARTBEAT:
        return { messageType, data: { timestamp: payload.readBigInt64BE(0) }, isValid: true };
      default:
        return { messageType: MessageType.ERROR, data: null, isValid: false, error: `未知的消息类型：${messageType}` };
    }
  } catch (err) {
    return { 
      messageType: MessageType.ERROR, 
      data: null, 
      isValid: false, 
      error: `解码失败：${err instanceof Error ? err.message : 'Unknown error'}`
    };
  }
}

function decodeSensorData(payload: Buffer): DecodedMessage<{
  deviceId: string;
  timestamp: number;
  dataType: SensorDataType;
  sequenceNumber: number;
  data: Float64Array;
}> {
  try {
    const deviceId = payload.slice(0, 16).toString('utf8').replace(/\0/g, '');
    const timestamp = Number(payload.readBigInt64BE(16));
    const dataType = payload.readUInt8(24);
    const sequenceNumber = payload.readUInt32BE(25);
    const data = new Float64Array(payload.slice(29).buffer);
    
    return {
      messageType: MessageType.SENSOR_DATA,
      data: { deviceId, timestamp, dataType, sequenceNumber, data },
      isValid: true,
    };
  } catch (err) {
    return { messageType: MessageType.ERROR, data: null, isValid: false, error: `解码传感器数据失败：${err}` };
  }
}

function decodeControlCommand(payload: Buffer): DecodedMessage<{
  commandId: string;
  targetDeviceId: string;
  commandType: CommandTypes;
  params: Record<string, number>;
}> {
  try {
    const commandId = payload.slice(0, 16).toString('utf8').replace(/\0/g, '');
    const targetDeviceId = payload.slice(16, 32).toString('utf8').replace(/\0/g, '');
    const commandType = payload.readUInt8(32);
    const paramCount = payload.readUInt8(33);
    
    const params: Record<string, number> = {};
    let offset = 34;
    
    for (let i = 0; i < paramCount; i++) {
      const key = String.fromCharCode(payload.readUInt8(offset++));
      const value = payload.readFloatLE(offset);
      offset += 8;
      params[key] = value;
    }
    
    return {
      messageType: MessageType.CONTROL_COMMAND,
      data: { commandId, targetDeviceId, commandType, params },
      isValid: true,
    };
  } catch (err) {
    return { messageType: MessageType.ERROR, data: null, isValid: false, error: `解码控制命令失败：${err}` };
  }
}

// ────────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────────

/**
 * 计算消息校验和（用于完整性验证）
 */
export function calculateChecksum(buffer: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum = (sum + buffer[i]) & 0xFFFFFFFF;
  }
  return sum;
}

/**
 * 验证消息完整性
 */
export function verifyMessageIntegrity(buffer: Buffer, expectedChecksum: number): boolean {
  const actualChecksum = calculateChecksum(buffer);
  return actualChecksum === expectedChecksum;
}
