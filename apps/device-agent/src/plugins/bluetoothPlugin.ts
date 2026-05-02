/**
 * Bluetooth 通信插件 — 处理 device.bluetooth.* 工具集
 *
 * 跨平台蓝牙探测与通信：
 *   Linux:   bluetoothctl
 *   macOS:   blueutil（回退 system_profiler）
 *   Windows: PowerShell Get-PnpDevice -Class Bluetooth
 *
 * @layer plugin
 */
import type { CapabilityDescriptor } from "@mindpal/device-agent-sdk";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "@mindpal/device-agent-sdk";
import { commandExists, runProcess, runPowerShell, runPowerShellJson } from "./pluginUtils";

// ── 类型定义 ──────────────────────────────────────────────────────

type BluetoothBackend = "bluetoothctl" | "blueutil" | "powershell" | null;

interface BluetoothDeviceInfo {
  address: string;
  name?: string;
  connected: boolean;
  paired: boolean;
  type: "classic" | "ble" | "unknown";
  rssi?: number;
}

// ── 内部状态 ──────────────────────────────────────────────────────

let backend: BluetoothBackend = null;
const connectedDevices: Map<string, BluetoothDeviceInfo> = new Map();

// ── MAC 地址校验 ─────────────────────────────────────────────────

const MAC_RE = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;

function isValidMac(addr: string): boolean {
  return MAC_RE.test(addr);
}

// ── 跨平台探测 ──────────────────────────────────────────────────

async function probeBackend(): Promise<BluetoothBackend> {
  const platform = process.platform;

  if (platform === "linux") {
    if (await commandExists("bluetoothctl")) return "bluetoothctl";
  } else if (platform === "darwin") {
    if (await commandExists("blueutil")) return "blueutil";
    // system_profiler 可列出蓝牙设备但无法控制连接，降级标记
    const sp = await runProcess("system_profiler", ["SPBluetoothDataType"]);
    if (sp.code === 0 && sp.stdout.includes("Bluetooth")) return "blueutil"; // 仅列出能力，连接操作将返回 unsupported
  } else if (platform === "win32") {
    try {
      const r = await runPowerShell("Get-PnpDevice -Class Bluetooth -ErrorAction Stop | Select-Object -First 1 | ConvertTo-Json -Compress");
      if (r) return "powershell";
    } catch { /* 无蓝牙硬件 */ }
  }
  return null;
}

// ── 输出解析工具 ────────────────────────────────────────────────

function parseBluetoothctlDevices(stdout: string): BluetoothDeviceInfo[] {
  const devices: BluetoothDeviceInfo[] = [];
  // 格式: Device XX:XX:XX:XX:XX:XX DeviceName
  for (const line of stdout.split("\n")) {
    const m = line.match(/Device\s+([0-9A-Fa-f:]{17})\s+(.*)/);
    if (m) {
      devices.push({
        address: m[1],
        name: m[2].trim() || undefined,
        connected: false,
        paired: false,
        type: "unknown",
      });
    }
  }
  return devices;
}

function parseBlueutilDevices(stdout: string): BluetoothDeviceInfo[] {
  const devices: BluetoothDeviceInfo[] = [];
  try {
    const raw = JSON.parse(stdout);
    const items: any[] = Array.isArray(raw) ? raw : [raw];
    for (const d of items) {
      if (!d?.address) continue;
      devices.push({
        address: String(d.address),
        name: d.name ? String(d.name) : undefined,
        connected: d.connected === 1 || d.connected === true,
        paired: d.paired === 1 || d.paired === true,
        type: "unknown",
      });
    }
  } catch {
    // blueutil 文本格式回退
    for (const line of stdout.split("\n")) {
      const m = line.match(/address:\s*([0-9A-Fa-f:.-]{17})/i);
      if (m) {
        devices.push({
          address: m[1].replaceAll("-", ":"),
          name: line.match(/name:\s*"?([^",]+)/i)?.[1]?.trim(),
          connected: /connected:\s*1/i.test(line),
          paired: /paired:\s*1/i.test(line),
          type: "unknown",
        });
      }
    }
  }
  return devices;
}

function parsePowershellDevices(raw: any): BluetoothDeviceInfo[] {
  const devices: BluetoothDeviceInfo[] = [];
  const items: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const d of items) {
    const instanceId = String(d.InstanceId ?? d.DeviceID ?? "");
    const macMatch = instanceId.match(/([0-9A-Fa-f]{2}[_:\-]){5}[0-9A-Fa-f]{2}/);
    const address = macMatch ? macMatch[0].replaceAll("_", ":").replaceAll("-", ":") : instanceId;
    devices.push({
      address,
      name: d.FriendlyName ? String(d.FriendlyName) : d.Name ? String(d.Name) : undefined,
      connected: String(d.Status ?? "").toLowerCase() === "ok",
      paired: true, // PnpDevice 列出的都是已配对
      type: "unknown",
    });
  }
  return devices;
}

// ── device.bluetooth.scan ───────────────────────────────────────

async function execScan(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!backend) {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_bluetooth_backend" } };
  }

  const durationSec: number = Math.max(1, Math.min(60, Number(ctx.input.durationSec ?? 10)));
  let devices: BluetoothDeviceInfo[] = [];

  try {
    if (backend === "bluetoothctl") {
      // 启动扫描
      await runProcess("bluetoothctl", ["--timeout", String(durationSec), "scan", "on"]);
      const r = await runProcess("bluetoothctl", ["devices"]);
      if (r.code === 0) devices = parseBluetoothctlDevices(r.stdout);
    } else if (backend === "blueutil") {
      const r = await runProcess("blueutil", ["--inquiry", String(durationSec)]);
      if (r.code === 0) devices = parseBlueutilDevices(r.stdout);
    } else if (backend === "powershell") {
      const raw = await runPowerShellJson<any>(
        "Get-PnpDevice -Class Bluetooth -PresentOnly | Select-Object FriendlyName, InstanceId, Status | ConvertTo-Json -Compress",
      );
      devices = parsePowershellDevices(raw);
    }

    return { status: "succeeded", outputDigest: { devices } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "scan_failed", message: err?.message?.slice(0, 300) } };
  }
}

// ── device.bluetooth.connect ────────────────────────────────────

async function execConnect(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!backend) {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_bluetooth_backend" } };
  }
  const address = String(ctx.input.address ?? "");
  if (!isValidMac(address)) {
    return { status: "failed", errorCategory: "invalid_input", outputDigest: { reason: "invalid_mac_address", address } };
  }

  try {
    let name: string | undefined;

    if (backend === "bluetoothctl") {
      const r = await runProcess("bluetoothctl", ["connect", address]);
      if (r.code !== 0 && !r.stdout.includes("successful")) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "connect_failed", stderr: r.stderr.slice(0, 300) } };
      }
      const nameMatch = r.stdout.match(/Name:\s*(.+)/);
      name = nameMatch?.[1]?.trim();
    } else if (backend === "blueutil") {
      const r = await runProcess("blueutil", ["--connect", address]);
      if (r.code !== 0) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "connect_failed", stderr: r.stderr.slice(0, 300) } };
      }
    } else if (backend === "powershell") {
      // Windows 蓝牙配对/连接通常需通过系统 UI，此处尝试 DeviceAssociationService
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "windows_connect_requires_system_ui" } };
    }

    const info: BluetoothDeviceInfo = { address, name, connected: true, paired: true, type: "unknown" };
    connectedDevices.set(address, info);

    return { status: "succeeded", outputDigest: { connected: true, address, name } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "connect_exception", message: err?.message?.slice(0, 300) } };
  }
}

// ── device.bluetooth.disconnect ─────────────────────────────────

async function execDisconnect(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!backend) {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_bluetooth_backend" } };
  }
  const address = String(ctx.input.address ?? "");
  if (!isValidMac(address)) {
    return { status: "failed", errorCategory: "invalid_input", outputDigest: { reason: "invalid_mac_address", address } };
  }

  try {
    if (backend === "bluetoothctl") {
      const r = await runProcess("bluetoothctl", ["disconnect", address]);
      if (r.code !== 0 && !r.stdout.includes("successful")) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "disconnect_failed", stderr: r.stderr.slice(0, 300) } };
      }
    } else if (backend === "blueutil") {
      const r = await runProcess("blueutil", ["--disconnect", address]);
      if (r.code !== 0) {
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "disconnect_failed", stderr: r.stderr.slice(0, 300) } };
      }
    } else if (backend === "powershell") {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "windows_disconnect_requires_system_ui" } };
    }

    connectedDevices.delete(address);
    return { status: "succeeded", outputDigest: { disconnected: true, address } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "disconnect_exception", message: err?.message?.slice(0, 300) } };
  }
}

// ── device.bluetooth.send ───────────────────────────────────────

async function execSend(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!backend) {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_bluetooth_backend" } };
  }
  const address = String(ctx.input.address ?? "");
  if (!isValidMac(address)) {
    return { status: "failed", errorCategory: "invalid_input", outputDigest: { reason: "invalid_mac_address", address } };
  }
  const data = String(ctx.input.data ?? "");
  const encoding: string = String(ctx.input.encoding ?? "utf8");

  if (!data) {
    return { status: "failed", errorCategory: "invalid_input", outputDigest: { reason: "empty_data" } };
  }

  let payload: Buffer;
  try {
    if (encoding === "base64") {
      payload = Buffer.from(data, "base64");
    } else if (encoding === "hex") {
      payload = Buffer.from(data, "hex");
    } else {
      payload = Buffer.from(data, "utf8");
    }
  } catch {
    return { status: "failed", errorCategory: "invalid_input", outputDigest: { reason: "encoding_error", encoding } };
  }

  try {
    if (backend === "bluetoothctl") {
      // BLE: gatttool char-write-req；经典蓝牙: rfcomm 通道
      // 优先尝试 rfcomm (经典蓝牙)
      const hexData = payload.toString("hex");
      if (await commandExists("gatttool")) {
        const r = await runProcess("gatttool", ["-b", address, "--char-write-req", "-a", "0x0001", "-n", hexData]);
        if (r.code !== 0) {
          return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "gatttool_send_failed", stderr: r.stderr.slice(0, 300) } };
        }
      } else {
        // 回退: 通过 bluetoothctl 的 GATT menu
        return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_send_backend_available", hint: "install gatttool or rfcomm" } };
      }
    } else if (backend === "blueutil") {
      // macOS 不支持通用蓝牙数据发送 CLI
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "macos_send_not_supported" } };
    } else if (backend === "powershell") {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "windows_send_not_supported" } };
    }

    return { status: "succeeded", outputDigest: { sent: true, bytes: payload.length } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "send_exception", message: err?.message?.slice(0, 300) } };
  }
}

// ── device.bluetooth.read ───────────────────────────────────────

async function execRead(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!backend) {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_bluetooth_backend" } };
  }
  const address = String(ctx.input.address ?? "");
  if (!isValidMac(address)) {
    return { status: "failed", errorCategory: "invalid_input", outputDigest: { reason: "invalid_mac_address", address } };
  }
  const _timeoutMs: number = Math.max(1000, Number(ctx.input.timeoutMs ?? 5000));

  try {
    if (backend === "bluetoothctl") {
      if (await commandExists("gatttool")) {
        const r = await runProcess("gatttool", ["-b", address, "--char-read", "-a", "0x0001"]);
        if (r.code === 0) {
          // gatttool 输出: Characteristic value/descriptor: xx xx xx
          const hexMatch = r.stdout.match(/:\s*([0-9a-fA-F\s]+)$/m);
          if (hexMatch) {
            const hexStr = hexMatch[1].trim().replaceAll(" ", "");
            const buf = Buffer.from(hexStr, "hex");
            return {
              status: "succeeded",
              outputDigest: { data: buf.toString("base64"), encoding: "base64", bytes: buf.length },
            };
          }
        }
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "gatttool_read_failed", stderr: r.stderr.slice(0, 300) } };
      }
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_read_backend_available", hint: "install gatttool" } };
    } else if (backend === "blueutil") {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "macos_read_not_supported" } };
    } else if (backend === "powershell") {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "windows_read_not_supported" } };
    }

    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "unknown_backend" } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "read_exception", message: err?.message?.slice(0, 300) } };
  }
}

// ── device.bluetooth.devices ────────────────────────────────────

async function execDevices(_ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!backend) {
    return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "no_bluetooth_backend" } };
  }

  try {
    let paired: BluetoothDeviceInfo[] = [];
    const connected: BluetoothDeviceInfo[] = Array.from(connectedDevices.values());

    if (backend === "bluetoothctl") {
      const r = await runProcess("bluetoothctl", ["paired-devices"]);
      if (r.code === 0) {
        paired = parseBluetoothctlDevices(r.stdout);
      }
      // 检查每个已配对设备的连接状态
      for (const dev of paired) {
        const info = await runProcess("bluetoothctl", ["info", dev.address]);
        if (info.code === 0) {
          dev.connected = /Connected:\s*yes/i.test(info.stdout);
          dev.paired = true;
          const typeMatch = info.stdout.match(/Icon:\s*(\S+)/);
          if (typeMatch) {
            dev.type = typeMatch[1].includes("phone") || typeMatch[1].includes("computer") ? "classic" : "unknown";
          }
          if (dev.connected) connectedDevices.set(dev.address, dev);
        }
      }
    } else if (backend === "blueutil") {
      const r = await runProcess("blueutil", ["--paired", "--format", "json"]);
      if (r.code === 0) {
        paired = parseBlueutilDevices(r.stdout);
      }
    } else if (backend === "powershell") {
      const raw = await runPowerShellJson<any>(
        "Get-PnpDevice -Class Bluetooth -PresentOnly | Select-Object FriendlyName, InstanceId, Status | ConvertTo-Json -Compress",
      );
      paired = parsePowershellDevices(raw);
    }

    return { status: "succeeded", outputDigest: { paired, connected } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "devices_list_failed", message: err?.message?.slice(0, 300) } };
  }
}

// ── 路由表 ──────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.bluetooth.scan": execScan,
  "device.bluetooth.connect": execConnect,
  "device.bluetooth.disconnect": execDisconnect,
  "device.bluetooth.send": execSend,
  "device.bluetooth.read": execRead,
  "device.bluetooth.devices": execDevices,
};

// ── 能力声明 ──────────────────────────────────────────────────────

const BT_CAPABILITIES: CapabilityDescriptor[] = [
  { toolRef: "device.bluetooth.scan", riskLevel: "low", description: "扫描附近蓝牙设备" },
  { toolRef: "device.bluetooth.connect", riskLevel: "medium", description: "连接蓝牙设备" },
  { toolRef: "device.bluetooth.disconnect", riskLevel: "low", description: "断开蓝牙连接" },
  { toolRef: "device.bluetooth.send", riskLevel: "medium", description: "向蓝牙设备发送数据" },
  { toolRef: "device.bluetooth.read", riskLevel: "low", description: "从蓝牙设备读取数据" },
  { toolRef: "device.bluetooth.devices", riskLevel: "low", description: "列出已配对/已连接设备" },
];

// ── 导出插件实例 ──────────────────────────────────────────────────

const bluetoothPlugin: DeviceToolPlugin = {
  name: "bluetooth",
  version: "1.0.0",
  source: "builtin",
  toolPrefixes: ["device.bluetooth.*"],
  toolNames: [
    "device.bluetooth.scan",
    "device.bluetooth.connect",
    "device.bluetooth.disconnect",
    "device.bluetooth.send",
    "device.bluetooth.read",
    "device.bluetooth.devices",
  ],
  capabilities: BT_CAPABILITIES,
  resourceLimits: { maxMemoryMb: 20, maxCpuPercent: 10 },
  deviceTypeResourceProfiles: {
    iot: { maxMemoryMb: 15, maxCpuPercent: 8 },
    robot: { maxMemoryMb: 15, maxCpuPercent: 8 },
    vehicle: { maxMemoryMb: 15, maxCpuPercent: 8 },
    home: { maxMemoryMb: 15, maxCpuPercent: 8 },
  },

  async init(): Promise<void> {
    console.warn("[bluetooth] probing bluetooth backend...");
    backend = await probeBackend();
    console.warn(`[bluetooth] backend=${backend ?? "none"}`);
  },

  async healthcheck(): Promise<{ healthy: boolean; details: Record<string, unknown> }> {
    return {
      healthy: backend !== null,
      details: { backend: backend ?? "none", connectedCount: connectedDevices.size },
    };
  },

  async execute(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) {
      return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "bluetooth" } };
    }
    return handler(ctx);
  },

  async dispose(): Promise<void> {
    console.warn("[bluetooth] disconnecting all devices...");
    for (const [address] of connectedDevices) {
      try {
        if (backend === "bluetoothctl") {
          await runProcess("bluetoothctl", ["disconnect", address]);
        } else if (backend === "blueutil") {
          await runProcess("blueutil", ["--disconnect", address]);
        }
      } catch (err: any) {
        console.error(`[bluetooth] dispose disconnect error (${address}): ${err?.message}`);
      }
    }
    connectedDevices.clear();
    console.warn("[bluetooth] disposed");
  },
};

export default bluetoothPlugin;
