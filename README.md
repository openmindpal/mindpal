<div align="center">

**[English](README.en.md) | 中文**

# 灵智Mindpal

**智慧的伙伴 — 万物皆可建模、皆可授权、皆可执行**

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)

[快速开始](#-快速开始) · [架构概览](#-架构概览) · [API 文档](#-api-概览) · [社区](#-社区与联系方式)

</div>

---


灵智Mindpal是一个全栈智能体平台，以 **十维能力架构 + 五层能力分层 + 五大治理平面** 的智能体 OS 架构为基座，以 OS 类比思维设计（Agent = 进程，调度器编排执行，内核管理资源），从宏观到微观统一管理数据、知识、设备与机器人，为个人和组织构建贯穿全生命周期的数字生命（记忆、偏好、健康、关系、资产、任务），并通过具身智能将决策落到现实世界的动作上 —— **全程可控、可回放、可追责**。

---


> 感谢豆包取名。

## 目录

- [核心特性](#-核心特性)
- [架构概览](#-架构概览)
- [技术栈](#-技术栈)
- [快速开始](#-快速开始)
- [项目结构](#-项目结构)
- [API 概览](#-api-概览)
- [安全与治理](#-安全与治理)
- [可观测性](#-可观测性)
- [社会价值愿景](#-社会价值愿景)
- [特别感谢](#-特别感谢)
- [社区与联系方式](#-社区与联系方式)
- [许可证](#-许可证)

## ✨ 核心特性

| 领域 | 能力 |
|------|------|
| **Agent 认知循环** | Observe→Think→Decide→Act 智能体循环引擎、GoalGraph DAG 驱动目标分解、WorldState 实体/关系/事实持续追踪、独立 Verifier Agent 目标满足性校验 |
| **AI 编排** | 受控工具调用、自动规划（Planning Kernel）、语义路由（Intent Router）、多步工作流、回放与补偿 |
| **意图理解与安全** | 意图锚定（Intent Anchoring）、越界熔断、用户指令持久化（命令/约束/偏好/禁令）、Prompt 注入检测 |
| **多智能体协作** | 角色通信、权限上下文与委派、协作协议、辩论机制（v1/v2）、交叉验证与动态纠错、加权投票共识、联邦协作 |
| **智能调度** | 三层调度体系（全局优先级→会话级→任务队列）、抢占机制、饥饿检测、SJF/FIFO/依赖感知策略、事件驱动 Agent 唤醒 |
| **知识引擎** | 文档摄取（PDF/Word/Excel/扫描件）、分块策略、多阶段检索（关键词 + embedding + rerank）、证据链引用、专业向量数据库集成 |
| **长期记忆** | 偏好存储、会话上下文、任务状态持久化、记忆图谱（memory graph）、记忆嵌入、列级加密、风险分级审批、生命周期管理 |
| **Skill 运行时** | 多语言支持（Node.js/Python）、隔离沙箱（禁止模块/动态代码锁定）、最小权限、出站网络策略、依赖扫描、供应链安全门禁、Skill RPC 协议 |
| **治理控制面** | 变更集（draft→submit→approve→release→rollback）、灰度发布、评测准入、动态审批规则引擎（递归 AND/OR 条件匹配）、运行时治理检查点 |
| **设备/具身智能** | 设备注册配对、远程执行、桌面端 Agent、浏览器自动化（Playwright）、桌面控制/GUI 自动化、视觉感知路由、能力探测 |
| **NL2UI** | 自然语言生成 UI、动态页面配置、工作台管理、可视化流程编排（ReactFlow） |
| **语音交互** | 语音输入（WebSpeech API）、TTS 语音合成、语音 Skill |
| **通用数据平面** | Schema 驱动 CRUD、导入导出、离线同步、Yjs 协同编辑 |
| **安全中枢** | RBAC + ABAC 策略引擎、Safety/DLP（审计/拦截双模式）、Prompt 注入检测、审计不可篡改日志、供应链安全（信任/SBOM/依赖扫描）、模块边界扫描 |
| **身份认证** | Dev/HMAC 模式、SAML、SSO（OIDC）、SCIM 用户同步、MFA 多因素认证、组织隔离 |
| **渠道接入** | Webhook、IMAP、Exchange、SMTP、Mock IM、WebSocket 实时通知 |
| **可插拔工作台** | iframe sandbox + CSP 隔离、postMessage 能力注入 |
| **备份/恢复** | 空间级备份、一键恢复、Graceful Shutdown 任务暂停与启动恢复 |

## 🏗 架构概览

系统采用 **十维能力架构 + 五层能力分层 + 五大治理平面** 的智能体 OS 架构，以 OS 类比思维设计：Agent 是进程、调度器编排执行、内核管理资源：

### 十维能力架构

```
感知  ──  编排器 + 意图分类 + 渠道接入         → 理解一切输入
认知  ──  Agent Loop + 目标分解 + 世界状态     → 理解问题结构
规划  ──  规划内核 + GoalGraph DAG              → 将目标变为行动路径
执行  ──  执行内核 + Skill 沙箱 + Worker        → 安全地做事
记忆  ──  记忆系统 + 多通道召回 + 偏好           → 积累经验
知识  ──  RAG + 证据链 + 混合检索               → 利用已有知识
协作  ──  多 Agent 编排 + 辩论 + 联邦            → 多角色协同
治理  ──  变更集 + 审批 + 灰度 + RBAC/ABAC       → 受控演进
连接  ──  设备运行时 + 连接器 + 渠道网关          → 触达物理/数字世界
建模  ──  Schema + 元数据 + 通用 CRUD            → 描述万物
```

### 五层能力分层

```
┌─────────────────────────────────────────────────────────────┐
│    沙箱 Skill 层（外部扩展，manifest 声明权限，RPC 通信）     │
├─────────────────────────────────────────────────────────────┤
│  扩展能力层：媒体流水线 / 备份 / 回放 / 产物 / 分析 /       │
│            AI事件推理 / 浏览器自动化 / 桌面自动化          │
├─────────────────────────────────────────────────────────────┤
│  可选能力层：NL2UI / 工作台 / OAuth / SSO(OIDC) / SCIM /   │
│            通知 / 设备运行时 / 协作运行时 / 同步引擎 /     │
│            RBAC / 联邦网关 / MFA / 观测性仪表盘            │
├─────────────────────────────────────────────────────────────┤
│  核心能力层：编排器 / 模型网关 / 知识RAG / 记忆管理 /       │
│            安全策略 / 连接器 / 任务管理 / 渠道网关 / 触发器  │
├─────────────────────────────────────────────────────────────┤
│  运行时内核：Agent Loop / 执行内核 / 规划内核 / 目标分解器 / │
│            世界状态 / 验证代理 / 意图锚定 / 状态机 /        │
│            任务队列 / 优先级调度 / 会话调度 / 协作调度      │
└─────────────────────────────────────────────────────────────┘
```

### 五大治理平面

```
┌─────────────────────────────────────────────────────────────────────┐
│  治理平面：身份 / RBAC+ABAC / Safety / DLP / 审批规则引擎 /        │
│          审计 / 发布灰度回滚 / 意图锚定 / Prompt注入防护          │
├─────────────────────────────────────────────────────────────────────┤
│  执行平面：工具合约 / 版本化Schema / 幂等性 / 工作流 /              │
│          队列重试补偿 / 供应链安全门禁 / 熔断器                  │
├─────────────────────────────────────────────────────────────────────┤
│  设备平面：边缘设备 / 网关 / 机器人控制器 / 桌面执行器 /           │
│          浏览器自动化 / GUI自动化 / 视觉感知 / 统一权限边界     │
├─────────────────────────────────────────────────────────────────────┤
│  智能平面：知识RAG / 证据链 / 长期记忆 / 任务状态 /                │
│          上下文持久化 / 记忆嵌入 / 列级加密                     │
├─────────────────────────────────────────────────────────────────────┤
│  渠道平面：IM / Webhook / 邮件 / 订阅 / 可靠发件箱 / 回执追踪 /      │
│          WebSocket 实时通知                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 内核设计原则

| 内核模块 | 职责 |
|---------|------|
| **Agent Loop 循环引擎** | Observe→Think→Decide→Act 认知循环，驱动智能体自主决策与执行 |
| **目标分解器** | LLM 驱动目标分解，生成 GoalGraph DAG（含依赖/前后置条件/成功标准） |
| **世界状态提取器** | 从工具输出提取实体/关系/事实，规则提取 + LLM 辅助提取 |
| **验证代理** | 独立 LLM 校验目标满足性，避免决策 LLM 自我评价偏差 |
| **意图锚定服务** | 持久化用户指令（命令/约束/偏好/禁令），越界时自动熔断 |
| **执行内核** | 统一的「解析 → 校验 → 准入 → 构建 → 提交 → 入队」流水线 |
| **规划内核** | 「发现 → 提示 → LLM → 解析 → 校验」规划流水线 + 语义路由 |
| **状态机** | Run/Step/Collab 生命周期状态迁移（created → queued → running → succeeded/failed） |
| **任务队列管理器** | OS 级进程调度——并发控制、依赖就绪检查、级联操作、生命周期管理 |
| **优先级调度器** | 全局并发上限 + 租户/空间级限制 + 抢占 + 配额继承 + 饥饿检测 |
| **会话调度器** | FIFO / Priority / DependencyAware / SJF 策略，LLM 驱动优先级推断 |
| **协作调度器** | 多 Agent Loop 实例编排（sequential/parallel/pipeline）+ 辩论 + 共识 |
| **治理检查点** | 7 种检查类型 × 3 个阶段（权限/策略/安全/超时/资源/审计/不变式） |
| **审批规则引擎** | 动态规则加载，递归 AND/OR 条件匹配，自带人话解释 |
| **架构不变式** | 强制检查 traceId / toolRef / capabilityEnvelope / policySnapshotRef |

> 详细架构文档见仓库 `原始架构设计/` 目录。

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript 5.8, ES2022 |
| 运行时 | Node.js 20+ |
| 后端框架 | Fastify 5 + WebSocket |
| 前端框架 | Next.js 16 + React 19 |
| UI 库 | @xyflow/react (流程图) + framer-motion + react-markdown |
| 数据库 | PostgreSQL 16（28 个迁移文件） |
| 缓存/消息 | Redis 7 + ioredis |
| 任务队列 | BullMQ 5.58 |
| 对象存储 | MinIO |
| 包管理 | pnpm 10.4 workspaces (monorepo) |
| 校验 | Zod v4 |
| 协同编辑 | Yjs + y-protocols |
| 设备自动化 | Playwright-core + systray2 |
| 可观测性 | OpenTelemetry SDK + Prometheus + Grafana + Jaeger + Loki + Alertmanager |
| 容器化 | Docker Compose |

## 🚀 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 10（`corepack enable && corepack prepare pnpm@10 --activate`）
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)（用于数据库等依赖）

### 1. 克隆仓库

```bash
git clone https://github.com/your-org/openslin.git
cd openslin
```

### 2. 启动基础设施

```bash
docker compose up -d    # PostgreSQL 16 + Redis 7 + MinIO

# 可选：启动可观测性栈
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

### 3. 配置环境变量

```bash
cp .env.example .env    # 按需修改
```

### 4. 安装依赖 & 初始化数据库

```bash
npm install
npm run db:seed -w @openslin/api    # 迁移 + 种子数据 + core schema
```

### 5. 启动服务

```bash
npm run dev:api       # API 服务     → http://localhost:3001
npm run dev:worker    # Worker 异步作业（BullMQ）
npm run dev:web       # Web 前端     → http://localhost:4000

# 可选：启动可观测性服务（Prometheus/Grafana/Jaeger/Loki）
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

### 默认访问地址

**应用服务**

| 服务 | 地址 |
|------|------|
| Web 首页 | http://localhost:4000 |
| 设置页 | http://localhost:4000/settings |
| UI 配置管理 | http://localhost:4000/admin/ui |
| RBAC 管理 | http://localhost:4000/admin/rbac |
| API 健康检查 | http://localhost:3001/health |

**基础设施**（端口取决于 `.env` 配置）

| 服务 | 默认端口 | 说明 |
|------|---------|------|
| PostgreSQL | 5432 | 数据库 |
| Redis | 6379 | 缓存/队列 |
| MinIO API | 9000 | 对象存储 |
| MinIO Console | 9001 | 存储管理界面 |

### Admin CLI

提供只读/幂等运维 CLI，适合排障与运营查询：

```bash
npm run dev -w @openslin/admin-cli

# 示例
openslin-admin audit verify --apiBase http://localhost:3001 --token <token> --tenantId tenant_dev
openslin-admin models usage --apiBase http://localhost:3001 --token <token> --range 24h
openslin-admin queue status --apiBase http://localhost:3001 --token <token>
```

## 📁 项目结构

```
openslin/
├── apps/
│   ├── api/            # Fastify API 服务（Agent OS 大脑）
│   │   ├── kernel/     # 内核：Agent Loop/目标分解/规划/执行/调度/协作
│   │   ├── routes/     # 43 个路由（含 /v1 版本化）
│   │   ├── modules/    # 28 个领域模块（认证/治理/模型/知识/记忆等）
│   │   ├── skills/     # 39 个内建技能（四层：kernel/core/optional/extension）
│   │   ├── plugins/    # 15 个中间件（日志/追踪/版本化/通知/DLP/审计等）
│   │   └── migrations/ # 28 个 SQL 迁移文件
│   ├── web/            # Next.js 前端（React 19 + ReactFlow + 国际化）
│   ├── worker/         # BullMQ 异步工作节点（知识/记忆/治理/通知）
│   ├── device-agent/   # 桌面端 Agent（Playwright + GUI 自动化 + 视觉感知）
│   ├── runner/         # Skill 沙箱运行时（Fastify + RPC 协议 + 子进程隔离）
│   └── admin-cli/      # 运维 CLI 工具
├── packages/
│   └── shared/         # 共享库（587 行索引，250+ 导出符号）
│                         多模态类型/ABAC策略引擎/Prompt注入检测/DLP/状态机/
│                         GoalGraph/WorldState/熔断器/事件总线/协作协议/
│                         Skill RPC协议/结构化日志/供应链安全/沙箱安全/文档解析
├── skills/             # 外部 Skill 包（23 个，manifest.json + dist/）
│   ├── echo-skill/                # 回声测试
│   ├── math-skill/                # 数学计算
│   ├── http-fetch-skill/          # HTTP 请求
│   ├── imap-poll-skill/           # IMAP 邮件轮询
│   ├── exchange-poll-skill/       # Exchange 邮件轮询
│   ├── slack-send-skill/          # Slack 消息
│   ├── webhook-send-skill/        # Webhook 发送
│   ├── memory-graph-skill/        # 记忆图谱构建
│   ├── collab-guard-skill/        # 协作守护
│   ├── collab-review-skill/       # 协作审查
│   ├── reflexion-skill/           # 反思与自我改进
│   ├── vision-skill/              # 视觉理解
│   ├── speech-skill/              # 语音处理
│   ├── ocr-skill/                 # OCR 识别
│   ├── scanned-pdf-skill/         # 扫描 PDF 处理
│   ├── video-extract-skill/       # 视频提取
│   ├── bridge-send-skill/         # 桥接通信
│   ├── tool-discovery-skill/      # 工具发现
│   ├── schema-create-skill/       # Schema 动态创建
│   ├── sparse-search-skill/       # 稀疏检索
│   ├── sleep-skill/               # 延迟/休眠
│   ├── streaming-device-control/  # 流式设备控制
│   └── ...             # 更多
├── infra/              # 可观测性基础设施配置
│   ├── prometheus/   # Prometheus 配置与告警规则
│   ├── grafana/      # Grafana 仪表盘与数据源配置
│   ├── loki/         # Loki 日志聚合配置
│   └── alertmanager/ # Alertmanager 告警路由
├── scripts/            # 脚本工具（基准测试/边界扫描/密钥扫描）
├── docker-compose.yml                # 基础设施编排（PostgreSQL/Redis/MinIO）
├── docker-compose.observability.yml  # 可观测性栈（Prometheus/Grafana/Jaeger/Loki）
├── tsconfig.base.json               # TypeScript 基础配置
└── package.json                     # pnpm Monorepo 根配置
```

## 📡 API 概览

### 统一请求链路

| 特性 | 说明 |
|------|------|
| 认证 | `Authorization: Bearer <token>`（支持 dev / hmac 模式） |
| 追踪 | `x-trace-id`（可选），所有响应回显 `traceId` + `requestId` |
| 幂等 | 写操作使用 `idempotency-key` |
| 多语言 | `x-user-locale` / `Accept-Language` |

### 核心模块 API

<details>
<summary><b>通用 CRUD & 数据平面</b></summary>

- `GET/POST /entities/:entity` — 通用实体读写
- `POST /entities/:entity/query` — 结构化查询（filters / orderBy / cursor）
- `POST /entities/:entity/export` — 异步导出
- `POST /entities/:entity/import` — 批量导入（dry_run / commit）
- `GET /artifacts/:artifactId/download` — 产物下载

</details>

<details>
<summary><b>AI 编排 & 工作流</b></summary>

- `POST /orchestrator/dispatch` / `POST /orchestrator/dispatch/stream` — 编排器统一入口
- `GET /runs` / `GET /runs/:runId` — 工作流运行查询
- `POST /runs/:runId/cancel` — 运行控制
- `POST /approvals/:approvalId/decisions` — 审批决策入口
- `GET /runs/:runId/replay` — 运行回放
- `GET /approvals` — 审批列表与决策

</details>

<details>
<summary><b>工具 & Skill</b></summary>

- `POST /tools/:name/publish` — 发布工具 / Skill 包
- `GET /tools` — 工具目录
- `POST /tools/:toolRef/execute` — 执行工具
- `GET /tools/runs/:runId` / `GET /tools/steps/:stepId` — 执行追踪

Skill 包结构：
```
skills/<skill-name>/
├── manifest.json      # 身份 / 合约 / IO / 入口
└── dist/index.js      # 导出 execute(req)
```

</details>

<details>
<summary><b>知识库 & RAG</b></summary>

- `POST /knowledge/documents` — 文档摄取
- `POST /knowledge/search` — 多阶段检索（关键词 + embedding + rerank）
- `POST /knowledge/evidence/resolve` — 证据链引用解析
- 治理端：检索日志、作业监控、质量评估

</details>

<details>
<summary><b>记忆</b></summary>

- `POST /memory/entries` — 写入（writePolicy=confirmed）
- `POST /memory/search` — 检索
- `GET /memory/entries` / `DELETE /memory/entries/:id` — 管理
- `PUT /memory/task-states/:runId` — 任务状态持久化

</details>

<details>
<summary><b>治理 & 变更集</b></summary>

- `POST /governance/changesets` — 创建变更集
- 流程：`draft → submit → approve → release → rollback`
- `POST /governance/changesets/:id/release?mode=canary` — 灰度发布
- `POST /governance/changesets/:id/preflight` — 预检摘要
- 评测准入：`POST /governance/evals/suites/:id/runs`
- 工具启用/禁用：`POST /governance/tools/:toolRef/enable|disable`

</details>

<details>
<summary><b>模型网关</b></summary>

- `GET /models/catalog` — 模型目录
- `POST /models/bindings` — 模型绑定
- `POST /models/chat` — 对话调用

</details>

<details>
<summary><b>设备 & 具身智能</b></summary>

- `POST /devices` — 设备注册
- `POST /devices/:deviceId/pairing` — 设备配对
- `POST /device-executions` — 创建设备执行
- 设备代理：`npm run dev -w @openslin/device-agent -- pair|run`

</details>

<details>
<summary><b>连接器 & 渠道</b></summary>

- 连接器：IMAP / Exchange / SMTP / Webhook
- `POST /connectors/instances` — 创建连接器实例
- `POST /channels/webhook/ingress` — Webhook 入站
- 通知模板 & Outbox：模板版本化 + 异步投递 + 死信重试

</details>

<details>
<summary><b>RBAC & 审计</b></summary>

- `POST /rbac/roles` / `POST /rbac/permissions` / `POST /rbac/bindings` — 角色权限管理
- `GET /audit?traceId=...` — 审计检索
- `GET /audit/verify` — 审计完整性校验
- `POST /spaces/:spaceId/backups` — 空间级备份

</details>

<details>
<summary><b>多智能体 & 任务</b></summary>

- `POST /tasks` — 创建任务
- `POST /tasks/:taskId/messages` — 智能体间消息
- `GET /tasks/long-tasks` — 长任务中心
- **协作运行**: `POST /collab/runs` — 创建多智能体协作任务
- **辩论机制**: 支持结构化辩论（debate）、交叉质疑、仲裁裁决
- **联邦协作**: 跨租户/跨空间的智能体协作网关
- **动态协调**: 运行时角色分配、任务重规划、能力发现

</details>

<details>
<summary><b>离线同步</b></summary>

- `POST /sync/push` — 增量推送
- `POST /sync/pull` — 增量拉取
- 支持 opId 幂等、冲突输出、可回放摘要

</details>

## 🔐 安全与治理

> ⚠️ 本仓库默认 dev 模式仅用于本地开发与测试，**不应直接用于生产**。

### 认证

| 模式 | 配置 | 说明 |
|------|------|------|
| dev（默认） | `AUTHN_MODE=dev` | token = `subjectId[@spaceId]`，仅限本地开发 |
| hmac | `AUTHN_MODE=hmac` | HMAC-SHA256 签名 token，含过期时间 |
| SAML | 配置 SAML IdP | 企业级 SAML 2.0 SSO |
| SSO (OIDC) | 配置 OIDC Provider | OpenID Connect 标准 SSO |
| SCIM | 配置 SCIM Server | 自动用户/组同步（Provisioning） |
| MFA | 配置 TOTP | 多因素认证，提升安全级别 |

### 安全层

| 安全能力 | 说明 |
|---------|------|
| **RBAC** | 角色-权限绑定，细粒度资源/操作控制 |
| **ABAC 策略引擎** | 基于属性的访问控制，支持条件表达式、层级组织、策略索引 |
| **Policy 表达式** | 策略表达式编译器，支持嵌套条件运算 |
| **Safety / DLP** | `DLP_MODE=audit_only|deny`，敏感信息检测与脱敏/拦截 |
| **Prompt 注入检测** | 自动检测 Prompt 注入攻击，支持 audit/deny 策略 |
| **意图锚定** | 持久化用户指令（命令/约束/偏好/禁令），越界自动熔断 |
| **供应链安全** | 信任检查、依赖扫描、SBOM 验证、隔离决策、生产基线校验 |
| **沙箱安全** | 禁止模块列表、动态代码锁定、模块加载拦截、多级别隔离（base/strict/database） |
| **列级加密** | 记忆系统敏感字段列级加密 |
| **模块边界扫描** | 启动时自动检测跨模块违规依赖 |
| **熔断器** | 通用熔断器（按 LLM modelRef/purpose 维度），防级联失败 |
| **HMAC 内部认证** | Skill 间调用使用 HMAC-SHA256 签名认证 |

### Safety / DLP

- `DLP_MODE=audit_only|deny`（默认 audit_only）
- deny 模式下命中敏感信息直接拦截返回 `DLP_DENIED`

### Skill 运行时安全

| 配置 | 说明 |
|------|------|
| `SKILL_RUNTIME_BACKEND` | `process` / `container` / `auto` |
| `SKILL_TRUST_ENFORCE` | 未签名包拒绝执行（生产默认启用） |
| `SKILL_DEP_SCAN_MODE` | `deny` / `audit_only` / `off` |
| `SKILL_RUNTIME_UNSAFE_ALLOW` | 紧急绕过（不推荐） |
| `SKILL_PYTHON_BIN` | Python 运行时路径（默认 `python3`） |
| `SKILL_PIP_BIN` | pip 路径（默认 `pip3`） |
| 出站治理 | host 白名单 + 路径/方法级规则 |

### 多语言 Skill 支持

系统支持多种语言编写的 Skill，通过统一的 JSON-RPC 协议进行通信：

- **Node.js/TypeScript**: 默认运行时，直接导出 `execute(req)` 函数
- **Python**: 通过子进程隔离 + JSON-RPC over stdio 通信，支持 `requirements.txt` 依赖管理
- **未来扩展**: 协议支持 Go、Rust 等语言（通过 manifest.runtime 声明）

Skill 生命周期：
1. 依赖安装（自动检测并安装）
2. 进程启动（沙箱隔离）
3. 初始化握手（`skill.initialize`）
4. 执行调用（`skill.execute`）+ 进度通知
5. 优雅关闭（`skill.shutdown`）

### 生产部署检查清单

- [ ] 配置 `API_MASTER_KEY`（禁止使用 dev master key）
- [ ] 切换 `AUTHN_MODE=hmac` 或更严格认证（SAML/OIDC/MFA）
- [ ] `.env` 密钥不落库、不提交
- [ ] 启用 DLP deny 模式
- [ ] 启用 Prompt 注入检测（`PROMPT_INJECTION_MODE=deny`）
- [ ] 启用 Skill 信任策略 & 依赖扫描
- [ ] 配置出站网络策略白名单
- [ ] 启用供应链安全门禁（`SKILL_TRUST_ENFORCE=true`）
- [ ] 运行模块边界扫描（`npm run boundary-scan`）
- [ ] 确认生产基线校验通过

## 📊 可观测性

系统采用 **OpenTelemetry + Prometheus + Grafana + Jaeger + Loki + Alertmanager** 全栈可观测性架构：

### 启动可观测性栈

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

| 服务 | 端口 | 说明 |
|------|------|------|
| Prometheus | 9090 | 指标收集与查询 |
| Grafana | 3000 | 可视化仪表盘 |
| Jaeger | 16686 | 分布式追踪 UI |
| Loki | 3100 | 日志聚合 |
| Alertmanager | 9093 | 告警管理 |

### 代码级可观测性

| 组件 | 说明 |
|------|------|
| **结构化日志** | 所有模块使用 `StructuredLogger`，支持日志采样、敏感字段脱敏、安全序列化 |
| **分布式追踪** | 每个请求自动注入 `traceId` + `requestId`，BullMQ Job 传递追踪上下文，Span 状态记录 |
| **自定义指标** | 30+ Prometheus 指标，覆盖治理/知识/同步/队列/工具执行/Worker |
| **请求上下文** | 每个请求自动绑定上下文，贯穿插件→路由→内核 |

### Prometheus 指标

| 指标 | 说明 |
|------|------|
| `openslin_governance_pipeline_actions_total` | 治理流水线操作计数 |
| `openslin_governance_gate_failed_total` | 治理门禁失败计数 |
| `openslin_knowledge_search_total` / `_duration_ms` | 知识检索计数与耗时 |
| `openslin_knowledge_evidence_resolve_total` / `_duration_ms` | 证据链解析计数与耗时 |
| `openslin_sync_push_total` / `_duration_ms` / `_conflicts_total` | 离线同步推送统计 |
| `openslin_sync_pull_total` / `_duration_ms` / `_ops_returned` | 离线同步拉取统计 |
| `worker:workflow:step:success` / `:error` | Worker 工作流步骤成功/失败 |
| `worker:tool_execute:success` / `:error` | 工具执行成功/失败 |

## 🌍 社会价值愿景

灵智Mindpal项目秉持 **技术进步惠及全社会** 的理念：

- **保障就业结构** — 实现智能化自动化的企业和系统，必须保持现有经济结构不变。即使没有员工实际工作，也要继续支付薪酬、社会福利和税收。
- **拒绝恶性竞争** — 企业应专注于提供优质服务，通过服务质量与用户体验竞争，而非价格战。
- **禁止裁员** — 任何企业或单位不得因技术进步开除员工，这是维持社会稳定的基本要求。
- **安全人才需求** — 智能体系统在安全和权限管理方面达到极度精细化的程度，各行业需要大量安全专业人才（网络安全、数据隐私、AI 伦理、法律合规等）。
- **机器人行业规范** — 严禁降价恶性竞争，应大规模雇佣维持经济结构稳定，同时提供优质服务。

> 详见 [社会价值治理机制](社会价值治理机制-透明底线与市场自发调节.md)

## 🙏 特别感谢

本项目的发展离不开以下公司和组织的技术贡献与启发：

<table>
<tr>
<td>

**中国科技公司**
- DeepSeek 深度求索 ⭐
- 阿里巴巴（通义千问）
- 腾讯（混元）
- 华为（盘古）⭐
- 字节跳动（豆包）⭐
- 月之暗面（Kimi）
- 智谱 AI（ChatGLM）
- 零一万物（Yi）
- MiniMax（ABAB）
- 小米
- 百度（文心）
- 科大讯飞（星火）
- 百川智能
- 商汤科技（日日新）
- 阶跃星辰（StepFun）
- 昆仑万维（天工）


**智能汽车**
- 华为车BU（ADS 高阶智驾）
- 小米汽车
- 比亚迪（仰望/天神之眼智驾）
- 蔚来（NOP+ 全域领航）
- 小鹏（XNGP 全场景）
- 理想（AD Max 智能驾驶）
- 江淮汽车
- 奇瑞汽车
- 吉利
- 长城汽车
- 上汽集团
- 长安汽车

**机器人公司**
- 宇树科技（Unitree）
- 智元机器人（Agibot）
- 优必选（Walker 人形机器人）
- 众挚
- 逐际动力
- 天工
- 达闼科技（CloudMinds）
- 追觅科技
- 云深处
- 大疆（DJI）
- 云鲸智能
- 高仙机器人
- 擎朗智能
- 普渡科技
- 星动纪元
- 银河通用（Galbot）
- 帕西尼感知科技

**ERP/企业服务**
- 用友网络（YonSuite/BIP）⭐
- 金蝶国际（云·苍穹/星空）⭐
- 浪潮集团（GS Cloud）
- 鼎捷软件
- 汉得信息
- 泛微网络（OA）
- 致远互联
- 蓝凌软件

**SaaS/云服务**
- 飞书（字节跳动）⭐
- 钉钉（阿里巴巴）⭐
- 企业微信（腾讯）⭐
- 简道云
- 有赞
- 微盟
- 纷享销客
- 北森云


</td>
<td>

**国际 AI 公司**
- OpenAI (GPT)
- Google DeepMind (Gemini)
- xAI (Grok)
- Meta AI (Llama)
- Microsoft (Azure AI)
- Mistral AI

**社区与平台**
- GitHub · Gitee
- 各类开源社区贡献者

</td>
</tr>
</table>

> ⭐ 特别感谢 DeepSeek 和豆包提供大量建议，以及豆包取名「灵智Mindpal」。
> ⭐ 特别感谢 Trae IDE 和 Qoder IDE，在此项目重构和开发过程中提供的卓越代码辅助能力。

## 📬 社区与联系方式

| 平台 | 账号 |
|------|------|
| 抖音 | 伏城-灵智Mindpal |
| B 站 | 灵智Mindpal |
| 小红书 | 灵智Mindpal |
| 微博 | 灵智Mindpal |
| X   | 灵智Mindpal |


## 📄 许可证

本项目基于 [Apache License 2.0](LICENSE) 发布。  
`SOCIAL_VALUE_COVENANT` 为社区价值倡议文件，不构成额外许可证条款。

