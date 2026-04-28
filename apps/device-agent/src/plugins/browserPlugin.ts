/**
 * 浏览器自动化子插件 — 处理 device.browser.* 工具
 */
import type { CapabilityDescriptor } from "@openslin/device-agent-sdk";
import { getOrCreateSession, touchSession, getActiveSessionByType } from "@openslin/device-agent-sdk";
import type { DeviceToolPlugin, ToolExecutionContext, ToolExecutionResult } from "@openslin/device-agent-sdk";
import { resolveDeviceAgentEnv } from "../deviceAgentEnv";
import {
  captureScreen,
  cleanupCapture,
  ocrScreen,
  findTextInOcrResults,
  clickMouse,
  typeText as localTypeText,
  pressKey,
  pressCombo,
  scroll as localScroll,
  moveMouse,
  type OcrMatch,
} from "./localVision";
import {
  perceive as routerPerceive,
  locateAndAct,
  locateElement as routerLocateElement,
  browserDomNavigate,
  browserDomSessionStatus,
  browserDomListTabs,
  browserDomNewTab,
  browserDomSwitchTab,
  browserDomCloseTab,
  browserDomScreenshot,
  browserDomWaitFor,
  browserDomExtract,
  browserDomEvaluate,
  initPerceptionProviders,
  getActiveProviderName,
} from "./perceptionRouter";
import { getHost, sleep } from "./pluginUtils";
import {
  getScreenObservation,
  captureScreenshotPayload,
  uploadScreenshotEvidence,
  tryLaunch,
} from "./desktopInfra";

// ── 浏览器会话便捷函数 ────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 60 * 1000;

function getBrowserSession() {
  return getOrCreateSession({ sessionType: "browser", metadata: { userAgent: "device-agent" }, ttlMs: SESSION_TTL_MS });
}

function touchBrowserSession() {
  const session = getActiveSessionByType("browser");
  if (session) touchSession(session.sessionId);
}

// ── 浏览器工具实现 ────────────────────────────────────────────────

async function execBrowserOpen(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const session = getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  const url = String(ctx.input.url ?? "");
  if (!url) return { status: "failed", errorCategory: "input_invalid", outputDigest: { field: "url", received: ctx.input.url === undefined ? "undefined" : JSON.stringify(ctx.input.url), expected: "string — a valid URL, e.g. https://example.com", inputKeys: Object.keys(ctx.input) } };
  const net = ctx.policy?.networkPolicy ?? null;
  const allowedDomains = Array.isArray(net?.allowedDomains) ? net.allowedDomains.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
  if (!allowedDomains.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "egress_denied" } };
  const host = getHost(url);
  const domainAllowed = allowedDomains.includes("*") || allowedDomains.includes(host);
  if (!domainAllowed) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "domain_not_allowed", host } };
  const domResult = await browserDomNavigate({
    url,
    waitUntil: typeof ctx.input.waitUntil === "string" ? String(ctx.input.waitUntil) : undefined,
    timeoutMs: Number(ctx.input.timeout ?? 15000) || 15000,
  }).catch(() => null);
  if (domResult?.ok) {
    touchBrowserSession();
    return {
      status: "succeeded",
      outputDigest: {
        success: true, ok: true, host,
        url: domResult.url ?? url, title: domResult.title,
        readyState: domResult.readyState, launched: false,
        sessionId: session.sessionId, perceptionSource: domResult.source,
        silentCapable: true,
      },
    };
  }
  const launched = tryLaunch(url);
  if (!launched) {
    const launchMode = resolveDeviceAgentEnv().launchMode;
    return { status: "failed", errorCategory: "device_not_ready", outputDigest: { reason: "browser_launch_failed", host, url, launchMode, domError: domResult?.error } };
  }
  touchBrowserSession();
  await sleep(2000);
  let screenTexts: string[] = [];
  try {
    const obs = await routerPerceive();
    screenTexts = obs.elements.map(e => e.text).filter(Boolean);
  } catch {}
  return { status: "succeeded", outputDigest: { success: true, ok: true, host, url, launched: true, sessionId: session.sessionId, visibleTextsAfterNav: screenTexts.slice(0, 30), perceptionSource: domResult?.source, silentCapable: false } };
}

async function execBrowserClick(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  const selector = String(ctx.input.selector ?? "");
  if (!selector) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "selector" } };
  const button = (String(ctx.input.button ?? "left") as "left" | "right");
  try {
    const routerResult = await locateAndAct(selector, "click").catch(() => null);
    if (routerResult && routerResult.ok) {
      console.log(`[browser.click] 通过 ${routerResult.source} 成功点击 "${selector}"`);
      touchBrowserSession();
      await sleep(500);
      let afterTexts: string[] = [];
      try { const afterObs = await routerPerceive(); afterTexts = afterObs.elements.map(e => e.text).filter(Boolean); } catch {}
      return {
        status: "succeeded",
        outputDigest: {
          success: true, clickedText: selector,
          position: routerResult.element.bbox ? { x: routerResult.element.bbox.x, y: routerResult.element.bbox.y } : undefined,
          confidence: routerResult.element.confidence,
          perceptionSource: routerResult.source,
          usedMouseSimulation: routerResult.usedMouseSimulation,
          screenTextsAfterClick: afterTexts.slice(0, 30),
        },
      };
    }
    const { ocrResults, screenTexts } = await getScreenObservation();
    console.log(`[browser.click] OCR 识别到 ${ocrResults.length} 个文本块，目标：${selector}`);
    const match = findTextInOcrResults(ocrResults, selector, { fuzzy: true });
    if (match) {
      console.log(`[browser.click] OCR 匹配到目标："${selector}" @ (${match.x}, ${match.y})`);
      await clickMouse(match.x, match.y, button);
      touchBrowserSession();
      await sleep(500);
      let afterTexts: string[] = [];
      try { const afterObs = await getScreenObservation(); afterTexts = afterObs.screenTexts; } catch {}
      return {
        status: "succeeded",
        outputDigest: {
          success: true, clickedText: selector,
          position: { x: match.x, y: match.y }, confidence: match.confidence,
          perceptionSource: "local_ocr_fallback",
          screenTextsAfterClick: afterTexts.slice(0, 30),
        },
      };
    }
    console.warn(`[browser.click] 未匹配到目标："${selector}"`);
    return {
      status: "failed", errorCategory: "element_not_found",
      outputDigest: {
        reason: "text_not_found_on_screen", targetText: selector,
        ocrTextCount: ocrResults.length, visibleTexts: screenTexts.slice(0, 50),
        activeProvider: getActiveProviderName(),
        hint: "The target text was not found on screen. You may: 1) Use a different text that IS visible on screen, 2) Scroll to reveal it, 3) Wait for page to load.",
      },
    };
  } catch (err: any) {
    console.error(`[browser.click] 异常：${err?.message ?? err}`);
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "click_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

async function execBrowserType(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  const text = String(ctx.input.text ?? "");
  if (!text) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "text" } };
  const clear = Boolean(ctx.input.clear);
  try {
    const selector = String(ctx.input.selector ?? "");
    let focused = false;
    let focusStrategy = "none";
    if (selector) {
      const routerResult = await locateAndAct(selector, "click").catch(() => null);
      if (routerResult && routerResult.ok) {
        console.log(`[browser.type] 通过 ${routerResult.source} 定位并聚焦 "${selector}"`);
        focused = true;
        focusStrategy = `perception_router:${routerResult.source}`;
        await sleep(200);
      } else {
        const { ocrResults, screenTexts } = await getScreenObservation();
        console.log(`[browser.type] OCR 识别到 ${ocrResults.length} 个文本块，目标：${selector}`);
        const match = findTextInOcrResults(ocrResults, selector, { fuzzy: true });
        if (match) {
          console.log(`[browser.type] OCR 匹配到目标："${selector}" @ (${match.x}, ${match.y})`);
          await clickMouse(match.x, match.y);
          focused = true;
          focusStrategy = "ocr_fallback";
          await sleep(200);
        } else {
          console.warn(`[browser.type] 未匹配到目标："${selector}"`);
          return {
            status: "failed", errorCategory: "element_not_found",
            outputDigest: {
              reason: "selector_text_not_found", targetText: selector, textToType: text,
              ocrTextCount: ocrResults.length, visibleTexts: screenTexts.slice(0, 50),
              activeProvider: getActiveProviderName(),
              hint: "The target text was not found on screen. The Agent should: 1) Click on the actual input field using visible text near it, 2) Use browser.click on the input area first, then call browser.type without selector.",
            },
          };
        }
      }
    }
    if (clear) { await pressCombo(["ctrl", "a"]); await sleep(100); }
    console.log(`[browser.type] 输入文本："${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" (长度：${text.length})`);
    await localTypeText(text);
    touchBrowserSession();
    let afterTexts: string[] = [];
    try {
      const afterObs = await getScreenObservation();
      afterTexts = afterObs.screenTexts;
      const textFound = afterObs.ocrResults.some(r => r.text && r.text.includes(text));
      if (textFound) console.log(`[browser.type] 验证：屏幕上检测到已输入文本`);
    } catch {}
    return { status: "succeeded", outputDigest: { success: true, textLength: text.length, focused, focusStrategy, screenTextsAfterType: afterTexts.slice(0, 30) } };
  } catch (err: any) {
    console.error(`[browser.type] 异常：${err?.message ?? err}`);
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "type_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

async function execBrowserWaitFor(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  const timeout = Math.min(Number(ctx.input.timeout ?? 10000) || 10000, 30000);
  const expectedText = String(ctx.input.text ?? ctx.input.selector ?? "");
  const pollMs = 1500;
  const maxPolls = Math.max(2, Math.ceil(timeout / pollMs));
  const domSelector = typeof ctx.input.selector === "string" ? String(ctx.input.selector).trim() : "";
  const domText = typeof ctx.input.text === "string" ? String(ctx.input.text).trim() : "";
  try {
    const domResult = await browserDomWaitFor({
      selector: domSelector || undefined,
      text: domText || (!domSelector ? expectedText : "") || undefined,
      timeoutMs: timeout,
      state: typeof ctx.input.state === "string" ? String(ctx.input.state) : undefined,
    }).catch(() => null);
    if (domResult) {
      if (domResult.ok && domResult.found) {
        touchBrowserSession();
        return { status: "succeeded", outputDigest: { success: true, found: true, matchedText: domResult.matchedText, waitedMs: domResult.waitedMs, visibleTexts: domResult.pageTextSample?.slice(0, 20), perceptionSource: domResult.source } };
      }
      return { status: "failed", errorCategory: /timeout/i.test(String(domResult.error ?? "")) ? "timeout" : "device_error", outputDigest: { success: false, found: false, waitedMs: domResult.waitedMs, expectedText: domResult.matchedText ?? (expectedText || undefined), visibleTexts: domResult.pageTextSample?.slice(0, 30), perceptionSource: domResult.source, error: domResult.error } };
    }
    let lastOcrResults: OcrMatch[] = [];
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollMs);
      const { ocrResults, screenTexts } = await getScreenObservation();
      lastOcrResults = ocrResults;
      if (expectedText) {
        const found = findTextInOcrResults(ocrResults, expectedText, { fuzzy: true });
        if (found) {
          touchBrowserSession();
          return { status: "succeeded", outputDigest: { success: true, found: true, matchedText: expectedText, ocrItemCount: ocrResults.length, waitedMs: (i + 1) * pollMs, visibleTexts: screenTexts.slice(0, 20) } };
        }
      } else if (ocrResults.length > 0) {
        touchBrowserSession();
        return { status: "succeeded", outputDigest: { success: true, found: true, ocrItemCount: ocrResults.length, waitedMs: (i + 1) * pollMs, visibleTexts: screenTexts.slice(0, 20) } };
      }
    }
    const lastTexts = lastOcrResults.map(r => r.text).filter(Boolean);
    return { status: "failed", errorCategory: "timeout", outputDigest: { success: false, found: false, waitedMs: timeout, expectedText: expectedText || undefined, ocrItemCount: lastOcrResults.length, visibleTexts: lastTexts.slice(0, 30), hint: "Timeout waiting. The screen content at timeout is provided for Agent analysis." } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "wait_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

async function execBrowserExtract(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  try {
    const { ocrResults, screenTexts } = await getScreenObservation();
    const multiple = Boolean(ctx.input.multiple);
    const filterText = String(ctx.input.filter ?? "");
    const selector = typeof ctx.input.selector === "string" ? String(ctx.input.selector).trim() : "";
    const attribute = typeof ctx.input.attribute === "string" ? String(ctx.input.attribute).trim() : "";
    if (selector) {
      const domResult = await browserDomExtract({ selector, attribute: attribute || undefined, multiple, filter: filterText || undefined }).catch(() => null);
      if (domResult) {
        if (domResult.ok) {
          touchBrowserSession();
          return { status: "succeeded", outputDigest: { success: true, value: domResult.value ?? "", values: domResult.values, count: domResult.count, elements: domResult.elements, filter: filterText || undefined, perceptionSource: domResult.source } };
        }
        return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "extract_failed", selector, filter: filterText || undefined, perceptionSource: domResult.source, error: domResult.error } };
      }
    }
    touchBrowserSession();
    let filteredResults = ocrResults;
    if (filterText) {
      const ft = filterText.toLowerCase();
      filteredResults = ocrResults.filter(r => r.text.toLowerCase().includes(ft));
    }
    const texts = filteredResults.map(r => r.text).filter(Boolean);
    const withPosition = filteredResults.slice(0, 50).map(r => ({ text: r.text, x: r.bbox.x, y: r.bbox.y, w: r.bbox.w, h: r.bbox.h }));
    return { status: "succeeded", outputDigest: { success: true, value: texts.join("\n"), values: multiple ? texts.slice(0, 100) : undefined, count: texts.length, totalOcrItems: ocrResults.length, elements: withPosition, filter: filterText || undefined } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "extract_failed", error: String(err?.message ?? err).slice(0, 200) } };
  }
}

async function execBrowserScroll(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  const y = Number(ctx.input.y ?? 0);
  try {
    const direction = y >= 0 ? "down" : "up";
    const clicks = Math.max(1, Math.ceil(Math.abs(y || 300) / 100));
    await localScroll(direction as "up" | "down", clicks);
    touchBrowserSession();
    let afterTexts: string[] = [];
    try { await sleep(300); const afterObs = await getScreenObservation(); afterTexts = afterObs.screenTexts; } catch {}
    return { status: "succeeded", outputDigest: { success: true, scrollY: y, direction, clicks, visibleTextsAfterScroll: afterTexts.slice(0, 30) } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "scroll_failed" } };
  }
}

async function execBrowserSelect(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  const label = String(ctx.input.label ?? ctx.input.value ?? "");
  if (!label) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "label_or_value" } };
  try {
    const { ocrResults, screenTexts } = await getScreenObservation();
    const match = findTextInOcrResults(ocrResults, label, { fuzzy: true });
    if (match) {
      await clickMouse(match.x, match.y);
      touchBrowserSession();
      let afterTexts: string[] = [];
      try { await sleep(300); const afterObs = await getScreenObservation(); afterTexts = afterObs.screenTexts; } catch {}
      return { status: "succeeded", outputDigest: { success: true, selectedValue: label, position: { x: match.x, y: match.y }, visibleTextsAfterSelect: afterTexts.slice(0, 20) } };
    }
    return { status: "failed", errorCategory: "element_not_found", outputDigest: { reason: "option_not_found", targetLabel: label, ocrTextCount: ocrResults.length, visibleTexts: screenTexts.slice(0, 50), hint: "The option text was not found. You may need to click a dropdown first, or scroll to reveal options." } };
  } catch (err: any) {
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "select_failed" } };
  }
}

async function execBrowserEvaluate(_ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  await initPerceptionProviders(_ctx.cfg).catch(() => {});
  const script = String(_ctx.input.script ?? "");
  if (!script) return { status: "failed", errorCategory: "input_invalid", outputDigest: { missing: "script" } };
  const args = Array.isArray(_ctx.input.args) ? _ctx.input.args : [];
  const domResult = await browserDomEvaluate({ script, args }).catch(() => null);
  if (!domResult) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "browser.evaluate requires a browser driver which is not available" } };
  if (!domResult.ok) return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "evaluate_failed", perceptionSource: domResult.source, error: domResult.error } };
  touchBrowserSession();
  return { status: "succeeded", outputDigest: { success: true, result: domResult.result, perceptionSource: domResult.source } };
}

async function execBrowserSessionStatus(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  const domResult = await browserDomSessionStatus().catch(() => null);
  if (!domResult) return { status: "succeeded", outputDigest: { success: false, connected: false, owned: false, tabCount: 0, perceptionSource: "none" } };
  touchBrowserSession();
  return {
    status: domResult.ok ? "succeeded" : "failed",
    errorCategory: domResult.ok ? undefined : "device_error",
    outputDigest: {
      success: domResult.ok, connected: domResult.connected, owned: domResult.owned,
      browserName: domResult.browserName, cdpUrl: domResult.cdpUrl, debugPort: domResult.debugPort,
      profileDir: domResult.profileDir, headless: domResult.headless, pid: domResult.pid,
      activeTabId: domResult.activeTabId, activeUrl: domResult.activeUrl, activeTitle: domResult.activeTitle,
      tabCount: domResult.tabCount ?? domResult.tabs?.length ?? 0, tabs: domResult.tabs,
      perceptionSource: domResult.source, error: domResult.error,
    },
  };
}

async function execBrowserTabList(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  const domResult = await browserDomListTabs().catch(() => null);
  if (!domResult) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "browser_tab_management_requires_browser_driver" } };
  touchBrowserSession();
  return { status: "succeeded", outputDigest: { success: true, tabs: domResult.tabs, count: domResult.tabs.length, perceptionSource: domResult.source } };
}

async function execBrowserTabNew(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  try {
    const domResult = await browserDomNewTab({ url: typeof ctx.input.url === "string" ? String(ctx.input.url) : undefined, activate: ctx.input.activate === undefined ? true : Boolean(ctx.input.activate) });
    if (!domResult) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "browser_tab_management_requires_browser_driver", detail: "browserDomNewTab returned null" } };
    touchBrowserSession();
    return { status: "succeeded", outputDigest: { success: true, tab: domResult, tabId: domResult.id, url: domResult.url, title: domResult.title, perceptionSource: domResult.source } };
  } catch (err: any) {
    console.error("[browser.tab.new] execution failed:", err?.message ?? err);
    return { status: "failed", errorCategory: "device_error", outputDigest: { reason: "new_tab_failed", error: String(err?.message ?? err).slice(0, 500) } };
  }
}

async function execBrowserTabSwitch(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  const domResult = await browserDomSwitchTab({ tabId: typeof ctx.input.tabId === "string" ? String(ctx.input.tabId) : undefined, index: ctx.input.index === undefined ? undefined : Number(ctx.input.index) }).catch(() => null);
  if (!domResult) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "browser_tab_management_requires_browser_driver" } };
  touchBrowserSession();
  return { status: "succeeded", outputDigest: { success: true, tab: domResult, tabId: domResult.id, url: domResult.url, title: domResult.title, perceptionSource: domResult.source } };
}

async function execBrowserTabClose(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  getBrowserSession();
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  const domResult = await browserDomCloseTab({ tabId: typeof ctx.input.tabId === "string" ? String(ctx.input.tabId) : undefined, index: ctx.input.index === undefined ? undefined : Number(ctx.input.index) }).catch(() => null);
  if (!domResult) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { reason: "browser_tab_management_requires_browser_driver" } };
  touchBrowserSession();
  return {
    status: domResult.ok ? "succeeded" : "failed",
    errorCategory: domResult.ok ? undefined : "device_error",
    outputDigest: { success: domResult.ok, closedTabId: domResult.closedTabId, remainingTabs: domResult.remainingTabs, activeTabId: domResult.activeTabId, perceptionSource: domResult.source, error: domResult.error },
  };
}

async function execBrowserScreenshot(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  if (!ctx.requireUserPresence) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "require_user_presence" } };
  await initPerceptionProviders(ctx.cfg).catch(() => {});
  const url = ctx.input.url === undefined || ctx.input.url === null ? null : String(ctx.input.url);
  if (url) {
    const net = ctx.policy?.networkPolicy ?? null;
    const allowedDomains = Array.isArray(net?.allowedDomains) ? net.allowedDomains.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
    if (!allowedDomains.length) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "egress_denied" } };
    const host = getHost(url);
    if (!allowedDomains.includes(host)) return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "domain_not_allowed", host } };
  }
  const domResult = await browserDomScreenshot({
    selector: typeof ctx.input.selector === "string" ? String(ctx.input.selector).trim() || undefined : undefined,
    fullPage: Boolean(ctx.input.fullPage),
    format: typeof ctx.input.format === "string" ? String(ctx.input.format) : undefined,
  }).catch(() => null);
  const payload = domResult?.ok && domResult.contentBase64
    ? { contentBase64: domResult.contentBase64, width: domResult.width, height: domResult.height, source: `${domResult.source}:dom` }
    : await captureScreenshotPayload();
  touchBrowserSession();
  const result = await uploadScreenshotEvidence(ctx, payload);
  if (result.status === "succeeded") {
    result.outputDigest = {
      ...result.outputDigest,
      title: domResult?.ok ? domResult.title : undefined,
      url: domResult?.ok ? domResult.url : undefined,
      viewportOnly: true,
      requestedSelector: ctx.input.selector === undefined ? undefined : String(ctx.input.selector),
      requestedFullPage: ctx.input.fullPage === undefined ? undefined : Boolean(ctx.input.fullPage),
    };
  }
  return result;
}

// ── 路由表 ────────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<string, (ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {
  "device.browser.open": execBrowserOpen,
  "device.browser.click": execBrowserClick,
  "device.browser.type": execBrowserType,
  "device.browser.waitFor": execBrowserWaitFor,
  "device.browser.extract": execBrowserExtract,
  "device.browser.scroll": execBrowserScroll,
  "device.browser.select": execBrowserSelect,
  "device.browser.evaluate": execBrowserEvaluate,
  "device.browser.screenshot": execBrowserScreenshot,
  "device.browser.session.status": execBrowserSessionStatus,
  "device.browser.tab.list": execBrowserTabList,
  "device.browser.tab.new": execBrowserTabNew,
  "device.browser.tab.switch": execBrowserTabSwitch,
  "device.browser.tab.close": execBrowserTabClose,
};

// ── 能力声明 ──────────────────────────────────────────────────────

const successOutputSchema = { type: "object", properties: { success: { type: "boolean" } }, additionalProperties: true };
const stringArraySchema = { type: "array", items: { type: "string" } };
const tabSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
  },
  additionalProperties: true,
};

const BROWSER_CAPABILITIES: CapabilityDescriptor[] = [
  { toolRef: "device.browser.open", riskLevel: "medium", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 256, cpuPercent: 40, networkRequired: true }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser"], description: "在本地浏览器打开目标地址" },
  { toolRef: "device.browser.click", riskLevel: "medium", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 192, cpuPercent: 50 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser"], description: "在浏览器上下文点击元素" },
  { toolRef: "device.browser.type", riskLevel: "medium", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, clear: { type: "boolean" } }, required: ["text"], additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 192, cpuPercent: 50 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser"], description: "在浏览器上下文输入文本" },
  { toolRef: "device.browser.waitFor", riskLevel: "low", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, timeout: { type: "number" } }, additionalProperties: true }, outputSchema: { type: "object", properties: { found: { type: "boolean" }, waitedMs: { type: "number" }, visibleTexts: stringArraySchema }, additionalProperties: true }, resourceRequirements: { memoryMb: 128, cpuPercent: 30 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser"], description: "等待浏览器元素或文本出现" },
  { toolRef: "device.browser.extract", riskLevel: "low", inputSchema: { type: "object", properties: { selector: { type: "string" }, filter: { type: "string" }, multiple: { type: "boolean" } }, additionalProperties: true }, outputSchema: { type: "object", properties: { value: { type: "string" }, values: stringArraySchema, count: { type: "number" } }, additionalProperties: true }, resourceRequirements: { memoryMb: 160, cpuPercent: 35 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser"], description: "提取浏览器页面内容" },
  { toolRef: "device.browser.scroll", riskLevel: "low", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 96, cpuPercent: 20 }, concurrencyLimit: 4, version: "1.0.0", tags: ["desktop", "browser"], description: "滚动浏览器页面" },
  { toolRef: "device.browser.select", riskLevel: "medium", inputSchema: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, selector: { type: "string" } }, additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 160, cpuPercent: 30 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser"], description: "选择浏览器下拉项" },
  { toolRef: "device.browser.evaluate", riskLevel: "high", inputSchema: { type: "object", properties: { script: { type: "string" }, args: { type: "array", items: {} } }, required: ["script"], additionalProperties: true }, outputSchema: { type: "object", properties: { success: { type: "boolean" }, result: {} }, additionalProperties: true }, resourceRequirements: { memoryMb: 160, cpuPercent: 40 }, concurrencyLimit: 1, version: "1.0.0", tags: ["desktop", "browser"], description: "执行浏览器上下文脚本" },
  { toolRef: "device.browser.screenshot", riskLevel: "medium", inputSchema: { type: "object", properties: { fullPage: { type: "boolean" } }, additionalProperties: true }, outputSchema: { type: "object", properties: { artifactId: { type: "string" }, evidenceRefs: stringArraySchema }, additionalProperties: true }, resourceRequirements: { memoryMb: 256, cpuPercent: 45 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser", "evidence"], description: "采集浏览器截图证据" },
  { toolRef: "device.browser.session.status", riskLevel: "low", inputSchema: { type: "object", additionalProperties: true }, outputSchema: { type: "object", properties: { sessionActive: { type: "boolean" } }, additionalProperties: true }, resourceRequirements: { memoryMb: 48 }, concurrencyLimit: 8, version: "1.0.0", tags: ["desktop", "browser", "session"], description: "查询浏览器会话状态" },
  { toolRef: "device.browser.tab.list", riskLevel: "low", inputSchema: { type: "object", additionalProperties: true }, outputSchema: { type: "object", properties: { tabs: { type: "array", items: tabSchema }, count: { type: "number" } }, additionalProperties: true }, resourceRequirements: { memoryMb: 64 }, concurrencyLimit: 4, version: "1.0.0", tags: ["desktop", "browser", "session"], description: "列出浏览器标签页" },
  { toolRef: "device.browser.tab.new", riskLevel: "medium", inputSchema: { type: "object", properties: { url: { type: "string" } }, additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 128, cpuPercent: 20 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser", "session"], description: "新建浏览器标签页" },
  { toolRef: "device.browser.tab.switch", riskLevel: "medium", inputSchema: { type: "object", properties: { tabId: { anyOf: [{ type: "string" }, { type: "number" }] } }, additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 128, cpuPercent: 20 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser", "session"], description: "切换浏览器标签页" },
  { toolRef: "device.browser.tab.close", riskLevel: "medium", inputSchema: { type: "object", properties: { tabId: { anyOf: [{ type: "string" }, { type: "number" }] } }, additionalProperties: true }, outputSchema: successOutputSchema, resourceRequirements: { memoryMb: 128, cpuPercent: 20 }, concurrencyLimit: 2, version: "1.0.0", tags: ["desktop", "browser", "session"], description: "关闭浏览器标签页" },
];

// ── 导出插件实例 ──────────────────────────────────────────────────

const browserPlugin: DeviceToolPlugin = {
  name: "browser",
  version: "1.0.0",
  toolPrefixes: ["device.browser"],
  capabilities: BROWSER_CAPABILITIES,
  resourceLimits: { maxMemoryMb: 512, maxCpuPercent: 80, maxConcurrency: 2, maxExecutionTimeMs: 120000 },
  toolNames: Object.keys(TOOL_HANDLERS),
  async execute(ctx) {
    const handler = TOOL_HANDLERS[ctx.toolName];
    if (!handler) return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolName: ctx.toolName, plugin: "browser" } };
    return handler(ctx);
  },
};

export default browserPlugin;
