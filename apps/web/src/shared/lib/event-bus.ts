type Subscriber<T = unknown> = (payload: T) => void;
type Unsubscribe = () => void;

interface PollerEntry {
  fn: () => Promise<void>;
  intervalMs: number;
  timerId: ReturnType<typeof setInterval> | null;
  active: boolean;
}

class EventBus {
  private channels = new Map<string, Set<Subscriber>>();
  private pollers = new Map<string, PollerEntry>();
  private visibilityHandler: (() => void) | null = null;

  constructor() {
    if (typeof document !== "undefined") {
      this.visibilityHandler = () => this.handleVisibilityChange();
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  /** Subscribe to a channel. Returns unsubscribe function. */
  subscribe<T = unknown>(channel: string, handler: Subscriber<T>): Unsubscribe {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    const subs = this.channels.get(channel)!;
    subs.add(handler as Subscriber);
    return () => {
      subs.delete(handler as Subscriber);
      if (subs.size === 0) this.channels.delete(channel);
    };
  }

  /** Publish payload to all subscribers on a channel. */
  publish<T = unknown>(channel: string, payload: T): void {
    const subs = this.channels.get(channel);
    if (!subs) return;
    for (const handler of subs) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] Error in handler for channel "${channel}":`, err);
      }
    }
  }

  /** Register a periodic poller with shared scheduling. */
  registerPoller(key: string, fn: () => Promise<void>, intervalMs: number): void {
    this.unregisterPoller(key);
    const entry: PollerEntry = { fn, intervalMs, timerId: null, active: true };
    this.pollers.set(key, entry);
    this.startPoller(key, entry);
  }

  /** Unregister and stop a poller. */
  unregisterPoller(key: string): void {
    const entry = this.pollers.get(key);
    if (entry) {
      entry.active = false;
      if (entry.timerId !== null) clearInterval(entry.timerId);
      this.pollers.delete(key);
    }
  }

  /** Pause all pollers (e.g. when page is hidden). */
  pausePollers(): void {
    for (const [, entry] of this.pollers) {
      if (entry.timerId !== null) {
        clearInterval(entry.timerId);
        entry.timerId = null;
      }
    }
  }

  /** Resume all active pollers. */
  resumePollers(): void {
    for (const [key, entry] of this.pollers) {
      if (entry.active && entry.timerId === null) {
        this.startPoller(key, entry);
      }
    }
  }

  /** Clean up all subscriptions, pollers, and listeners. */
  destroy(): void {
    this.channels.clear();
    for (const [key] of this.pollers) {
      this.unregisterPoller(key);
    }
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  private startPoller(key: string, entry: PollerEntry): void {
    const run = async () => {
      if (!entry.active) return;
      try {
        await entry.fn();
      } catch (err) {
        console.error(`[EventBus] Poller "${key}" error:`, err);
      }
    };
    // Run immediately on start
    run();
    entry.timerId = setInterval(run, entry.intervalMs);
  }

  private handleVisibilityChange(): void {
    if (document.hidden) {
      this.pausePollers();
      this.publish("system:visibility", { visible: false });
    } else {
      this.resumePollers();
      this.publish("system:visibility", { visible: true });
    }
  }
}

export const eventBus = new EventBus();
export { EventBus, type Subscriber, type Unsubscribe };
