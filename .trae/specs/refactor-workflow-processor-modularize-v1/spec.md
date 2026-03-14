# Workflow Processor 模块化拆分 Spec

## Why
`apps/worker/src/workflow/processor.ts` 过大（约 2.5k 行），承载了工作流执行的多种职责，导致可读性差、改动冲突概率高、回归风险难评估。

## What Changes
- 将 `processor.ts` 按“现有职责边界”拆分为多个内部模块，并保持行为不变
- `processStep` 仍作为唯一对外入口导出，签名不变
- 拆分后的模块只做函数迁移与依赖整理，不引入新功能、不改变数据库读写语义与错误分类
- 将重复的 policy / egress 判断逻辑抽为可复用模块（如与 `skillSandboxChild.ts` 存在重复），减少双实现漂移风险
- **BREAKING**：不引入对外 API 变更；但会改变内部文件路径与导入路径（仅对仓库内部代码有影响）

## Impact
- Affected specs: workflow step 处理、工具执行/动态技能、network policy、审计与加密、实体写工具、幂等与写租约
- Affected code: 
  - `apps/worker/src/workflow/processor.ts`
  - `apps/worker/src/workflow/skillSandboxChild.ts`（如复用 policy 模块）
  - `apps/worker/src/workflow/writeLease.ts`（导入保持不变）
  - `apps/worker/src/workflow/*` 新增模块文件（仅 worker 内部使用）

## ADDED Requirements
### Requirement: 模块化拆分
系统 SHALL 将 `processor.ts` 按职责拆分为多个模块文件，且不改变运行行为。

#### Scenario: 构建与测试通过
- **WHEN** 在仓库根目录执行 `npm run build -w @openslin/worker`
- **THEN** TypeScript 编译通过
- **AND** 执行 `npm run test -w @openslin/worker` 通过

#### Scenario: processStep 入口稳定
- **WHEN** 其他模块以现有方式导入并调用 `processStep(params)`
- **THEN** 导出路径与函数签名保持不变（仍从 `workflow/processor.ts` 导出）
- **AND** `jobType` / `toolRef` 分发逻辑与错误分类保持一致

### Requirement: 拆分边界清晰
系统 SHALL 将拆分后的代码组织为“可被单独理解与测试”的模块，边界至少覆盖以下类别：
- job handlers（如 entity.import/export、space.backup/restore 等）
- 内置工具分发（entity.*、memory.*、knowledge.*、sleep、http.get 等）
- dynamic skill runner（artifact skill 执行、child process、egress 记录、degraded/runtimeBackend）
- policy/limits 工具函数（limits/networkPolicy 归一化、egress 判定、并发/超时包装）
- 审计与加密（output envelope、input decrypt、audit 写入、DLP 摘要挂载）

## MODIFIED Requirements
### Requirement: 现有工作流执行行为不变
系统 SHALL 保持原有的数据库更新语义、审计写入字段、错误分类（timeout/resource_exhausted/policy_violation/internal/retryable）与重试策略不变。

## REMOVED Requirements
（无）

