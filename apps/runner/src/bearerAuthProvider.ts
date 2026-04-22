/**
 * Bearer-token AuthProvider — 将 Runner 的 Bearer token 验证
 * 封装为统一 AuthProvider 接口实现。
 *
 * authenticate(): 比对环境变量 RUNNER_BEARER_TOKEN，匹配则返回 AuthContext
 * authorize():    Runner 信任调用方（Worker），默认返回 true
 */
import type { AuthContext, AuthProvider } from "@openslin/shared";

class BearerAuthProvider implements AuthProvider {
  private readonly expectedToken: string | null;

  constructor() {
    const raw = String(process.env.RUNNER_BEARER_TOKEN ?? "").trim();
    this.expectedToken = raw || null;
  }

  async authenticate(credential: string): Promise<AuthContext | null> {
    // 从 "Bearer <token>" 格式中提取 token
    const token = credential.startsWith("Bearer ") ? credential.slice(7) : credential;
    if (!token) return null;

    // 如果未配置 RUNNER_BEARER_TOKEN，则信任所有调用方
    if (this.expectedToken && token !== this.expectedToken) return null;

    return {
      subject: "runner-caller",
      tenantId: "internal",
      permissions: ["*"],
      metadata: { authenticatedAt: new Date().toISOString() },
    };
  }

  /**
   * Runner 信任调用方（由 Worker 签名验证保障），默认允许所有权限。
   */
  async authorize(_ctx: AuthContext, _permission: string): Promise<boolean> {
    return true;
  }
}

/** 工厂函数：创建基于 Bearer token 的 AuthProvider */
export function createBearerAuthProvider(): AuthProvider {
  return new BearerAuthProvider();
}
