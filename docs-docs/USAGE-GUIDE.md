# 灵智 MindPal 智能体 OS — 系统使用指南

> 版本：2.0 &nbsp;|&nbsp; 本文档聚焦于「怎么用这个 OS 来做事」

---

## 1. OS 思维模型：理解灵智的运行哲学

灵智 MindPal 不是一个聊天机器人框架，不是一个工作流引擎。它是一个**操作系统** —— 智能体操作系统。理解这一点是正确使用它的前提。

### 1.1 类比操作系统

| 传统 OS 概念 | 灵智 MindPal 对等物 |
|-------------|-------------------|
| 进程（Process） | Agent Loop 实例 — 每个智能体任务是一个独立进程 |
| 进程调度器（Scheduler） | Priority Scheduler + Session Scheduler — 全局抢占 + 会话级策略 |
| 系统调用（Syscall） | 执行内核三阶段流水线 — resolve → admit → submit |
| 可执行程序（Executable） | 技能(Skill)包 — manifest 声明权限，沙箱隔离执行 |
| 文件系统（FS） | Schema 驱动的通用数据平面 — 万物皆可建模 |
| 内存（Memory） | 记忆系统 — 偏好/上下文/任务状态/记忆图谱 |
| 设备驱动（Driver） | 设备运行时 + 连接器 — 统一抽象物理世界和数字渠道 |
| 权限系统 | RBAC + ABAC + 策略快照 — 每次决策可追溯 |
| IPC | 协作信封（Envelope）+ Redis 事件总线 — Agent 间结构化通信 |
| Shell | 编排器 — 自然语言统一入口，意图分类，分流到各子系统 |

### 1.2 核心运行原语

灵智 MindPal 的一切行为围绕四个原语运转：**Observe → Think → Decide → Act**

- **Observe**：从工具执行结果、记忆召回、知识检索、世界状态中构建观察
- **Think**：Agent 基于观察和目标图，调用 LLM 推理下一步行动
- **Decide**：解析 LLM 输出为结构化决策（tool_call / done / delegate / escalate）
- **Act**：通过执行内核将决策提交为可追踪的步骤，进入工作流队列

### 1.3 架构不变式

每个执行步骤强制检查四项不变式，违反即拒绝：

1. **traceId** — 全链路追踪 ID，确保可追溯
2. **toolRef** — 版本化工具引用，必须已发布且已启用
3. **capabilityEnvelope** — 能力信封声明权限边界，不得扩大
4. **policySnapshotRef** — 策略快照关联，审计可回放

---

## 2. 内核机制：执行内核与规划内核

### 2.1 执行内核（Execution Kernel）

执行内核是所有工具调用的统一入口，无论来自编排器、Agent 循环、协作运行时还是直接 API 调用，都经过同一条流水线。这是 OS 的系统调用层。

**三阶段流水线：**

**Phase 1 — resolveAndValidateTool（解析与校验）**
- 解析原始工具引用（支持 `toolName@version` 或自动解析最新版本）
- 校验版本存在性、发布状态（必须 released）
- 校验工具在当前租户+空间的启用状态
- 校验工具合约完整性（scope / resourceType / action / idempotencyRequired）

**Phase 2 — admitAndBuildStepEnvelope（准入与信封构建）**
- 执行治理检查点（策略、安全扫描）
- 构建能力信封（CapabilityEnvelope），声明本次执行的权限边界
- 验证信封不得扩大调用者的权限
- 构建网络策略摘要（出站治理）

**Phase 3 — submitToolStep（提交与入队）**
- 创建 Job/Run/Step 三级记录
- 高风险操作自动进入审批流（needs_approval）
- 普通操作直接入队（queued）等待 Worker 执行

**核心设计原则**：零散乱 —— 之前分散在 orchestrator、agent-runtime、collab-runtime、tools 路由中的重复提交逻辑，全部统一到这一条流水线。任何新的运行时只需调用执行内核即可获得完整的校验、准入、审计。

### 2.2 规划内核（Planning Kernel）

规划内核负责将自然语言意图转化为可执行的工具调用计划。

**四阶段流水线：**

1. **discoverEnabledTools** — 发现当前租户+空间下所有已启用的工具，构建工具目录
2. **buildPlannerPrompt** — 将工具目录注入规划提示词（含语义路由增强）
3. **invokePlannerLlm** — 调用模型网关进行规划推理
4. **parsePlanSuggestions** — 解析 LLM 输出的 tool_call 建议，逐一校验版本/启用/定义，丢弃不合规的调用并审计

**语义预路由**：规划前先进行语义路由（routeByIntent），当高置信度匹配到特定技能(Skill)时，在 Prompt 中优先推荐，加速规划收敛。

---

## 3. Agent Loop：智能体循环引擎

Agent Loop 是灵智 MindPal 的核心进程模型。每个独立的智能体任务都是一个 Agent Loop 实例。

### 3.1 循环结构

```
┌─────────────────────────────────────────┐
│              Agent Loop                  │
│                                          │
│  ┌─ Prepare ─┐                          │
│  │ 工具发现    │                          │
│  │ 记忆召回    │                          │
│  │ 知识检索    │                          │
│  │ 策略加载    │                          │
│  └────┬───────┘                          │
│       ▼                                  │
│  ┌─ Iteration Loop ────────────────┐    │
│  │  Observe → Think → Decide → Act │◄──┐│
│  │       │                         │   ││
│  │       ├─ tool_call → 执行内核 ──┤   ││
│  │       ├─ done → 验证Agent ─────┤   ││
│  │       ├─ delegate → 委派 ──────┤   ││
│  │       └─ escalate → 上报人工 ──┤   ││
│  │                                 │   ││
│  │  World State 更新 ◄─ 执行结果   │───┘│
│  └─────────────────────────────────┘    │
│                                          │
│  ┌─ Finalize ─┐                         │
│  │ 目标验证    │                          │
│  │ 任务状态持久化│                        │
│  │ 自动反思    │                          │
│  └────────────┘                          │
└──────────────────────────────────────────┘
```

### 3.2 准备阶段

Agent Loop 启动时自动执行准备：
- **工具发现**：扫描当前可用工具集，带 LRU 缓存（TTL 30s）
- **记忆召回**：召回相关历史记忆（TTL 60s 缓存）
- **知识检索**：检索相关知识库文档
- **策略召回**：加载程序性策略（已学到的 how-to）
- **目标分解**：将用户目标分解为结构化 GoalGraph

### 3.3 迭代循环

每轮迭代：
1. 构建观察上下文（包含步骤历史、世界状态、目标进度）
2. 调用 LLM 进行推理（Think），生成决策
3. 解析决策为结构化 Action
4. 执行 Action（工具调用通过执行内核提交）
5. 等待步骤完成，提取世界状态变化
6. 评估目标条件满足性
7. 若目标未完成且未超限，继续下一轮

### 3.4 验证 Agent

当 Agent Loop 认为目标已完成（decision = done）时，**不会直接信任 LLM 的自我报告**。而是启动独立的 Verifier Agent：
- 使用**不同的 LLM 调用**（独立 purpose），避免自我验证偏差
- 对比 GoalGraph 的 successCriteria 与当前 WorldState
- 输出 verified / rejected / needs_more_info
- rejected 时返回未满足标准 + 建议修复方向，Agent Loop 继续迭代

### 3.5 自动反思

循环结束后触发 auto-reflexion：分析执行过程中的效率、错误模式、策略有效性，将学到的经验写入记忆系统，供后续任务复用。

---

## 4. 编排器：统一入口与意图理解

编排器是灵智的 Shell —— 所有用户交互的统一入口。

### 4.1 四种模式

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| **answer** | 对话问答类意图 | 调用模型网关直接回答，可选知识检索增强 |
| **execute** | 工具调用类意图 | 进入规划 → 执行流水线，创建 Run/Step |
| **collab** | 需要多角色协作 | 创建协作运行，启动多个 Agent Loop |
| **intervene** | 人工介入请求 | 暂停自动执行，等待人类输入 |

### 4.2 意图分类

编排器使用两级意图分类：
- **快速分类**（fast）：低延迟规则 + 轻量模型
- **深度分类**（two_level）：完整 LLM 分析

支持并行双路决策（PARALLEL_CLASSIFY_ENABLED=1）：fast 和 two_level 同时执行，以 two_level 为准，fast 作影子对比，含熔断机制。

### 4.3 执行策略

当意图被分类为 execute 时，系统检查自动执行阈值（AUTO_EXECUTION_THRESHOLD）：
- 高置信度 → 自动进入执行
- 低置信度 → 返回建议，等待用户确认

### 4.4 流式分派

`POST /orchestrator/dispatch/stream` 提供 SSE 流式响应：
- 实时推送每个步骤的状态变化
- 支持流式 LLM 输出
- 包含 DLP 实时过滤
- 支持会话持久化和恢复

---

## 5. 目标分解与世界状态

### 5.1 GoalGraph — 结构化目标图

Agent Loop 不是简单地「一步一步执行」，而是将目标分解为 DAG（有向无环图）结构的子目标。

每个 SubGoal 包含：
- **前置条件**（preconditions）：开始前必须满足的条件（数据存在/权限就绪/状态检查）
- **后置条件**（postconditions）：完成后世界状态的变化
- **成功标准**（successCriteria）：验证方法 + 权重 + 是否必需
- **完成证据**（completionEvidence）：证明完成的具体产物
- **依赖类型**（dependencyType）：finish_to_start / output_to_input / cancel_cascade
- **复杂度估计**、写操作标记、审批要求

GoalGraph 经过 DAG 合法性验证（无循环、无悬空引用、资源冲突检测）后交给 Agent Loop 执行。

### 5.2 WorldState — 结构化世界状态

灵智 MindPal 维护一个运行时的结构化世界状态，从每个工具执行结果中增量提取：

- **实体**（Entity）：创建/修改了什么对象（客户、订单、文档...）
- **关系**（Relation）：对象间产生了什么关系
- **事实**（Fact）：环境中发生了什么变化

提取策略分两层：
1. **规则提取**（零 LLM）：从结构化工具输出直接映射
2. **LLM 辅助提取**（可选）：对非结构化输出调用 LLM 提取

WorldState 是 Agent Loop 做决策的重要上下文，也是 GoalCondition 评估的基础。

---

## 6. 意图锚定与越界熔断

这是灵智 MindPal 最关键的安全能力之一：**确保智能体始终在人类意图边界内运行**。

### 6.1 Intent Anchoring（意图锚定）

系统自动从用户指令中提取并持久化四类意图锚点：
- **explicit_command**：明确指令（「查询上月销售数据」）
- **constraint**：约束条件（「必须使用中文回复」「务必在10分钟内完成」）
- **preference**：偏好（「尽量简洁」）
- **prohibition**：禁令（「不要修改生产数据」「禁止发送邮件」）

锚点支持正则模式匹配（中英文），优先级排序，可通过配置文件或环境变量自定义规则。

### 6.2 Boundary Detection（越界检测）

Agent Loop 的每一轮迭代中，在 Act 之前检查：
- 即将执行的工具调用是否违背已锚定的禁令
- 输入参数是否违反约束条件
- 行为是否偏离原始意图方向

### 6.3 Circuit Breaker（越界熔断）

检测到越界时的三级响应：
1. **暂停**：挂起当前 Agent Loop，保存 checkpoint
2. **回滚**：撤销已执行的副作用（如果可补偿）
3. **上报**：通知人工介入，附带越界上下文

---

## 7. 多智能体协作与辩论

### 7.1 协作编排器（Collab Orchestrator）

类比 OS：Agent Loop 是进程，CollabOrchestrator 是调度器。每个 Agent 是独立 runAgentLoop 实例，有特定角色和子目标，Agent 间通过共享 DB（collab_envelopes）+ 事件通知通信。

**协调策略由 LLM 决定**（通过 CollabPlan），不硬编码调度逻辑。

三种执行策略：
- **sequential**：顺序执行各 Agent，后者可看到前者的输出
- **parallel**：并行执行，最后汇总
- **pipeline**：流水线模式，每个 Agent 处理并传递

### 7.2 辩论机制（Debate V2）

当多个 Agent 产生分歧时，自动触发结构化辩论：

1. 各方提出立场（DebatePosition），含论点、置信度、证据
2. 多轮交叉质疑与反驳，每轮由各方看到对手论点后更新自己的立场
3. 分歧检测：计算 N 方分歧度，判断是否需要继续辩论
4. 动态纠错：在辩论过程中发现错误时，发出 correction，所有方更新
5. 共识演化追踪：记录共识分数随轮次的变化曲线
6. 仲裁裁决：达到收敛阈值或最大轮次后，仲裁者做出最终裁决

### 7.3 协作权限

- 每个 Agent 角色有独立的权限边界
- 支持权限委派（delegation）和委派链追踪
- 仲裁策略：加权投票、多数决、unanimous
- 协作预算控制：协作场景中每个 Agent 角色可设置工具执行次数上限（`max_budget`），运行时逐次递增（`used_budget`），超限触发 `collab.budget.exceeded` 事件；支持预算委派，子 Agent 预算从父 Agent 余额中扣除

### 7.4 交叉验证

协作完成后执行交叉验证：各 Agent 验证其他 Agent 的输出，记录角色表现历史，供后续协作参考。

---

## 8. OS 级进程调度

### 8.1 全局优先级调度器（Priority Scheduler）

管理所有 Agent Loop 实例的全局调度：
- **租户级并发限制**：每个租户最大并行 Agent 数（默认 20）
- **空间级并发限制**：每个空间最大并行 Agent 数（默认 10）
- **全局硬上限**：防止 OOM 的绝对上限
- **优先级抢占**：高优先级 Agent 可抢占低优先级的资源配额
- **配额继承**：子 Agent 配额不超过父 Agent
- **公平调度**：同优先级按等待时间 FIFO
- **饥饿检测**：低优先级任务等待超阈值时自动提升优先级

### 8.2 会话级调度器（Session Scheduler）

在全局调度之下，管理单个会话内多任务的执行顺序：

四种调度策略：
- **FIFO** — 先入先出
- **Priority** — 按优先级排序
- **DependencyAware** — 依赖就绪的任务优先
- **SJF** — 最短作业优先

支持动态并发配置（无硬编码上限）、会话级抢占、LLM 驱动优先级推断。

### 8.3 任务队列管理器（Task Queue Manager）

OS 级进程调度器的核心实现：
- 入队/出队生命周期管理
- 依赖就绪检查（前置任务完成后才允许执行）
- pause/resume/cancel/retry 全生命周期
- 级联操作（任务完成/失败时触发下游依赖处理）
- checkpoint 写入（shutdown 时暂停活跃任务，重启后恢复）
- 僵尸任务检测（Supervisor 定期扫描超时进程）

---

## 9. 知识引擎与证据链

### 9.1 多阶段检索

灵智 MindPal 的 RAG 不是简单的「向量搜索」，而是多阶段管线：

```
文档摄取 → 格式检测 → 文档解析 → 智能分块 → 向量化 → 入库
用户查询 → 关键词检索 → Embedding 检索 → Rerank → 证据链引用 → 返回
```

### 9.2 可插拔分块策略

| 策略 | 适用场景 |
|------|---------|
| 默认 | 通用文本 |
| ParentChild | 层次化文档（手册、规范） |
| TableAware | 含表格的文档（保留表格完整性） |
| CodeAware | 代码文件（按函数/类分块） |
| 自定义 | 通过 `registerChunkStrategy()` 注册任意策略 |

### 9.3 证据链

每个检索结果都关联证据引用（evidenceRef），支持：
- 原文定位（精确到 chunk）
- 证据链解析（多层引用追溯）
- 置信度评分

### 9.4 向量存储降级链

支持多后端自动降级：Qdrant → Milvus → External HTTP → 内置。某个后端不可用时自动切换到下一个，通过 `DegradingVectorStoreChain` 实现。

---

## 10. 记忆系统与记忆图谱

### 10.1 记忆类型

- **偏好记忆**：语言、交互风格、关注领域
- **会话上下文**：对话历史、上下文窗口
- **任务状态**：工作流中间状态持久化
- **程序性策略**：学到的 how-to 经验
- **记忆图谱**：实体关系网络

### 10.2 记忆安全

基于 Minhash 语义向量进行近似去重，风险分级写入：
- **low** — 直接写入
- **medium** — 写入 + 审计
- **high** — 需要审批确认（writePolicy=confirmed）

### 10.3 记忆在 Agent Loop 中的作用

准备阶段自动召回相关记忆，注入 Agent 的思考上下文。Agent 完成任务后，自动反思生成新的记忆条目，形成「做得越多，越聪明」的正循环。

---

## 11. 技能(Skill)体系：OS 的可执行程序

技能(Skill)就是灵智 MindPal 的可执行程序。像操作系统通过进程运行程序一样，灵智 MindPal 通过技能(Skill)沙箱运行能力。

### 11.1 四层注册体系

| 层级 | 说明 | 特征 |
|------|------|------|
| **kernel** | 核心工具声明 | 始终启用，不可禁用 |
| **core** | 基本平台能力（编排器、模型网关、RAG、记忆等） | 始终注册，不可禁用 |
| **optional** | 可选能力（NL2UI、OAuth、SSO、协作运行时等） | 默认注册，可禁用 |
| **extension** | 扩展能力（媒体、备份、AI事件推理等） | 按需加载 |

### 11.2 技能(Skill)合约

每个技能(Skill)的 manifest.json 是一份能力合约，声明：
- 身份（name@version）
- 权限范围（scope: read/write）
- 资源类型和操作
- 风险等级（low/medium/high）
- 审批要求
- 幂等性要求
- 输入/输出 Schema

### 11.3 技能(Skill)运行时安全

- **进程隔离 / 容器隔离** — 通过 `SKILL_RUNTIME_BACKEND` 配置
- **出站网络策略** — host 白名单 + 路径/方法级规则
- **依赖扫描** — 检查技能(Skill)依赖的安全性
- **供应链信任** — 未签名包可拒绝执行
- **禁止模块列表** — 阻止访问 fs/net/child_process 等危险模块
- **动态代码执行锁定** — 禁用 eval/Function 等

### 11.4 多语言支持

- **Node.js/TypeScript**：原生支持
- **Python**：JSON-RPC over stdio，支持 requirements.txt
- **扩展协议**：任何能通过 JSON-RPC 通信的语言

---

## 12. 治理控制面

### 12.1 变更集生命周期

所有对系统的重要变更都通过变更集管理：

```
draft → submit → approve → release → (rollback)
                              ↘ canary（灰度发布）
```

- **预检**（preflight）：发布前摘要和影响分析
- **评测准入**：可配置评测套件，只有通过评测才允许发布
- **灰度发布**：canary 模式，渐进式推广

### 12.2 审批规则引擎

不是简单的「高风险需审批」，而是完整的规则引擎：
- 自动评估工具执行风险
- 支持双人审批（dual approval）配置
- 上下文感知的审批决策（assessment context）
- 审批链追踪

### 12.3 治理检查点

在执行内核的 Phase 2（准入阶段），运行治理检查点管线：
- 策略合规检查
- 安全扫描
- 降级审计（检查基础设施异常时也会记录，确保可追溯）
- 失败时 fail-closed（拒绝执行）

---

## 13. 安全中枢

### 13.1 ABAC 策略引擎

比传统 RBAC 更强大的属性基策略：
- 支持条件表达式（subject/resource/environment 属性组合）
- 行过滤（row filter）— 自动限制查询范围
- 字段级权限 — 读/写方向独立控制
- 策略组合算法（deny-overrides / permit-overrides / first-applicable）
- 策略集索引加速评估

### 13.2 DLP（数据防泄漏）

两种模式：
- `audit_only` — 记录但不拦截
- `deny` — 命中敏感信息直接拦截

流式 DLP：对 SSE 流式输出也实时过滤，不是等全部输出完再检查。

### 13.3 提示注入防御

自动检测 Prompt Injection 攻击，支持多级严重度和策略配置。

### 13.4 列级加密

敏感字段 AES 加密存储，支持：
- 按需加密/解密
- 密钥轮换（reencrypt）
- 加密状态检测

### 13.5 审计不可篡改

- 链式哈希校验（类似区块链）
- 审计 Outbox 异步归档
- 审计完整性验证接口

---

## 14. Schema 驱动的元数据万物建模

这是灵智 MindPal 的「文件系统」—— 一切实体、关系、行为、策略均可通过元数据动态建模与扩展。

### 14.1 通用实体 CRUD

无需写一行代码即可管理任何数据。Schema 定义后，自动获得：
- 创建/读取/更新/删除
- 结构化查询（filters / orderBy / cursor 分页）
- 批量导入导出
- 字段级权限控制
- 审计日志

### 14.2 NL2Schema

通过自然语言描述自动创建 Schema —— schema-create-skill 接受自然语言输入，AI 推断实体、字段、关系，生成完整的 Schema 定义，通过变更集审批后发布。

---

## 15. 设备平面与具身智能

### 15.1 设备运行时

设备是灵智与物理世界的接口。Device Agent 是一个可以部署在任何设备（PC、服务器、机器人、IoT）上的常驻程序：
- 注册配对 → 心跳保活 → 指令接收 → 本地执行 → 结果上报
- 支持 WebSocket 长连接实时双向通信
- 插件体系扩展设备能力
- 内核边界检查确保插件不侵入核心
- 本地策略缓存支持离线决策

### 15.2 流式设备控制

`streaming-device-control` 技能(Skill)提供实时流式控制能力，适用于机器人操控等低延迟场景。

### 15.3 桌面/浏览器自动化

browser-automation 和 desktop-automation 技能(Skill)提供桌面和浏览器级别的自动化能力。

---

## 16. 渠道平面与全域接入

灵智 MindPal 可以接入任何数字渠道：

| 渠道 | 连接器 |
|------|--------|
| Webhook | 入站/出站，签名验证 |
| 邮件 | IMAP / Exchange / SMTP |
| IM | Mock IM（可扩展到企业微信/钉钉/Slack） |
| 订阅 | 长轮询/WebSocket 订阅 |

渠道网关统一消息格式，通知模板版本化，Outbox 模式保证可靠投递，死信重试。

---

## 17. 可观测性与运维

### 17.1 四柱可观测

- **Metrics**：Prometheus 兼容指标（API/Worker/Runner 均导出）
- **Traces**：OpenTelemetry 分布式追踪（Jaeger）
- **Logs**：结构化日志 + Loki 聚合
- **Alerts**：Alertmanager 告警规则

### 17.2 Admin CLI

只读/幂等运维工具：
- `audit verify` — 审计链完整性校验
- `models usage` — 模型调用量统计
- `queue status` — 队列状态查询

---

## 18. 扩展范式：如何在 OS 之上构建一切

灵智 MindPal 是一个 OS，这意味着**任何应用都可以在它之上构建**。扩展不是修改核心代码，而是组合 OS 原语。

### 18.1 扩展三原则

1. **技能(Skill)即程序**：所有新能力通过技能(Skill)包注册，声明合约，沙箱执行
2. **Schema 即数据**：所有新数据模型通过 Schema 定义，无需写 CRUD 代码
3. **连接器即驱动**：所有新渠道/设备通过连接器注册，统一生命周期

### 18.2 组合示例

**场景：构建一个行业应用**

1. 定义 Schema（业务数据模型）→ 自动获得 CRUD + 权限 + 审计
2. 开发技能(Skill)（行业专业能力）→ manifest 声明合约 → 沙箱执行
3. 配置连接器（接入行业系统）→ 统一消息格式
4. 配置治理规则（审批/灰度）→ 变更集管理
5. 注入知识库（行业知识）→ RAG 增强
6. 配置 Agent（角色/工具/约束）→ Agent Loop 自动执行

**你不需要写框架代码**。你只需要告诉 OS：有什么数据、有什么能力、有什么规则、有什么知识。OS 负责把它们编排成一个完整的智能系统。
