-- 028: Metadata Governance Foundation Tables
-- Migrate hardcoded metadata (tool category mappings, tool policy rules,
-- orchestrator rules) into configurable database tables.

-- ══════════════════════════════════════════════════════════════════════
-- Table 1: resource_type_profiles
-- Stores resourceType → category / priority / tags derivation config,
-- replacing hardcoded mappings in toolAutoDiscovery.ts.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS resource_type_profiles (
  tenant_id        TEXT        NOT NULL DEFAULT 'tenant_dev',
  resource_type    TEXT        NOT NULL,
  default_category TEXT        NOT NULL DEFAULT 'integration',
  default_priority INTEGER     NOT NULL DEFAULT 5 CHECK (default_priority BETWEEN 1 AND 10),
  default_tags     TEXT[]      NOT NULL DEFAULT ARRAY['tool'],
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, resource_type)
);

-- Seed: extracted from inferCategory / inferPriority / inferTags in toolAutoDiscovery.ts
INSERT INTO resource_type_profiles (tenant_id, resource_type, default_category, default_priority, default_tags)
VALUES
  ('tenant_dev', 'model',         'ai',            9, ARRAY['llm','model','generation']),
  ('tenant_dev', 'embedding',     'ai',            8, ARRAY['embedding','vector','ai']),
  ('tenant_dev', 'knowledge',     'ai',            8, ARRAY['knowledge','rag','search']),
  ('tenant_dev', 'memory',        'ai',            8, ARRAY['memory','context','recall']),
  ('tenant_dev', 'intent',        'ai',            9, ARRAY['intent','analysis','nlp']),
  ('tenant_dev', 'nl2ui',         'ai',            9, ARRAY['nl2ui','page-generation','frontend']),
  ('tenant_dev', 'media',         'ai',            7, ARRAY['media','multimodal','vision']),
  ('tenant_dev', 'schema',        'database',      9, ARRAY['schema','database','ddl']),
  ('tenant_dev', 'entity',        'database',      8, ARRAY['entity','data','crud']),
  ('tenant_dev', 'channel',       'communication', 7, ARRAY['channel','im','messaging']),
  ('tenant_dev', 'federation',    'integration',   7, ARRAY['federation','cross-tenant','bridge']),
  ('tenant_dev', 'rbac',          'governance',    8, ARRAY['rbac','permission','authorization']),
  ('tenant_dev', 'governance',    'governance',    9, ARRAY['governance','audit','compliance']),
  ('tenant_dev', 'agent_runtime', 'governance',    8, ARRAY['agent','runtime','orchestration']),
  ('tenant_dev', 'agent',         'workflow',      7, ARRAY['agent','reflection','learning']),
  ('tenant_dev', 'browser',       'integration',   6, ARRAY['browser','automation','web']),
  ('tenant_dev', 'desktop',       'integration',   6, ARRAY['desktop','automation','application']),
  ('tenant_dev', 'skill',         'governance',    7, ARRAY['skill','management']),
  ('tenant_dev', 'tool',          'integration',   6, ARRAY['tool','discovery']),
  ('tenant_dev', 'workbench',     'integration',   6, ARRAY['workbench','plugin'])
ON CONFLICT (tenant_id, resource_type) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
-- Table 2: tool_policy_rules
-- Stores tool sorting / visibility policies, replacing PINNED_TOOL_NAMES
-- and isPlannerVisibleTool hardcoding in agentContext.ts.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tool_policy_rules (
  tenant_id     TEXT        NOT NULL DEFAULT 'tenant_dev',
  rule_type     TEXT        NOT NULL CHECK (rule_type IN ('pinned', 'hidden')),
  match_field   TEXT        NOT NULL CHECK (match_field IN ('name', 'tag', 'prefix')),
  match_pattern TEXT        NOT NULL,
  effect        JSONB       NOT NULL DEFAULT '{}',
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule_type, match_field, match_pattern)
);

-- Seed: pinned rules from PINNED_TOOL_NAMES (agentContext.ts L46-50)
INSERT INTO tool_policy_rules (tenant_id, rule_type, match_field, match_pattern, effect)
VALUES
  ('tenant_dev', 'pinned', 'name', 'knowledge.search', '{"pinnedOrder": 1}'),
  ('tenant_dev', 'pinned', 'name', 'memory.read',      '{"pinnedOrder": 2}'),
  ('tenant_dev', 'pinned', 'name', 'memory.write',     '{"pinnedOrder": 3}'),
  ('tenant_dev', 'pinned', 'name', 'nl2ui.generate',   '{"pinnedOrder": 4}'),
  ('tenant_dev', 'pinned', 'name', 'entity.create',    '{"pinnedOrder": 5}'),
  ('tenant_dev', 'pinned', 'name', 'entity.update',    '{"pinnedOrder": 6}'),
  ('tenant_dev', 'pinned', 'name', 'entity.delete',    '{"pinnedOrder": 7}')
ON CONFLICT (tenant_id, rule_type, match_field, match_pattern) DO NOTHING;

-- Seed: hidden rules from isPlannerVisibleTool (agentContext.ts L389-393)
INSERT INTO tool_policy_rules (tenant_id, rule_type, match_field, match_pattern, effect)
VALUES
  ('tenant_dev', 'hidden', 'prefix', 'device.', '{"visible": false, "reason": "device tools hidden from planner"}'),
  ('tenant_dev', 'hidden', 'tag', 'planner:hidden',    '{"visible": false, "reason": "tagged as planner:hidden"}'),
  ('tenant_dev', 'hidden', 'tag', 'internal-only',     '{"visible": false, "reason": "internal-only tool"}')
ON CONFLICT (tenant_id, rule_type, match_field, match_pattern) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
-- Table 3: orchestrator_rule_configs
-- Stores orchestrator rule configuration, replacing hardcoded rules in
-- orchestrator.ts and analyzer.ts.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS orchestrator_rule_configs (
  tenant_id  TEXT        NOT NULL DEFAULT 'tenant_dev',
  rule_group TEXT        NOT NULL CHECK (rule_group IN (
    'event_trigger', 'category_display', 'layer_display',
    'intent_pattern', 'action_intent_rescue'
  )),
  rules      JSONB       NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule_group)
);

-- Seed: event_trigger — from EVENT_TRIGGER_PATTERNS (orchestrator.ts L59-65)
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'event_trigger', '[
  {"pattern": "换个话题|说回|回到|继续(之前的|刚才的)", "reason": "topic_switch"},
  {"pattern": "总结一下|归纳一下|所以(结论是|结果是)", "reason": "conclusion"},
  {"pattern": "定稿|确认|就这样(吧|了)", "reason": "finalization"},
  {"pattern": "列(个|出|一下)(清单|列表|要点)", "reason": "listing"},
  {"pattern": "按(前面|之前|刚才)(的方式|的方法|的思路)", "reason": "reference"}
]'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;

-- Seed: category_display — from categoryNames (orchestrator.ts L155-171)
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'category_display', '{
  "nl2ui":         {"zh": "界面生成",       "en": "UI Generation"},
  "memory":        {"zh": "记忆管理",       "en": "Memory Management"},
  "knowledge":     {"zh": "知识检索",       "en": "Knowledge Retrieval"},
  "governance":    {"zh": "治理控制",       "en": "Governance Control"},
  "communication": {"zh": "通信集成",       "en": "Communication"},
  "file":          {"zh": "文件操作",       "en": "File Operations"},
  "database":      {"zh": "数据库",         "en": "Database"},
  "analytics":     {"zh": "数据分析",       "en": "Analytics"},
  "integration":   {"zh": "系统集成",       "en": "Integration"},
  "ai":            {"zh": "AI 增强",        "en": "AI Enhancement"},
  "device":        {"zh": "设备控制",       "en": "Device Control"},
  "collaboration": {"zh": "多智能体协作",   "en": "Multi-Agent Collaboration"},
  "testing":       {"zh": "测试工具",       "en": "Testing Tools"},
  "automation":    {"zh": "自动化",         "en": "Automation"},
  "uncategorized": {"zh": "其他工具",       "en": "Other Tools"}
}'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;

-- Seed: layer_display — from layerNames (orchestrator.ts L200-204)
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'layer_display', '{
  "kernel":    {"zh": "Kernel 内核层",    "en": "Kernel Layer",    "examples": ["实体CRUD", "工具治理"]},
  "builtin":   {"zh": "Core 核心层",      "en": "Core Layer",      "examples": ["编排", "模型网关", "知识", "记忆", "安全"]},
  "extension": {"zh": "Extension 扩展层", "en": "Extension Layer", "examples": ["媒体", "自动化", "分析"]}
}'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;

-- Seed: intent_pattern — rule-based intent detection from analyzer.ts L63-131
-- Context-dependent rules (L63-82) + standalone rules (L85-131)
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'intent_pattern', '{
  "context_rules": [
    {"pattern": "^(继续|接着来|再多看几条|再看看|继续查|再查一些)$", "prevIntent": "query", "intent": "query", "confidence": 0.68, "tag": "context_query_follow_up"},
    {"pattern": "^(就用这个方案|按这个方案来|就按这个来|用这个方案)$", "prevIntent": "ui", "intent": "ui", "confidence": 0.67, "tag": "context_ui_follow_up"},
    {"pattern": "^(对，?执行吧|执行吧|开始吧|就这样执行)$", "prevIntent": "task", "intent": "task", "confidence": 0.72, "tag": "context_task_confirm"},
    {"pattern": "^(算了，不弄了|不要继续了|换个思路|先别弄了)$", "prevIntent": "task", "intent": "task", "confidence": 0.64, "tag": "context_task_cancel"},
    {"pattern": "^(和上次一样的格式|按上次那个格式|保持上次格式)$", "historyPattern": "(生成|报表|月报|导出|格式)", "intent": "task", "confidence": 0.62, "tag": "context_task_repeat"},
    {"pattern": "^搞定了没有$", "prevIntent": "task", "intent": "query", "confidence": 0.58, "tag": "context_status_query"}
  ],
  "standalone_rules": [
    {"pattern": "^[.…!！?？.]+$", "intent": "chat", "confidence": 0.05, "tag": "punctuation_only"},
    {"pattern": "^(你好|您好|hello|hi|hey)$", "intent": "chat", "confidence": 0.85, "tag": "greeting"},
    {"pattern": "^(谢谢|感谢).*(清楚|明白|解释|帮助|啦)?$|^(好的|好吧|明白了|我知道了|收到|可以吗|行吗)([，,。.!！]|$)", "intent": "chat", "confidence": 0.85, "tag": "acknowledgement"},
    {"pattern": "什么是|区别|怎么|怎样|为什么|缺点|优点|详细|例子|展开讲讲|还有其他方法|跟上一个方案比|天气怎么样|架构是怎样|我想了解|解释一下|你觉得.+更好|推荐.+框架", "intent": "chat", "confidence": 0.72, "tag": "chat_qa_pattern"},
    {"pattern": "协作|多智能体|多角色|多个 agent|多个智能体|一起调查|一起评审|并行处理|团队讨论|组织一场.+讨论|发起.+讨论", "intent": "collab", "confidence": 0.78, "tag": "collab_pattern"},
    {"pattern": "查询并.*(删除|创建|审批|通知)|删除然后创建|执行审批最后发通知|把.+改为.+|改成发邮件|约一下|安排一下|排查一下|弄一下吧|换个思路|不要继续了", "intent": "task", "confidence": 0.76, "tag": "task_explicit_pattern"},
    {"pattern": "^有个东西需要你帮忙$", "intent": "task", "confidence": 0.46, "tag": "task_vague_request"},
    {"pattern": "^帮我看看数据$", "intent": "query", "confidence": 0.45, "tag": "query_vague_data"},
    {"pattern": "弄一下报表|做一下报表|生成报表|报表界面", "intent": "ui", "confidence": 0.66, "tag": "ui_report_pattern"},
    {"pattern": "上个月的报表|查一下.+报表|按时间排序|上个月的数据|这个月的数据|搞定了没有|把.+联系方式给我|查.+联系方式|结果有问题", "intent": "query", "confidence": 0.72, "tag": "query_explicit_pattern"},
    {"pattern": "生成.+(面板|页面|界面)|显示.+(看板|dashboard|图表|面板)|show me.+(dashboard|page|panel)|左边.+右边.+|上面.+下面.+|三栏布局|仪表盘|dashboard", "intent": "ui", "confidence": 0.82, "tag": "ui_explicit_pattern"},
    {"pattern": "界面|页面|面板|布局|表单|仪表盘|dashboard|图表|看板|左边.*右边|上面.*下面", "intent": "ui", "confidence": 0.76, "tag": "ui_pattern"},
    {"pattern": "查询|查找|搜索|列出|统计|汇总|找下|找找|看看|看下|拉一下|找出来|翻翻|有哪些|还在不在|历史订单|最近\\d+条|数据不对劲|给我拉|帮我看下|报表|联系方式|再多看几条", "intent": "query", "confidence": 0.72, "tag": "query_pattern"},
    {"pattern": "创建|新建|更新|修改|删除|审批|发送|发一封|导入|安排|处理|转给|设置|发布|标记|撤回|重新来过|停止|取消|暂停|回滚|执行|通知|跳过审批|继续这个任务|排查|约一下|弄一下|改成|换个思路", "intent": "task", "confidence": 0.74, "tag": "task_pattern"}
  ],
  "keywords": {
    "ui":    ["显示","展示","界面","页面","dashboard","看板","图表","可视化","生成页面","创建界面","ui","view","page","layout"],
    "query": ["查询","查找","搜索","查看","列出","统计","汇总","query","search","find","list","count","get"],
    "task":  ["执行","运行","创建","更新","删除","审批","提交","execute","run","create","update","delete","approve","submit"],
    "collab":["协作","讨论","辩论","多智能体","团队","分配","collaborate","discuss","debate","assign","team"],
    "chat":  []
  }
}'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;

-- Seed: action_intent_rescue — from orchestrator.ts L722
INSERT INTO orchestrator_rule_configs (tenant_id, rule_group, rules)
VALUES ('tenant_dev', 'action_intent_rescue', '{
  "pattern": "执行|(帮我.{0,8}创建)|(帮我.{0,8}删除)|(帮我.{0,8}更新)|(帮我.{0,8}发送)|(帮我.{0,8}关闭)|(请.{0,8}创建)|(请.{0,8}删除)",
  "description": "Detect action intent in reply text when tool_call is missing, trigger secondary LLM validation"
}'::jsonb)
ON CONFLICT (tenant_id, rule_group) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════
-- Extra: Tag nl2ui tools with execution:separate-pipeline
-- ══════════════════════════════════════════════════════════════════════

UPDATE tool_definitions
SET tags = array_append(tags, 'execution:separate-pipeline')
WHERE resource_type = 'nl2ui'
  AND NOT ('execution:separate-pipeline' = ANY(tags));
