import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { collabRuntimeRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "collab.runtime", version: "1.0.0" },
    routes: ["/collab-runtime"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
    tools: [
      // 联邦节点管理
      {
        name: "federation.node.list",
        displayName: { "zh-CN": "查看联邦节点", "en-US": "List Federation Nodes" },
        description: { "zh-CN": "查看所有已连接的远程节点", "en-US": "List all connected remote nodes" },
        scope: "read",
        resourceType: "federation",
        action: "read",
        riskLevel: "low",
      },
      // 权限授权
      {
        name: "federation.grant.list",
        displayName: { "zh-CN": "查看权限授权", "en-US": "List Permission Grants" },
        description: { "zh-CN": "查看节点权限授权列表", "en-US": "List node permission grants" },
        scope: "read",
        resourceType: "federation",
        action: "read",
        riskLevel: "low",
      },
      {
        name: "federation.grant.create",
        displayName: { "zh-CN": "创建权限授权", "en-US": "Create Permission Grant" },
        description: { "zh-CN": "授予远程节点访问权限", "en-US": "Grant access permission to remote node" },
        scope: "write",
        resourceType: "federation",
        action: "write",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            nodeId: { type: "string", required: true, description: "节点ID" },
            permissionType: { type: "string", required: true, description: "read|write|forward|audit|invoke|subscribe" },
            resourcePattern: { type: "string", description: "资源模式，如 skill:*" },
          },
        },
      },
      {
        name: "federation.grant.revoke",
        displayName: { "zh-CN": "撤销权限授权", "en-US": "Revoke Permission Grant" },
        description: { "zh-CN": "撤销节点的访问权限", "en-US": "Revoke node access permission" },
        scope: "write",
        resourceType: "federation",
        action: "write",
        riskLevel: "medium",
        inputSchema: { fields: { grantId: { type: "string", required: true } } },
      },
      // 用户授权
      {
        name: "federation.user-grant.list",
        displayName: { "zh-CN": "查看用户授权", "en-US": "List User Grants" },
        description: { "zh-CN": "查看用户跨域授权列表", "en-US": "List user cross-domain grants" },
        scope: "read",
        resourceType: "federation",
        action: "read",
        riskLevel: "low",
      },
      {
        name: "federation.user-grant.create",
        displayName: { "zh-CN": "创建用户授权", "en-US": "Create User Grant" },
        description: { "zh-CN": "授权用户跨域访问", "en-US": "Grant user cross-domain access" },
        scope: "write",
        resourceType: "federation",
        action: "write",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            nodeId: { type: "string", required: true },
            localUserId: { type: "string", required: true },
            remoteIdentity: { type: "string", required: true },
            scopes: { type: "string", description: "逗号分隔的授权范围" },
          },
        },
      },
      {
        name: "federation.user-grant.revoke",
        displayName: { "zh-CN": "撤销用户授权", "en-US": "Revoke User Grant" },
        description: { "zh-CN": "撤销用户跨域授权", "en-US": "Revoke user cross-domain grant" },
        scope: "write",
        resourceType: "federation",
        action: "write",
        riskLevel: "medium",
        inputSchema: { fields: { userGrantId: { type: "string", required: true } } },
      },
      // 内容策略
      {
        name: "federation.policy.list",
        displayName: { "zh-CN": "查看内容策略", "en-US": "List Content Policies" },
        description: { "zh-CN": "查看联邦内容策略列表", "en-US": "List federation content policies" },
        scope: "read",
        resourceType: "federation",
        action: "read",
        riskLevel: "low",
      },
      {
        name: "federation.policy.create",
        displayName: { "zh-CN": "创建内容策略", "en-US": "Create Content Policy" },
        description: { "zh-CN": "创建数据用途、生命周期、脱敏策略", "en-US": "Create usage/lifecycle/redaction policy" },
        scope: "write",
        resourceType: "federation",
        action: "write",
        riskLevel: "medium",
        inputSchema: {
          fields: {
            policyName: { type: "string", required: true },
            policyType: { type: "string", required: true, description: "usage_restriction|lifecycle|redaction|encryption" },
            rules: { type: "object", description: "JSON策略规则" },
          },
        },
      },
      {
        name: "federation.policy.delete",
        displayName: { "zh-CN": "删除内容策略", "en-US": "Delete Content Policy" },
        description: { "zh-CN": "删除指定的内容策略", "en-US": "Delete specified content policy" },
        scope: "write",
        resourceType: "federation",
        action: "write",
        riskLevel: "medium",
        inputSchema: { fields: { policyId: { type: "string", required: true } } },
      },
      // 审计日志
      {
        name: "federation.audit.list",
        displayName: { "zh-CN": "查看审计日志", "en-US": "List Audit Logs" },
        description: { "zh-CN": "查看跨域操作审计日志", "en-US": "List cross-domain audit logs" },
        scope: "read",
        resourceType: "federation",
        action: "read",
        riskLevel: "low",
        inputSchema: { fields: { nodeId: { type: "string", description: "筛选节点ID" } } },
      },
    ],
  },
  routes: collabRuntimeRoutes,
};

export default plugin;
