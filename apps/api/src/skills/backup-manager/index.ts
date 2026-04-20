import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { backupRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "backup.manager", version: "1.0.0" },
    displayName: { "zh-CN": "备份管理器", "en-US": "Backup Manager" },
    description: { "zh-CN": "执行系统数据的备份与恢复", "en-US": "Execute system data backup and restore operations" },
    routes: ["/backups"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: backupRoutes,
};

export default plugin;
