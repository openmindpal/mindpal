use crate::types::DeviceClaimEnvelope;
use std::collections::VecDeque;
use tokio::sync::Mutex;
use chrono::Utc;
use tracing::{debug, warn, info};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Low = 0,
    Normal = 1,
    High = 2,
    Critical = 3,
}

#[derive(Debug)]
pub struct QueuedTask {
    pub envelope: DeviceClaimEnvelope,
    pub priority: Priority,
    pub enqueued_at: chrono::DateTime<chrono::Utc>,
    pub timeout_at: chrono::DateTime<chrono::Utc>,
    pub retries: u32,
}

/// 本地任务队列
pub struct TaskQueue {
    queue: Mutex<VecDeque<QueuedTask>>,
    max_size: usize,
    default_timeout_ms: u64,
    #[allow(dead_code)]
    max_retries: u32,
}

impl TaskQueue {
    pub fn new(max_size: usize, default_timeout_ms: u64, max_retries: u32) -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            max_size,
            default_timeout_ms,
            max_retries,
        }
    }

    /// 入队（按优先级插入）
    pub async fn enqueue(
        &self,
        envelope: DeviceClaimEnvelope,
        priority: Priority,
    ) -> anyhow::Result<()> {
        let mut queue = self.queue.lock().await;

        if queue.len() >= self.max_size {
            anyhow::bail!(
                "Task queue full (max_size={}), rejecting task",
                self.max_size
            );
        }

        let now = Utc::now();
        let timeout_at = now + chrono::Duration::milliseconds(self.default_timeout_ms as i64);

        let task = QueuedTask {
            envelope,
            priority: priority.clone(),
            enqueued_at: now,
            timeout_at,
            retries: 0,
        };

        // 按优先级插入：找到第一个优先级低于当前任务的位置
        let insert_pos = queue
            .iter()
            .position(|t| t.priority < priority)
            .unwrap_or(queue.len());

        queue.insert(insert_pos, task);
        debug!(queue_len = queue.len(), "Task enqueued");
        Ok(())
    }

    /// 出队（取最高优先级任务，即队首）
    pub async fn dequeue(&self) -> Option<QueuedTask> {
        let mut queue = self.queue.lock().await;
        let task = queue.pop_front();
        if task.is_some() {
            debug!(queue_len = queue.len(), "Task dequeued");
        }
        task
    }

    /// 队列长度
    pub async fn len(&self) -> usize {
        self.queue.lock().await.len()
    }

    /// 队列是否为空
    pub async fn is_empty(&self) -> bool {
        self.queue.lock().await.is_empty()
    }

    /// 清理超时任务
    pub async fn cleanup_timed_out(&self) -> u32 {
        let now = Utc::now();
        let mut queue = self.queue.lock().await;
        let before_len = queue.len();

        queue.retain(|task| {
            if now > task.timeout_at {
                warn!(
                    tool_ref = %task.envelope.execution.tool_ref,
                    "Task timed out and removed from queue"
                );
                false
            } else {
                true
            }
        });

        let removed = (before_len - queue.len()) as u32;
        if removed > 0 {
            info!(removed, "Timed out tasks cleaned from queue");
        }
        removed
    }

    /// 是否已满
    pub async fn is_full(&self) -> bool {
        self.queue.lock().await.len() >= self.max_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ClaimExecution, DeviceClaimEnvelope};

    fn make_envelope(tool_ref: &str) -> DeviceClaimEnvelope {
        DeviceClaimEnvelope {
            execution: ClaimExecution {
                device_execution_id: uuid::Uuid::new_v4().to_string(),
                tool_ref: tool_ref.to_string(),
                input: None,
            },
            require_user_presence: None,
            policy: None,
            policy_digest: None,
        }
    }

    #[tokio::test]
    async fn test_enqueue_dequeue() {
        let queue = TaskQueue::new(10, 60000, 3);
        queue.enqueue(make_envelope("tool.a"), Priority::Normal).await.unwrap();
        queue.enqueue(make_envelope("tool.b"), Priority::High).await.unwrap();

        let task = queue.dequeue().await.unwrap();
        assert_eq!(task.envelope.execution.tool_ref, "tool.b");

        let task = queue.dequeue().await.unwrap();
        assert_eq!(task.envelope.execution.tool_ref, "tool.a");
    }

    #[tokio::test]
    async fn test_queue_full() {
        let queue = TaskQueue::new(2, 60000, 3);
        queue.enqueue(make_envelope("a"), Priority::Normal).await.unwrap();
        queue.enqueue(make_envelope("b"), Priority::Normal).await.unwrap();
        let result = queue.enqueue(make_envelope("c"), Priority::Normal).await;
        assert!(result.is_err());
    }
}
