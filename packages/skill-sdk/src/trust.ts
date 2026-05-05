/**
 * @mindpal/skill-sdk — Ed25519 信任验证相关类型
 *
 * 定义 Skill 签名与供应链信任验证的类型结构。
 * Skill 发布到 Registry 时需进行签名，Runner 加载时进行验签。
 */

/* ================================================================== */
/*  信任验证                                                             */
/* ================================================================== */

/** Skill 信任验证信息（随 manifest 一起分发） */
export interface SkillTrustVerification {
  /** 签名算法 */
  signatureAlgorithm: 'Ed25519';
  /** 公钥（hex 或 base64 编码） */
  publicKey: string;
  /** 对 manifest 内容的签名 */
  signature: string;
  /** 供应链策略：strict 要求验签通过，permissive 仅警告 */
  supplyChainPolicy: 'strict' | 'permissive';
}

/** Skill 签名配置（开发者本地使用） */
export interface SkillSigningConfig {
  /** 私钥文件路径 */
  privateKeyPath: string;
  /** 公钥文件路径 */
  publicKeyPath: string;
  /** 签名算法 */
  algorithm: 'Ed25519';
}

/* ================================================================== */
/*  信任链元数据                                                         */
/* ================================================================== */

/** Skill 发布者身份 */
export interface SkillPublisherIdentity {
  /** 发布者名称 */
  name: string;
  /** 发布者邮箱 */
  email?: string;
  /** 公钥指纹（SHA-256 前 8 字节 hex） */
  keyFingerprint: string;
}

/** 完整的信任链信息 */
export interface SkillTrustChain {
  /** 发布者身份 */
  publisher: SkillPublisherIdentity;
  /** 验证信息 */
  verification: SkillTrustVerification;
  /** 签名时间戳（ISO 8601） */
  signedAt: string;
  /** 签名过期时间（ISO 8601），可选 */
  expiresAt?: string;
}
