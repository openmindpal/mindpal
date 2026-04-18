/**
 * Skill: browser-automation
 *
 * 提供浏览器自动化能力，支持：
 * - 页面导航与截图
 * - 元素点击、输入、滚动
 * - 表单填写与提交
 * - 数据提取
 *
 * 作为扩展层 Skill，通过 device-agent bridge 执行，
 * 必须支持纯设备端部署，不依赖中心服务。
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { browserAutomationRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "browser.automation", version: "1.0.0" },
    layer: "extension",
    routes: ["/browser-automation"],
    frontend: ["/gov/browser-automation"],
    dependencies: ["schemas", "audit", "rbac"],
    skillDependencies: ["device.runtime"],
    tools: [
      {
        name: "browser.navigate",
        displayName: { "zh-CN": "页面导航", "en-US": "Navigate to URL" },
        description: {
          "zh-CN": "在浏览器中打开指定 URL",
          "en-US": "Navigate browser to specified URL",
        },
        scope: "write",
        resourceType: "browser",
        action: "navigate",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            url: { type: "string", required: true, description: "目标 URL" },
            waitUntil: { type: "string", description: "等待条件：load/domcontentloaded/networkidle" },
            timeout: { type: "number", description: "超时时间（毫秒）" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            title: { type: "string" },
            url: { type: "string" },
            readyState: { type: "string" },
            launched: { type: "boolean" },
            silentCapable: { type: "boolean" },
            perceptionSource: { type: "string" },
          },
        },
      },
      {
        name: "browser.screenshot",
        displayName: { "zh-CN": "页面截图", "en-US": "Take screenshot" },
        description: {
          "zh-CN": "截取当前浏览器可见内容并上传为证据",
          "en-US": "Capture the current visible browser content and upload it as evidence",
        },
        scope: "read",
        resourceType: "browser",
        action: "screenshot",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            selector: { type: "string", description: "可选的目标元素描述，当前用于记录截图上下文" },
            fullPage: { type: "boolean", description: "是否请求整页截图；当前运行时返回可见区域截图" },
            format: { type: "string", description: "图片格式，当前运行时固定为 png" },
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
        name: "browser.click",
        displayName: { "zh-CN": "点击元素", "en-US": "Click element" },
        description: {
          "zh-CN": "点击页面上的指定元素",
          "en-US": "Click on specified page element",
        },
        scope: "write",
        resourceType: "browser",
        action: "click",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            selector: { type: "string", required: true, description: "CSS 选择器、可见文本或兼容查询表达式" },
            button: { type: "string", description: "鼠标按钮：left/right/middle" },
            clickCount: { type: "number", description: "点击次数" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            elementText: { type: "string" },
          },
        },
      },
      {
        name: "browser.type",
        displayName: { "zh-CN": "输入文本", "en-US": "Type text" },
        description: {
          "zh-CN": "在指定输入框中输入文本",
          "en-US": "Type text into specified input field",
        },
        scope: "write",
        resourceType: "browser",
        action: "type",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            selector: { type: "string", required: true, description: "CSS 选择器、可见文本或兼容查询表达式" },
            text: { type: "string", required: true, description: "要输入的文本" },
            delay: { type: "number", description: "每个字符的输入延迟（毫秒）" },
            clear: { type: "boolean", description: "是否先清空输入框" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
          },
        },
      },
      {
        name: "browser.select",
        displayName: { "zh-CN": "选择选项", "en-US": "Select option" },
        description: {
          "zh-CN": "在下拉框中选择指定选项",
          "en-US": "Select option from dropdown",
        },
        scope: "write",
        resourceType: "browser",
        action: "select",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            selector: { type: "string", description: "可选的 CSS 选择器、可见文本或兼容查询表达式" },
            value: { type: "string", description: "选项的 value 属性" },
            label: { type: "string", description: "选项的显示文本" },
            index: { type: "number", description: "选项的索引" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            selectedValue: { type: "string" },
          },
        },
      },
      {
        name: "browser.scroll",
        displayName: { "zh-CN": "滚动页面", "en-US": "Scroll page" },
        description: {
          "zh-CN": "滚动页面到指定位置或元素",
          "en-US": "Scroll page to specified position or element",
        },
        scope: "write",
        resourceType: "browser",
        action: "scroll",
        riskLevel: "low",
        inputSchema: {
          fields: {
            selector: { type: "string", description: "CSS 选择器、可见文本或兼容查询表达式" },
            x: { type: "number", description: "水平滚动距离（像素）" },
            y: { type: "number", description: "垂直滚动距离（像素）" },
            behavior: { type: "string", description: "滚动行为：smooth/instant" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            scrollX: { type: "number" },
            scrollY: { type: "number" },
          },
        },
      },
      {
        name: "browser.extract",
        displayName: { "zh-CN": "提取数据", "en-US": "Extract data" },
        description: {
          "zh-CN": "从当前浏览器可见内容中提取 OCR 文本",
          "en-US": "Extract DOM or OCR text from the current browser content",
        },
        scope: "read",
        resourceType: "browser",
        action: "extract",
        riskLevel: "low",
        inputSchema: {
          fields: {
            selector: { type: "string", description: "可选的 CSS 选择器；未提供时按可见文本/OCR 提取" },
            filter: { type: "string", description: "仅返回包含指定文本的 OCR 结果" },
            multiple: { type: "boolean", description: "是否提取所有匹配元素" },
          },
        },
        outputSchema: {
          fields: {
            value: { type: "string", description: "单元素提取结果" },
            values: { type: "json", description: "多元素提取结果" },
            count: { type: "number" },
            elements: { type: "json", description: "带位置信息的 OCR 文本块" },
          },
        },
      },
      {
        name: "browser.evaluate",
        displayName: { "zh-CN": "执行脚本", "en-US": "Evaluate script" },
        description: {
          "zh-CN": "在页面上下文中执行 JavaScript 代码",
          "en-US": "Execute JavaScript code in page context",
        },
        scope: "write",
        resourceType: "browser",
        action: "evaluate",
        riskLevel: "high",
        approvalRequired: true,
        priority: 2,
        tags: ["planner:hidden", "primitive", "script"],
        inputSchema: {
          fields: {
            script: { type: "string", required: true, description: "要执行的 JavaScript 代码" },
            args: { type: "array", items: { type: "any" }, description: "传递给脚本的参数" },
          },
        },
        outputSchema: {
          fields: {
            result: { type: "any" },
          },
        },
      },
      {
        name: "browser.waitFor",
        displayName: { "zh-CN": "等待元素", "en-US": "Wait for element" },
        description: {
          "zh-CN": "等待当前浏览器可见内容中出现目标文本",
          "en-US": "Wait until the target text appears in the visible browser content",
        },
        scope: "read",
        resourceType: "browser",
        action: "waitFor",
        riskLevel: "low",
        inputSchema: {
          fields: {
            selector: { type: "string", description: "可选的 CSS 选择器、可见文本或兼容查询表达式" },
            text: { type: "string", description: "等待出现的文本" },
            state: { type: "string", description: "兼容字段" },
            timeout: { type: "number", description: "超时时间（毫秒）" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            found: { type: "boolean" },
            waitedMs: { type: "number" },
          },
        },
      },
      {
        name: "browser.session.status",
        displayName: { "zh-CN": "浏览器会话状态", "en-US": "Browser session status" },
        description: {
          "zh-CN": "查看后台浏览器会话、调试端口、活动标签页和连接状态",
          "en-US": "Inspect background browser session, debug port, active tab, and connection state",
        },
        scope: "read",
        resourceType: "browser",
        action: "session.status",
        riskLevel: "low",
        inputSchema: { fields: {} },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            connected: { type: "boolean" },
            owned: { type: "boolean" },
            browserName: { type: "string" },
            cdpUrl: { type: "string" },
            debugPort: { type: "number" },
            profileDir: { type: "string" },
            activeTabId: { type: "string" },
            activeUrl: { type: "string" },
            activeTitle: { type: "string" },
            tabCount: { type: "number" },
            tabs: { type: "json" },
          },
        },
      },
      {
        name: "browser.tab.list",
        displayName: { "zh-CN": "列出标签页", "en-US": "List browser tabs" },
        description: {
          "zh-CN": "列出后台浏览器会话中的所有标签页",
          "en-US": "List all tabs in the background browser session",
        },
        scope: "read",
        resourceType: "browser",
        action: "tab.list",
        riskLevel: "low",
        inputSchema: { fields: {} },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            count: { type: "number" },
            tabs: { type: "json" },
          },
        },
      },
      {
        name: "browser.tab.new",
        displayName: { "zh-CN": "新建标签页", "en-US": "Open browser tab" },
        description: {
          "zh-CN": "在后台浏览器中创建新标签页，可选直接打开 URL",
          "en-US": "Create a new background browser tab and optionally open a URL",
        },
        scope: "write",
        resourceType: "browser",
        action: "tab.new",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            url: { type: "string", description: "新标签页打开的 URL" },
            activate: { type: "boolean", description: "是否切换到该标签页" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            tabId: { type: "string" },
            url: { type: "string" },
            title: { type: "string" },
          },
        },
      },
      {
        name: "browser.tab.switch",
        displayName: { "zh-CN": "切换标签页", "en-US": "Switch browser tab" },
        description: {
          "zh-CN": "按标签页 ID 或索引切换后台浏览器活动标签页",
          "en-US": "Switch the active background browser tab by ID or index",
        },
        scope: "write",
        resourceType: "browser",
        action: "tab.switch",
        riskLevel: "low",
        inputSchema: {
          fields: {
            tabId: { type: "string", description: "标签页 ID" },
            index: { type: "number", description: "标签页索引" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            tabId: { type: "string" },
            url: { type: "string" },
            title: { type: "string" },
          },
        },
      },
      {
        name: "browser.tab.close",
        displayName: { "zh-CN": "关闭标签页", "en-US": "Close browser tab" },
        description: {
          "zh-CN": "关闭后台浏览器中的指定标签页",
          "en-US": "Close a specified tab in the background browser session",
        },
        scope: "write",
        resourceType: "browser",
        action: "tab.close",
        riskLevel: "low",
        inputSchema: {
          fields: {
            tabId: { type: "string", description: "标签页 ID" },
            index: { type: "number", description: "标签页索引" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            closedTabId: { type: "string" },
            remainingTabs: { type: "number" },
            activeTabId: { type: "string" },
          },
        },
      },
    ],
  },
  routes: browserAutomationRoutes,
};

export default plugin;
