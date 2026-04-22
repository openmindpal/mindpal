/**
 * 统一认证上下文
 *
 * 提供跨应用层的认证/授权上下文接口。
 */

export interface AuthContext {
  /** 认证主体标识（用户ID / 服务账号ID） */
  subject: string;
  /** 租户ID */
  tenantId: string;
  /** 空间ID（可选） */
  spaceId?: string;
  /** 已授予的权限列表 */
  permissions: string[];
  /** 设备ID（端侧场景） */
  deviceId?: string;
  /** 会话ID */
  sessionId?: string;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

export interface AuthProvider {
  /** 根据凭证认证，返回上下文或 null（认证失败） */
  authenticate(credential: string): Promise<AuthContext | null>;
  /** 授权检查：判断上下文是否具有指定权限 */
  authorize(ctx: AuthContext, permission: string): Promise<boolean>;
}

export type Permission = string;
