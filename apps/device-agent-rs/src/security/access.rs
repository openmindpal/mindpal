use crate::types::{CallerIdentity, CallerType, CachedPolicy};
use std::collections::HashMap;
use std::sync::RwLock;
use chrono::Utc;
use tracing::{debug, warn};

/// 调用方上下文
#[derive(Debug, Clone)]
struct CallerContext {
    identity: CallerIdentity,
    created_at: chrono::DateTime<chrono::Utc>,
}

/// 访问控制管理器
pub struct AccessController {
    secret_key: Option<String>,
    max_context_age_ms: u64,
    contexts: RwLock<HashMap<String, CallerContext>>,
}

impl AccessController {
    pub fn new(secret_key: Option<&str>, max_context_age_ms: u64) -> Self {
        Self {
            secret_key: secret_key.map(|s| s.to_string()),
            max_context_age_ms,
            contexts: RwLock::new(HashMap::new()),
        }
    }

    /// 验证调用方身份
    pub fn verify_caller(&self, caller_id: &str, token: &str) -> anyhow::Result<CallerIdentity> {
        // 检查是否有 secret_key，如果有则验证 token
        if let Some(ref secret) = self.secret_key {
            if token != secret.as_str() {
                anyhow::bail!("Invalid caller token for caller_id={}", caller_id);
            }
        }

        let now = Utc::now();
        let identity = CallerIdentity {
            caller_id: caller_id.to_string(),
            caller_type: CallerType::Api,
            tenant_id: None,
            subject_id: None,
            verified_at: now.to_rfc3339(),
            expires_at: None,
        };

        // 缓存调用方上下文
        let context = CallerContext {
            identity: identity.clone(),
            created_at: now,
        };

        if let Ok(mut contexts) = self.contexts.write() {
            contexts.insert(caller_id.to_string(), context);
        }

        debug!(caller_id, "Caller verified successfully");
        Ok(identity)
    }

    /// 检查工具是否被策略允许
    pub fn check_tool_allowed(&self, tool_ref: &str, policy: &CachedPolicy) -> bool {
        match &policy.allowed_tools {
            Some(tools) => tools.iter().any(|t| tool_ref.starts_with(t) || t == tool_ref),
            None => true, // 无白名单限制时全部允许
        }
    }

    /// 清理过期上下文
    pub fn cleanup_expired_contexts(&self) -> u32 {
        let now = Utc::now();
        let mut removed = 0u32;

        if let Ok(mut contexts) = self.contexts.write() {
            let before_len = contexts.len();
            contexts.retain(|_id, ctx| {
                let age_ms = (now - ctx.created_at).num_milliseconds() as u64;
                age_ms < self.max_context_age_ms
            });
            removed = (before_len - contexts.len()) as u32;
        } else {
            warn!("Failed to acquire write lock for context cleanup");
        }

        if removed > 0 {
            debug!(removed, "Expired caller contexts cleaned up");
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_tool_allowed_with_whitelist() {
        let controller = AccessController::new(None, 60000);
        let policy = CachedPolicy {
            allowed_tools: Some(vec!["file.".to_string(), "network.fetch".to_string()]),
            file_policy: None,
            network_policy: None,
            ui_policy: None,
            evidence_policy: None,
            clipboard_policy: None,
            limits: None,
            tool_feature_flags: None,
            degradation_rules: None,
            circuit_breaker_config: None,
        };

        assert!(controller.check_tool_allowed("file.read", &policy));
        assert!(controller.check_tool_allowed("file.write", &policy));
        assert!(controller.check_tool_allowed("network.fetch", &policy));
        assert!(!controller.check_tool_allowed("system.exec", &policy));
    }

    #[test]
    fn test_check_tool_allowed_no_whitelist() {
        let controller = AccessController::new(None, 60000);
        let policy = CachedPolicy {
            allowed_tools: None,
            file_policy: None,
            network_policy: None,
            ui_policy: None,
            evidence_policy: None,
            clipboard_policy: None,
            limits: None,
            tool_feature_flags: None,
            degradation_rules: None,
            circuit_breaker_config: None,
        };

        assert!(controller.check_tool_allowed("anything.goes", &policy));
    }

    #[test]
    fn test_verify_caller_no_secret() {
        let controller = AccessController::new(None, 60000);
        let result = controller.verify_caller("test-caller", "any-token");
        assert!(result.is_ok());
        assert_eq!(result.unwrap().caller_id, "test-caller");
    }

    #[test]
    fn test_verify_caller_with_secret() {
        let controller = AccessController::new(Some("my-secret"), 60000);
        assert!(controller.verify_caller("caller1", "my-secret").is_ok());
        assert!(controller.verify_caller("caller2", "wrong").is_err());
    }
}
