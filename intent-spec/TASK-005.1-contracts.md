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

**失败额度是准入条件，不只是记账**：`maxFailedToolCallsPerRound` 用尽后，`consume(..., { kind: "tool_call" })`
在**发起之前**就拒绝（`quota_failed_tool_calls_exhausted`）——只在记录下一次失败时才检查，等于让副作用先发生、事后再拒绝。
`businessStopReason(state, budget)` 返回 `"attempts_exhausted" | "tool_invocations_exhausted" | "failed_tool_calls_exhausted"`，
就是交给 Main 的停止原因；`isBusinessBudgetExhausted` 是它的布尔形式。
`maxFailedToolCallsPerRound: 0` 的语义是**零容忍**：第一次失败就已超限，因此不发起任何业务调用（"试到失败为止"不是额度）。
控制通道 `{ kind: "control" }` 不消耗、也从不被拒绝，所以额度耗尽后仍能上报与收尾。

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
- `composeModelResolution(input, stamp, grounding)`：`resolvedBy: "model"` 盖章；payload 没有 `answers`/actor 字段可携带。
  第三个参数 `grounding = { requestId, originalInputEntryIds, recordedAnswers }` 是**程序从持久化读出的可信事实**，写入边界据此校验依据：
  `answer` 必须指向本请求已记录、且 `answeredAt` 一致的回答（`resolution_answer_missing` / `resolution_answer_mismatch`）；
  `original_input` 必须指向本请求真实存在的输入条目 `basis.inputEntryId`（`resolution_original_input_unbound`）。
  `ResolutionBasis` 的 `original_input` 现在**强制携带 `inputEntryId`**，`detail` 只解释理由，不能替代引用。
- `validateClarificationState` 仍拒绝任何 `source !== "application"` 的答案，并交叉校验解决依据指向的问题与回答。
- **收到回答 ≠ 语义充分**：`UserAnswer.sufficient` 是应用的判断；`openQuestionIds` 只在"有充分回答的解决"或"带输入条目引用的 `original_input` 解决"时解除阻塞；
  含糊回答继续阻塞，缺 `inputEntryId` 的 `original_input` 解决直接校验失败、同样不解除阻塞。`mayResumeAfterAnswer` 同语义。
- 模型 payload 只要带 runtime 字段就 `reserved_field` 拒绝。
- 未声明的路径一律拒绝（"没人想过"不是权限模型）。

**证据归属（AC-04 的实质）**：形状校验不能替代归属校验，而归属校验也不能只校验证据——**结果自己的身份同样要绑定**。
`assembleTaskResult(...)` 先用 attribution context 校验 `runtime.taskId` 与 `runtime.round`（`result_task_mismatch` / `result_round_mismatch`），
再校验工作内容，最后才校验证据；因此"一个合法的 round 1 条目 + 一个声称 round 99 的结果"不会因为条目合法而通过。

`verifyEvidenceAttribution(references, known, context)` 依据**已持久化**的事实逐条判定：

| 规则 | code |
|---|---|
| 条目必须在索引里 | `evidence_entry_unknown` |
| 条目必须属于本任务的 child conversation | `evidence_conversation_foreign` |
| 引用的 `kind` 必须等于条目持久化的 `kind` | `evidence_kind_mismatch` |
| 引用的业务任务必须是本任务 | `evidence_task_foreign` |
| 条目必须带 Durable task 归属 | `evidence_task_unattributed` |
| 条目所属 Durable task 必须属于**本轮**（`roundDurableTaskIds`，非整个业务任务的历史） | `evidence_task_mismatch` |
| 条目所属 Submission 必须与本轮一致（双方都记录时） | `evidence_submission_mismatch` |
| 声明了 `toolCallId` 时，条目必须记录该字段且相等 | `evidence_toolcall_unverifiable` / `evidence_toolcall_mismatch` |
| 声明了 `toolName` 时，条目必须记录该字段且相等 | `evidence_toolname_unverifiable` / `evidence_toolname_mismatch` |

两条容易漏掉的点，这里都补上了：

1. **轮次作用域**：`roundDurableTaskIds` 是本轮创建的 Durable task 集合。同一子会话返工多轮时，"整个业务任务拥有过的所有 task" 会让上一轮的条目冒充本轮；按轮次收窄后不能。
2. **"条目恰好没有这个字段"不是通过**：只有当双方都存在该字段时才比较的 AND 条件，恰好是伪造引用需要的漏洞。声明了就必须能核对，否则拒绝。

注意两个 id 空间不同：`EntryRecord.byTaskId` 是 Durable 的 task id，`businessTaskId` 是应用任务 id，二者**不按名字相等推断**，桥接靠程序自己的绑定列表。

## 6. Document 与 schemaVersion

| kind | 状态类型 | 说明 |
|---|---|---|
| `app.agent.request` | `AgentRequestDocState` | 用户请求与材料，`text: ""` 表示未记录；`requestVersion` 是**需求版本**（用户重述需求时递增），初始为 1 |
| `app.agent.clarification` | `ClarificationState` | 问题/回答/解决 |
| `app.agent.plan` | `Plan` | `version: 0` 表示尚未保存过 |
| `app.agent.task-config` | `AgentTaskConfigDocState` | 运行时写入的配置快照 |
| `app.agent.task-result` | `AgentTaskResultDocState` | 运行时写入的结果 |

全部为 `scope: "conversation"` / `history: "latest"` / `fork: "initial"` / `family: true`，version 1。
**无 `migrate`**：这些都是新的 v1 文档，没有旧形态要解释；将来升级时必须只补字段、不改内容
（AC-03：close/reopen 后问题、回答、版本、结果不变）。legacy 迁移只存在于 TASK-003 的 `app.multiagent.task-ledger`。

配置快照（`TaskConfigSnapshot`）区分三种版本号，并记录实际运行的实现标识：

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 文档形状的版本 |
| `contractRevision` | **行为合同修订版**；合同变更而形状不变时靠它区分 |
| `requestVersion` | **用户需求版本**：这一轮回答的是哪一版需求。与上两者、与 `planVersion` 都不同——"最新的计划"回答不了"这是哪一版需求" |
| `taskSpecVersion` / `planVersion` | 派发 spec 与计划的版本 |
| `skillVersion` / `skillHash` | Skill 版本与哈希（64 位小写 hex） |
| `tools` | `{ name, version }[]`：**实际授权并运行的**工具及其版本标识 |
| `assembledPrompt` | 程序从校验后合同组装的提交文本（非模型原文） |
| `budget` | 实际使用的 `RunConfig` |
| `configHash` | 以上内容的稳定哈希，恢复时用于逐位比对 |

`requestVersion` 与 `schemaVersion`/`planVersion` 一样是**必填**：缺失时 `validateTaskConfigSnapshot` 在 `$.requestVersion` 上拒绝，
不提供默认值——默认值会让"同一需求、新计划"和"新需求"在恢复时无法区分。

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

### 7.2 应用协议（本 Issue 选定）

1. `finish_task` 是模型提交**自身工作**（summary/findings/unresolved/artifacts）的结构化入口；
   参数里没有身份/状态/证据字段——模型无处可写，也就无法伪造。
2. **提交有效就请求终止，无论会话还授权了什么工具。** 工具看不到同轮其它调用的 control，
   所以"授权集合里还有别的工具"**不是关于本轮的断言**——它对每一个可用的子 Agent 都成立，
   据此拒绝会让这个工具在真正需要它的会话里完全不可用。工具能做的是"请求"，并把请求说清楚。
3. **模型的责任是让 `finish_task` 成为本轮的唯一次调用**：先做业务工作（可多轮），最后单独提交一轮。
   同轮若还有其它不终止的调用，harness 不会终止（源码规则 1），run 继续；工具输出明确告知这一点
   （"if the run continues, call finish_task again as the only call of the round"），所以模型不会被误导成"已经结束"。
4. **不得自行 accepted**：标记接受是 Main 依据持久化证据的决定。
5. **不在工具内宣称完成**：输出只说"本轮请求结束"（`decideFinish` 的 `statement`），绝不出现 "Finished"；
   run 的结果由等待 `Submission.wait` 的一方在结算后记录。
6. **`isRunEnded` 只认真实结算**：`isRunEnded(settlement)` 依据 `Submission.wait` 返回的 `status`
   （`done` / `unanswered` 为终态，`queued` / `placed` 不是）；"工具请求终止"由 `isTerminateRequested` 表达——
   那是**请求**谓词，不是结算。程序绝不以"工具叫 finish_task"推断已停止。

### 7.3 实测（真实 harness，faux provider，本地 SQLite）

`test/agent-state.test.ts` 的用例：

| 用例 | 断言 |
|---|---|
| 会话只授权 `finish_task`，模型调用它 | run 结束：**只有 1 条 assistant 记录**、`submission.wait` 为 `done`；工具结果 `isError=false` 且文本是"请求结束"而非"已完成"；faux 路由器若被调用即失败（证明没有第二次模型请求）；模型工作持久化在它发出的 toolCall 参数里 |
| **会话另授权业务工具：先执行业务工具，再单独提交** | run 在提交那一轮结束：**2 条 assistant 记录**（业务轮 + 提交轮），`submission.wait` 为 `done`；路由器若被调用即失败（证明没有第三次 provider 请求）；结算后条目序列不变 |
| **同轮竞合**：同一轮同时调用 `finish_task` 与一个不终止的工具 | **本轮没有停**（harness 要求每个调用都请求终止），run 继续到第 2 轮（**2 条 assistant 记录**）；工具结果 `isError=false`，文本说明"必须是本轮唯一次调用"，且**不含** "Finished" |
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

### 7.4 备选协议（合同允许，供未来 Runtime 选用）

若某个 Runtime 无法依赖第 3 步的"唯一次调用"，合同允许的替代是「结构校验的最终答案 + `Submission.wait`」：
run 在模型停止调用工具、给出最终答案时结束。它更弱（依赖模型自己停，而非 run 真的结束），
所以本 Issue 的默认协议仍是 `control.terminate` + 单独提交；也**不**用提示词保证终止、不改上游核心。

## 8. 测试与 CI

| 文件 | 内容 |
|---|---|
| `test/agent-contracts.test.ts` | **46** 个纯契约测试：spec/batch/config/snapshot（含 `requestVersion` 必填）、列表逐项、分权、结果身份与证据归属（任务/轮次错配、上一轮条目、伪造 kind、无法核对的 toolCallId/toolName）、澄清与写入边界（含 `original_input` 未绑定/外请求/无记录回答的负例）、finish 决策与 `isRunEnded` 语义、plan 版本、Document kind |
| `test/agent-state.test.ts` | **24** 个测试：转换表、轮次失败决策、恢复语义、取消准入、额度（含失败额度准入拦截、零容忍语义、控制通道）、finish（4 个真实 harness 用例：单独提交、先业务后提交、同轮竞合、无效提交）、五类 Document 的真实写入/关闭/重开（关闭前读全量、重开后整份 deepEqual）、真实跨会话与跨轮次证据负例 |

`npm test` 是完整入口：本机 **15 文件 / 197 测试**全过；`.github/workflows/ci.yml` 有第三个 job `test`
（与 lint/typecheck 同样的准备步骤 + `npm test`），不扩大原有 lint/typecheck 的范围。
测试全部离线、确定性、faux provider，不需要任何凭据。

## 9. 本子任务未做

- TUI、动态委派、Skill manifest 解析、真实模型/Notion 验证：属于后续子任务。
- **证据归属**：本任务交付的是合同与组装边界（`verifyEvidenceAttribution` / `assembleTaskResult`），
  它需要调用方把持久化条目与**本轮的** Durable task 绑定读进来。把这些绑定在真实调度中持续维护、
  以及在写入结果时调用组装，属于 Runtime 子任务；本任务不实现调度器。
- `finish_task` 的默认协议要求模型把提交放在**单独一轮**；把"如何让后续 Builder/Runtime 的 Agent loop
  稳定做到这一点"落到调度实现，也属于 Runtime 子任务（合同层已给出协议与备选方案，见 §7.4）。
- 数量/时间默认值**不在此处决定**；运行必须显式有限配置，测试中的数字只是 fixture。

## 10. AC 覆盖（按真实证据）

| AC | 状态 | 依据 |
|---|---|---|
| AC-01 Schema 与额度校验 | 通过 | `test/agent-contracts.test.ts`（未知字段、非法 id、依赖环、旧 schemaVersion、负/非整数/无限额度、非数组批次、列表逐项、`blockingScope` 非数组） |
| AC-02 状态转换与额度耗尽 | 通过 | `lifecycle.ts` 转换表 + `decideRoundFailure`；`test/agent-state.test.ts` 的转换表/轮次失败/额度用例 |
| AC-03 五类 Document 持久化 | 通过 | `test/agent-state.test.ts`：真实 SQLite 写入 → `close()` → 重开 → **整份 deepEqual** + 重校验 |
| AC-04 字段分权与证据归属 | 通过 | 分权矩阵 + `verifyEvidenceAttribution`（含真实跨会话、跨轮次负例） |
| AC-05 提交后停止本轮 | 通过 | `finish_task` + `decideFinish`；4 个真实 harness 用例（含"先业务后提交"与同轮竞合） |
| 新确定性测试进入 CI | 通过 | `.github/workflows/ci.yml` 第三个 job `test` 跑完整 `npm test` |
