/**
 * Built-in Skill: Schema-UI Generator
 *
 * 通过自然语言生成 JSON Schema 驱动的 UI 配置。
 * 替代旧版 NL2UI 生成器，极简实现。
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { schemaUiRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "schema-ui.generate", version: "1.0.0" },
    displayName: { "zh-CN": "Schema-UI 生成器", "en-US": "Schema-UI Generator" },
    description: { "zh-CN": "自然语言驱动的 Schema-UI 页面生成", "en-US": "Natural language driven Schema-UI page generation" },
    routes: ["/schema-ui"],
    dependencies: ["schemas", "entities", "rbac"],
    skillDependencies: ["model.gateway"],
  },
  routes: schemaUiRoutes,
};

export default plugin;
