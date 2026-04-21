/**
 * Perception Router — 浏览器执行引擎 + OCR 回退
 *
 * 端侧只保留 Playwright 执行引擎（可选安装），
 * 无 Playwright 时回退到本地 OCR（localVision）。
 * 感知决策路由已移至云端。
 *
 * desktopPlugin 调用 perceive() / locateAndAct() 即可。
 */
import { resolveDeviceAgentEnv } from "../deviceAgentEnv";
// ── 核心类型（原 perceptionProvider.ts，已内联）─────────────────────

/** 屏幕上识别到的元素 */
export interface ScreenElement {
  text: string;
  bbox?: { x: number; y: number; w: number; h: number };
  selector?: string;
  tagName?: string;
  confidence: number;
  interactable: boolean;
}

/** 统一感知结果 */
export interface PerceptionResult {
  elements: ScreenElement[];
  screenshotPath?: string;
  source: "playwright" | "local_ocr";
  durationMs: number;
}

/** 动作执行结果 */
export interface ActionResult {
  ok: boolean;
  elementsAfter?: ScreenElement[];
  error?: string;
}

export interface BrowserScreenshotResult {
  ok: boolean;
  contentBase64?: string;
  width?: number;
  height?: number;
  format?: string;
  title?: string;
  url?: string;
  error?: string;
}

export interface BrowserWaitResult {
  ok: boolean;
  found: boolean;
  waitedMs: number;
  matchedText?: string;
  pageTextSample?: string[];
  error?: string;
}

export interface BrowserExtractResult {
  ok: boolean;
  value?: string;
  values?: string[];
  count: number;
  elements?: Array<{ text: string; x: number; y: number; w: number; h: number; selector?: string; tagName?: string }>;
  error?: string;
}

export interface BrowserEvaluateResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BrowserNavigateResult {
  ok: boolean;
  url?: string;
  title?: string;
  readyState?: string;
  error?: string;
}

export interface BrowserTabSummary {
  id: string;
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserSessionStatus {
  ok: boolean;
  connected: boolean;
  owned: boolean;
  browserName?: string;
  cdpUrl?: string;
  debugPort?: number;
  profileDir?: string;
  headless?: boolean;
  pid?: number;
  activeTabId?: string;
  activeUrl?: string;
  activeTitle?: string;
  tabCount?: number;
  tabs?: BrowserTabSummary[];
  error?: string;
}

// ── 以下为路由实现 ────────────────────────────────────────────────────
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  captureScreen,
  cleanupCapture,
  ocrScreen,
  findTextInOcrResults,
  clickMouse,
  typeText as localTypeText,
  scroll as localScroll,
  type OcrMatch,
} from "./localVision";

type BrowserLaunchPlan = {
  executablePath: string;
  browserName: string;
  debugPort: number;
  cdpUrl: string;
  profileDir: string;
  headless: boolean;
  args: string[];
};

type BrowserRuntimeState = BrowserLaunchPlan & {
  owned: boolean;
  pid?: number;
};

function createTabId(index: number): string {
  return `tab-${index}`;
}

export function summarizeBrowserTabs(
  tabs: Array<{ url?: string; title?: string }>,
  activeIndex: number,
): BrowserTabSummary[] {
  return tabs.map((tab, index) => ({
    id: createTabId(index),
    index,
    url: String(tab.url ?? ""),
    title: String(tab.title ?? ""),
    active: index === activeIndex,
  }));
}

function isPathLikeExecutable(candidate: string): boolean {
  return /[\\/]/.test(candidate) || /^[a-zA-Z]:/.test(candidate);
}

export function getBrowserExecutableCandidates(platform = process.platform, env = process.env): string[] {
  const preferred = String(env.DEVICE_AGENT_BROWSER_EXECUTABLE ?? "").trim();
  if (preferred) return [preferred];
  const channel = String(env.DEVICE_AGENT_BROWSER_CHANNEL ?? "edge").trim().toLowerCase();
  const candidatesByChannel: Record<string, string[]> = {
    edge: platform === "win32"
      ? [
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          path.join(process.env.LOCALAPPDATA ?? "", "Microsoft\\Edge\\Application\\msedge.exe"),
        ]
      : platform === "darwin"
        ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["microsoft-edge", "microsoft-edge-stable"],
    chrome: platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
        ]
      : platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["google-chrome", "google-chrome-stable"],
    chromium: platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA ?? "", "Chromium\\Application\\chrome.exe")]
      : platform === "darwin"
        ? ["/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["chromium-browser", "chromium"],
  };
  const orderedChannels = Array.from(new Set([channel, "edge", "chrome", "chromium"]));
  const result: string[] = [];
  for (const item of orderedChannels) {
    for (const candidate of candidatesByChannel[item] ?? []) {
      if (candidate && !result.includes(candidate)) result.push(candidate);
    }
  }
  return result;
}

export function buildBackgroundBrowserArgs(params: { port: number; profileDir: string; headless: boolean; extraArgs?: string[] }): string[] {
  const args = [
    `--remote-debugging-port=${params.port}`,
    `--user-data-dir=${params.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--disable-renderer-backgrounding",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--window-size=1440,1024",
    ...(params.headless ? ["--headless=new", "--disable-gpu"] : []),
    ...(params.extraArgs ?? []),
    "about:blank",
  ];
  return Array.from(new Set(args.filter(Boolean)));
}

async function resolveUsableExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!isPathLikeExecutable(candidate)) return candidate;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function allocateDebugPort(preferred?: number): Promise<number> {
  const tryListen = (port: number) => new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const resolved = typeof addr === "object" && addr ? addr.port : port;
      server.close(() => resolve(resolved));
    });
  });
  if (preferred && preferred > 0) {
    try {
      return await tryListen(preferred);
    } catch {
    }
  }
  return tryListen(0);
}

function createProfileDir(env = process.env): string {
  const configured = String(env.DEVICE_AGENT_BROWSER_PROFILE_DIR ?? "").trim();
  if (configured) return path.resolve(configured);
  return path.join(os.tmpdir(), `openslin-browser-profile-${process.pid}`);
}

async function waitForCdpEndpoint(cdpUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${cdpUrl.replace(/\/+$/, "")}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (resp.ok) return true;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function isChildAlive(proc: childProcess.ChildProcess | null): boolean {
  if (!proc?.pid) return false;
  try {
    process.kill(proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function resolveBackgroundBrowserLaunchPlan(env = process.env, platform = process.platform): Promise<BrowserLaunchPlan | null> {
  const executablePath = await resolveUsableExecutable(getBrowserExecutableCandidates(platform, env));
  if (!executablePath) return null;
  const requestedPort = Number(env.DEVICE_AGENT_BROWSER_DEBUG_PORT ?? 0) || undefined;
  const debugPort = await allocateDebugPort(requestedPort);
  const profileDir = createProfileDir(env);
  const headless = String(env.DEVICE_AGENT_BROWSER_HEADLESS ?? "false").trim().toLowerCase() !== "false";
  const extraArgs = String(env.DEVICE_AGENT_BROWSER_ARGS ?? "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const browserName = /edge/i.test(executablePath) ? "edge" : /chrom/i.test(executablePath) ? "chromium" : "browser";
  return {
    executablePath,
    browserName,
    debugPort,
    cdpUrl: `http://127.0.0.1:${debugPort}`,
    profileDir,
    headless,
    args: buildBackgroundBrowserArgs({ port: debugPort, profileDir, headless, extraArgs }),
  };
}

// ── Playwright Provider（浏览器执行引擎，可选安装）───────────────

class PlaywrightProvider {
  readonly name = "playwright" as const;
  private _available: boolean | null = null;
  private _pw: any = null;
  private _browser: any = null;
  private _page: any = null;
  private _runtime: BrowserRuntimeState | null = null;
  private _browserProcess: childProcess.ChildProcess | null = null;
  private _launchPromise: Promise<BrowserRuntimeState | null> | null = null;
  private _exitHooksRegistered = false;

  async isAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;
    try {
      // 动态 import，不安装不报错（可选依赖）
      // @ts-ignore — playwright 是可选依赖，不安装时 catch 降级
      this._pw = await import("playwright").catch(async () =>
        // @ts-ignore — playwright-core 是可选依赖，不安装时 catch 降级
        import("playwright-core").catch(() => null),
      );
      if (!this._pw) {
        console.warn("[PlaywrightProvider] neither playwright nor playwright-core is installed");
        this._available = false;
        return false;
      }
      console.log("[PlaywrightProvider] playwright module loaded successfully");
      this._available = true;
    } catch (err: any) {
      console.error("[PlaywrightProvider] failed to load playwright:", err?.message ?? err);
      this._available = false;
    }
    return this._available;
  }

  private getCdpUrl(): string {
    return resolveDeviceAgentEnv().browserCdpUrl;
  }

  private registerExitHooks() {
    if (this._exitHooksRegistered) return;
    this._exitHooksRegistered = true;
    const dispose = () => {
      try {
        this.stopOwnedBrowser();
      } catch {
      }
    };
    process.once("exit", dispose);
    process.once("SIGINT", dispose);
    process.once("SIGTERM", dispose);
  }

  private stopOwnedBrowser() {
    if (this._browserProcess?.pid && isChildAlive(this._browserProcess)) {
      try {
        if (process.platform === "win32") {
          childProcess.spawnSync("taskkill", ["/F", "/T", "/PID", String(this._browserProcess.pid)], { stdio: "ignore", windowsHide: true });
        } else {
          process.kill(this._browserProcess.pid, "SIGTERM");
        }
      } catch {
      }
    }
    this._browserProcess = null;
    if (this._runtime?.owned) this._runtime = null;
  }

  private async resetConnection() {
    try {
      await this._browser?.close?.();
    } catch {
    }
    this._browser = null;
    this._page = null;
  }

  private async ensureBrowserRuntime(): Promise<BrowserRuntimeState | null> {
    this.registerExitHooks();
    const externalCdpUrl = resolveDeviceAgentEnv().browserCdpUrl;
    if (externalCdpUrl && externalCdpUrl !== "http://localhost:9222") {
      console.log("[PlaywrightProvider] checking external CDP URL:", externalCdpUrl);
      const reachable = await waitForCdpEndpoint(externalCdpUrl, 1500);
      if (reachable) {
        console.log("[PlaywrightProvider] external CDP reachable");
        this._runtime = { executablePath: "", browserName: "external", debugPort: 0, cdpUrl: externalCdpUrl, profileDir: "", headless: false, args: [], owned: false };
        return this._runtime;
      }
      console.warn("[PlaywrightProvider] external CDP NOT reachable:", externalCdpUrl);
    }

    if (this._runtime?.owned) {
      const alive = isChildAlive(this._browserProcess);
      if (!alive) {
        this._runtime = null;
        this._browserProcess = null;
        await this.resetConnection();
      } else {
        const reachable = await waitForCdpEndpoint(this._runtime.cdpUrl, 1000);
        if (reachable) return this._runtime;
      }
    }

    if (this._launchPromise) return this._launchPromise;
    this._launchPromise = (async () => {
      console.log("[PlaywrightProvider] resolving browser launch plan...");
      const plan = await resolveBackgroundBrowserLaunchPlan();
      if (!plan) {
        console.error("[PlaywrightProvider] no browser executable found on this machine");
        return null;
      }
      console.log("[PlaywrightProvider] launching browser:", plan.executablePath, "port:", plan.debugPort, "headless:", plan.headless);
      await fs.mkdir(plan.profileDir, { recursive: true });
      const proc = childProcess.spawn(plan.executablePath, plan.args, {
        stdio: "ignore",
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      proc.unref();
      proc.once("exit", async () => {
        if (this._browserProcess?.pid === proc.pid) {
          this._browserProcess = null;
        }
        if (this._runtime?.pid === proc.pid) {
          this._runtime = null;
        }
        await this.resetConnection();
      });
      const ready = await waitForCdpEndpoint(plan.cdpUrl, 15000);
      if (!ready) {
        console.error("[PlaywrightProvider] CDP endpoint not ready after 15s at", plan.cdpUrl);
        try {
          if (proc.pid) {
            if (process.platform === "win32") {
              childProcess.spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore", windowsHide: true });
            } else {
              process.kill(proc.pid, "SIGTERM");
            }
          }
        } catch {
        }
        return null;
      }
      console.log("[PlaywrightProvider] browser launched successfully, CDP at:", plan.cdpUrl, "PID:", proc.pid);
      this._browserProcess = proc;
      this._runtime = { ...plan, owned: true, pid: proc.pid ?? undefined };
      return this._runtime;
    })();
    try {
      return await this._launchPromise;
    } finally {
      this._launchPromise = null;
    }
  }

  private async getHealthyPage() {
    if (!this._page) return null;
    try {
      await this._page.evaluate(() => document.readyState);
      return this._page;
    } catch {
      await this.resetConnection();
      return null;
    }
  }

  private async getContextAndPages() {
    console.log("[PlaywrightProvider.getContextAndPages] starting");
    const page = await this.ensurePage();
    console.log("[PlaywrightProvider.getContextAndPages] ensurePage returned:", page ? "page" : "null");
    if (!page) {
      console.error("[PlaywrightProvider.getContextAndPages] no page available");
      return null;
    }
    try {
      const context = page.context();
      const pages = context.pages();
      console.log("[PlaywrightProvider.getContextAndPages] context has", pages.length, "pages");
      return { context, pages };
    } catch (err: any) {
      console.error("[PlaywrightProvider.getContextAndPages] error:", err?.message ?? err);
      return null;
    }
  }

  private async getActivePageIndex(): Promise<number> {
    const info = await this.getContextAndPages();
    if (!info) return -1;
    return Math.max(0, info.pages.findIndex((item: any) => item === this._page));
  }

  private async getTabSummaries(): Promise<BrowserTabSummary[]> {
    const info = await this.getContextAndPages();
    if (!info) return [];
    const activeIndex = Math.max(0, info.pages.findIndex((item: any) => item === this._page));
    const rawTabs = await Promise.all(info.pages.map(async (tab: any) => ({
      url: await tab.url(),
      title: await tab.title().catch(() => ""),
    })));
    return summarizeBrowserTabs(rawTabs, activeIndex < 0 ? 0 : activeIndex);
  }

  private async ensurePage() {
    const healthyPage = await this.getHealthyPage();
    if (healthyPage) return healthyPage;
    if (!this._pw) {
      console.error("[PlaywrightProvider.ensurePage] playwright module not loaded (_pw is null)");
      return null;
    }
    try {
      const runtime = await this.ensureBrowserRuntime();
      const cdpUrl = runtime?.cdpUrl ?? this.getCdpUrl();
      console.log("[PlaywrightProvider.ensurePage] connecting via CDP:", cdpUrl);
      this._browser = await this._pw.chromium.connectOverCDP(cdpUrl);
      const contexts = this._browser.contexts();
      const ctx = contexts[0] ?? (await this._browser.newContext());
      const pages = ctx.pages();
      this._page = pages[0] ?? (await ctx.newPage());
      console.log("[PlaywrightProvider.ensurePage] connected successfully, pages:", pages.length);
      return this._page;
    } catch (err: any) {
      console.error("[PlaywrightProvider.ensurePage] first attempt failed:", err?.message ?? err);
      await this.resetConnection();
      if (this._runtime?.owned) {
        this.stopOwnedBrowser();
        try {
          console.log("[PlaywrightProvider.ensurePage] retrying with fresh browser...");
          const runtime = await this.ensureBrowserRuntime();
          if (!runtime) {
            console.error("[PlaywrightProvider.ensurePage] retry: no runtime available");
            return null;
          }
          this._browser = await this._pw.chromium.connectOverCDP(runtime.cdpUrl);
          const contexts = this._browser.contexts();
          const ctx = contexts[0] ?? (await this._browser.newContext());
          const pages = ctx.pages();
          this._page = pages[0] ?? (await ctx.newPage());
          console.log("[PlaywrightProvider.ensurePage] retry connected, pages:", pages.length);
          return this._page;
        } catch (retryErr: any) {
          console.error("[PlaywrightProvider.ensurePage] retry also failed:", retryErr?.message ?? retryErr);
        }
      }
      return null;
    }
  }

  async perceive(): Promise<PerceptionResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    if (!page) return { elements: [], source: "playwright", durationMs: Date.now() - start };

    try {
      const elements: ScreenElement[] = await page.evaluate(() => {
        const result: any[] = [];
        const all = document.querySelectorAll("a, button, input, textarea, select, [role=button], [onclick], label, h1, h2, h3, p, span, div");
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const text = (el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value?.trim() || (el as HTMLElement).getAttribute("aria-label") || "";
          if (!text) continue;
          const tag = el.tagName.toLowerCase();
          const interactable = ["a", "button", "input", "textarea", "select"].includes(tag) || el.hasAttribute("onclick") || el.getAttribute("role") === "button";
          result.push({
            text: text.slice(0, 200),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            tagName: tag,
            interactable,
          });
        }
        return result.slice(0, 200);
      });

      return {
        elements: elements.map((e: any) => ({
          text: e.text,
          bbox: { x: e.x, y: e.y, w: e.w, h: e.h },
          tagName: e.tagName,
          confidence: 1.0,
          interactable: e.interactable,
        })),
        source: "playwright",
        durationMs: Date.now() - start,
      };
    } catch {
      return { elements: [], source: "playwright", durationMs: Date.now() - start };
    }
  }

  async locateElement(query: string): Promise<ScreenElement | null> {
    const page = await this.ensurePage();
    if (!page) return null;

    try {
      const locator = page.getByText(query, { exact: false }).first();
      const box = await locator.boundingBox().catch(() => null);
      if (!box) return null;
      const tagName = await locator.evaluate((el: HTMLElement) => el.tagName.toLowerCase()).catch(() => "");
      return {
        text: query,
        bbox: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
        selector: `text=${query}`,
        tagName,
        confidence: 1.0,
        interactable: true,
      };
    } catch {
      return null;
    }
  }

  async executeAction(
    action: "click" | "type" | "select" | "scroll",
    target: ScreenElement,
    params?: Record<string, unknown>,
  ): Promise<ActionResult | null> {
    const page = await this.ensurePage();
    if (!page) return null;

    try {
      const locator = target.selector
        ? page.locator(target.selector).first()
        : page.getByText(target.text, { exact: false }).first();

      switch (action) {
        case "click":
          await locator.click({ timeout: 5000 });
          return { ok: true };
        case "type":
          await locator.fill(String(params?.text ?? ""), { timeout: 5000 });
          return { ok: true };
        case "select":
          await locator.selectOption(String(params?.value ?? ""), { timeout: 5000 });
          return { ok: true };
        case "scroll":
          await page.mouse.wheel(0, Number(params?.deltaY ?? 300));
          return { ok: true };
        default:
          return null;
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "playwright_action_failed" };
    }
  }

  async screenshot(params?: { selector?: string; fullPage?: boolean; format?: string }): Promise<BrowserScreenshotResult | null> {
    const page = await this.ensurePage();
    if (!page) return null;

    try {
      const format = String(params?.format ?? "png").toLowerCase() === "jpeg" ? "jpeg" : "png";
      const selector = String(params?.selector ?? "").trim();
      const title = await page.title().catch(() => "");
      const url = page.url();
      if (selector) {
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: "visible", timeout: 5000 });
        const box = await locator.boundingBox().catch(() => null);
        const buf: Buffer = await locator.screenshot({ type: format, timeout: 5000 });
        return {
          ok: true,
          contentBase64: buf.toString("base64"),
          width: box ? Math.round(box.width) : undefined,
          height: box ? Math.round(box.height) : undefined,
          format,
          title,
          url,
        };
      }

      const metrics = await page.evaluate((fullPage: boolean) => ({
        width: Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0),
        height: fullPage
          ? Math.max(
              document.body?.scrollHeight || 0,
              document.documentElement.scrollHeight || 0,
              document.documentElement.clientHeight || 0,
              window.innerHeight || 0,
            )
          : Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0),
      }), Boolean(params?.fullPage));
      const buf: Buffer = await page.screenshot({ type: format, fullPage: Boolean(params?.fullPage) });
      return {
        ok: true,
        contentBase64: buf.toString("base64"),
        width: Number(metrics?.width ?? 0),
        height: Number(metrics?.height ?? 0),
        format,
        title,
        url,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? "playwright_screenshot_failed") };
    }
  }

  async navigate(params: { url: string; waitUntil?: string; timeoutMs?: number }): Promise<BrowserNavigateResult | null> {
    const page = await this.ensurePage();
    if (!page) return null;
    try {
      await page.goto(params.url, {
        waitUntil: params.waitUntil ?? "domcontentloaded",
        timeout: params.timeoutMs ?? 15000,
      });
      const title = await page.title().catch(() => "");
      const readyState = await page.evaluate(() => document.readyState).catch(() => "unknown");
      return {
        ok: true,
        url: page.url(),
        title,
        readyState,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? "playwright_navigate_failed") };
    }
  }

  async waitFor(params: { selector?: string; text?: string; timeoutMs: number; state?: string }): Promise<BrowserWaitResult | null> {
    const page = await this.ensurePage();
    if (!page) return null;
    const startedAt = Date.now();
    const selector = String(params.selector ?? "").trim();
    const text = String(params.text ?? "").trim();
    const state = String(params.state ?? "visible").trim() || "visible";
    try {
      if (selector) {
        await page.locator(selector).first().waitFor({ state, timeout: params.timeoutMs });
        return { ok: true, found: true, waitedMs: Date.now() - startedAt, matchedText: selector };
      }
      if (text) {
        await page.waitForFunction(
          (expected: string) => Boolean(document.body?.innerText?.includes(expected)),
          text,
          { timeout: params.timeoutMs },
        );
        const pageTextSample: string[] = await page.evaluate((expected: string) => {
          const raw = document.body?.innerText ?? "";
          return raw.split(/\n+/).map((item) => item.trim()).filter(Boolean).filter((item) => item.includes(expected)).slice(0, 20);
        }, text).catch(() => []);
        return { ok: true, found: true, waitedMs: Date.now() - startedAt, matchedText: text, pageTextSample };
      }
      await page.waitForLoadState("domcontentloaded", { timeout: params.timeoutMs });
      return { ok: true, found: true, waitedMs: Date.now() - startedAt };
    } catch (e: any) {
      const pageTextSample: string[] = await page.evaluate(() => {
        const raw = document.body?.innerText ?? "";
        return raw.split(/\n+/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
      }).catch(() => []);
      const message = String(e?.message ?? "");
      const timeoutLike = /timeout/i.test(message);
      return {
        ok: timeoutLike ? false : false,
        found: false,
        waitedMs: Date.now() - startedAt,
        matchedText: text || selector || undefined,
        pageTextSample,
        error: message || "playwright_wait_failed",
      };
    }
  }

  async extract(params: { selector?: string; attribute?: string; multiple?: boolean; filter?: string }): Promise<BrowserExtractResult | null> {
    const page = await this.ensurePage();
    if (!page) return null;
    const selector = String(params.selector ?? "").trim();
    if (!selector) return null;
    try {
      const raw = await page.evaluate((input: { selector: string; attribute?: string; multiple?: boolean; filter?: string }) => {
        const nodes = Array.from(document.querySelectorAll(input.selector));
        const items = nodes.map((node) => {
          const el = node as HTMLElement;
          const rect = el.getBoundingClientRect();
          const text = input.attribute
            ? el.getAttribute(input.attribute) ?? ""
            : ("value" in el && typeof (el as HTMLInputElement).value === "string" && (el as HTMLInputElement).value)
              ? String((el as HTMLInputElement).value)
              : (el.innerText || el.textContent || "").trim();
          return {
            text: String(text ?? "").trim(),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            selector: input.selector,
            tagName: el.tagName.toLowerCase(),
          };
        }).filter((item) => item.text);
        return input.filter
          ? items.filter((item) => item.text.toLowerCase().includes(String(input.filter).toLowerCase()))
          : items;
      }, { selector, attribute: params.attribute, multiple: params.multiple, filter: params.filter });
      const items = Array.isArray(raw) ? raw : [];
      const values = (params.multiple ? items : items.slice(0, 1)).map((item: any) => String(item.text));
      return {
        ok: true,
        value: values[0],
        values: params.multiple ? values : undefined,
        count: items.length,
        elements: items.map((item: any) => ({
          text: String(item.text),
          x: Number(item.x ?? 0),
          y: Number(item.y ?? 0),
          w: Number(item.w ?? 0),
          h: Number(item.h ?? 0),
          selector: String(item.selector ?? selector),
          tagName: String(item.tagName ?? ""),
        })),
      };
    } catch (e: any) {
      return { ok: false, count: 0, error: String(e?.message ?? "playwright_extract_failed") };
    }
  }

  async evaluate(params: { script: string; args?: unknown[] }): Promise<BrowserEvaluateResult | null> {
    const page = await this.ensurePage();
    if (!page) return null;
    try {
      const result = await page.evaluate(({ script, args }: { script: string; args?: unknown[] }) => {
        const fn = new Function("args", script);
        return fn(args ?? []);
      }, { script: params.script, args: params.args });
      return { ok: true, result };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? "playwright_evaluate_failed") };
    }
  }

  async getSessionStatus(): Promise<BrowserSessionStatus | null> {
    const runtime = await this.ensureBrowserRuntime();
    if (!runtime) {
      return { ok: false, connected: false, owned: false, error: "browser_runtime_unavailable" };
    }
    const tabs = await this.getTabSummaries().catch(() => []);
    const active = tabs.find((item) => item.active);
    return {
      ok: true,
      connected: Boolean(await this.ensurePage()),
      owned: runtime.owned,
      browserName: runtime.browserName,
      cdpUrl: runtime.cdpUrl,
      debugPort: runtime.debugPort,
      profileDir: runtime.profileDir,
      headless: runtime.headless,
      pid: runtime.pid,
      activeTabId: active?.id,
      activeUrl: active?.url,
      activeTitle: active?.title,
      tabCount: tabs.length,
      tabs,
    };
  }

  async listTabs(): Promise<BrowserTabSummary[] | null> {
    return this.getTabSummaries();
  }

  async newTab(params?: { url?: string; activate?: boolean }): Promise<BrowserTabSummary | null> {
    console.log("[PlaywrightProvider.newTab] starting, params:", JSON.stringify(params));
    const info = await this.getContextAndPages();
    if (!info) {
      console.error("[PlaywrightProvider.newTab] getContextAndPages returned null");
      return null;
    }
    console.log("[PlaywrightProvider.newTab] got context and pages, page count:", info.pages.length);
    try {
      const page = await info.context.newPage();
      console.log("[PlaywrightProvider.newTab] created new page");
      if (params?.url) {
        console.log("[PlaywrightProvider.newTab] navigating to URL:", params.url);
        await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch((err: any) => {
          console.error("[PlaywrightProvider.newTab] navigation failed:", err?.message ?? err);
        });
      }
      if (params?.activate !== false) {
        this._page = page;
        console.log("[PlaywrightProvider.newTab] set as active page");
      }
      const tabs = await this.getTabSummaries();
      console.log("[PlaywrightProvider.newTab] got tab summaries, count:", tabs.length);
      const activeIndex = tabs.findIndex((tab) => tab.active && params?.activate !== false);
      const urlIndex = tabs.findIndex((tab) => tab.url === page.url());
      const targetIndex = activeIndex >= 0 ? activeIndex : urlIndex >= 0 ? urlIndex : tabs.length - 1;
      const result = tabs[Math.max(0, targetIndex)] ?? null;
      console.log("[PlaywrightProvider.newTab] returning result:", result ? "success" : "null", "index:", targetIndex);
      return result;
    } catch (err: any) {
      console.error("[PlaywrightProvider.newTab] error:", err?.message ?? err);
      return null;
    }
  }

  async switchTab(params: { tabId?: string; index?: number }): Promise<BrowserTabSummary | null> {
    const info = await this.getContextAndPages();
    if (!info) return null;
    const targetIndex = typeof params.index === "number"
      ? params.index
      : typeof params.tabId === "string" && /^tab-(\d+)$/.test(params.tabId)
        ? Number(params.tabId.match(/^tab-(\d+)$/)?.[1] ?? -1)
        : -1;
    if (targetIndex < 0 || targetIndex >= info.pages.length) return null;
    this._page = info.pages[targetIndex];
    const tabs = await this.getTabSummaries();
    return tabs[targetIndex] ?? null;
  }

  async closeTab(params: { tabId?: string; index?: number }): Promise<{ ok: boolean; closedTabId?: string; remainingTabs?: number; activeTabId?: string; error?: string } | null> {
    const info = await this.getContextAndPages();
    if (!info) return null;
    const targetIndex = typeof params.index === "number"
      ? params.index
      : typeof params.tabId === "string" && /^tab-(\d+)$/.test(params.tabId)
        ? Number(params.tabId.match(/^tab-(\d+)$/)?.[1] ?? -1)
        : info.pages.length - 1;
    if (targetIndex < 0 || targetIndex >= info.pages.length) {
      return { ok: false, error: "tab_not_found" };
    }
    const closing = info.pages[targetIndex];
    await closing.close({ runBeforeUnload: false }).catch(() => {});
    const remainingTabs = await this.getTabSummaries();
    if (remainingTabs.length > 0) {
      const nextActiveIndex = Math.min(targetIndex, remainingTabs.length - 1);
      const switched = await this.switchTab({ index: nextActiveIndex }).catch(() => null);
      return {
        ok: true,
        closedTabId: createTabId(targetIndex),
        remainingTabs: remainingTabs.length,
        activeTabId: switched?.id ?? remainingTabs[nextActiveIndex]?.id,
      };
    }
    const fresh = await this.newTab({ activate: true }).catch(() => null);
    return {
      ok: true,
      closedTabId: createTabId(targetIndex),
      remainingTabs: fresh ? 1 : 0,
      activeTabId: fresh?.id,
    };
  }
}

// ── 简化感知路由：直接使用 PlaywrightProvider，无多Provider级联 ──

let _playwrightProvider: PlaywrightProvider | null = null;
let _initialized = false;

/**
 * 初始化感知提供者 — 仅探测 Playwright 是否可用。
 * 感知决策路由已移至云端，端侧只保留 Playwright 执行引擎。
 */
export async function initPerceptionProviders(cfg?: { apiBase: string; deviceToken: string }): Promise<boolean> {
  if (_initialized) return Boolean(_playwrightProvider);
  const pw = new PlaywrightProvider();
  try {
    const ok = await pw.isAvailable();
    if (ok) {
      _playwrightProvider = pw;
      console.log("[perceptionRouter] Playwright available");
    } else {
      console.log("[perceptionRouter] Playwright not available, browser tools disabled");
    }
  } catch (err: any) {
    console.warn("[perceptionRouter] Playwright probe failed:", err?.message ?? err);
  }
  _initialized = true;
  return Boolean(_playwrightProvider);
}

/** 获取当前感知引擎名称 */
export function getActiveProviderName(): string {
  return _playwrightProvider ? "playwright" : "none";
}

/**
 * 感知当前屏幕 — 使用 Playwright DOM 感知，无 Playwright 时回退 OCR。
 */
export async function perceive(): Promise<PerceptionResult> {
  if (_playwrightProvider) {
    try {
      const result = await _playwrightProvider.perceive();
      if (result.elements.length > 0) return result;
    } catch { /* fall through to OCR */ }
  }
  // OCR 回退：直接使用 localVision，不再经过 Provider 封装
  const start = Date.now();
  const capture = await captureScreen();
  try {
    const ocrResults = await ocrScreen(capture);
    return {
      elements: ocrResults.map((m) => ({
        text: m.text,
        bbox: m.bbox,
        confidence: m.confidence,
        interactable: true,
      })),
      source: "local_ocr",
      durationMs: Date.now() - start,
    };
  } catch {
    return { elements: [], source: "local_ocr", durationMs: Date.now() - start };
  } finally {
    await cleanupCapture(capture).catch(() => {});
  }
}

/**
 * 定位并执行动作 — Playwright 优先，回退 OCR + 鼠标模拟。
 */
export async function locateAndAct(
  query: string,
  action: "click" | "type" | "select" | "scroll",
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; element: ScreenElement; source: string; usedMouseSimulation: boolean; error?: string } | null> {
  if (_playwrightProvider) {
    try {
      const el = await _playwrightProvider.locateElement(query);
      if (el) {
        const actionResult = await _playwrightProvider.executeAction(action, el, params);
        if (actionResult) {
          return { ok: actionResult.ok, element: el, source: "playwright", usedMouseSimulation: false, error: actionResult.error };
        }
        // 回退到鼠标模拟
        if (el.bbox) {
          const cx = Math.round(el.bbox.x + el.bbox.w / 2);
          const cy = Math.round(el.bbox.y + el.bbox.h / 2);
          switch (action) {
            case "click":
              await clickMouse(cx, cy);
              return { ok: true, element: el, source: "playwright", usedMouseSimulation: true };
            case "type":
              await clickMouse(cx, cy);
              await new Promise((r) => setTimeout(r, 200));
              await localTypeText(String(params?.text ?? ""));
              return { ok: true, element: el, source: "playwright", usedMouseSimulation: true };
            case "scroll":
              await localScroll((params?.direction as any) ?? "down", Number(params?.clicks ?? 3));
              return { ok: true, element: el, source: "playwright", usedMouseSimulation: true };
            default:
              return { ok: true, element: el, source: "playwright", usedMouseSimulation: true };
          }
        }
        return { ok: false, element: el, source: "playwright", usedMouseSimulation: false, error: "element_found_but_no_coordinates" };
      }
    } catch { /* fall through to OCR */ }
  }

  // OCR 回退
  const capture = await captureScreen();
  try {
    const ocrResults = await ocrScreen(capture);
    const match = findTextInOcrResults(ocrResults, query);
    if (!match) return null;
    const el: ScreenElement = { text: query, bbox: match.bbox, confidence: match.confidence, interactable: true };
    const cx = Math.round(match.bbox.x + match.bbox.w / 2);
    const cy = Math.round(match.bbox.y + match.bbox.h / 2);
    switch (action) {
      case "click":
        await clickMouse(cx, cy);
        return { ok: true, element: el, source: "local_ocr", usedMouseSimulation: true };
      case "type":
        await clickMouse(cx, cy);
        await new Promise((r) => setTimeout(r, 200));
        await localTypeText(String(params?.text ?? ""));
        return { ok: true, element: el, source: "local_ocr", usedMouseSimulation: true };
      case "scroll":
        await localScroll((params?.direction as any) ?? "down", Number(params?.clicks ?? 3));
        return { ok: true, element: el, source: "local_ocr", usedMouseSimulation: true };
      default:
        return { ok: true, element: el, source: "local_ocr", usedMouseSimulation: true };
    }
  } finally {
    await cleanupCapture(capture).catch(() => {});
  }
}

/**
 * 纯感知定位（不执行动作）。
 */
export async function locateElement(query: string): Promise<{ element: ScreenElement; source: string } | null> {
  if (_playwrightProvider) {
    try {
      const el = await _playwrightProvider.locateElement(query);
      if (el) return { element: el, source: "playwright" };
    } catch { /* fall through */ }
  }
  // OCR 回退
  const capture = await captureScreen();
  try {
    const ocrResults = await ocrScreen(capture);
    const match = findTextInOcrResults(ocrResults, query);
    if (!match) return null;
    return { element: { text: query, bbox: match.bbox, confidence: match.confidence, interactable: true }, source: "local_ocr" };
  } finally {
    await cleanupCapture(capture).catch(() => {});
  }
}

// ── browserDom* 函数：直接代理 PlaywrightProvider ──────────────────

export async function browserDomScreenshot(params?: { selector?: string; fullPage?: boolean; format?: string }): Promise<(BrowserScreenshotResult & { source: string }) | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.screenshot(params);
    return result ? { ...result, source: "playwright" } : null;
  } catch { return null; }
}

export async function browserDomNavigate(params: { url: string; waitUntil?: string; timeoutMs?: number }): Promise<(BrowserNavigateResult & { source: string }) | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.navigate(params);
    return result ? { ...result, source: "playwright" } : null;
  } catch { return null; }
}

export async function browserDomWaitFor(params: { selector?: string; text?: string; timeoutMs: number; state?: string }): Promise<(BrowserWaitResult & { source: string }) | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.waitFor(params);
    return result ? { ...result, source: "playwright" } : null;
  } catch { return null; }
}

export async function browserDomExtract(params: { selector?: string; attribute?: string; multiple?: boolean; filter?: string }): Promise<(BrowserExtractResult & { source: string }) | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.extract(params);
    return result ? { ...result, source: "playwright" } : null;
  } catch { return null; }
}

export async function browserDomEvaluate(params: { script: string; args?: unknown[] }): Promise<(BrowserEvaluateResult & { source: string }) | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.evaluate(params);
    return result ? { ...result, source: "playwright" } : null;
  } catch { return null; }
}

export async function browserDomSessionStatus(): Promise<(BrowserSessionStatus & { source: string }) | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.getSessionStatus();
    return result ? { ...result, source: "playwright" } : null;
  } catch { return null; }
}

export async function browserDomListTabs(): Promise<{ tabs: BrowserTabSummary[]; source: string } | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.listTabs();
    return result ? { tabs: result, source: "playwright" } : null;
  } catch { return null; }
}

export async function browserDomNewTab(params?: { url?: string; activate?: boolean }): Promise<(BrowserTabSummary & { source: string }) | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.newTab(params);
    return result ? { ...result, source: "playwright" } : null;
  } catch { return null; }
}

export async function browserDomSwitchTab(params: { tabId?: string; index?: number }): Promise<(BrowserTabSummary & { source: string }) | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.switchTab(params);
    return result ? { ...result, source: "playwright" } : null;
  } catch { return null; }
}

export async function browserDomCloseTab(params: { tabId?: string; index?: number }): Promise<({ ok: boolean; closedTabId?: string; remainingTabs?: number; activeTabId?: string; error?: string } & { source: string }) | null> {
  if (!_playwrightProvider) return null;
  try {
    const result = await _playwrightProvider.closeTab(params);
    return result ? { ...result, source: "playwright" } : null;
  } catch { return null; }
}
