/**
 * Sensor Bridge — 传感器 HAL 桥接插件
 *
 * Provider 模式抽象硬件访问层，内置 SerialProvider / HttpProvider。
 * 支持动态注册自定义 Provider（通过 sensor.provider.register 消息）。
 *
 * 工具：device.sensor.read / write / list / configure
 *
 * @layer plugin
 */
import childProcess from "node:child_process";
import http from "node:http";
import type {
  DeviceToolPlugin,
  ToolExecutionContext,
  ToolExecutionResult,
  CapabilityDescriptor,
  DeviceMessageContext,
} from "../kernel/types";

// ── 公共接口 ─────────────────────────────────────────────────────

export interface SensorProvider {
  protocol: string; // "serial" | "http" | "mqtt" | "gpio" | "can" | "custom"
  discover(): Promise<SensorChannel[]>;
  read(channelId: string): Promise<SensorReading>;
  write?(channelId: string, command: unknown): Promise<void>;
  configure?(channelId: string, params: Record<string, unknown>): Promise<void>;
  dispose?(): Promise<void>;
}

export interface SensorChannel {
  channelId: string; // "serial:/dev/ttyUSB0/temp" | "http:192.168.1.100:8080/sensor"
  name: string;
  unit?: string;
  dataType: "number" | "boolean" | "json" | "binary";
  provider: string;
  metadata?: Record<string, unknown>;
}

export interface SensorReading {
  channelId: string;
  value: unknown;
  timestamp: number;
  unit?: string;
}

// ── 内部状态 ─────────────────────────────────────────────────────

const providers: Map<string, SensorProvider> = new Map();
const channels: Map<string, SensorChannel> = new Map();

// ── 工具函数 ─────────────────────────────────────────────────────

function spawnAsync(
  cmd: string,
  args: string[],
  opts?: { stdin?: string; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = childProcess.spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: opts?.timeoutMs ?? 10_000,
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    p.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    if (opts?.stdin) { p.stdin.write(opts.stdin); p.stdin.end(); } else { p.stdin.end(); }
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function httpRequest(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: 10_000,
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("http_timeout")); });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function findProviderForChannel(channelId: string): SensorProvider | null {
  const ch = channels.get(channelId);
  if (!ch) return null;
  return providers.get(ch.provider) ?? null;
}

// ── SerialProvider ───────────────────────────────────────────────

function createSerialProvider(): SensorProvider {
  return {
    protocol: "serial",

    async discover(): Promise<SensorChannel[]> {
      const found: SensorChannel[] = [];
      try {
        if (process.platform === "linux") {
          const r = await spawnAsync("sh", ["-c", "ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null"]);
          if (r.code === 0) {
            for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
              found.push({
                channelId: `serial:${line}`,
                name: line.split("/").pop() ?? line,
                dataType: "json",
                provider: "serial",
                metadata: { path: line },
              });
            }
          }
        } else if (process.platform === "win32") {
          const script = "Get-CimInstance Win32_SerialPort | Select-Object -Property Name, DeviceID | ConvertTo-Json -Compress";
          const r = await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
          if (r.code === 0 && r.stdout.trim()) {
            try {
              const raw = JSON.parse(r.stdout.trim());
              const ports = Array.isArray(raw) ? raw : [raw];
              for (const p of ports) {
                if (!p?.DeviceID) continue;
                found.push({
                  channelId: `serial:${p.DeviceID}`,
                  name: String(p.Name ?? p.DeviceID),
                  dataType: "json",
                  provider: "serial",
                  metadata: { deviceId: p.DeviceID, name: p.Name },
                });
              }
            } catch { /* ignore parse error */ }
          }
        } else if (process.platform === "darwin") {
          const r = await spawnAsync("sh", ["-c", "ls /dev/tty.usb* 2>/dev/null"]);
          if (r.code === 0) {
            for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
              found.push({
                channelId: `serial:${line}`,
                name: line.split("/").pop() ?? line,
                dataType: "json",
                provider: "serial",
                metadata: { path: line },
              });
            }
          }
        }
      } catch (e: any) {
        console.warn(`[sensorBridge] serial discover error: ${e?.message ?? "unknown"}`);
      }
      return found;
    },

    async read(channelId: string): Promise<SensorReading> {
      const ch = channels.get(channelId);
      const devPath = (ch?.metadata?.path as string) ?? (ch?.metadata?.deviceId as string) ?? channelId.replace("serial:", "");

      let value: unknown = null;
      try {
        if (process.platform === "win32") {
          const script = [
            `$port = New-Object System.IO.Ports.SerialPort '${devPath}',9600,'None',8,'One'`,
            "$port.ReadTimeout = 3000",
            "$port.Open()",
            "$line = $port.ReadLine()",
            "$port.Close()",
            "Write-Output $line",
          ].join("; ");
          const r = await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs: 8000 });
          value = r.stdout.trim();
        } else {
          // Linux/macOS: configure with stty then read
          await spawnAsync("stty", ["-F", devPath, "9600", "cs8", "-cstopb", "-parenb"], { timeoutMs: 3000 }).catch(() => {});
          const r = await spawnAsync("sh", ["-c", `head -n 1 < '${devPath}'`], { timeoutMs: 5000 });
          value = r.stdout.trim();
        }
      } catch (e: any) {
        console.warn(`[sensorBridge] serial read error (${channelId}): ${e?.message}`);
      }

      return { channelId, value, timestamp: Date.now(), unit: ch?.unit };
    },

    async write(channelId: string, command: unknown): Promise<void> {
      const ch = channels.get(channelId);
      const devPath = (ch?.metadata?.path as string) ?? (ch?.metadata?.deviceId as string) ?? channelId.replace("serial:", "");
      const data = typeof command === "string" ? command : JSON.stringify(command);

      if (process.platform === "win32") {
        const script = [
          `$port = New-Object System.IO.Ports.SerialPort '${devPath}',9600,'None',8,'One'`,
          "$port.Open()",
          `$port.Write('${data.replaceAll("'", "''")}')`,
          "$port.Close()",
        ].join("; ");
        await spawnAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs: 5000 });
      } else {
        await spawnAsync("sh", ["-c", `echo '${data}' > '${devPath}'`], { timeoutMs: 3000 });
      }
    },
  };
}

// ── HttpProvider ─────────────────────────────────────────────────

/** HTTP 端点配置（通过 configure 或初始化时注入） */
const httpEndpoints: Map<string, { url: string; name?: string; unit?: string; dataType?: SensorChannel["dataType"] }> = new Map();

function createHttpProvider(): SensorProvider {
  return {
    protocol: "http",

    async discover(): Promise<SensorChannel[]> {
      const found: SensorChannel[] = [];
      for (const [id, ep] of httpEndpoints) {
        found.push({
          channelId: `http:${id}`,
          name: ep.name ?? id,
          unit: ep.unit,
          dataType: ep.dataType ?? "json",
          provider: "http",
          metadata: { url: ep.url },
        });
      }
      return found;
    },

    async read(channelId: string): Promise<SensorReading> {
      const ch = channels.get(channelId);
      const url = (ch?.metadata?.url as string) ?? "";
      if (!url) {
        return { channelId, value: null, timestamp: Date.now() };
      }
      try {
        const res = await httpRequest("GET", url);
        let value: unknown = res.data;
        try { value = JSON.parse(res.data); } catch { /* raw string */ }
        return { channelId, value, timestamp: Date.now(), unit: ch?.unit };
      } catch (e: any) {
        console.warn(`[sensorBridge] http read error (${channelId}): ${e?.message}`);
        return { channelId, value: null, timestamp: Date.now(), unit: ch?.unit };
      }
    },

    async write(channelId: string, command: unknown): Promise<void> {
      const ch = channels.get(channelId);
      const url = (ch?.metadata?.url as string) ?? "";
      if (!url) throw new Error(`http_no_endpoint: ${channelId}`);
      await httpRequest("POST", url, command);
    },

    async configure(channelId: string, params: Record<string, unknown>): Promise<void> {
      const ch = channels.get(channelId);
      const url = (ch?.metadata?.url as string) ?? "";
      if (!url) throw new Error(`http_no_endpoint: ${channelId}`);
      await httpRequest("PUT", url, params);
    },
  };
}

// ── 能力声明 ─────────────────────────────────────────────────────

const SENSOR_CAPABILITIES: CapabilityDescriptor[] = [
  { toolRef: "device.sensor.read", riskLevel: "low", description: "读取传感器数据" },
  { toolRef: "device.sensor.write", riskLevel: "high", description: "向执行器发送指令" },
  { toolRef: "device.sensor.list", riskLevel: "low", description: "列出已注册传感器通道" },
  { toolRef: "device.sensor.configure", riskLevel: "medium", description: "配置传感器参数" },
];

// ── 生命周期 ─────────────────────────────────────────────────────

async function refreshChannels(): Promise<void> {
  channels.clear();
  for (const [, prov] of providers) {
    try {
      const discovered = await prov.discover();
      for (const ch of discovered) channels.set(ch.channelId, ch);
    } catch (e: any) {
      console.warn(`[sensorBridge] discover error (${prov.protocol}): ${e?.message}`);
    }
  }
}

async function init(): Promise<void> {
  // 1. 串口探测
  const serial = createSerialProvider();
  try {
    const serialChannels = await serial.discover();
    if (serialChannels.length > 0) {
      providers.set("serial", serial);
      console.warn(`[sensorBridge] serial provider registered (${serialChannels.length} channels)`);
    }
  } catch { /* serial not available, skip */ }

  // 2. HTTP provider（始终注册）
  providers.set("http", createHttpProvider());

  // 3. 刷新通道缓存
  await refreshChannels();
  console.warn(`[sensorBridge] init complete: ${providers.size} providers, ${channels.size} channels`);
}

async function healthcheck(): Promise<{ healthy: boolean; details?: Record<string, unknown> }> {
  return {
    healthy: true,
    details: {
      providerCount: providers.size,
      channelCount: channels.size,
      providers: Array.from(providers.keys()),
    },
  };
}

// ── execute 路由 ─────────────────────────────────────────────────

async function execute(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const { toolName, input } = ctx;

  try {
    switch (toolName) {
      case "device.sensor.read": {
        const channelId = input.channelId as string | undefined;
        if (!channelId) return { status: "failed", errorCategory: "invalid_input", outputDigest: { error: "channelId required" } };
        const prov = findProviderForChannel(channelId);
        if (!prov) return { status: "failed", errorCategory: "channel_not_found", outputDigest: { channelId } };
        const reading = await prov.read(channelId);
        return { status: "succeeded", outputDigest: reading };
      }

      case "device.sensor.write": {
        const channelId = input.channelId as string | undefined;
        const command = input.command;
        if (!channelId) return { status: "failed", errorCategory: "invalid_input", outputDigest: { error: "channelId required" } };
        const prov = findProviderForChannel(channelId);
        if (!prov) return { status: "failed", errorCategory: "channel_not_found", outputDigest: { channelId } };
        if (!prov.write) return { status: "failed", errorCategory: "write_not_supported", outputDigest: { channelId, provider: prov.protocol } };
        await prov.write(channelId, command);
        return { status: "succeeded", outputDigest: { sent: true, channelId } };
      }

      case "device.sensor.list": {
        return {
          status: "succeeded",
          outputDigest: {
            channels: Array.from(channels.values()),
            providers: Array.from(providers.keys()),
          },
        };
      }

      case "device.sensor.configure": {
        const channelId = input.channelId as string | undefined;
        const params = (input.params ?? {}) as Record<string, unknown>;
        if (!channelId) return { status: "failed", errorCategory: "invalid_input", outputDigest: { error: "channelId required" } };
        const prov = findProviderForChannel(channelId);
        if (!prov) return { status: "failed", errorCategory: "channel_not_found", outputDigest: { channelId } };
        if (!prov.configure) return { status: "failed", errorCategory: "configure_not_supported", outputDigest: { channelId, provider: prov.protocol } };
        await prov.configure(channelId, params);
        return { status: "succeeded", outputDigest: { configured: true, channelId } };
      }

      default:
        return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName } };
    }
  } catch (e: any) {
    console.error(`[sensorBridge] execute error (${toolName}): ${e?.message}`);
    return { status: "failed", errorCategory: "execution_error", outputDigest: { toolName, error: e?.message } };
  }
}

// ── onMessage — 动态 Provider 注册 ──────────────────────────────

async function onMessage(ctx: DeviceMessageContext): Promise<void> {
  if (ctx.topic !== "sensor.provider.register") return;

  const { protocol, endpoints, channels: chDefs } = ctx.payload as {
    protocol?: string;
    endpoints?: Array<{ id: string; url: string; name?: string; unit?: string; dataType?: SensorChannel["dataType"] }>;
    channels?: SensorChannel[];
  };

  if (protocol === "http" && Array.isArray(endpoints)) {
    for (const ep of endpoints) {
      if (ep.id && ep.url) httpEndpoints.set(ep.id, ep);
    }
    // 刷新 http channels
    const httpProv = providers.get("http");
    if (httpProv) {
      const discovered = await httpProv.discover();
      for (const ch of discovered) channels.set(ch.channelId, ch);
    }
    console.warn(`[sensorBridge] http endpoints registered via message: ${endpoints.length}`);
    return;
  }

  // 通用自定义 Provider 通道注册
  if (Array.isArray(chDefs)) {
    for (const ch of chDefs) {
      if (ch.channelId) channels.set(ch.channelId, ch);
    }
    console.warn(`[sensorBridge] custom channels registered via message: ${chDefs.length}`);
  }
}

// ── dispose ──────────────────────────────────────────────────────

async function dispose(): Promise<void> {
  for (const [name, prov] of providers) {
    try {
      if (prov.dispose) await prov.dispose();
    } catch (e: any) {
      console.error(`[sensorBridge] dispose error (${name}): ${e?.message}`);
    }
  }
  providers.clear();
  channels.clear();
  httpEndpoints.clear();
}

// ── 插件导出 ─────────────────────────────────────────────────────

const sensorBridgePlugin: DeviceToolPlugin = {
  name: "sensorBridge",
  version: "1.0.0",
  source: "builtin",
  toolPrefixes: ["device.sensor.*"],
  toolNames: [
    "device.sensor.read",
    "device.sensor.write",
    "device.sensor.list",
    "device.sensor.configure",
  ],
  capabilities: SENSOR_CAPABILITIES,
  resourceLimits: { maxMemoryMb: 30, maxCpuPercent: 10 },
  deviceTypeResourceProfiles: {
    iot: { maxMemoryMb: 15, maxCpuPercent: 8 },
    robot: { maxMemoryMb: 15, maxCpuPercent: 8 },
    vehicle: { maxMemoryMb: 15, maxCpuPercent: 8 },
    home: { maxMemoryMb: 15, maxCpuPercent: 8 },
    gateway: { maxMemoryMb: 15, maxCpuPercent: 8 },
  },
  messageTopics: ["sensor.provider.register"],
  init,
  healthcheck,
  execute,
  onMessage,
  dispose,
};

export default sensorBridgePlugin;
