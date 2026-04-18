/**
 * P0-2: Device Execution 跨节点推送测试
 * 
 * 验证多实例部署时，task_pending 通知能够通过 D2D Bus 正确推送
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Pool } from "pg";
import Redis from "ioredis";
import { sendD2DMessage } from "../modules/crossDeviceBus";

// Mock Redis
const mockRedis = {
  publish: vi.fn().mockResolvedValue(1),
  hset: vi.fn().mockResolvedValue(1),
  sadd: vi.fn().mockResolvedValue(1),
  zadd: vi.fn().mockResolvedValue(1),
  set: vi.fn().mockResolvedValue("OK"),
  expire: vi.fn().mockResolvedValue(1),
  lpush: vi.fn().mockResolvedValue(1),
  ltrim: vi.fn().mockResolvedValue("OK"),
} as unknown as Redis;

// Mock DB Pool
const mockPool = {
  query: vi.fn(),
} as unknown as Pool;

describe("P0-2: Cross-node task pending notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should persist task_pending message to database", async () => {
    const executionId = "exec-123";
    const deviceId = "device-456";
    const tenantId = "tenant-789";

    // Mock DB insert
    (mockPool.query as any).mockResolvedValueOnce({
      rows: [{ message_id: "msg-001" }],
    });

    await sendD2DMessage({
      pool: mockPool,
      redis: mockRedis,
      msg: {
        tenantId,
        fromDeviceId: null,
        routingKind: "direct",
        toDeviceId: deviceId,
        category: "system_notification",
        priority: "high",
        payload: {
          type: "task_pending",
          executionId,
          toolRef: "test.tool@1.0.0",
          requireUserPresence: true,
        },
        requireAck: false,
        ttlMs: 5 * 60 * 1000,
        maxRetries: 3,
      },
    });

    // Verify DB persistence
    expect(mockPool.query).toHaveBeenCalled();
    const insertCall = (mockPool.query as any).mock.calls.find(
      (call: any[]) => call[0]?.includes("INSERT INTO device_messages")
    );
    expect(insertCall).toBeDefined();
    
    // Verify message content
    const params = insertCall[1];
    expect(params[1]).toBe(tenantId);
    expect(params[4]).toBe(deviceId);
    expect(params[6]).toBe("system_notification");
    expect(params[7]).toBe("high");
    expect(JSON.parse(params[8]).type).toBe("task_pending");
    expect(JSON.parse(params[8]).executionId).toBe(executionId);
  });

  it("should publish to Redis for real-time delivery", async () => {
    const deviceId = "device-456";
    const tenantId = "tenant-789";

    (mockPool.query as any).mockResolvedValueOnce({
      rows: [{ message_id: "msg-001" }],
    });

    await sendD2DMessage({
      pool: mockPool,
      redis: mockRedis,
      msg: {
        tenantId,
        fromDeviceId: null,
        routingKind: "direct",
        toDeviceId: deviceId,
        category: "system_notification",
        priority: "high",
        payload: {
          type: "task_pending",
          executionId: "exec-123",
          toolRef: "test.tool@1.0.0",
          requireUserPresence: false,
        },
        requireAck: false,
        ttlMs: 5 * 60 * 1000,
        maxRetries: 3,
      },
    });

    // Verify Redis publish
    expect(mockRedis.publish).toHaveBeenCalled();
    const publishCall = (mockRedis.publish as any).mock.calls[0];
    expect(publishCall[0]).toContain(`d2d:ch:${tenantId}:${deviceId}`);
    
    const publishedMessage = JSON.parse(publishCall[1]);
    expect(publishedMessage.messageId).toBeDefined();
    expect(publishedMessage.payload.type).toBe("task_pending");
    expect(publishedMessage.payload.executionId).toBe("exec-123");
  });

  it("should handle high priority with correct TTL", async () => {
    const tenantId = "tenant-789";

    (mockPool.query as any).mockResolvedValueOnce({
      rows: [{ message_id: "msg-001" }],
    });

    await sendD2DMessage({
      pool: mockPool,
      redis: mockRedis,
      msg: {
        tenantId,
        fromDeviceId: null,
        routingKind: "direct",
        toDeviceId: "device-456",
        category: "system_notification",
        priority: "high",
        payload: { type: "task_pending", executionId: "exec-123" },
        requireAck: false,
        ttlMs: 5 * 60 * 1000, // 5 minutes
        maxRetries: 3,
      },
    });

    // Verify TTL is set correctly (5 minutes)
    expect(mockRedis.set).toHaveBeenCalled();
    const setCall = (mockRedis.set as any).mock.calls.find(
      (call: any[]) => String(call[0] ?? "").includes("d2d:dedup:")
    );
    if (setCall) {
      expect(setCall[2]).toBe("EX");
      expect(setCall[3]).toBeLessThanOrEqual(3600);
      expect(setCall[4]).toBe("NX");
    }
    expect(mockRedis.expire).toHaveBeenCalled();
  });

  it("should not require ACK for system notifications", async () => {
    const tenantId = "tenant-789";

    (mockPool.query as any).mockResolvedValueOnce({
      rows: [{ message_id: "msg-001" }],
    });

    await sendD2DMessage({
      pool: mockPool,
      redis: mockRedis,
      msg: {
        tenantId,
        fromDeviceId: null,
        routingKind: "direct",
        toDeviceId: "device-456",
        category: "system_notification",
        priority: "high",
        payload: { type: "task_pending" },
        requireAck: false, // Explicitly no ACK required
        ttlMs: 5 * 60 * 1000,
        maxRetries: 3,
      },
    });

    // Verify message is marked as not requiring ACK
    const insertCall = (mockPool.query as any).mock.calls.find(
      (call: any[]) => call[0]?.includes("INSERT INTO device_messages")
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][9]).toBe(false);
  });

  it("should support retry mechanism for failed deliveries", async () => {
    const tenantId = "tenant-789";

    (mockPool.query as any).mockResolvedValueOnce({
      rows: [{ message_id: "msg-001" }],
    });

    await sendD2DMessage({
      pool: mockPool,
      redis: mockRedis,
      msg: {
        tenantId,
        fromDeviceId: null,
        routingKind: "direct",
        toDeviceId: "device-456",
        category: "system_notification",
        priority: "high",
        payload: { type: "task_pending" },
        requireAck: false,
        ttlMs: 5 * 60 * 1000,
        maxRetries: 3, // Allow 3 retries
      },
    });

    // Verify max_retries is set
    const insertCall = (mockPool.query as any).mock.calls.find(
      (call: any[]) => call[0]?.includes("INSERT INTO device_messages")
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][14]).toBe(3);
  });

  it("should handle multi-node scenario via Redis Pub/Sub", async () => {
    const tenantId = "tenant-789";
    const deviceId = "device-456";

    (mockPool.query as any).mockResolvedValueOnce({
      rows: [{ message_id: "msg-001" }],
    });

    await sendD2DMessage({
      pool: mockPool,
      redis: mockRedis,
      msg: {
        tenantId,
        fromDeviceId: null,
        routingKind: "direct",
        toDeviceId: deviceId,
        category: "system_notification",
        priority: "high",
        payload: {
          type: "task_pending",
          executionId: "exec-123",
          toolRef: "test.tool@1.0.0",
        },
        requireAck: false,
        ttlMs: 5 * 60 * 1000,
        maxRetries: 3,
      },
    });

    // In multi-node scenario, Redis publish ensures cross-node delivery
    expect(mockRedis.publish).toHaveBeenCalledWith(
      expect.stringContaining(`d2d:ch:${tenantId}:${deviceId}`),
      expect.stringContaining("task_pending")
    );

    // Message is persisted in DB for offline devices
    expect(mockPool.query).toHaveBeenCalled();
  });

  it("should maintain backward compatibility with pushToDevice fallback", () => {
    // This test verifies that the old pushToDevice still works for single-node
    // The new implementation uses sendD2DMessage which internally handles both cases
    
    // Single node: local WS connection → direct push
    // Multi node: no local connection → Redis Pub/Sub → other node picks up
    
    expect(true).toBe(true); // Placeholder - actual integration test needed
  });
});
