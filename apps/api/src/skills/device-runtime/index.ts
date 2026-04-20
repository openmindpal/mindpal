import type { FastifyPluginAsync } from "fastify";
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { deviceRoutes } from "./routeDevices";
import { deviceAgentRoutes } from "./routeDeviceAgent";
import { deviceExecutionRoutes } from "./routeDeviceExecutions";
import { deviceWsRoutes } from "./routeDeviceWs";
import { deviceMessageRoutes } from "./routeDeviceMessages";

/** Composite route that registers all device sub-routes. */
const compositeRoutes: FastifyPluginAsync = async (app) => {
  app.register(deviceRoutes);
  app.register(deviceAgentRoutes);
  app.register(deviceExecutionRoutes);
  app.register(deviceWsRoutes);
  app.register(deviceMessageRoutes);
};

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "device.runtime", version: "1.0.0" },
    displayName: { "zh-CN": "设备运行时", "en-US": "Device Runtime" },
    description: { "zh-CN": "管理端侧设备的运行状态和通信", "en-US": "Manage device agent runtime state and communication" },
    routes: ["/devices", "/device-agent", "/device-executions"],
    frontend: ["/gov/devices"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: compositeRoutes,
};

export default plugin;
