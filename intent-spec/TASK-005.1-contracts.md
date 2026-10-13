# TASK-005.1 合同：Schema、状态转换与持久状态

本文件是 TASK-005.1（Issue #16）的实现说明，与 `intent-spec/TASK-005-personal-agent-tui.md` 配套。
总任务的行为合同不变；这里只记录**本子任务新增的合同**与**锁定源码依据**。任何偏离需用户确认。

代码位置：`durable-cli-probe/src/agent/contracts/`（纯校验与 Document）、`durable-cli-probe/src/agent/state/`（状态机、额度、分权、完成边界 `finish.ts`）。
本任务**不提供**完成工具：提交由"结算后的结构化最终答案"承担，理由与实测见 §7。

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

## 7. 完成边界：结算后的结构化最终答案（源码依据与实现）

### 7.1 源码依据（锁定 pi `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`）

- `packages/durable/src/harness/types.ts`
  - `ToolControl = { addTools?: readonly string[]; terminate?: true; handoff?: string }`
  - `ToolExecutionResult.control?: ToolControl`（工具只能在结果上带 control）
- `packages/durable/src/harness/generation.ts` → `finishToolRound`
  - `terminate = slots.length > 0 && slots.every((slot) => slot.taskId !== undefined && controls.get(slot.taskId)?.terminate === true)`
  - `if (terminate || handoff !== undefined)` → `applyBoundary(…, "final", …)` + `endRun(…, { status: "done", answer: assistant })`；
    否则 `handOver(...)` 交给下一个 generation，**run 继续**。
- `packages/durable/src/harness/generation.ts` → `answer`
  - 一条**没有工具调用**的最终回答：`applyBoundary(…, "final", …)` + `endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id })`。

### 7.2 为什么 `control.terminate` 不能作为本合同的完成边界

`terminate` 要求**本轮每一个调用**都请求终止，而工具调用看不到同轮兄弟。因此"`finish_task` + 任何不终止的调用"会被静默忽略：
run 继续，后续轮次仍可发起业务调用，唯一能让停止发生的办法是**要求模型把提交单独放一轮**。
那是对模型的请求，不是程序给出的保证——而"有效提交之后仍发生业务调用"正是 AC-05 禁止的。
（`handoff` 确实能无条件结束 run，但它会追加一条 reset entry 并移动会话 head，是本合同不要求的副作用，故不采用。）

这不是推断。真实 harness（faux provider、内存 SQLite）实测：第 1 轮 `finish_task(valid)` + 业务调用，第 2 轮业务调用，
第 3 轮 `finish_task` 单独调用，记录到 `businessCalls = 2`——**第一次有效提交之后仍执行了一次业务调用**。
据此该路线被放弃，`finish_task` 工具已从本实现移除（`src/agent/tools/` 不再存在）。

### 7.3 选定协议：结构化最终答案 + 结算（`completeSubmission`）

1. 模型用它被授权的工具做业务工作，可以多轮。
2. **提交 = 一条没有工具调用的最终回答**，回答正文是工作合同的 JSON（裸 JSON，或唯一的 fenced 代码块）。
   该轮没有工具调用，harness 应用 `"final"` 边界并结束 run——这条边界**不需要任何兄弟配合**：
   没有工具调用的轮次没有兄弟。
3. 程序等待它已经持有的 `Submission.wait`。只有 `done` 算结算（`queued`/`placed` 未结算；`unanswered` 没有回答可接受）。
4. **只有到这时**程序才读回答条目并校验 payload（`completeSubmission`）。
   **任何工具调用都不是提交**：完成定义在"run 已结算 **且** 结果通过校验"之后，
   所以"尚未终止 run 的 finish 调用"不可能被当成成功提交。

于是 AC-05 要的性质是**结构性**成立的，而不是靠提示词：业务调用发生在提交之前，提交就是 run 的结束。

`completeSubmission` 的稳定拒绝码：`submission_not_settled` / `submission_unanswered` / `submission_answer_missing` /
`submission_answer_empty` / `submission_answer_ambiguous` / `submission_result_unparseable` / `submission_result_invalid`
（后者同时转发 `validateModelWork` 的违规码，例如 `reserved_field`，路径前缀 `$.answer`）。

**"唯一 fenced 块"是被检查的，不是被假定的。** `parseStructuredAnswer` 扫描**全部**围栏，
而不是取第一对：

- 恰好 1 个完整块 → 解析该块；块内 payload 非法 → `submission_result_unparseable`。
- **多于 1 个完整块** → `submission_answer_ambiguous`（路径 `$`）。
- 1 个完整块 + 1 个**未闭合**围栏 → 同样 `submission_answer_ambiguous`。

取第一块会让模型自己的更正（第二块）被忽略，而它已被取代的草稿却被当成最终工作提交——
这正是"不能通过实现悄悄改变约定"要避免的。歧义必须拒绝，不能猜。
（此条为 Codex 第 4 轮 P2-1 的修复。）

**不得自行 accepted**：标记接受仍是 Main 依据持久化证据的决定；`completeSubmission` 只回答"这个提交是否成立"。

### 7.4 实测（真实 harness，faux provider，本地 SQLite）

`test/agent-state.test.ts` 的用例：

| 用例 | 断言 |
|---|---|
| 会话有业务工具，模型先业务、后提交 | **2 条 assistant**（业务轮 + 回答轮）；`submission.wait` 为 `done`；`completeSubmission` 接受且 `work` 与回答一致；**回答条目之后没有任何 tool-result**；结算后条目序列不变 |
| 带 fenced 代码块的回答 | 同样被接受（正文可以包一层说明，但合同必须放进代码块） |
| 散文回答 / 无效 JSON / 带 runtime 字段的回答 | run 结算为 `done`，但 `completeSubmission` 拒绝：`submission_result_unparseable` / `submission_result_invalid`（路径 `$.answer.summary`）/ `reserved_field` |
| **工具调用不是提交**：两轮业务调用之后才回答 | **3 条 assistant**、2 条业务 tool-result，全部在回答之前；回答之后 **0** 条 tool-result；路由器若被调用即失败（没有第 4 次 provider 请求） |
| 关闭后重开同一 SQLite | **保存真实 `submission.id`**；重开后 `harness.resume()` 启用调度并 `waitForIdle`；用公开入口 `harness.submission(id, context)` **重新取得同一提交并 `wait`**，按**实际** `settlement.answer` 读回答；条目序列、结算与回答身份不变；**显式断言 provider 调用数为 0** |

> 重开用例此前只做只读调用，并用手写 `{status:"done"}` 代替真实结算——锁定 `types.ts` 的
> `resume()` 注释明确"只读 viewer 从不启用调度"，因此该用例即使持久化或恢复调度有回归也照样通过。
> 现版本启用调度、重取真实提交，并计数 provider 调用。
> （此条为 Codex 第 4 轮 P2-2 的修复。计数器的**敏感性**已单独验证：重开后提交一个**新**输入
> 会使计数 > 0，证明调度确实启用、计数器确实有效，故 `toBe(0)` 是有效断言而非静态检查。）

纯函数层（`test/agent-contracts.test.ts`）：裸 JSON / fenced / 散文 / 空串 / 未闭合 fence 的解析；
**歧义拒绝**——两个合法但不同的块、首合法次非法、完整块 + 未闭合围栏，均 `submission_answer_ambiguous`；
`submission_not_settled`（`queued`/`placed`）、`submission_unanswered`、`submission_answer_missing`；
以及 `isRunEnded` 只认 `done`/`unanswered`。

可重复的取证入口：

```bash
cd durable-cli-probe
npm run agent:finish-evidence
# 或指定库与请求 id：
npm run agent:finish-evidence -- --db ./finish.sqlite --request-id my-run
```

它复现上面那个失败形状（业务工具 + 一轮业务调用 + 结构化回答），打印
`databasePath` / `requestId` / `conversationId` / `settledStatus` / `submissionEntryId` / `answerEntryId` /
条目序列 / `assistantEntryCount` / `businessToolResultCount` / `businessResultsAfterAnswer` / `submissionValid`，
并在"回答之后仍有业务 tool-result"、"出现第 3 次模型轮次"、"未结算为 done"或"提交未通过校验"时以非零退出。
输出示例（本机实跑）：

```json
{ "databasePath": "…/finish-evidence-1CD23U/finish-evidence.sqlite", "requestId": "finish-evidence-1",
  "conversationId": 1, "settledStatus": "done", "submissionEntryId": 7, "answerEntryId": 15,
  "entryKinds": ["pi.user#7", "pi.system#10", "pi.assistant#11", "pi.tool-result#13", "pi.assistant#15"],
  "assistantEntryCount": 2, "businessToolResultCount": 1, "businessResultsAfterAnswer": 0,
  "submissionValid": true, "submissionSummary": "Revenue is 1,204 units, quoted from the material." }
```

## 8. 测试与 CI

| 文件 | 内容 |
|---|---|
| `test/agent-contracts.test.ts` | **49** 个纯契约测试：spec/batch/config/snapshot（含 `requestVersion` 必填）、列表逐项、分权、结果身份与证据归属（任务/轮次错配、上一轮条目、伪造 kind、无法核对的 toolCallId/toolName）、澄清与写入边界（含 `original_input` 未绑定/外请求/无记录回答的负例）、完成边界（答案解析、`submission_not_settled`/`submission_unanswered`/`submission_answer_missing`、`isRunEnded`）、plan 版本、Document kind |
| `test/agent-state.test.ts` | **23** 个测试：转换表、轮次失败决策、恢复语义、取消准入、额度（含失败额度准入拦截、零容忍语义、控制通道）、完成边界（4 个真实 harness 用例：结构化回答被接受（裸 JSON 与 fenced）、不可读/无效/带 runtime 字段被拒、工具调用不是提交且回答之后 0 条业务调用、重开重读同一份提交）、五类 Document 的真实写入/关闭/重开（关闭前读全量、重开后整份 deepEqual）、真实跨会话与跨轮次证据负例 |

`npm test` 是完整入口：本机 **15 文件 / 199 测试**全过；`.github/workflows/ci.yml` 有第三个 job `test`
（与 lint/typecheck 同样的准备步骤 + `npm test`），不扩大原有 lint/typecheck 的范围。
测试全部离线、确定性、faux provider，不需要任何凭据。

其中四个 suite 打开真实 harness + 真实 SQLite，明显慢于纯函数检查，在整套并行运行时会再被拖慢数倍，
因此显式声明了 30s 的单测预算（`describe(name, { timeout: 30_000 }, …)`），而不是依赖默认 5s 与本机负载。

## 9. 本子任务未做

- TUI、动态委派、Skill manifest 解析、真实模型/Notion 验证：属于后续子任务。
- **证据归属**：本任务交付的是合同与组装边界（`verifyEvidenceAttribution` / `assembleTaskResult`），
  它需要调用方把持久化条目与**本轮的** Durable task 绑定读进来。把这些绑定在真实调度中持续维护、
  以及在写入结果时调用组装，属于 Runtime 子任务；本任务不实现调度器。
- **完成边界**已在本任务交付并可重复验证（§7）：提交 = "结算后的结构化最终答案"，程序只认 `completeSubmission`。
  后续 Builder/Runtime 要做的是把这个协议接进它们的 Agent loop（例如约定回答格式）、
  在真实调度里调用 `completeSubmission` 并把结论交给 Main——这些属于 Runtime 子任务。
  本任务不实现调度器，也**不**依赖"模型必须把提交单独放一轮"这类提示词约定来保证停止。
- 数量/时间默认值**不在此处决定**；运行必须显式有限配置，测试中的数字只是 fixture。

## 10. AC 覆盖（按真实证据）

| AC | 状态 | 依据 |
|---|---|---|
| AC-01 Schema 与额度校验 | 通过 | `test/agent-contracts.test.ts`（未知字段、非法 id、依赖环、旧 schemaVersion、负/非整数/无限额度、非数组批次、列表逐项、`blockingScope` 非数组） |
| AC-02 状态转换与额度耗尽 | 通过 | `lifecycle.ts` 转换表 + `decideRoundFailure`；`test/agent-state.test.ts` 的转换表/轮次失败/额度用例 |
| AC-03 五类 Document 持久化 | 通过 | `test/agent-state.test.ts`：真实 SQLite 写入 → `close()` → 重开 → **整份 deepEqual** + 重校验 |
| AC-04 字段分权与证据归属 | 通过 | 分权矩阵 + `verifyEvidenceAttribution`（含真实跨会话、跨轮次负例） |
| AC-05 有效提交后停止（不再发生业务调用） | 通过 | 完成边界 = **结算后的结构化最终答案**：`isRunEnded` + `parseStructuredAnswer` + `completeSubmission`（§7.3）。真实 harness 用例证明：回答之后 **0** 条业务 tool-result、工具调用**不是**提交、无效/不可读/带 runtime 字段的回答不被接受；**回答必须恰好一个 fenced 块，歧义（多块/未闭合围栏）拒绝**；**重开用例保存真实 `submission.id`、启用调度、经 `harness.submission(id)` 重取真实结算，并断言 provider 调用为 0**。`npm run agent:finish-evidence` 可重复取证（`businessResultsAfterAnswer: 0`）。工具路线（`control.terminate`）为何不可用见 §7.2，附实测数据 |
| 新确定性测试进入 CI | 通过 | `.github/workflows/ci.yml` 第三个 job `test` 跑完整 `npm test` |
