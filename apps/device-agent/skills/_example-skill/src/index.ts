/**
 * 端侧示例 Skill — echo handler（TypeScript 源码）
 * 编译后生成 dist/index.js
 */
export async function handler(
  input: { text?: string },
  context?: { toolRef?: string },
): Promise<{ echo: string; source: string; toolRef: string; timestamp: string }> {
  return {
    echo: input.text ?? "",
    source: "device-local-skill",
    toolRef: context?.toolRef ?? "unknown",
    timestamp: new Date().toISOString(),
  };
}

export default { handler };
