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
| 技术失败且重启额度**或** attempt 额度用尽 | failed | **不变**：结算为失败轮次 + `requiresMainDecision: true`，停止业务调用，由 Main 决定（接受现有产出 / 判定 failed / 补材料） |
| 质量不合格（结果差） | completed | 不变，交 `awaiting_review` 由 Main 决策 |
| 取消 | cancelled | cancelled（终态） |

关键点：**额度耗尽是基础设施事实，不是对任务的判断**。`failed` 是终态且不可复活，所以只有 Main/授权策略的显式决定才能让业务进入 `failed`/`cancelled`；自动重试则被额度封顶，不会出现无限重试链。
额度账本：`src/agent/state/quota.ts`，`consume()` 单次完成「检查+预留」，超限抛 `QuotaError`
（稳定 code：`quota_attempts_exhausted` / `quota_technical_restarts_exhausted` /
`quota_tool_invocations_exhausted` / `quota_failed_tool_calls_exhausted`）；
每轮计数在新轮次开始时由 `resetRoundCounters` 归零，每操作计数持续。`stopsBusinessCalls(settlement)` 表示不得再发起业务调用。

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

**写入边界，而不是字符串标签**（这是 AC-03/AC-04 的要点）：

- `composeUserAnswer(input, stamp)`：`source: "application"` 由**写入调用**盖章；它接受的 payload 里根本没有 `source` 字段，所以模型自造一份"我是应用"的 JSON 会被 `field_unknown` 拒绝，而不是被相信。`sufficient` 同样只由应用给出。
- `composeModelResolution(input, stamp)`：`resolvedBy: "model"` 盖章；payload 没有 `answers`/actor 字段可携带。解决依据必须是已记录的真实回答（`basis.answerAt` 与记录一致）或 `original_input`。
- `validateClarificationState` 仍拒绝任何 `source !== "application"` 的答案，并交叉校验解决依据指向的问题与回答。
- **收到回答 ≠ 语义充分**：`UserAnswer.sufficient` 是应用的判断；`openQuestionIds` 只在"有充分回答的解决"或"original_input 解决"时解除阻塞，含糊回答继续阻塞，`mayResumeAfterAnswer` 同语义。
- 模型 payload 只要带 runtime 字段就 `reserved_field` 拒绝。
- 未声明的路径一律拒绝（"没人想过"不是权限模型）。

**证据归属（AC-04 的实质）**：形状校验不能替代归属校验。`verifyEvidenceAttribution(references, known, context)` 依据**已持久化**的事实判定：
条目必须在索引里（`evidence_entry_unknown`）、必须属于本任务的 child conversation（`evidence_conversation_foreign`）、
引用的业务任务必须是本任务（`evidence_task_foreign`）、条目所属的 Durable task 必须在程序已绑定的集合内（`evidence_task_mismatch`）、
toolCallId 必须与条目自身一致（`evidence_toolcall_mismatch`）。
注意两个 id 空间不同：`EntryRecord.byTaskId` 是 Durable 的 task id，`businessTaskId` 是应用任务 id，二者**不按名字相等推断**，桥接靠程序自己的绑定列表。
`assembleTaskResult(...)` 把「程序分配的身份 + runtime 观测结果 + 模型工作内容」组装起来，并在返回前完成归属校验。

## 6. Document 与 schemaVersion

| kind | 状态类型 | 说明 |
|---|---|---|
| `app.agent.request` | `AgentRequestDocState` | 用户请求与材料，`text: ""` 表示未记录 |
| `app.agent.clarification` | `ClarificationState` | 问题/回答/解决 |
| `app.agent.plan` | `Plan` | `version: 0` 表示尚未保存过 |
| `app.agent.task-config` | `AgentTaskConfigDocState` | 运行时写入的配置快照 |
| `app.agent.task-result` | `AgentTaskResultDocState` | 运行时写入的结果 |

全部为 `scope: "conversation"` / `history: "latest"` / `fork: "initial"` / `family: true`，version 1。
**无 `migrate`**：这些都是新的 v1 文档，没有旧形态要解释；将来升级时必须只补字段、不改内容
（AC-03：close/reopen 后问题、回答、版本、结果不变）。legacy 迁移只存在于 TASK-003 的 `app.multiagent.task-ledger`。

配置快照（`TaskConfigSnapshot`）区分两种版本号，并记录实际运行的实现标识：

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 文档形状的版本 |
| `contractRevision` | **行为合同修订版**；合同变更而形状不变时靠它区分 |
| `taskSpecVersion` / `planVersion` | 需求与计划的版本 |
| `skillVersion` / `skillHash` | Skill 版本与哈希（64 位小写 hex） |
| `tools` | `{ name, version }[]`：**实际授权并运行的**工具及其版本标识 |
| `assembledPrompt` | 程序从校验后合同组装的提交文本（非模型原文） |
| `budget` | 实际使用的 `RunConfig` |
| `configHash` | 以上内容的稳定哈希，恢复时用于逐位比对 |

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
3. **只在提交能真的结束本轮时才要求终止**。工具看不到同轮其它调用的 control，所以它检查唯一能诚实验证的东西：
   本会话**被授权可调用**的工具集（`api.agent(context).tools`）。只要还有 `finish_task` 之外的授权工具，
   本轮就可能存在竞合调用、harness 不会终止，于是**拒绝提交**（`isError`、无 control），而不是返回一个会被忽略的 terminate。
   代价是：一个同时授权了其它工具的会话，不能靠 `finish_task` 结束本轮——这是"要么真的停、要么明说不能停"的取舍。
4. **不得自行 accepted**：标记接受是 Main 依据持久化证据的决定。
5. **不在工具内宣称完成**：工具输出只说"本轮请求结束"，run 的结果由等待 `Submission.wait` 的一方在结算后记录。
6. 程序通过已有的 `Submission.wait` 得知 run 结束，**不**以"工具叫 finish_task"推断已停止。

### 7.3 实测（真实 harness，faux provider，本地 SQLite）

`test/agent-state.test.ts` 的用例：

| 用例 | 断言 |
|---|---|
| 会话只授权 `finish_task`，模型调用它 | run 结束：**只有 1 条 assistant 记录**、`submission.wait` 为 `done`；工具结果 `isError=false` 且文本是"请求结束"而非"已完成"；faux 路由器若被调用即失败（证明没有第二次模型请求）；模型工作持久化在它发出的 toolCall 参数里 |
| 会话另授权一个不终止的工具，模型同轮调用两者 | `finish_task` **拒绝**（`isError=true`，文本点名竞合工具），**2 条 assistant 记录**——本轮没有停 |
| 提交空 summary（校验失败） | 拒绝、无 control、**2 条 assistant 记录**：无效提交绝不终止 |
| 关闭后重开同一 SQLite | conversation 与条目序列完全一致，重开期间任何 provider 请求都会让测试失败 |

可重复的取证入口（取代上一轮的一次性脚本）：

```bash
cd durable-cli-probe
npm run agent:finish-evidence
# 或指定库与请求 id：
npm run agent:finish-evidence -- --db ./finish.sqlite --request-id my-run
```

它打印 `databasePath` / `requestId` / `conversationId` / `submissionEntryId` / `answerEntryId` / 条目序列 /
`assistantEntryCount`，并在"出现第二次模型轮次"或"未结算为 done"时以非零退出。输出示例（本机实跑）：

```json
{ "databasePath": "…/finish-evidence-FVEO1j/finish-evidence.sqlite", "requestId": "finish-evidence-1",
  "conversationId": 1, "settledStatus": "done", "submissionEntryId": 7, "answerEntryId": 11,
  "entryKinds": ["pi.user#7", "pi.system#10", "pi.assistant#11", "pi.tool-result#13"],
  "assistantEntryCount": 1, "toolResultEntryCount": 1 }
```

### 7.4 备选协议（记录，未使用）

若 `control.terminate` 不可用，唯一稳妥的替代是「结构校验的最终答案 + `Submission.wait`」：
run 在模型停止调用工具并给出最终答案时结束。它更弱（依赖模型自己停，而非 run 真的结束），
故不采纳；也**不**用提示词保证终止、不改上游核心。

## 8. 测试与 CI

| 文件 | 内容 |
|---|---|
| `test/agent-contracts.test.ts` | 38 个纯契约测试：spec/batch/config/snapshot、列表逐项、分权、结果归属、澄清与写入边界、plan 版本、Document kind |
| `test/agent-state.test.ts` | 21 个测试：转换表、轮次失败决策、恢复语义、取消准入、额度、finish（4 个真实 harness 用例）、五类 Document 的真实写入/关闭/重开、跨会话证据归属负例 |

`npm test` 是完整入口；`.github/workflows/ci.yml` 有第三个 job `test`（与 lint/typecheck 同样的准备步骤 + `npm test`），
不扩大原有 lint/typecheck 的范围。测试全部离线、确定性、faux provider，不需要任何凭据。

## 9. 本子任务未做

- TUI、动态委派、Skill manifest 解析、真实模型/Notion 验证：属于后续子任务。
- `TaskResult` 的 evidence 归属校验（entryId 是否属于本任务的子会话）由 Runtime 在写入时完成，
  本任务的校验器只负责形状与分权。
- 数量/时间默认值**不在此处决定**；运行必须显式有限配置，测试中的数字只是 fixture。
