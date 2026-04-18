/**
 * Skill: desktop-automation
 *
 * 提供桌面自动化能力，支持：
 * - 应用启动与窗口管理
 * - 鼠标点击、移动、拖拽
 * - 键盘输入与快捷键
 * - 屏幕截图与 OCR
 * - 剪贴板操作
 *
 * 作为扩展层 Skill，通过 device-agent bridge 执行，
 * 必须支持纯设备端部署，不依赖中心服务。
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { desktopAutomationRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "desktop.automation", version: "1.0.0" },
    layer: "extension",
    routes: ["/desktop-automation"],
    frontend: ["/gov/desktop-automation"],
    dependencies: ["schemas", "audit", "rbac"],
    skillDependencies: ["device.runtime"],
    tools: [
      {
        name: "desktop.launch",
        displayName: { "zh-CN": "启动应用", "en-US": "Launch application" },
        description: {
          "zh-CN": "启动指定的桌面应用程序",
          "en-US": "Launch specified desktop application",
        },
        scope: "write",
        resourceType: "desktop",
        action: "launch",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            appPath: { type: "string", required: true, description: "应用程序路径或名称" },
            args: { type: "array", items: { type: "string" }, description: "启动参数" },
            workDir: { type: "string", description: "工作目录" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            app: { type: "string" },
            launched: { type: "boolean" },
            pid: { type: "number" },
            windowId: { type: "string" },
          },
        },
      },
      {
        name: "desktop.window.list",
        displayName: { "zh-CN": "列出窗口", "en-US": "List windows" },
        description: {
          "zh-CN": "列出当前打开的所有窗口，支持 Windows、macOS、Linux 桌面会话",
          "en-US": "List all currently open windows across Windows, macOS, and Linux desktop sessions",
        },
        scope: "read",
        resourceType: "desktop",
        action: "window.list",
        riskLevel: "low",
        inputSchema: {
          fields: {
            filter: { type: "string", description: "按窗口标题过滤" },
          },
        },
        outputSchema: {
          fields: {
            windows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  appName: { type: "string" },
                  bounds: { type: "object" },
                },
              },
            },
          },
        },
      },
      {
        name: "desktop.window.focus",
        displayName: { "zh-CN": "聚焦窗口", "en-US": "Focus window" },
        description: {
          "zh-CN": "将指定窗口带到前台并获得焦点，支持 Windows、macOS、Linux 桌面会话",
          "en-US": "Bring the specified window to foreground and focus across Windows, macOS, and Linux desktop sessions",
        },
        scope: "write",
        resourceType: "desktop",
        action: "window.focus",
        riskLevel: "low",
        inputSchema: {
          fields: {
            windowId: { type: "string", description: "窗口 ID" },
            title: { type: "string", description: "窗口标题（模糊匹配）" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            windowId: { type: "string" },
          },
        },
      },
      {
        name: "desktop.window.resize",
        displayName: { "zh-CN": "调整窗口", "en-US": "Resize window" },
        description: {
          "zh-CN": "调整窗口大小和位置，支持 Windows、macOS、Linux 桌面会话",
          "en-US": "Resize and reposition a window across Windows, macOS, and Linux desktop sessions",
        },
        scope: "write",
        resourceType: "desktop",
        action: "window.resize",
        riskLevel: "low",
        inputSchema: {
          fields: {
            windowId: { type: "string", required: true, description: "窗口 ID" },
            x: { type: "number", description: "X 坐标" },
            y: { type: "number", description: "Y 坐标" },
            width: { type: "number", description: "宽度" },
            height: { type: "number", description: "高度" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
          },
        },
      },
      {
        name: "desktop.mouse.click",
        displayName: { "zh-CN": "鼠标点击", "en-US": "Mouse click" },
        description: {
          "zh-CN": "在指定坐标执行鼠标点击",
          "en-US": "Perform mouse click at specified coordinates",
        },
        scope: "write",
        resourceType: "desktop",
        action: "mouse.click",
        riskLevel: "medium",
        priority: 2,
        tags: ["planner:hidden", "primitive", "desktop-input"],
        inputSchema: {
          fields: {
            x: { type: "number", required: true, description: "X 坐标" },
            y: { type: "number", required: true, description: "Y 坐标" },
            button: { type: "string", description: "鼠标按钮：left/right/middle" },
            clickCount: { type: "number", description: "点击次数" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
          },
        },
      },
      {
        name: "desktop.mouse.move",
        displayName: { "zh-CN": "移动鼠标", "en-US": "Move mouse" },
        description: {
          "zh-CN": "移动鼠标到指定坐标",
          "en-US": "Move mouse to specified coordinates",
        },
        scope: "write",
        resourceType: "desktop",
        action: "mouse.move",
        riskLevel: "low",
        priority: 1,
        tags: ["planner:hidden", "primitive", "desktop-input"],
        inputSchema: {
          fields: {
            x: { type: "number", required: true, description: "X 坐标" },
            y: { type: "number", required: true, description: "Y 坐标" },
            smooth: { type: "boolean", description: "是否平滑移动" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
          },
        },
      },
      {
        name: "desktop.mouse.drag",
        displayName: { "zh-CN": "鼠标拖拽", "en-US": "Mouse drag" },
        description: {
          "zh-CN": "从起点拖拽到终点",
          "en-US": "Drag from start point to end point",
        },
        scope: "write",
        resourceType: "desktop",
        action: "mouse.drag",
        riskLevel: "medium",
        priority: 2,
        tags: ["planner:hidden", "primitive", "desktop-input"],
        inputSchema: {
          fields: {
            startX: { type: "number", required: true, description: "起点 X" },
            startY: { type: "number", required: true, description: "起点 Y" },
            endX: { type: "number", required: true, description: "终点 X" },
            endY: { type: "number", required: true, description: "终点 Y" },
            button: { type: "string", description: "鼠标按钮" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
          },
        },
      },
      {
        name: "desktop.keyboard.type",
        displayName: { "zh-CN": "键盘输入", "en-US": "Keyboard type" },
        description: {
          "zh-CN": "模拟键盘输入文本",
          "en-US": "Simulate keyboard text input",
        },
        scope: "write",
        resourceType: "desktop",
        action: "keyboard.type",
        riskLevel: "medium",
        priority: 2,
        tags: ["planner:hidden", "primitive", "desktop-input"],
        inputSchema: {
          fields: {
            text: { type: "string", required: true, description: "要输入的文本" },
            delay: { type: "number", description: "每个字符的输入延迟（毫秒）" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
          },
        },
      },
      {
        name: "desktop.keyboard.hotkey",
        displayName: { "zh-CN": "快捷键", "en-US": "Hotkey" },
        description: {
          "zh-CN": "执行键盘快捷键组合",
          "en-US": "Execute keyboard hotkey combination",
        },
        scope: "write",
        resourceType: "desktop",
        action: "keyboard.hotkey",
        riskLevel: "medium",
        priority: 2,
        tags: ["planner:hidden", "primitive", "desktop-input"],
        inputSchema: {
          fields: {
            keys: {
              type: "array",
              items: { type: "string" },
              required: true,
              description: "按键组合，如 [\"ctrl\", \"c\"]",
            },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
          },
        },
      },
      {
        name: "desktop.screen.capture",
        displayName: { "zh-CN": "屏幕截图", "en-US": "Screen capture" },
        description: {
          "zh-CN": "截取当前屏幕、指定区域或窗口内容并上传为证据",
          "en-US": "Capture the current screen, a region, or a window and upload it as evidence",
        },
        scope: "read",
        resourceType: "desktop",
        action: "screen.capture",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            x: { type: "number", description: "区域 X 坐标" },
            y: { type: "number", description: "区域 Y 坐标" },
            width: { type: "number", description: "区域宽度" },
            height: { type: "number", description: "区域高度" },
            windowId: { type: "string", description: "截取指定窗口" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            artifactId: { type: "string" },
            evidenceRefs: { type: "json" },
            width: { type: "number" },
            height: { type: "number" },
            format: { type: "string" },
            source: { type: "string" },
          },
        },
      },
      {
        name: "desktop.screen.ocr",
        displayName: { "zh-CN": "屏幕 OCR", "en-US": "Screen OCR" },
        description: {
          "zh-CN": "识别屏幕区域中的文字",
          "en-US": "Recognize text in screen region",
        },
        scope: "read",
        resourceType: "desktop",
        action: "screen.ocr",
        riskLevel: "low",
        inputSchema: {
          fields: {
            x: { type: "number", description: "区域 X 坐标" },
            y: { type: "number", description: "区域 Y 坐标" },
            width: { type: "number", description: "区域宽度" },
            height: { type: "number", description: "区域高度" },
            language: { type: "string", description: "OCR 语言：zh/en/auto" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            text: { type: "string" },
            blocks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  bounds: { type: "object" },
                  confidence: { type: "number" },
                },
              },
            },
          },
        },
      },
      {
        name: "desktop.clipboard.get",
        displayName: { "zh-CN": "获取剪贴板", "en-US": "Get clipboard" },
        description: {
          "zh-CN": "获取剪贴板内容",
          "en-US": "Get clipboard content",
        },
        scope: "read",
        resourceType: "desktop",
        action: "clipboard.get",
        riskLevel: "medium",
        priority: 2,
        tags: ["planner:hidden", "primitive", "clipboard"],
        inputSchema: { fields: {} },
        outputSchema: {
          fields: {
            text: { type: "string" },
            hasImage: { type: "boolean" },
            formats: { type: "array", items: { type: "string" } },
            truncated: { type: "boolean" },
          },
        },
      },
      {
        name: "desktop.clipboard.set",
        displayName: { "zh-CN": "设置剪贴板", "en-US": "Set clipboard" },
        description: {
          "zh-CN": "设置剪贴板内容",
          "en-US": "Set clipboard content",
        },
        scope: "write",
        resourceType: "desktop",
        action: "clipboard.set",
        riskLevel: "medium",
        priority: 2,
        tags: ["planner:hidden", "primitive", "clipboard"],
        inputSchema: {
          fields: {
            text: { type: "string", description: "文本内容" },
            imageBase64: { type: "string", description: "图片内容（base64）" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            wroteImage: { type: "boolean" },
          },
        },
      },
      {
        name: "desktop.file.dialog",
        displayName: { "zh-CN": "文件对话框", "en-US": "File dialog" },
        description: {
          "zh-CN": "打开文件选择对话框，支持 Windows、macOS 以及带图形会话的 Linux",
          "en-US": "Open a file selection dialog on Windows, macOS, and Linux desktop sessions with a GUI dialog backend",
        },
        scope: "write",
        resourceType: "desktop",
        action: "file.dialog",
        riskLevel: "medium",
        approvalRequired: true,
        priority: 3,
        tags: ["planner:hidden", "primitive", "file"],
        inputSchema: {
          fields: {
            type: { type: "string", required: true, description: "对话框类型：open/save/folder" },
            title: { type: "string", description: "对话框标题" },
            filters: {
              type: "array",
              items: { type: "object" },
              description: "文件类型过滤",
            },
            defaultPath: { type: "string", description: "默认路径" },
          },
        },
        outputSchema: {
          fields: {
            selected: { type: "boolean" },
            paths: { type: "array", items: { type: "string" } },
          },
        },
      },
    ],
  },
  routes: desktopAutomationRoutes,
};

export default plugin;
