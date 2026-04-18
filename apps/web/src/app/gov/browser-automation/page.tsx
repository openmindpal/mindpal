import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";

const COPY = {
  "zh-CN": {
    title: "\u6d4f\u89c8\u5668\u81ea\u52a8\u5316",
    subtitle: "\u67e5\u770b\u6d4f\u89c8\u5668\u81ea\u52a8\u5316\u80fd\u529b\u4e0e\u8c03\u8bd5\u5165\u53e3\u3002",
    sections: [
      {
        title: "\u5df2\u63a5\u901a\u80fd\u529b",
        items: [
          "\u9875\u9762\u5bfc\u822a\u3001\u622a\u56fe\u3001\u70b9\u51fb\u3001\u8f93\u5165\u3001\u6eda\u52a8\u3001\u63d0\u53d6\u3001\u7b49\u5f85",
          "\u6d4f\u89c8\u5668\u4f1a\u8bdd\u72b6\u6001\u4e0e\u6807\u7b7e\u9875\u7ba1\u7406",
          "\u901a\u8fc7\u5728\u7ebf desktop device-agent \u6267\u884c",
        ],
      },
      {
        title: "\u5e38\u7528\u63a5\u53e3",
        items: [
          "POST /browser-automation/navigate",
          "POST /browser-automation/click",
          "POST /browser-automation/type",
          "POST /browser-automation/select",
          "POST /browser-automation/scroll",
          "POST /browser-automation/extract",
          "POST /browser-automation/waitFor",
          "GET /browser-automation/session/status",
          "GET /browser-automation/tabs",
          "POST /browser-automation/tab/new",
          "POST /browser-automation/tab/switch",
          "POST /browser-automation/tab/close",
        ],
      },
      {
        title: "\u6267\u884c\u8bf4\u660e",
        items: [
          "selector \u5b57\u6bb5\u517c\u5bb9 CSS \u9009\u62e9\u5668\u3001\u53ef\u89c1\u6587\u672c\u4e0e\u517c\u5bb9\u67e5\u8be2\u8868\u8fbe\u5f0f",
          "\u4f1a\u4f18\u5148\u5c1d\u8bd5 DOM/\u6d4f\u89c8\u5668\u9a71\u52a8\u80fd\u529b\uff0c\u5931\u8d25\u65f6\u56de\u9000\u672c\u5730\u89c6\u89c9/OCR",
          "\u8bbe\u5907\u79bb\u7ebf\u6216\u6743\u9650\u7b56\u7565\u4e0d\u6ee1\u8db3\u65f6\u4f1a\u8fd4\u56de\u6267\u884c\u5931\u8d25",
        ],
      },
    ],
  },
  "en-US": {
    title: "Browser Automation",
    subtitle: "Inspect browser automation capabilities and debugging entrypoints.",
    sections: [
      {
        title: "Available capabilities",
        items: [
          "Navigate, screenshot, click, type, scroll, extract, and wait",
          "Browser session status and tab management",
          "Executed through an online desktop device-agent",
        ],
      },
      {
        title: "Common endpoints",
        items: [
          "POST /browser-automation/navigate",
          "POST /browser-automation/click",
          "POST /browser-automation/type",
          "POST /browser-automation/select",
          "POST /browser-automation/scroll",
          "POST /browser-automation/extract",
          "POST /browser-automation/waitFor",
          "GET /browser-automation/session/status",
          "GET /browser-automation/tabs",
          "POST /browser-automation/tab/new",
          "POST /browser-automation/tab/switch",
          "POST /browser-automation/tab/close",
        ],
      },
      {
        title: "Notes",
        items: [
          "The selector field accepts CSS selectors, visible text, and compatible query expressions",
          "The runtime prefers DOM/browser-driver execution and falls back to local vision or OCR when needed",
          "Requests fail when the device is offline or blocked by policy",
        ],
      },
    ],
  },
} as const;

export default async function GovBrowserAutomationPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams) === "en-US" ? "en-US" : "zh-CN";
  const copy = COPY[locale];

  return (
    <main style={{ display: "grid", gap: 16 }}>
      <section style={{ display: "grid", gap: 8 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{copy.title}</h1>
        <p style={{ color: "var(--sl-muted)" }}>{copy.subtitle}</p>
      </section>
      {copy.sections.map((section) => (
        <section key={section.title} style={{ border: "1px solid var(--sl-border)", borderRadius: 12, padding: 16, background: "var(--sl-panel)" }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>{section.title}</h2>
          <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
