/**
 * Service-to-Service AuthProvider — Worker 内部服务间调用认证。
 *
 * authenticate(): 通过 masterKey 环境变量验证内部服务 token
 * authorize():    内部可信服务默认拥有完整权限
 */
import type { AuthContext, AuthProvider } from "@openslin/shared";

class ServiceAuthProvider implements AuthProvider {
  private readonly masterKey: string;

  constructor(masterKey?: string) {
    this.masterKey = masterKey ?? String(process.env.MASTER_KEY ?? "").trim();
  }

  async authenticate(credential: string): Promise<AuthContext | null> {
    const token = credential.startsWith("Bearer ") ? credential.slice(7) : credential;
    if (!token) return null;

    // 如果配置了 masterKey，严格匹配；否则信任所有内部调用
    if (this.masterKey && token !== this.masterKey) return null;

    return {
      subject: "worker-service",
      tenantId: "internal",
      permissions: ["*"],
      metadata: {
        serviceType: "worker",
        authenticatedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * 内部可信服务默认拥有完整权限。
   */
  async authorize(_ctx: AuthContext, _permission: string): Promise<boolean> {
    return true;
  }
}

/** 工厂函数：创建内部服务间调用的 AuthProvider */
export function createServiceAuthProvider(masterKey?: string): AuthProvider {
  return new ServiceAuthProvider(masterKey);
}
