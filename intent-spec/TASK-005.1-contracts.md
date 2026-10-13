# TASK-005.1 合同：Schema、状态转换与持久状态

本文件是 TASK-005.1（Issue #16）的实现说明，与 `intent-spec/TASK-005-personal-agent-tui.md` 配套。
总任务的行为合同不变；这里只记录**本子任务新增的合同**与**锁定源码依据**。任何偏离需用户确认。

代码位置：`durable-cli-probe/src/agent/contracts/`（纯校验与 Document）、`durable-cli-probe/src/agent/state/`（状态机、额度、分权、finish）、`durable-cli-probe/src/agent/tools/`（finish_task 工具）。

## 1. 状态机（业务/轮次分离）

业务状态：`planned / running / awaiting_review / awaiting_input / accepted / failed / cancelled`，
外加 legacy `revising`（见 §3）。合法转换：

| 从 | 到 |
|---|---|
| planned | running, cancelled |
| running | awaiting_review, awaiting_input, failed, cancelled |
| awaiting_input | running, failed, cancelled |
| awaiting_review | running, revising(legacy), accepted, failed, cancelled |
| revising (legacy) | awaiting_review, failed, cancelled |
| accepted / failed / cancelled | —（终态，不可复活） |

轮次状态：`queued / running / retry_wait / completed / failed / cancelled`，
`queued→running|cancelled`、`running→completed|failed|cancelled|retry_wait`、`retry_wait→queued|running|cancelled`；
`completed/failed/cancelled` 为已结算，不可重开。

代码：`src/agent/state/lifecycle.ts` 的 `BUSINESS_TRANSITIONS` / `ROUND_TRANSITIONS`。

## 2. 轮次失败 ≠ 任务失败（`decideRoundFailure`）

| 情况 | 轮次状态 | 业务状态 |
|---|---|---|
| 技术失败且 `technicalRestartsUsed < maxTechnicalRestarts` 且 `attemptsUsed < maxAttemptsPerOperation` | retry_wait | 不变（仍在 running） |
| 技术失败且重启额度用尽 | failed | failed（终态） |
| 技术失败且操作 attempt 额度用尽 | failed | failed（终态） |
| 质量不合格（结果差） | completed | 不变，交 `awaiting_review` 由 Main 决策 |
| 取消 | cancelled | cancelled（终态） |

即：provider/harness 故障在额度内重试且不计质量返工；只有 Main 或程序判定才让业务进入 `failed`。
额度账本：`src/agent/state/quota.ts`，`consume()` 单次完成「检查+预留」，超限抛 `QuotaError`
（稳定 code：`quota_attempts_exhausted` / `quota_technical_restarts_exhausted` /
`quota_tool_invocations_exhausted` / `quota_failed_tool_calls_exhausted`）；
每轮计数在新轮次开始时由 `resetRoundCounters` 归零，每操作计数持续。

## 3. 旧台账兼容（TASK-003）

- `awaiting_review → revising` 这条**旧写入路径仍然合法**，TASK-003 的 delegation/tools/回归测试不修改；
  等价的新路径是 `awaiting_review → running`（`recordTransition` 对 `revising`/`running` 都保留执行权）。
- 读取侧：`readLegacyStatus("revising") === "running"`；`src/multiagent/ledger.ts` 的转换表现在直接使用
  共享表（`lane 1` 的同一张表），既有 `TaskLedgerDoc`（version 2，含 v1 迁移）保持不变。
- 既有回归证据：`npm run multiagent:test`（10 文件 / 40 测试）在本 PR 上全绿。

## 4. 取消意图

`mayTerminateAfterCancel(businessStatus, hasActiveExecution, hasCancelIntent)`：只有「已持久化取消意图
且无活跃执行」才允许进入 `cancelled`。意图先落盘，活跃执行被观察到停止后再置终态，避免终态盖掉仍在跑的工作。

## 5. 字段分权（谁可以写什么）

矩阵是数据（`src/agent/state/authorization.ts` 的 `FIELD_OWNERS`），不是约定：

| 归属 | 字段 |
|---|---|
| application | `request.*`、`clarification.questions/answers/resolutions`、`plan.*`、`taskConfig.*`、`taskSpec.id/dependencies/budget/acceptance/skillId` |
| model | `result.work.summary/findings/unresolved/artifacts` |
| runtime | `result.resultId`、`result.runtime.*`、`result.evidence` |

- 用户回答只能是 `source: "application"`，校验器用 `answer_source_forbidden` 拒绝其它来源。
- 模型标记已解决必须引用**真实回答**（`basis: {kind:"answer", answerAt}` 与记录一致）或**原始输入**（`{kind:"original_input", detail}`），
  否则 `resolution_answer_missing` / `resolution_answer_mismatch`。
- 模型 payload 只要带 runtime 字段就 `reserved_field` 拒绝，因此跨任务证据不可能由模型伪造。
- 未声明的路径一律拒绝（"没人想过"不是权限模型）。

## 6. Document 与 schemaVersion

| kind | 状态类型 | 说明 |
|---|---|---|
| `app.agent.request` | `AgentRequestDocState` | 用户请求与材料，`text: ""` 表示未记录 |
| `app.agent.clarification` | `ClarificationState` | 问题/回答/解决 |
| `app.agent.plan` | `Plan` | `version: 0` 表示尚未保存过 |
| `app.agent.task-config` | `AgentTaskConfigDocState` | 运行时写入的配置快照（含 `configHash`） |
| `app.agent.task-result` | `AgentTaskResultDocState` | 运行时写入的结果 |

全部为 `scope: "conversation"` / `history: "latest"` / `fork: "initial"` / `family: true`，version 1。
**无 `migrate`**：这些都是新的 v1 文档，没有旧形态要解释；将来升级时必须只补字段、不改内容
（AC-03：close/reopen 后问题、回答、版本、结果不变）。legacy 迁移只存在于 TASK-003 的 `app.multiagent.task-ledger`。

## 7. finish：提交后停止本轮（源码依据与实现）

### 7.1 源码依据（锁定 pi `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`）

- `packages/durable/src/harness/types.ts`
  - `ToolControl = { addTools?: readonly string[]; terminate?: true; handoff?: string }`
  - `ToolExecutionResult.control?: ToolControl`（工具只能在结果上带 control）
- `packages/durable/src/harness/generation.ts` → `finishToolRound`
  - 注释与实现：`Every call of the round, including those answered without a task, must ask to terminate.`
    `terminate = slots.length > 0 && slots.every((slot) => slot.taskId !== undefined && controls.get(slot.taskId)?.terminate === true)`
  - terminate（或 handoff、或排队的 reset）时边界按 `"final"` 应用，并 `endRun(tx, live, runtime.taskId, { status: "done", answer: assistant })`，
    随后**不会**为下一轮创建 generation；唯一可能跟随的是为**已排队的用户输入**起新 run。

### 7.2 应用协议

1. `finish_task` 是模型提交**自身工作**（summary/findings/unresolved/artifacts）的结构化入口；
   参数里没有身份/状态/证据字段——模型无处可写，也就无法伪造。
2. 校验通过才返回 `control: { terminate: true }`；校验失败只返回 `isError: true`（无 control）。
3. **不得自行 accepted**：标记接受是 Main 依据持久化证据的决定。
4. 程序通过已有的 `Submission.wait` 得知 run 结束，**不**以"工具叫 finish_task"推断已停止。
5. 同轮存在不要求终止的其它调用时不会停止（源码规则 1）；把这一条写回模型输出（`decideFinish` 的 `continue`）。

### 7.3 实测（真实 harness，faux provider，本地 SQLite）

`test/agent-state.test.ts` 的三个 harness 用例：

| 用例 | 断言 |
|---|---|
| 单独调用 `finish_task` | run 结束：**只有 1 条 assistant 记录**、1 条 tool-result、`submission.wait` 为 `done`；faux 路由器若被调用即失败（证明没有第二次模型请求） |
| `finish_task` 与一个不终止的同轮调用 | **2 条 assistant 记录**，证明"每个调用都必须要求终止" |
| `finish_task` 提交空 summary（校验失败） | **2 条 assistant 记录**，证明无效提交绝不带来终止 |

另有一条 **真实 SQLite reopen** 用例：关闭后对同一文件重开，conversation id、条目数与顺序完全一致，
且重开期间任何 provider 请求都会让测试失败。

### 7.4 备选协议（记录，未使用）

若 `control.terminate` 不可用，唯一稳妥的替代是「结构校验的最终答案 + `Submission.wait`」：
run 在模型停止调用工具并给出最终答案时结束。它更弱（依赖模型自己停，而非 run 真的结束），
故不采纳；也**不**用提示词保证终止、不改上游核心。

## 8. 本子任务未做

- TUI、动态委派、Skill manifest 解析、真实模型/Notion 验证：属于后续子任务。
- `TaskResult` 的 evidence 归属校验（entryId 是否属于本任务的子会话）由 Runtime 在写入时完成，
  本任务的校验器只负责形状与分权。
- 数量/时间默认值**不在此处决定**；运行必须显式有限配置，测试中的数字只是 fixture。
