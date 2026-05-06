use crate::types::{ExecutionStatus, PluginResourceLimits, ToolExecutionResult};
use std::sync::atomic::{AtomicU32, Ordering};
use tokio::time::{timeout, Duration};
use tracing::error;

/// 熔断器状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    Closed,   // 正常
    Open,     // 熔断（拒绝请求）
    HalfOpen, // 半开（允许探测）
}

/// 熔断器
pub struct CircuitBreaker {
    state: std::sync::RwLock<CircuitState>,
    failure_count: AtomicU32,
    failure_threshold: u32,
    half_open_max_attempts: u32,
    half_open_window_ms: u64,
    last_failure_at: std::sync::RwLock<Option<chrono::DateTime<chrono::Utc>>>,
}

impl CircuitBreaker {
    pub fn new(
        failure_threshold: u32,
        half_open_window_ms: u64,
        half_open_max_attempts: u32,
    ) -> Self {
        Self {
            state: std::sync::RwLock::new(CircuitState::Closed),
            failure_count: AtomicU32::new(0),
            failure_threshold,
            half_open_max_attempts,
            half_open_window_ms,
            last_failure_at: std::sync::RwLock::new(None),
        }
    }

    /// 是否允许执行
    pub fn allow_request(&self) -> bool {
        let state = *self.state.read().unwrap();
        match state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                // 检查是否可以进入半开状态
                let last_failure = self.last_failure_at.read().unwrap();
                if let Some(last) = *last_failure {
                    let elapsed = chrono::Utc::now()
                        .signed_duration_since(last)
                        .num_milliseconds() as u64;
                    if elapsed >= self.half_open_window_ms {
                        drop(last_failure);
                        let mut state_w = self.state.write().unwrap();
                        *state_w = CircuitState::HalfOpen;
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
            CircuitState::HalfOpen => {
                // 半开状态允许有限的探测请求
                let current = self.failure_count.load(Ordering::SeqCst);
                current < self.half_open_max_attempts
            }
        }
    }

    /// 记录成功
    pub fn record_success(&self) {
        self.failure_count.store(0, Ordering::SeqCst);
        let mut state = self.state.write().unwrap();
        *state = CircuitState::Closed;
    }

    /// 记录失败
    pub fn record_failure(&self) {
        let count = self.failure_count.fetch_add(1, Ordering::SeqCst) + 1;
        let mut last = self.last_failure_at.write().unwrap();
        *last = Some(chrono::Utc::now());

        if count >= self.failure_threshold {
            let mut state = self.state.write().unwrap();
            *state = CircuitState::Open;
        }
    }

    /// 当前状态
    pub fn state(&self) -> CircuitState {
        *self.state.read().unwrap()
    }
}

/// 沙箱执行包装器
pub struct PluginSandbox {
    /// 最大执行超时
    pub max_execution_time_ms: u64,
    /// 最大并发
    pub max_concurrency: u32,
    /// 当前并发计数
    current_concurrency: AtomicU32,
    /// 熔断器
    circuit_breaker: CircuitBreaker,
}

impl PluginSandbox {
    pub fn new(limits: Option<&PluginResourceLimits>) -> Self {
        let max_time = limits
            .and_then(|l| l.max_execution_time_ms)
            .unwrap_or(60_000);
        let max_conc = limits.and_then(|l| l.max_concurrency).unwrap_or(10);
        Self {
            max_execution_time_ms: max_time,
            max_concurrency: max_conc,
            current_concurrency: AtomicU32::new(0),
            circuit_breaker: CircuitBreaker::new(5, 30_000, 3),
        }
    }

    /// 沙箱化执行：超时控制 + 并发限制 + 熔断
    pub async fn execute<F, Fut>(&self, f: F) -> anyhow::Result<ToolExecutionResult>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<ToolExecutionResult>>,
    {
        // 1. 检查熔断器
        if !self.circuit_breaker.allow_request() {
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("circuit_breaker_open".to_string()),
                output_digest: None,
                evidence_refs: None,
            });
        }

        // 2. 检查并发限制
        let current = self.current_concurrency.fetch_add(1, Ordering::SeqCst);
        if current >= self.max_concurrency {
            self.current_concurrency.fetch_sub(1, Ordering::SeqCst);
            return Ok(ToolExecutionResult {
                status: ExecutionStatus::Failed,
                error_category: Some("concurrency_limit_exceeded".to_string()),
                output_digest: None,
                evidence_refs: None,
            });
        }

        // 3. 超时执行
        let result = timeout(Duration::from_millis(self.max_execution_time_ms), f()).await;

        self.current_concurrency.fetch_sub(1, Ordering::SeqCst);

        match result {
            Ok(Ok(r)) => {
                if r.status == ExecutionStatus::Succeeded {
                    self.circuit_breaker.record_success();
                } else {
                    self.circuit_breaker.record_failure();
                }
                Ok(r)
            }
            Ok(Err(e)) => {
                self.circuit_breaker.record_failure();
                Err(e)
            }
            Err(_) => {
                self.circuit_breaker.record_failure();
                error!("plugin execution timed out");
                Ok(ToolExecutionResult {
                    status: ExecutionStatus::Failed,
                    error_category: Some("execution_timeout".to_string()),
                    output_digest: None,
                    evidence_refs: None,
                })
            }
        }
    }
}
