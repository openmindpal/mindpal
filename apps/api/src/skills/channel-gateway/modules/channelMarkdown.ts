/**
 * 渠道层 Markdown 格式化 — 将标准 Markdown 转换为各平台原生富文本格式
 * 纯字符串替换，零外部依赖
 */

/**
 * 将标准 Markdown 转换为目标平台的富文本格式
 */
export function formatMarkdownForProvider(provider: string, markdown: string): string {
  if (!markdown) return "";
  switch (provider) {
    case "slack":
      return toSlackMrkdwn(markdown);
    case "feishu":
      // 飞书消息卡片原生支持 Markdown 子集（bold/italic/code/list），直接透传
      return markdown;
    case "dingtalk":
      return toDingtalkMarkdown(markdown);
    case "wecom":
      // 企业微信 Markdown 兼容度高，直接透传
      return markdown;
    case "wechat":
      return stripMarkdown(markdown);
    case "qq":
    case "qq.onebot":
      return stripMarkdown(markdown);
    case "discord":
      // Discord 原生支持标准 Markdown，直接透传
      return markdown;
    default:
      // Bridge 及其他：透传
      return markdown;
  }
}

/**
 * 标准 Markdown → Slack mrkdwn 格式
 * 参考: https://api.slack.com/reference/surfaces/formatting
 */
function toSlackMrkdwn(md: string): string {
  let out = md;

  // bold: **text** or __text__ → *text*
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  out = out.replace(/__(.+?)__/g, "*$1*");

  // italic: *text* (单星号，且不是 bold 的 ** ) → _text_
  // 注意：此时 ** 已被替换为 *，所以单独的 *text* 不会误匹配
  // Slack 用 _text_ 表示斜体
  // 但由于 bold 已转为 *text*，这里跳过 italic 以避免冲突

  // strikethrough: ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, "~$1~");

  // inline code: `code` → `code` (保持不变)

  // code block: ```lang\n...\n``` → ```\n...\n``` (保持不变)

  // images: ![alt](url) → <url|alt> (Slack 不内联渲染图片，但保留链接)（须在链接之前匹配）
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // links: [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // headers: # text → *text* (Slack 无标题语法，用 bold 替代)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // blockquote: > text → > text (Slack 原生支持)

  // unordered list: - item or * item → • item
  out = out.replace(/^[\s]*[-*]\s+/gm, "• ");

  // ordered list: 1. item → 1. item (保持不变，Slack 会渲染)

  // horizontal rule: --- or *** → ———
  out = out.replace(/^[-*]{3,}$/gm, "———");

  return out;
}

/**
 * 标准 Markdown → 钉钉 Markdown 子集
 * 钉钉支持：标题(#)、加粗(**)、链接、有序/无序列表、图片
 * 不支持：删除线
 */
function toDingtalkMarkdown(md: string): string {
  // 剥离删除线标记，保留文本
  return md.replace(/~~(.+?)~~/g, "$1");
}

/**
 * 剥离所有常见 Markdown 语法 → 纯文本
 * 用于微信、QQ 等不支持 Markdown 的平台
 */
function stripMarkdown(md: string): string {
  let out = md;

  // 代码块: ```lang\n...\n``` → 内容
  out = out.replace(/```[\s\S]*?```/g, (m) =>
    m.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, ""),
  );

  // 图片: ![alt](url) → [图片: alt]
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片: $1]");

  // 链接: [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // 加粗: **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  out = out.replace(/__(.+?)__/g, "$1");

  // 斜体: *text* or _text_
  out = out.replace(/(?<!\\)\*(.+?)\*/g, "$1");
  out = out.replace(/(?<!\\)_(.+?)_/g, "$1");

  // 删除线: ~~text~~
  out = out.replace(/~~(.+?)~~/g, "$1");

  // 行内代码: `code`
  out = out.replace(/`([^`]+)`/g, "$1");

  // 标题: # text → text
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // 引用: > text → text
  out = out.replace(/^>\s?/gm, "");

  // 无序列表: - item or * item → item
  out = out.replace(/^[\s]*[-*]\s+/gm, "");

  // 水平线: --- or ***
  out = out.replace(/^[-*]{3,}$/gm, "");

  return out;
}
