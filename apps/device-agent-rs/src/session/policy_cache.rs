use crate::types::CachedPolicy;
use crate::security::token::sha256_hex;
use std::sync::RwLock;
use chrono::Utc;
use tracing::{debug, info};

/// 策略缓存条目
#[derive(Debug, Clone)]
struct PolicyEntry {
    policy: CachedPolicy,
    cached_at: chrono::DateTime<chrono::Utc>,
    expires_at: chrono::DateTime<chrono::Utc>,
    version: u64,
    digest: String,
}

/// 策略缓存管理器
pub struct PolicyCache {
    device_id: String,
    max_age_ms: u64,
    enabled: bool,
    entry: RwLock<Option<PolicyEntry>>,
}

impl PolicyCache {
    pub fn new(device_id: &str, max_age_ms: u64, enabled: bool) -> Self {
        Self {
            device_id: device_id.to_string(),
            max_age_ms,
            enabled,
            entry: RwLock::new(None),
        }
    }

    /// 获取缓存的策略（检查过期）
    pub fn get(&self) -> Option<CachedPolicy> {
        if !self.enabled {
            return None;
        }

        let entry = self.entry.read().ok()?;
        let entry = entry.as_ref()?;

        if Utc::now() > entry.expires_at {
            debug!(device_id = %self.device_id, "Policy cache expired");
            return None;
        }

        Some(entry.policy.clone())
    }

    /// 更新缓存
    pub fn update(&self, policy: CachedPolicy, version: u64) {
        if !self.enabled {
            return;
        }

        let now = Utc::now();
        let expires_at = now + chrono::Duration::milliseconds(self.max_age_ms as i64);

        // 计算策略摘要
        let digest = match serde_json::to_string(&policy) {
            Ok(json) => sha256_hex(&json),
            Err(_) => String::from("unknown"),
        };

        let entry = PolicyEntry {
            policy,
            cached_at: now,
            expires_at,
            version,
            digest,
        };

        if let Ok(mut guard) = self.entry.write() {
            *guard = Some(entry);
        }

        info!(
            device_id = %self.device_id,
            version,
            "Policy cache updated"
        );
    }

    /// 策略是否过期
    pub fn is_expired(&self) -> bool {
        if !self.enabled {
            return true;
        }

        match self.entry.read() {
            Ok(guard) => match guard.as_ref() {
                Some(entry) => Utc::now() > entry.expires_at,
                None => true,
            },
            Err(_) => true,
        }
    }

    /// 清除缓存
    pub fn invalidate(&self) {
        if let Ok(mut guard) = self.entry.write() {
            *guard = None;
        }
        debug!(device_id = %self.device_id, "Policy cache invalidated");
    }

    /// 获取当前版本号
    pub fn version(&self) -> u64 {
        self.entry
            .read()
            .ok()
            .and_then(|guard| guard.as_ref().map(|e| e.version))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_policy() -> CachedPolicy {
        CachedPolicy {
            allowed_tools: Some(vec!["file.read".to_string()]),
            file_policy: None,
            network_policy: None,
            ui_policy: None,
            evidence_policy: None,
            clipboard_policy: None,
            limits: None,
            tool_feature_flags: None,
            degradation_rules: None,
            circuit_breaker_config: None,
        }
    }

    #[test]
    fn test_cache_update_and_get() {
        let cache = PolicyCache::new("device-1", 60000, true);
        assert!(cache.get().is_none());
        assert!(cache.is_expired());

        cache.update(make_policy(), 1);
        assert!(!cache.is_expired());

        let policy = cache.get().unwrap();
        assert_eq!(policy.allowed_tools.unwrap(), vec!["file.read".to_string()]);
        assert_eq!(cache.version(), 1);
    }

    #[test]
    fn test_cache_disabled() {
        let cache = PolicyCache::new("device-1", 60000, false);
        cache.update(make_policy(), 1);
        assert!(cache.get().is_none());
        assert!(cache.is_expired());
    }

    #[test]
    fn test_cache_invalidate() {
        let cache = PolicyCache::new("device-1", 60000, true);
        cache.update(make_policy(), 1);
        assert!(cache.get().is_some());

        cache.invalidate();
        assert!(cache.get().is_none());
        assert_eq!(cache.version(), 0);
    }
}
