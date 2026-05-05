/**
 * MindPal Protocol Registry Infrastructure
 *
 * 提供元协议架构的核心注册表机制。
 * 所有可扩展的协议元素（消息类型、错误码、模态、运行时等）
 * 通过注册表动态声明，而非硬编码枚举。
 *
 * 设计原则：
 * 1. 同步内存结构，零外部依赖
 * 2. builtIn 条目不可删除（保证核心功能永远可用）
 * 3. 支持按 category 分组查询
 * 4. 类型安全的泛型设计
 */

/** 注册表条目 */
export interface RegistryEntry<T = unknown> {
  /** 唯一标识（如 "task.assign", "image", "node"） */
  id: string;
  /** 分类标签（如 "collab.task", "modality", "runtime"） */
  category: string;
  /** 人类可读描述 */
  description?: string;
  /** payload 的 JSON Schema（可选，用于验证） */
  schema?: Record<string, unknown>;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
  /** 是否为内置条目（不可删除） */
  builtIn?: boolean;
  /** 关联值（泛型，如错误码的数字值） */
  value?: T;
}

/** 条目校验结果 */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/** 类型化注册表接口 */
export interface TypeRegistry<T = unknown> {
  /** 注册新条目。内部调用 validate 做前置校验，校验失败抛出错误。 */
  register(entry: RegistryEntry<T>): void;
  /** 批量注册 */
  registerAll(entries: RegistryEntry<T>[]): void;
  /** 注销条目。builtIn 条目不可注销，返回 false。 */
  unregister(id: string): boolean;
  /** 获取条目 */
  get(id: string): RegistryEntry<T> | undefined;
  /** 检查 id 是否已注册 */
  has(id: string): boolean;
  /** 列出所有条目，可按 category 过滤 */
  list(category?: string): RegistryEntry<T>[];
  /** 校验条目是否满足注册要求（id 非空、不重复、category 非空） */
  validate(entry: RegistryEntry<T>): ValidationResult;
  /** 获取所有已注册的 id 列表 */
  ids(): string[];
  /** 获取注册表大小 */
  size(): number;
  /** 重置为初始状态（仅保留 builtIn 条目） */
  reset(): void;
}

/** 创建注册表实例 */
export function createRegistry<T = unknown>(
  defaults?: RegistryEntry<T>[]
): TypeRegistry<T> {
  const store = new Map<string, RegistryEntry<T>>();

  // 初始化 defaults，未显式设置 builtIn 的条目默认为 true
  if (defaults) {
    for (const entry of defaults) {
      const normalized: RegistryEntry<T> = {
        ...entry,
        builtIn: entry.builtIn !== undefined ? entry.builtIn : true,
      };
      store.set(normalized.id, normalized);
    }
  }

  return {
    validate(entry: RegistryEntry<T>): ValidationResult {
      const errors: string[] = [];
      if (!entry.id || typeof entry.id !== 'string' || entry.id.trim() === '') {
        errors.push('entry.id must be a non-empty string');
      }
      if (!entry.category || typeof entry.category !== 'string' || entry.category.trim() === '') {
        errors.push('entry.category must be a non-empty string');
      }
      if (entry.id && store.has(entry.id)) {
        errors.push(`entry.id "${entry.id}" is already registered`);
      }
      return errors.length === 0 ? { valid: true } : { valid: false, errors };
    },

    register(entry: RegistryEntry<T>): void {
      const result = this.validate(entry);
      if (!result.valid) {
        throw new Error(`Registry: validation failed — ${result.errors!.join('; ')}`);
      }
      store.set(entry.id, { ...entry });
    },

    registerAll(entries: RegistryEntry<T>[]): void {
      for (const entry of entries) {
        this.register(entry);
      }
    },

    unregister(id: string): boolean {
      const entry = store.get(id);
      if (!entry) return false;
      if (entry.builtIn === true) return false;
      store.delete(id);
      return true;
    },

    get(id: string): RegistryEntry<T> | undefined {
      return store.get(id);
    },

    has(id: string): boolean {
      return store.has(id);
    },

    list(category?: string): RegistryEntry<T>[] {
      const entries = Array.from(store.values());
      if (category === undefined) return entries;
      return entries.filter((e) => e.category === category);
    },

    ids(): string[] {
      return Array.from(store.keys());
    },

    size(): number {
      return store.size;
    },

    reset(): void {
      for (const [id, entry] of store) {
        if (entry.builtIn !== true) {
          store.delete(id);
        }
      }
    },
  };
}

/** 快捷创建内置条目 */
export function builtInEntry<T>(
  id: string,
  category: string,
  value?: T,
  metadata?: Record<string, unknown>
): RegistryEntry<T> {
  return { id, category, builtIn: true, value, metadata };
}

/** 从注册表提取所有 id 作为常量数组（给 TS 消费者用于类型推断） */
export function registryIds<T>(registry: TypeRegistry<T>): string[] {
  return registry.ids();
}
