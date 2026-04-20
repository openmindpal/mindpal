import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { mediaRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "media.pipeline", version: "1.0.0" },
    displayName: { "zh-CN": "媒体处理管道", "en-US": "Media Pipeline" },
    description: { "zh-CN": "处理图片、音视频等多媒体内容", "en-US": "Process images, audio, video and other multimedia content" },
    routes: ["/media"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: mediaRoutes,
};

export default plugin;
