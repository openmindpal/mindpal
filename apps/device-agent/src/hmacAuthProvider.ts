/**
 * HMAC-based AuthProvider — 将 Device Agent 的 HMAC 签名验证
 * 封装为统一 AuthProvider 接口实现。
 *
 * authenticate(): 验证 HMAC 签名 token，解析 caller identity → AuthContext
 * authorize():    基于 AccessPolicy 白名单做简单权限检查
 */
import crypto from "node:crypto";
import type { AuthContext, AuthProvider } from "@openslin/shared";
import type { AccessPolicy } from "./kernel/auth";

/** 从 HMAC token 中解析 payload 并验证签名 */
function verifyHmacToken(token: string, secretKey: string): AuthContext | null {
  if (!token || !secretKey) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  const expectedSig = crypto.createHmac("sha256", secretKey).update(payloadB64).digest("base64url");
  if (signature !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return {
      subject: String(payload.sid || payload.cid || ""),
      tenantId: String(payload.tid || ""),
      permissions: [],
      deviceId: String(payload.cid || ""),
      metadata: {
        callerType: ["api", "local", "plugin"].includes(payload.ct) ? payload.ct : "api",
        verifiedAt: new Date().toISOString(),
      },
    };
  } catch {
    return null;
  }
}

class HmacAuthProvider implements AuthProvider {
  constructor(
    private readonly secretKey: string,
    private readonly policy: AccessPolicy = {},
  ) {}

  async authenticate(credential: string): Promise<AuthContext | null> {
    // 支持 "Bearer <token>" 格式或裸 token
    const token = credential.startsWith("Bearer ") ? credential.slice(7) : credential;
    return verifyHmacToken(token, this.secretKey);
  }

  /**
   * 授权：基于 AccessPolicy 白名单判断权限。
   * permission 约定: "tool:<toolName>" 或 "caller:<callerId>"。
   * 白名单为空时表示允许所有。
   */
  async authorize(ctx: AuthContext, permission: string): Promise<boolean> {
    const [kind, name] = permission.split(":");
    if (!kind || !name) return true; // 未知格式默认允许

    if (kind === "caller") {
      if (!this.policy.allowedCallers || this.policy.allowedCallers.length === 0) return true;
      return this.policy.allowedCallers.includes(name);
    }
    if (kind === "tool") {
      if (!this.policy.allowedTools || this.policy.allowedTools.length === 0) return true;
      return this.policy.allowedTools.includes(name);
    }
    return true;
  }
}

/** 工厂函数：创建基于 HMAC 签名的 AuthProvider */
export function createHmacAuthProvider(secretKey: string, policy?: AccessPolicy): AuthProvider {
  return new HmacAuthProvider(secretKey, policy);
}
