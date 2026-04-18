/**
 * completionNotifier.ts 单元测试
 * 测试导出的纯函数 formatNotificationContent() 和常量 DEFAULT_NOTIFICATION_TEMPLATES
 */
import { describe, it, expect } from "vitest";
import { formatNotificationContent, DEFAULT_NOTIFICATION_TEMPLATES } from "./completionNotifier";
import type { NotificationEvent } from "./completionNotifier";

/* ================================================================== */
/*  DEFAULT_NOTIFICATION_TEMPLATES 常量验证                             */
/* ================================================================== */

describe("DEFAULT_NOTIFICATION_TEMPLATES", () => {
  const allEvents: NotificationEvent[] = [
    "run.succeeded", "run.failed", "run.canceled", "run.needs_approval",
    "step.succeeded", "step.failed",
    "task.completed", "task.long_running",
  ];

  it("所有事件类型都有对应模板", () => {
    for (const event of allEvents) {
      expect(DEFAULT_NOTIFICATION_TEMPLATES[event]).toBeDefined();
    }
  });

  it("每个模板都包含中英文 title 和 body", () => {
    for (const event of allEvents) {
      const tmpl = DEFAULT_NOTIFICATION_TEMPLATES[event];
      expect(tmpl.title).toHaveProperty("zh");
      expect(tmpl.title).toHaveProperty("en");
      expect(tmpl.body).toHaveProperty("zh");
      expect(tmpl.body).toHaveProperty("en");
      expect(typeof tmpl.title.zh).toBe("string");
      expect(typeof tmpl.title.en).toBe("string");
      expect(typeof tmpl.body.zh).toBe("string");
      expect(typeof tmpl.body.en).toBe("string");
    }
  });

  it("run.succeeded 模板包含 {{runId}} 占位符", () => {
    expect(DEFAULT_NOTIFICATION_TEMPLATES["run.succeeded"].body.zh).toContain("{{runId}}");
    expect(DEFAULT_NOTIFICATION_TEMPLATES["run.succeeded"].body.en).toContain("{{runId}}");
  });

  it("run.needs_approval 模板包含 {{toolRef}} 占位符", () => {
    expect(DEFAULT_NOTIFICATION_TEMPLATES["run.needs_approval"].body.zh).toContain("{{toolRef}}");
    expect(DEFAULT_NOTIFICATION_TEMPLATES["run.needs_approval"].body.en).toContain("{{toolRef}}");
  });

  it("task.long_running 模板包含 {{durationMinutes}} 占位符", () => {
    expect(DEFAULT_NOTIFICATION_TEMPLATES["task.long_running"].body.zh).toContain("{{durationMinutes}}");
    expect(DEFAULT_NOTIFICATION_TEMPLATES["task.long_running"].body.en).toContain("{{durationMinutes}}");
  });
});

/* ================================================================== */
/*  formatNotificationContent                                           */
/* ================================================================== */

describe("formatNotificationContent", () => {
  it("替换单个变量", () => {
    const result = formatNotificationContent({
      template: "运行 {{runId}} 已完成",
      variables: { runId: "run-123" },
    });
    expect(result).toBe("运行 run-123 已完成");
  });

  it("替换多个变量", () => {
    const result = formatNotificationContent({
      template: "任务 {{taskId}} 的步骤 {{stepId}} 已完成",
      variables: { taskId: "task-001", stepId: "step-005" },
    });
    expect(result).toBe("任务 task-001 的步骤 step-005 已完成");
  });

  it("同一变量多次出现全部替换", () => {
    const result = formatNotificationContent({
      template: "{{name}} 你好，欢迎 {{name}}！",
      variables: { name: "张三" },
    });
    expect(result).toBe("张三 你好，欢迎 张三！");
  });

  it("变量值为 null/undefined 替换为空字符串", () => {
    const result = formatNotificationContent({
      template: "结果: {{value}}",
      variables: { value: null },
    });
    expect(result).toBe("结果: ");
  });

  it("变量值为数字正确转换为字符串", () => {
    const result = formatNotificationContent({
      template: "已运行 {{durationMinutes}} 分钟",
      variables: { durationMinutes: 30 },
    });
    expect(result).toBe("已运行 30 分钟");
  });

  it("变量值为布尔值正确转换", () => {
    const result = formatNotificationContent({
      template: "启用: {{enabled}}",
      variables: { enabled: true },
    });
    expect(result).toBe("启用: true");
  });

  it("模板中无占位符时原样返回", () => {
    const result = formatNotificationContent({
      template: "这是一条纯文本通知",
      variables: { unused: "value" },
    });
    expect(result).toBe("这是一条纯文本通知");
  });

  it("空变量对象不影响模板", () => {
    const result = formatNotificationContent({
      template: "固定内容 {{placeholder}}",
      variables: {},
    });
    expect(result).toBe("固定内容 {{placeholder}}");
  });

  it("空模板返回空字符串", () => {
    const result = formatNotificationContent({
      template: "",
      variables: { key: "value" },
    });
    expect(result).toBe("");
  });

  it("与 DEFAULT_NOTIFICATION_TEMPLATES 配合使用", () => {
    const tmpl = DEFAULT_NOTIFICATION_TEMPLATES["run.succeeded"];
    const zhResult = formatNotificationContent({
      template: tmpl.body.zh,
      variables: { runId: "run-abc-123" },
    });
    expect(zhResult).toContain("run-abc-123");
    expect(zhResult).not.toContain("{{runId}}");

    const enResult = formatNotificationContent({
      template: tmpl.body.en,
      variables: { runId: "run-abc-123" },
    });
    expect(enResult).toContain("run-abc-123");
    expect(enResult).not.toContain("{{runId}}");
  });

  it("处理 run.needs_approval 模板", () => {
    const tmpl = DEFAULT_NOTIFICATION_TEMPLATES["run.needs_approval"];
    const result = formatNotificationContent({
      template: tmpl.body.zh,
      variables: { toolRef: "deploy@2.0.0" },
    });
    expect(result).toContain("deploy@2.0.0");
  });

  it("处理 task.long_running 模板", () => {
    const tmpl = DEFAULT_NOTIFICATION_TEMPLATES["task.long_running"];
    const result = formatNotificationContent({
      template: tmpl.body.en,
      variables: { durationMinutes: 45 },
    });
    expect(result).toContain("45");
    expect(result).not.toContain("{{durationMinutes}}");
  });

  it("locale 参数目前不影响结果（预留扩展）", () => {
    const result1 = formatNotificationContent({
      template: "Hello {{name}}",
      variables: { name: "World" },
      locale: "zh",
    });
    const result2 = formatNotificationContent({
      template: "Hello {{name}}",
      variables: { name: "World" },
      locale: "en",
    });
    expect(result1).toBe(result2);
  });
});
