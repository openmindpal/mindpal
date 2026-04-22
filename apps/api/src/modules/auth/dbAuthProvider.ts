/**
 * DB-backed AuthProvider — 将 API 服务的多模式认证（PAT/HMAC/dev）
 * 和 RBAC 授权逻辑封装为统一 AuthProvider 接口实现。
 *
 * authenticate(): 复用 authn.ts 的 authenticate() 解析凭证 → AuthContext
 * authorize():    委托 authz.ts 的 authorize() 执行 RBAC + ABAC 决策
 */
import type { Pool } from "pg";
import type { AuthContext, AuthProvider } from "@openslin/shared";
import { authenticate as authnAuthenticate } from "./authn";
import { authorize as rbacAuthorize } from "./authz";

/**
 * 将 authn.ts 返回的 Subject 转换为 AuthContext。
 * permissions 在 authenticate 阶段无法确定（需要按资源查询），留空。
 */
function subjectToAuthContext(subject: { subjectId: string; tenantId: string; spaceId?: string }): AuthContext {
  return {
    subject: subject.subjectId,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    permissions: [],
  };
}

class DbAuthProvider implements AuthProvider {
  constructor(private readonly pool: Pool) {}

  /**
   * 认证：从 Authorization header 值（含 "Bearer " 前缀或裸 token）解析身份。
   * 内部委托 authn.authenticate()，支持 PAT / HMAC / dev 三种模式。
   */
  async authenticate(credential: string): Promise<AuthContext | null> {
    const subject = await authnAuthenticate({ pool: this.pool, authorization: credential });
    if (!subject) return null;
    return subjectToAuthContext(subject);
  }

  /**
   * 授权：执行 RBAC 权限检查。
   * permission 格式约定: "resourceType:action"（例如 "entity:read"、"tool:create"）。
   */
  async authorize(ctx: AuthContext, permission: string): Promise<boolean> {
    const [resourceType, action] = permission.split(":");
    if (!resourceType || !action) return false;

    const decision = await rbacAuthorize({
      pool: this.pool,
      subjectId: ctx.subject,
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      resourceType,
      action,
    });
    return decision.decision === "allow";
  }
}

/** 工厂函数：创建基于数据库的 AuthProvider */
export function createDbAuthProvider(pool: Pool): AuthProvider {
  return new DbAuthProvider(pool);
}
