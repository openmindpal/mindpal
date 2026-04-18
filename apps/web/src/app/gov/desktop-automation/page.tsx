import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";

const COPY = {
  "zh-CN": {
    title: "\u684c\u9762\u81ea\u52a8\u5316",
    subtitle: "\u67e5\u770b\u684c\u9762\u81ea\u52a8\u5316\u80fd\u529b\u4e0e\u8c03\u8bd5\u5165\u53e3\u3002",
    sections: [
      {
        title: "\u5df2\u63a5\u901a\u80fd\u529b",
        items: [
          "\u5e94\u7528\u542f\u52a8\u3001\u7a97\u53e3\u5217\u8868/\u805a\u7126/\u8c03\u6574\u5927\u5c0f",
          "\u9f20\u6807\u70b9\u51fb\u3001\u79fb\u52a8\u3001\u62d6\u62fd\u4e0e\u952e\u76d8\u8f93\u5165/\u5feb\u6377\u952e",
          "\u5c4f\u5e55\u622a\u56fe\u3001OCR\u3001\u526a\u8d34\u677f\u8bfb\u53d6/\u5199\u5165\u3001\u6587\u4ef6\u5bf9\u8bdd\u6846",
        ],
      },
      {
        title: "\u5e38\u7528\u63a5\u53e3",
        items: [
          "POST /desktop-automation/launch",
          "GET /desktop-automation/windows",
          "POST /desktop-automation/window/focus",
          "POST /desktop-automation/window/resize",
          "POST /desktop-automation/mouse/click",
          "POST /desktop-automation/mouse/move",
          "POST /desktop-automation/mouse/drag",
          "POST /desktop-automation/keyboard/type",
          "POST /desktop-automation/keyboard/hotkey",
          "POST /desktop-automation/screen/capture",
          "POST /desktop-automation/screen/ocr",
          "GET /desktop-automation/clipboard",
          "POST /desktop-automation/clipboard",
          "POST /desktop-automation/file/dialog",
        ],
      },
      {
        title: "\u6267\u884c\u8bf4\u660e",
        items: [
          "\u5f53\u524d\u8fd0\u884c\u65f6\u5df2\u5bf9\u9f50 Windows\u3001macOS \u4e0e Linux \u7684\u684c\u9762\u4f1a\u8bdd\u80fd\u529b",
          "\u7a97\u53e3\u5217\u8868/\u805a\u7126/\u8c03\u6574\u5927\u5c0f\u4f1a\u4f9d\u8d56\u7cfb\u7edf\u56fe\u5f62\u81ea\u52a8\u5316\u540e\u7aef\uff08macOS Accessibility\u3001Linux wmctrl/xdotool \u7b49\uff09",
          "\u622a\u56fe\u652f\u6301\u6574\u5c4f\u3001\u533a\u57df\u4e0e\u7a97\u53e3\u8fb9\u754c\u622a\u53d6\uff0c\u526a\u8d34\u677f\u4e0e\u6587\u4ef6\u5bf9\u8bdd\u6846\u53d7 requireUserPresence \u4e0e\u7b56\u7565\u63a7\u5236",
        ],
      },
    ],
  },
  "en-US": {
    title: "Desktop Automation",
    subtitle: "Inspect desktop automation capabilities and debugging entrypoints.",
    sections: [
      {
        title: "Available capabilities",
        items: [
          "Application launch plus window list, focus, and resize",
          "Mouse click, move, drag, and keyboard type or hotkeys",
          "Screen capture, OCR, clipboard read or write, and file dialogs",
        ],
      },
      {
        title: "Common endpoints",
        items: [
          "POST /desktop-automation/launch",
          "GET /desktop-automation/windows",
          "POST /desktop-automation/window/focus",
          "POST /desktop-automation/window/resize",
          "POST /desktop-automation/mouse/click",
          "POST /desktop-automation/mouse/move",
          "POST /desktop-automation/mouse/drag",
          "POST /desktop-automation/keyboard/type",
          "POST /desktop-automation/keyboard/hotkey",
          "POST /desktop-automation/screen/capture",
          "POST /desktop-automation/screen/ocr",
          "GET /desktop-automation/clipboard",
          "POST /desktop-automation/clipboard",
          "POST /desktop-automation/file/dialog",
        ],
      },
      {
        title: "Notes",
        items: [
          "The current runtime aligns desktop-session capabilities across Windows, macOS, and Linux",
          "Window list, focus, and resize rely on the native GUI automation backend such as macOS Accessibility or Linux wmctrl or xdotool",
          "Screen capture supports full-screen, region, and window-bounds capture, while clipboard and file dialogs remain gated by requireUserPresence and policy",
        ],
      },
    ],
  },
} as const;

export default async function GovDesktopAutomationPage(props: { searchParams: Promise<SearchParams> }) {
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
