use sha2::{Sha256, Digest};

/// 计算 SHA256 哈希并返回十六进制字符串
pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

/// 截取前8字符的摘要（用于日志安全显示）
pub fn sha256_8(input: &str) -> String {
    sha256_hex(input)[..8].to_string()
}

/// Token 验证器
pub struct TokenValidator {
    device_token: String,
}

impl TokenValidator {
    pub fn new(token: &str) -> Self {
        Self {
            device_token: token.to_string(),
        }
    }

    /// 验证 Bearer token 是否匹配
    pub fn validate_bearer(&self, bearer: &str) -> bool {
        let token = bearer.strip_prefix("Bearer ").unwrap_or(bearer);
        token == self.device_token
    }

    /// 获取 token 的完整哈希
    pub fn token_hash(&self) -> String {
        sha256_hex(&self.device_token)
    }

    /// 获取 token 的短摘要（前8字符）
    pub fn token_digest(&self) -> String {
        sha256_8(&self.device_token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_hex() {
        let hash = sha256_hex("hello");
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn test_sha256_8() {
        let digest = sha256_8("hello");
        assert_eq!(digest.len(), 8);
    }

    #[test]
    fn test_token_validator() {
        let validator = TokenValidator::new("my-secret-token");
        assert!(validator.validate_bearer("Bearer my-secret-token"));
        assert!(validator.validate_bearer("my-secret-token"));
        assert!(!validator.validate_bearer("Bearer wrong-token"));
    }
}
