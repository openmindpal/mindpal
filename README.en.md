<div align="center">

**English | [中文](README.md)**

# 灵智Mindpal

**Your Intelligent Companion — Everything Can Be Modeled, Authorized, and Executed**

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)

[Quick Start](#-quick-start) · [Architecture](#-architecture-overview) · [API Docs](#-api-overview) · [Community](#-community--contact)

</div>

---

灵智Mindpal is a full-stack AI agent platform built on a **Ten-Dimensional Capability Architecture + Five-Layer Capability Stack + Five Governance Planes** Agent OS architecture, designed with OS-analog thinking (Agent = process, scheduler orchestrates execution, kernel manages resources). It provides unified management of data, knowledge, devices, and robots from macro to micro levels, building a lifelong digital life for individuals and organizations (memory, preferences, health, relationships, assets, tasks), and translating decisions into real-world actions through embodied intelligence — **fully controllable, replayable, and accountable**.

## Table of Contents

- [Key Features](#-key-features)
- [Architecture Overview](#-architecture-overview)
- [Tech Stack](#-tech-stack)
- [Quick Start](#-quick-start)
- [Project Structure](#-project-structure)
- [API Overview](#-api-overview)
- [Security & Governance](#-security--governance)
- [Observability](#-observability)
- [Social Value Vision](#-social-value-vision)
- [Acknowledgments](#-acknowledgments)
- [Community & Contact](#-community--contact)
- [License](#-license)

## ✨ Key Features

| Domain | Capabilities |
|--------|-------------|
| **Agent Cognitive Loop** | Observe→Think→Decide→Act engine, GoalGraph DAG-driven decomposition, WorldState entity/relation/fact tracking, independent Verifier Agent |
| **AI Orchestration** | Controlled tool invocation, automatic planning (Planning Kernel), semantic routing, multi-step workflows, replay & compensation |
| **Intent Understanding & Safety** | Intent Anchoring, boundary circuit breaker, persistent user directives (commands/constraints/preferences/prohibitions), Prompt injection detection |
| **Multi-Agent Collaboration** | Role-based communication, permission delegation, collaboration protocols, debate (v1/v2), cross-validation & dynamic correction, weighted voting consensus, federation |
| **Intelligent Scheduling** | Three-layer scheduling (global priority→session→task queue), preemption, starvation detection, SJF/FIFO/dependency-aware strategies, event-driven Agent wakeup |
| **Knowledge Engine** | Document ingestion (PDF/Word/Excel/scanned), chunking, multi-stage retrieval (keyword + embedding + rerank), evidence chain, vector DB integration |
| **Long-Term Memory** | Preference storage, session context, task state persistence, memory graph, embedding, column-level encryption, risk-based approval, lifecycle management |
| **Skill Runtime** | Multi-language (Node.js/Python), sandbox (forbidden modules/dynamic code locking), least privilege, outbound network policies, dependency scanning, supply chain security gate, Skill RPC protocol |
| **Governance Control Plane** | Changesets (draft→submit→approve→release→rollback), canary releases, eval gating, dynamic approval rule engine (recursive AND/OR matching), runtime governance checkpoints |
| **Device / Embodied Intelligence** | Device registration & pairing, remote execution, desktop Agent, browser automation (Playwright), desktop control/GUI automation, visual perception routing, capability probing |
| **NL2UI** | Natural-language-to-UI generation, dynamic page config, workbench management, visual workflow orchestration (ReactFlow) |
| **Voice Interaction** | Voice input (WebSpeech API), TTS speech synthesis, voice Skills |
| **Universal Data Plane** | Schema-driven CRUD, import/export, offline sync, Yjs collaborative editing |
| **Security Hub** | RBAC + ABAC policy engine, Safety/DLP (audit/deny modes), Prompt injection detection, tamper-proof audit logs, supply chain security (trust/SBOM/scanning), module boundary scanning |
| **Identity & Auth** | Dev/HMAC modes, SAML, SSO (OIDC), SCIM user sync, MFA multi-factor auth, organizational isolation |
| **Channel Integration** | Webhook, IMAP, Exchange, SMTP, Mock IM, WebSocket real-time notifications |
| **Pluggable Workbenches** | iframe sandbox + CSP isolation, postMessage capability injection |
| **Backup / Restore** | Space-level backup, one-click restore, Graceful Shutdown task pause & startup recovery |

## 🏗 Architecture Overview

The system employs a **Ten-Dimensional Capability Architecture + Five-Layer Capability Stack + Five Governance Planes** Agent OS architecture, designed with OS-analog thinking: Agent = process, scheduler orchestrates execution, kernel manages resources:

### Ten-Dimensional Capability Architecture

```
Perception    ──  Orchestrator + Intent Classification + Channel Gateway     → Understand all inputs
Cognition     ──  Agent Loop + Goal Decomposition + World State            → Understand problem structure
Planning      ──  Planning Kernel + GoalGraph DAG                          → Transform goals into action paths
Execution     ──  Execution Kernel + Skill Sandbox + Worker                → Safely do things
Memory        ──  Memory System + Multi-channel Recall + Preferences       → Accumulate experience
Knowledge     ──  RAG + Evidence Chain + Hybrid Retrieval                  → Leverage existing knowledge
Collaboration ──  Multi-Agent Orchestration + Debate + Federation          → Multi-role coordination
Governance    ──  Changesets + Approval + Canary + RBAC/ABAC              → Controlled evolution
Connection    ──  Device Runtime + Connectors + Channel Gateway           → Reach physical/digital world
Modeling      ──  Schema + Metadata + Universal CRUD                       → Describe everything
```

### Five-Layer Capability Stack

```
┌───────────────────────────────────────────────────────────────────┐
│     Sandbox Skill Layer (External extensions, manifest-declared,    │
│                          RPC protocol communication)                │
├───────────────────────────────────────────────────────────────────┤
│  Extension Layer: Media Pipeline / Backup / Replay / Artifacts /   │
│                   Analytics / AI Event Reasoning /                 │
│                   Browser Automation / Desktop Automation           │
├───────────────────────────────────────────────────────────────────┤
│  Optional Layer: NL2UI / Workbench / OAuth / SSO(OIDC) / SCIM /  │
│                  Notification / Device Runtime / Collab Runtime /  │
│                  Sync / RBAC / Federation Gateway / MFA /          │
│                  Observability Dashboard                           │
├───────────────────────────────────────────────────────────────────┤
│  Core Layer: Orchestrator / Model Gateway / Knowledge RAG /       │
│             Memory / Safety / Connector / Task / Channel / Trigger│
├───────────────────────────────────────────────────────────────────┤
│  Runtime Kernel: Agent Loop / Execution Kernel / Planning Kernel /│
│                  Goal Decomposer / World State / Verifier Agent /  │
│                  Intent Anchoring / State Machine / Task Queue /   │
│                  Priority Scheduler / Session Scheduler /          │
│                  Collab Scheduler                                  │
└───────────────────────────────────────────────────────────────────┘
```

### Five Governance Planes

```
┌────────────────────────────────────────────────────────────────────────┐
│  Governance: Identity / RBAC+ABAC / Safety / DLP / Approval Rule       │
│              Engine / Audit / Release/Canary/Rollback /                │
│              Intent Anchoring / Prompt Injection Protection           │
├────────────────────────────────────────────────────────────────────────┤
│  Execution: Tool Contracts / Versioned Schema / Idempotency /          │
│             Workflow / Queue Retry & Compensation /                    │
│             Supply Chain Security Gate / Circuit Breaker             │
├────────────────────────────────────────────────────────────────────────┤
│  Device: Edge Devices / Gateways / Robot Controllers /                 │
│          Desktop Executors / Browser Automation / GUI Automation /     │
│          Visual Perception / Unified Permission Boundary             │
├────────────────────────────────────────────────────────────────────────┤
│  Intelligence: Knowledge RAG / Evidence Chain / Long-term Memory /     │
│                Task State / Context Persistence / Memory Embedding /   │
│                Column-level Encryption                                │
├────────────────────────────────────────────────────────────────────────┤
│  Channel: IM / Webhook / Email / Subscription / Reliable Outbox /      │
│           Receipt Tracking / WebSocket Real-time Notifications       │
└────────────────────────────────────────────────────────────────────────┘
```

### Kernel Design Principles

| Kernel Module | Responsibility |
|---------------|----------------|
| **Agent Loop Engine** | Observe→Think→Decide→Act cognitive loop, drives autonomous agent decision and execution |
| **Goal Decomposer** | LLM-driven goal decomposition, generates GoalGraph DAG (with dependencies/preconditions/success criteria) |
| **World State Extractor** | Extracts entities/relations/facts from tool output, rule-based + LLM-assisted extraction |
| **Verifier Agent** | Independent LLM verification of goal satisfaction, avoids self-evaluation bias |
| **Intent Anchoring Service** | Persistent user directives (commands/constraints/preferences/prohibitions), auto circuit breaker on boundary violation |
| **Execution Kernel** | Unified "resolve → validate → admit → build → submit → enqueue" pipeline |
| **Planning Kernel** | "discover → prompt → LLM → parse → validate" planning pipeline + semantic routing |
| **State Machine** | Run/Step/Collab lifecycle transitions (created → queued → running → succeeded/failed) |
| **Task Queue Manager** | OS-level process scheduling—concurrency control, dependency readiness check, cascade operations, lifecycle management |
| **Priority Scheduler** | Global concurrency limit + tenant/space limits + preemption + quota inheritance + starvation detection |
| **Session Scheduler** | FIFO / Priority / DependencyAware / SJF strategies, LLM-driven priority inference |
| **Collab Scheduler** | Multi Agent Loop instance orchestration (sequential/parallel/pipeline) + debate + consensus |
| **Governance Checkpoint** | 7 check types × 3 phases (permission/policy/safety/timeout/resource/audit/invariant) |
| **Approval Rule Engine** | Dynamic rule loading, recursive AND/OR condition matching, human-readable explanations |
| **Architecture Invariants** | Enforce traceId / toolRef / capabilityEnvelope / policySnapshotRef |

> Detailed architecture documentation is available in the `原始架构设计/` directory.

## 🛠 Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript 5.8, ES2022 |
| Runtime | Node.js 20+ |
| Backend | Fastify 5 + WebSocket |
| Frontend | Next.js 16 + React 19 |
| UI Libraries | @xyflow/react (flowchart) + framer-motion + react-markdown |
| Database | PostgreSQL 16 (28 migration files) |
| Cache / Message | Redis 7 + ioredis |
| Task Queue | BullMQ 5.58 |
| Object Storage | MinIO |
| Package Management | pnpm 10.4 workspaces (monorepo) |
| Validation | Zod v4 |
| Collaborative Editing | Yjs + y-protocols |
| Device Automation | Playwright-core + systray2 |
| Observability | OpenTelemetry SDK + Prometheus + Grafana + Jaeger + Loki + Alertmanager |
| Containerization | Docker Compose |

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 10 (`corepack enable && corepack prepare pnpm@10 --activate`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (for database and other dependencies)

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/openslin.git
cd openslin
```

### 2. Start Infrastructure

```bash
docker compose up -d    # PostgreSQL 16 + Redis 7 + MinIO

# Optional: Start observability stack
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

### 3. Configure Environment Variables

```bash
cp .env.example .env    # Modify as needed
```

### 4. Install Dependencies & Initialize Database

```bash
npm install
npm run db:seed -w @openslin/api    # Migration + seed data + core schema
```

### 5. Start Services

```bash
npm run dev:api       # API Server    → http://localhost:3001
npm run dev:worker    # Worker (BullMQ async jobs)
npm run dev:web       # Web Frontend  → http://localhost:4000

# Optional: Start observability services (Prometheus/Grafana/Jaeger/Loki)
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

### Default URLs

| Service | URL |
|---------|-----|
| Web Home | http://localhost:4000 |
| Settings | http://localhost:4000/settings |
| UI Config | http://localhost:4000/admin/ui |
| RBAC Admin | http://localhost:4000/admin/rbac |
| API Health | http://localhost:3001/health |

### Admin CLI

Read-only / idempotent operations CLI for troubleshooting and ops:

```bash
npm run dev -w @openslin/admin-cli

# Examples
openslin-admin audit verify --apiBase http://localhost:3001 --token <token> --tenantId tenant_dev
openslin-admin models usage --apiBase http://localhost:3001 --token <token> --range 24h
openslin-admin queue status --apiBase http://localhost:3001 --token <token>
```

## 📁 Project Structure

```
openslin/
├── apps/
│   ├── api/            # Fastify API server (Agent OS Brain)
│   │   ├── kernel/     # Kernel: Agent Loop/Goal Decomposition/Planning/Execution/Scheduling/Collaboration
│   │   ├── routes/     # 43 routes (with /v1 versioning)
│   │   ├── modules/    # 28 domain modules (auth/governance/model/knowledge/memory)
│   │   ├── skills/     # 39 built-in skills (4 tiers: kernel/core/optional/extension)
│   │   ├── plugins/    # 15 middlewares (logging/tracing/versioning/notifications/DLP/audit)
│   │   └── migrations/ # 28 SQL migration files
│   ├── web/            # Next.js frontend (React 19 + ReactFlow + i18n)
│   ├── worker/         # BullMQ async worker node (knowledge/memory/governance/notifications)
│   ├── device-agent/   # Desktop Agent (Playwright + GUI automation + visual perception)
│   ├── runner/         # Skill sandbox runtime (Fastify + RPC protocol + subprocess isolation)
│   └── admin-cli/      # Ops CLI tool
├── packages/
│   └── shared/         # Shared library (587-line index, 250+ exported symbols)
│                         Multimodal types/ABAC policy engine/Prompt injection detection/DLP/
│                         State machine/GoalGraph/WorldState/Circuit breaker/Event bus/
│                         Collab protocol/Skill RPC/Structured logging/Supply chain security/
│                         Sandbox security/Document parsing
├── skills/             # External Skill packages (23 total, manifest.json + dist/)
│   ├── echo-skill/                # Echo test
│   ├── math-skill/                # Math computation
│   ├── http-fetch-skill/          # HTTP requests
│   ├── imap-poll-skill/           # IMAP email polling
│   ├── exchange-poll-skill/       # Exchange email polling
│   ├── slack-send-skill/          # Slack messaging
│   ├── webhook-send-skill/        # Webhook sending
│   ├── memory-graph-skill/        # Memory graph construction
│   ├── collab-guard-skill/        # Collaboration guard
│   ├── collab-review-skill/       # Collaboration review
│   ├── reflexion-skill/           # Reflexion & self-improvement
│   ├── vision-skill/              # Vision understanding
│   ├── speech-skill/              # Speech processing
│   ├── ocr-skill/                 # OCR recognition
│   ├── scanned-pdf-skill/         # Scanned PDF processing
│   ├── video-extract-skill/       # Video extraction
│   ├── bridge-send-skill/         # Bridge communication
│   ├── tool-discovery-skill/      # Tool discovery
│   ├── schema-create-skill/       # Dynamic schema creation
│   ├── sparse-search-skill/       # Sparse search
│   ├── sleep-skill/               # Delay/sleep
│   ├── streaming-device-control/  # Streaming device control
│   └── ...             # More
├── infra/              # Observability infrastructure configuration
│   ├── prometheus/   # Prometheus configuration & alerting rules
│   ├── grafana/      # Grafana dashboards & data source configuration
│   ├── loki/         # Loki log aggregation configuration
│   └── alertmanager/ # Alertmanager alert routing
├── scripts/            # Script tools (benchmarking/boundary scanning/secret scanning)
├── docker-compose.yml                # Infrastructure orchestration (PostgreSQL/Redis/MinIO)
├── docker-compose.observability.yml  # Observability stack (Prometheus/Grafana/Jaeger/Loki)
├── tsconfig.base.json               # TypeScript base config
└── package.json                     # pnpm Monorepo root config
```

## 📡 API Overview

### Unified Request Pipeline

| Feature | Description |
|---------|------------|
| Auth | `Authorization: Bearer <token>` (supports dev / hmac modes) |
| Tracing | `x-trace-id` (optional), all responses echo `traceId` + `requestId` |
| Idempotency | Write operations use `idempotency-key` |
| i18n | `x-user-locale` / `Accept-Language` |

### Core Module APIs

<details>
<summary><b>Universal CRUD & Data Plane</b></summary>

- `GET/POST /entities/:entity` — Generic entity read/write
- `POST /entities/:entity/query` — Structured query (filters / orderBy / cursor)
- `POST /entities/:entity/export` — Async export
- `POST /entities/:entity/import` — Bulk import (dry_run / commit)
- `GET /artifacts/:artifactId/download` — Artifact download

</details>

<details>
<summary><b>AI Orchestration & Workflow</b></summary>

- `POST /orchestrator/dispatch` / `POST /orchestrator/dispatch/stream` — Unified orchestrator entrypoints
- `GET /runs` / `GET /runs/:runId` — Workflow run queries
- `POST /runs/:runId/cancel` — Run control
- `POST /approvals/:approvalId/decisions` — Approval decision entrypoint
- `GET /runs/:runId/replay` — Run replay
- `GET /approvals` — Approval list & decisions

</details>

<details>
<summary><b>Tools & Skills</b></summary>

- `POST /tools/:name/publish` — Publish tool / Skill package
- `GET /tools` — Tool catalog
- `POST /tools/:toolRef/execute` — Execute tool
- `GET /tools/runs/:runId` / `GET /tools/steps/:stepId` — Execution tracking

Skill package structure:
```
skills/<skill-name>/
├── manifest.json      # Identity / contract / IO / entry
└── dist/index.js      # Exports execute(req)
```

</details>

<details>
<summary><b>Knowledge Base & RAG</b></summary>

- `POST /knowledge/documents` — Document ingestion
- `POST /knowledge/search` — Multi-stage retrieval (keyword + embedding + rerank)
- `POST /knowledge/evidence/resolve` — Evidence chain reference resolution
- Governance: retrieval logs, job monitoring, quality evaluation

</details>

<details>
<summary><b>Memory</b></summary>

- `POST /memory/entries` — Write (writePolicy=confirmed)
- `POST /memory/search` — Search
- `GET /memory/entries` / `DELETE /memory/entries/:id` — Management
- `PUT /memory/task-states/:runId` — Task state persistence

</details>

<details>
<summary><b>Governance & Changesets</b></summary>

- `POST /governance/changesets` — Create changeset
- Flow: `draft → submit → approve → release → rollback`
- `POST /governance/changesets/:id/release?mode=canary` — Canary release
- `POST /governance/changesets/:id/preflight` — Preflight summary
- Eval gating: `POST /governance/evals/suites/:id/runs`
- Tool enable/disable: `POST /governance/tools/:toolRef/enable|disable`

</details>

<details>
<summary><b>Model Gateway</b></summary>

- `GET /models/catalog` — Model catalog
- `POST /models/bindings` — Model binding
- `POST /models/chat` — Chat invocation

</details>

<details>
<summary><b>Device & Embodied Intelligence</b></summary>

- `POST /devices` — Device registration
- `POST /devices/:deviceId/pairing` — Device pairing
- `POST /device-executions` — Create device execution
- Device agent: `npm run dev -w @openslin/device-agent -- pair|run`

</details>

<details>
<summary><b>Connectors & Channels</b></summary>

- Connectors: IMAP / Exchange / SMTP / Webhook
- `POST /connectors/instances` — Create connector instance
- `POST /channels/webhook/ingress` — Webhook ingress
- Notification templates & Outbox: versioned templates + async delivery + dead letter retry

</details>

<details>
<summary><b>RBAC & Audit</b></summary>

- `POST /rbac/roles` / `POST /rbac/permissions` / `POST /rbac/bindings` — Role & permission management
- `GET /audit?traceId=...` — Audit search
- `GET /audit/verify` — Audit integrity verification
- `POST /spaces/:spaceId/backups` — Space-level backup

</details>

<details>
<summary><b>Multi-Agent & Tasks</b></summary>

- `POST /tasks` — Create task
- `POST /tasks/:taskId/messages` — Inter-agent messages
- `GET /tasks/long-tasks` — Long task center
- **Collaboration Runs**: `POST /collab/runs` — Create multi-agent collaboration tasks
- **Debate Mechanism**: Structured debate, cross-examination, arbitration
- **Federation**: Cross-tenant/cross-space agent collaboration gateway
- **Dynamic Coordination**: Runtime role assignment, task replanning, capability discovery

</details>

<details>
<summary><b>Offline Sync</b></summary>

- `POST /sync/push` — Incremental push
- `POST /sync/pull` — Incremental pull
- Supports opId idempotency, conflict output, replayable summary

</details>

## 🔐 Security & Governance

> ⚠️ The default dev mode in this repository is for local development and testing only. **Do not use it in production.**

### Authentication

| Mode | Config | Description |
|------|--------|-------------|
| dev (default) | `AUTHN_MODE=dev` | token = `subjectId[@spaceId]`, local dev only |
| hmac | `AUTHN_MODE=hmac` | HMAC-SHA256 signed token with expiration |
| SAML | Configure SAML IdP | Enterprise SAML 2.0 SSO |
| SSO (OIDC) | Configure OIDC Provider | OpenID Connect standard SSO |
| SCIM | Configure SCIM Server | Automatic user/group sync (Provisioning) |
| MFA | Configure TOTP | Multi-factor authentication for enhanced security |

### Security Layers

| Security Capability | Description |
|---------------------|-------------|
| **RBAC** | Role-permission binding, fine-grained resource/operation control |
| **ABAC Policy Engine** | Attribute-based access control, supports conditional expressions, hierarchical organizations, policy indexing |
| **Policy Expressions** | Policy expression compiler, supports nested conditional operations |
| **Safety / DLP** | `DLP_MODE=audit_only|deny`, sensitive information detection and redaction/blocking |
| **Prompt Injection Detection** | Automatic Prompt injection attack detection, supports audit/deny policies |
| **Intent Anchoring** | Persistent user directives (commands/constraints/preferences/prohibitions), auto circuit breaker on boundary violation |
| **Supply Chain Security** | Trust verification, dependency scanning, SBOM validation, isolation decisions, production baseline validation |
| **Sandbox Security** | Forbidden module lists, dynamic code locking, module load interception, multi-level isolation (base/strict/database) |
| **Column-level Encryption** | Memory system sensitive field column-level encryption |
| **Module Boundary Scanning** | Automatic cross-module dependency violation detection at startup |
| **Circuit Breaker** | Universal circuit breaker (by LLM modelRef/purpose dimension), prevents cascading failures |
| **HMAC Internal Auth** | Skill-to-skill calls use HMAC-SHA256 signed authentication |

### Safety / DLP

- `DLP_MODE=audit_only|deny` (default: audit_only)
- In deny mode, sensitive information is intercepted and returns `DLP_DENIED`

### Skill Runtime Security

| Config | Description |
|--------|-------------|
| `SKILL_RUNTIME_BACKEND` | `process` / `container` / `auto` |
| `SKILL_TRUST_ENFORCE` | Reject unsigned packages (enabled by default in production) |
| `SKILL_DEP_SCAN_MODE` | `deny` / `audit_only` / `off` |
| `SKILL_RUNTIME_UNSAFE_ALLOW` | Emergency bypass (not recommended) |
| `SKILL_PYTHON_BIN` | Python runtime path (default: `python3`) |
| `SKILL_PIP_BIN` | pip path (default: `pip3`) |
| Outbound governance | Host allowlist + path/method-level rules |

### Multi-Language Skill Support

The system supports Skills written in multiple languages, communicating via unified JSON-RPC protocol:

- **Node.js/TypeScript**: Default runtime, directly exports `execute(req)` function
- **Python**: Subprocess isolation + JSON-RPC over stdio communication, supports `requirements.txt` dependency management
- **Future Extensions**: Protocol supports Go, Rust, and other languages (declared via manifest.runtime)

Skill Lifecycle:
1. Dependency installation (auto-detect and install)
2. Process startup (sandbox isolation)
3. Initialization handshake (`skill.initialize`)
4. Execution call (`skill.execute`) + progress notifications
5. Graceful shutdown (`skill.shutdown`)

### Production Deployment Checklist

- [ ] Configure `API_MASTER_KEY` (never use dev master key)
- [ ] Switch to `AUTHN_MODE=hmac` or stricter authentication (SAML/OIDC/MFA)
- [ ] Ensure `.env` secrets are not committed to version control
- [ ] Enable DLP deny mode
- [ ] Enable Prompt injection detection (`PROMPT_INJECTION_MODE=deny`)
- [ ] Enable Skill trust policy & dependency scanning
- [ ] Configure outbound network policy allowlist
- [ ] Enable supply chain security gate (`SKILL_TRUST_ENFORCE=true`)
- [ ] Run module boundary scanning (`npm run boundary-scan`)
- [ ] Confirm production baseline validation passed

## 📊 Observability

The system employs a full-stack observability architecture with **OpenTelemetry + Prometheus + Grafana + Jaeger + Loki + Alertmanager**:

### Start Observability Stack

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

| Service | Port | Description |
|---------|------|-------------|
| Prometheus | 9090 | Metrics collection & querying |
| Grafana | 3000 | Visualization dashboards |
| Jaeger | 16686 | Distributed tracing UI |
| Loki | 3100 | Log aggregation |
| Alertmanager | 9093 | Alert management |

### Code-Level Observability

| Component | Description |
|-----------|-------------|
| **Structured Logging** | All modules use `StructuredLogger`, supports log sampling, sensitive field redaction, safe serialization |
| **Distributed Tracing** | Every request auto-injects `traceId` + `requestId`, BullMQ Jobs propagate tracing context, Span status recording |
| **Custom Metrics** | 30+ Prometheus metrics covering governance/knowledge/sync/queue/tool execution/Worker |
| **Request Context** | Every request auto-binds context, flowing through plugins → routes → kernel |

### Prometheus Metrics

| Metric | Description |
|--------|-------------|
| `openslin_governance_pipeline_actions_total` | Governance pipeline action count |
| `openslin_governance_gate_failed_total` | Governance gate failure count |
| `openslin_knowledge_search_total` / `_duration_ms` | Knowledge search count & latency |
| `openslin_knowledge_evidence_resolve_total` / `_duration_ms` | Evidence chain resolution count & latency |
| `openslin_sync_push_total` / `_duration_ms` / `_conflicts_total` | Offline sync push stats |
| `openslin_sync_pull_total` / `_duration_ms` / `_ops_returned` | Offline sync pull stats |
| `worker:workflow:step:success` / `:error` | Worker workflow step success/failure |
| `worker:tool_execute:success` / `:error` | Tool execution success/failure |

## 🌍 Social Value Vision

The 灵智Mindpal project upholds the philosophy that **technological progress should benefit all of society**:

- **Protect Employment** — Enterprises implementing intelligent automation must maintain existing economic structures. Wages, social benefits, and taxes must continue to be paid even when roles are automated.
- **Reject Destructive Competition** — Enterprises should compete through service quality and user experience, not price wars.
- **No Layoffs** — No enterprise or organization may lay off employees due to technological advancement. This is a fundamental requirement for social stability.
- **Security Talent Demand** — Agent systems require extreme precision in security and permission management. All industries need massive security talent (cybersecurity, data privacy, AI ethics, legal compliance, etc.).
- **Robotics Industry Standards** — Price dumping is strictly prohibited. Large-scale employment should be maintained for economic stability while delivering quality services.

> See [Social Value Governance Mechanism](社会价值治理机制-透明底线与市场自发调节.md) for details.

## 🙏 Acknowledgments

This project's development is made possible by the technical contributions and inspiration from the following companies and organizations:

<table>
<tr>
<td>

**Chinese Tech Companies**
- DeepSeek ⭐
- Alibaba (Qwen)
- Tencent (Hunyuan)
- Huawei (Pangu)
- ByteDance (Doubao) ⭐
- Moonshot AI (Kimi)
- Zhipu AI (ChatGLM)
- MiniMax (ABAB)
- Baidu (ERNIE)
- iFlytek (Spark)
- Baichuan AI
- SenseTime (SenseNova)

</td>
<td>

**International AI Companies**
- OpenAI (GPT)
- Google DeepMind (Gemini)
- xAI (Grok)
- Meta AI (Llama)
- Microsoft (Azure AI)
- Mistral AI

**Communities & Platforms**
- GitHub · Gitee
- Open source community contributors

</td>
</tr>
</table>

> ⭐ Special thanks to DeepSeek and Doubao for extensive suggestions, and Doubao for naming "灵智Mindpal".
> ⭐ Special thanks to Trae IDE and Qoder IDE for providing exceptional coding assistance during the refactoring and development of this project.

## 📬 Community & Contact

| Platform | Account |
|----------|---------|
| Douyin (TikTok CN) | 伏城-灵智Mindpal |
| Bilibili | 灵智Mindpal |
| Xiaohongshu | 灵智Mindpal |
| Weibo | 灵智Mindpal |
| X   | 灵智Mindpal |

## 📄 License

This project is licensed under the [Apache License 2.0](LICENSE).  
`SOCIAL_VALUE_COVENANT` is a community values initiative and does not add extra license terms.
