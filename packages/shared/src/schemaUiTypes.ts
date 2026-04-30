/* Schema-UI 共享类型 — JSON Schema驱动 + MDX增强 */

/** LLM生成的Schema-UI配置 */
export interface SchemaUiConfig {
  intent: 'ui' | 'chat';
  confidence: number;
  /** JSON Schema (draft-7) 描述数据结构 */
  schema: Record<string, unknown>;
  /** 轻量UI渲染提示 */
  uiHints: SchemaUiHints;
  /** 可选MDX富文本内容 */
  mdx?: string;
  /** 数据绑定 */
  dataBindings: SchemaUiDataBinding[];
  metadata?: Record<string, unknown>;
}

/** UI渲染提示 — 非硬编码组件，而是渲染策略 */
export interface SchemaUiHints {
  layout: 'table' | 'cards' | 'form' | 'chart' | 'markdown' | 'dashboard' | 'kanban' | 'timeline' | 'stats' | 'tree';
  title?: string;
  description?: string;
  /** 表格列定义（layout=table时） */
  columns?: string[];
  /** 分组字段（layout=cards时） */
  groupBy?: string;
  /** 图表类型（layout=chart时） */
  chartType?: 'bar' | 'line' | 'pie';
  /** 样式token — 用户可自由传任意CSS值 */
  style?: Record<string, string>;
  /** 时间字段（timeline布局） */
  timeField?: string;
  /** 看板列字段（kanban布局） */
  columnField?: string;
  /** 统计指标字段列表（stats布局） */
  statFields?: string[];
  /** 父级字段（tree布局） */
  parentField?: string;
  /** 表单字段联动规则 */
  fieldDeps?: Record<string, { showWhen: { field: string; equals: unknown } }>;
  /** 操作按钮列表 */
  actions?: Array<{ label: string; action: string; confirm?: string }>;
  /** 级联下拉配置：目标字段 → 依赖字段 + 选项映射 */
  cascades?: Record<string, {
    /** 依赖的父字段名 */
    parentField: string;
    /** 父字段值 → 子字段选项列表 */
    optionsMap: Record<string, string[]>;
  }>;
}

/** 数据绑定 — 简化版 */
export interface SchemaUiDataBinding {
  entity: string;
  mode: 'list' | 'query';
  filter?: Record<string, unknown>;
  sort?: { field: string; order: 'asc' | 'desc' };
  limit?: number;
}
