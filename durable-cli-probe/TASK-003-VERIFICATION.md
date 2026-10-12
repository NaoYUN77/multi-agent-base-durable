# TASK-003 验证报告：主子 Agent 协作闭环

本报告记录 Issue #9（TASK-003）的验收证据，以及 PR #10 两轮审阅后逐条修复的结果与**当前真实结论**。所有标识（conversation / submission / entry / task id、SHA、路径）均从本机 SQLite 查询结果或实际命令输出抄录。

## 0. 修订历史与结论口径

| 轮次 | 被测 commit | 审阅结论 | 本轮改动 |
|---|---|---|---|
| 首轮 | `c6fcd6be9279176a001c7d1d2545b01bca27a2cd` | 不通过（6×P1 + 2×P2） | 操作绑定、取消、只读 inspect、提示加载、字段补全、测试修正 |
| 二轮 | `321dc5f45b1fa659b1fdda5292dbc93c7fe32994` | 不通过（5 项：并发预留、取消屏障、已结算重放、delta 解码、pre-submit 边界） | 见 §10 |
| 三轮 | `3baeccf13cb0d84722502b068499d39c7df6efd7`（含实现提交 `1bcddc54e1c5d090fedb8f49898f21dec903b73b` 与清理提交） | 不通过（3 项：取消与提交准入、revise 陈旧保护、返工 pre-submit 边界） | 见 §11（实现提交 `bb544b1f3bf46fc8a3416097a1a72ded76c4c900`） |
| 四轮 | `29839b75ecc5`（`bb544b1` + 文档提交） | 不通过（2×P2：准入测试的握手/窗口、AC-10 证据归属） | 见 §12（实现提交 `202005f750b06dd507a52acc86ce3db5621274bb`） |
| 本轮 | `202005f750b06dd507a52acc86ce3db5621274bb`（实现提交，完整 SHA；其后的文档提交只改报告与 spec） | 待审阅 | — |

**结论口径修正**：二轮审阅指出上一版报告把 AC-05/06/07 写成"通过"不成立——当时的实现里并发调用可同时占用同一轮次、取消没有持久化屏障、已结算轮次的原操作重放会再次执行 outcome 逻辑、`revising-intent` kill 点实际发生在 submission 之后、inspect 的 delta 解释会读错合法 op。本报告据实修订：**上一轮的 AC-05/06/07 结论作废**，本轮按新实现与新测试重新给出结论（§3）。

## 1. 被测对象与环境

| 项 | 值 |
|---|---|
| 被测 commit | `202005f750b06dd507a52acc86ce3db5621274bb`（本轮实现提交，完整 SHA） |
| 底座（本地 Pi checkout） | `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`（未改动） |
| 环境 | Windows，Node `v22.22.2` |
| 自动化检查 | `npm run typecheck` 退出 0；`npm test` **125 passed**（87 既有 + 38 新增，13 个文件） |

## 2. Ownership 实测（Issue 标注的未知边界）

- 首轮委派的工具 Task A 创建 task-owned 子会话（`owner={conversationId, taskId:A}`，`parent=undefined`）；
- 返工由**另一个**工具 Task B 执行，经 `tx.scanConversations({ ownerConversationId })` 找回同一子会话并 submit 成功；
- 重开 harness 后 root、子会话、transcript 全部可读。

结论：**foreground task-owned ownership 满足合同**，无需后台模式、无需 fork、无需新建会话。

## 3. 验收结论（AC-01 ~ AC-10）

| AC | 结论 | 依据 |
|---|---|---|
| AC-01 | 通过 | 主子 conversation id 不同；子 `parent=undefined`；返工同子会话；新任务新子会话（`multiagent.test.ts`） |
| AC-02 | 通过 | 子请求按**子指令标记**（`pi.system.sections`）独立识别；子请求不含主哨兵；beta 子请求不含 alpha 材料与子答案 |
| AC-03 | 通过 | `conversation.agent()`：主 6 工具、子白名单；未授权与未知工具被拒且留 error 证据；`runtime.reports` 为空 |
| AC-04 | 通过 | 证据与真实 entry 逐字段一致；**捕获的父请求**含 `entry/byTask/call/error/kind`；轮次边界；151 次调用跨页；脱敏摘要；截断全文取回；三类越权拒绝；空答案 → `failed(empty_answer)` |
| AC-05 | **通过（三轮重证）** | 并发委派/并发返工各只有一个赢家；重复委派拒绝；**审阅与返工都必填目标轮次**，陈旧请求被拒且不改动轮次/绑定/version；同消息两次 accept 只落 1 条；`revision_limit` → failed。二轮结论作废，见 §11-2 |
| AC-06 | **通过（三轮重证）** | 终态拒绝后续操作；取消先落意图、abort 子会话、确认无活跃子任务再终态；**取消与提交准入由执行权协议协调**（被 park 的轮次在取消完成后永不提交，首轮与返工各 1 项测试）；取消期间 `failRound` 让位并交回执行权；全局中止不算失败且可随后取消。二轮结论作废，见 §11-1 |
| AC-07 | **通过（三轮重证）** | **八个** unclean stop 边界（含首轮 pre-submit、**返工 pre-submit**、post-outcome 收据、省略 taskId 的派生 ID）；inspect 前后文件字节与逻辑记录一致。二轮结论作废，见 §11-3 |
| AC-08 | 通过 | 主/子真实压缩：有效上下文消息数 5→2 且含摘要、被压缩原文从 context 消失；旧 entry 可读；台账/审阅/证据引用不变 |
| AC-09 | 通过 | `npm run typecheck` 0；`npm test` 121 passed；改动范围核对 |
| AC-10 | 通过（样例链路） | 真实 DeepSeek 闭环 exit 0，程序侧验收校验与提示加载校验均通过（§6）。**单次运行，不构成概率保证** |

## 4. 跨进程恢复（AC-07）细节

测试用 `test/helpers/multiagent-runner.ts` 作为真实子进程；边界 1–4、7 由进程内 kill 点触发，边界 5/6 由 `createMultiagentExtension` 的**验证屏障**（`beforeSubmit` / `afterOutcome`）触发。Windows 上 SIGKILL 表现为退出码 1。

| 边界 | kill 点 | 重启后断言 |
|---|---|---|
| 1 | 子会话首次模型请求 | 1 ledger、1 子会话、该 requestId 恰 1 条 submission（`done`）、rounds=1 |
| 2 | round 已 settled 未审阅 | review 落**同一轮**：rounds=1、reviews=1、子会话不变 |
| 3 | 子会话收到返工任务 | 重放恢复 **round 2**：rounds=2、round 2 submission 恰 1 条、**round 3 submission 数 = 0** |
| 4 | 工具 `pauseMs` 睡眠期间（`pi.tool` 为 `running`、无 tool-result） | round 1 结算、tool-result **恰 1 条**、无 running 的 `pi.tool` |
| 5 | **`beforeSubmit` 屏障**（首轮：意图已落账、submit 尚未发生） | kill 时该 requestId 的 submission **0 条**；重启后**恰 1 条**、round 结算 |
| 6 | **`afterOutcome` 屏障**（结果已落账、父 tool-result 未落账） | 重放返回持久化收据：rounds=1、submission 仍 1 条、**version 与 events 完全不变**；随后 review 仍可验收 |
| 7 | 省略 `taskId` 的委派 + 中断 | 派生 ID（`task-<toolTaskId>`）在重启前后一致；1 文档、1 子会话、该 ID 的 round 1 submission 恰 1 条 |
| 8 | **返工的 `beforeSubmit` 屏障**（round 2 意图已落账、其 submission 尚未发生） | kill 时 round 2 的 submission **0 条**、status=revising、round 2 记录含 feedback 与 opKey；重启后 round 2 submission **恰 1 条**、**无 round 3**、round 1 证据与审阅记录不变 |

## 4b. 取消与提交准入（三轮引入，四轮改为可观察的握手）

设计：**取消意图只在唯一的准入闸口被检查**——Stage 2 的第二次准入，紧邻 `handle.submit`。更早的阶段（claim、Stage 0、Stage 1、第一次准入）只查**执行权**与**终态**，因此持有执行权的轮次总能走到该闸口（可被观察），而"取消已完成"必然意味着任务已终态，所有路径都会拒绝。`beforeSubmit` 验证屏障就位于闸口**之前**，覆盖"闸口已过、提交未发"的窗口。

`multiagent-cancel-admission.test.ts`（2 项，首轮与返工各一，含显式 enter/release 握手）：

1. 同一条消息里发出委派与取消（并行工具调用；同一会话的 inbox 会把第二个提交排队，因此这是唯一能让取消与 park 中的轮次并发的配置）；
2. 轮次到达屏障后**握手信号 `entered` 触发**，证明它确实处于准入窗口内（而不是"没进入 hook 也照样通过"）；
3. 在 park 期间断言：执行权仍被该轮持有（`activeOpKey` 匹配 `delegate:`/`revise:`）、`cancelRequested` 已记录、状态非终态、该轮 submission **0 条**，且取消的结果文本为 **`cancel pending`**（工具返回与终态明确区分）；
4. 释放屏障 → 该轮到达第二次准入，看到意图后拒绝提交（并交回执行权）；
5. 再次调用取消 → 终态 `cancelled`；断言该轮 submission 始终为 0、子会话无活跃任务；返工用例另断言 round 1 的 submission 数、证据数与审阅记录逐项不变。

## 5. 只读检查（inspect）

- 实现：裸 `node:sqlite` `readOnly` 连接 + **Chord 公开 `apply`**（`@earendil-works/chord/delta`）重建文档值；不打开 Harness、不迁移、不创建 root。
- 验证（`multiagent-inspect.test.ts`）：
  - 中断库（含 running 任务）检查前后：文件 SHA-256 相同、`conversations/entries/tasks/submissions/documents/document_revisions/record_ids` 全部行内容相同；
  - 副本检查前后同样一致；
  - 非 Durable 的 SQLite 文件：退出 1（`not a Durable database`），文件字节不变，未创建 `durable_schema`；
  - 缺库、缺任务：退出 1 且不创建任何文件；缺参数：退出 2；
  - **合法 delta 正常应用**（注入一条 `["s",["version"],99]` → inspect 读出 `version: 99`）；**非法 op**（Chord 未定义的 `zz`）→ 退出 1 且不打印错误台账；
  - 旧版（v1）台账文档按缺字段为空读取，台账定义另带 `migrate`。

## 6. 真实 DeepSeek smoke（AC-10）

每次运行独立记录：**被测 SHA 是该次运行时工作区的实现提交**，各次的绝对 DB 路径、requestId 与实际标识互不相同（同名 ID `1/14/21/26/28` 只说明库结构相同，不表示同一次运行）。

| # | 被测实现提交 | 绝对 DB 路径 | requestId | 子工具白名单 | 工具结果 entry / call | delegate op | review op | 结果 |
|---|---|---|---|---|---|---|---|---|
| smoke1（作废） | `c6fcd6be9279176a001c7d1d2545b01bca27a2cd` | `C:/Users/l/.workbuddy-ai/issue9-work/multiagent-smoke.sqlite` | `multiagent-smoke-1` | `text_stats` | entry 26 / `call_00_cPpGGch8tNmQ7ggLLsOZ7399`（`text="MATERIAL"`, count=1，**误验收**） | — | — | 已作废（见下） |
| smoke3 | `321dc5f45b1fa659b1fdda5292dbc93c7fe32994` | `…/multiagent-smoke3.sqlite` | `multiagent-smoke-3` | `text_stats, text_check` | entry 26 / `call_00_d3WIELqu4dq7VRAICe3Y9269`（chars=41, count=2） | `delegate:12:call_00_l29wjVahqU1xiy4B6qGX5325` | `review:36:call_00_HTZnIEWf8puDJxjzHs6p4025` | accepted |
| smoke4 | `1bcddc54e1c5d090fedb8f49898f21dec903b73b` | `…/multiagent-smoke4.sqlite` | `multiagent-smoke-4` | `text_stats, text_check` | entry 26 / `call_00_twrCOisUpegCNlNWgK5K8393` | `delegate:12:call_00_My16HqMZB4t1qwQBBcL64500` | `review:36:call_00_ZrdpEvBKzt9UpBHpugKJ2443` | accepted |
| smoke5 | `bb544b1f3bf46fc8a3416097a1a72ded76c4c900` | `…/multiagent-smoke5.sqlite` | `multiagent-smoke-5` | `text_stats` | entry 26 / `call_00_EFsnEnDx9sYfvFLCeSQ47497` | `delegate:12:call_00_Rfg0ehv8y3n9pCJr6EsN7216` | `review:36:call_00_MJstmlEwilC7ZyT9Ol234894` | accepted |
| **smoke6（本轮）** | `202005f750b06dd507a52acc86ce3db5621274bb` | `C:/Users/l/.workbuddy-ai/issue9-work/multiagent-smoke6.sqlite` | `multiagent-smoke-6` | `text_stats` | entry 26 / `call_00_CnbswNXfgLWBJKIjEYCh2872`（chars=41, count=2, error=false） | `delegate:12:call_00_Ua4iL1PyYGQbNIlo9qep3416` | `review:40:call_00_25rRWjS1RvZs4zsWsXN10026` | accepted |

smoke6 命令与输出（末尾两行为程序侧校验）：

```
DEEPSEEK_API_KEY=…（本机已有配置，未出现在命令/日志/库中）
npm run multiagent:probe -- --provider deepseek \
  --db C:/Users/l/.workbuddy-ai/issue9-work/multiagent-smoke6.sqlite \
  --request-id multiagent-smoke-6
…
── prompts verified: main.md and sub.md are the installed instructions ──
── verified: entry 26 counted MATERIAL in the material (count=2) ──
```

smoke6 的只读 inspect（`multiagent:inspect --db <同一库> --task-id task-smoke`）：

```
task: task-smoke
status: accepted
version: 2
main conversation: 1
child conversation: 14
model: {"provider":"deepseek","modelId":"deepseek-flash"}
child tools: text_stats
current round: 1

round 1 (initial) requestId=multiagent-round:task-smoke:1
  submissionId: 21
  answerEntryId: 28
  evidence entry=26 kind=pi.tool-result tool=text_stats byTask=25 call=call_00_CnbswNXfgLWBJKIjEYCh2872 error=false truncated=false
  evidence entry=28 kind=pi.assistant tool=- byTask=- call=- error=false truncated=false

review round 1: accept -> accepted (from awaiting_review) op=review:40:call_00_25rRWjS1RvZs4zsWsXN10026
event running -> awaiting_review round=1 op=delegate:12:call_00_Ua4iL1PyYGQbNIlo9qep3416
event awaiting_review -> accepted round=1 op=review:40:call_00_25rRWjS1RvZs4zsWsXN10026
operation delegate:12:call_00_Ua4iL1PyYGQbNIlo9qep3416 kind=delegate task=12 call=… round=1
operation review:40:call_00_25rRWjS1RvZs4zsWsXN10026 kind=review task=40 call=… round=1 decision=accept
```

**历史失败记录（保留）**：smoke1（首版代码 `c6fcd6b`）中，子 Agent 把任务描述里的「文本 MATERIAL」当字面量，`text_stats` 收到 `text="MATERIAL"`、`count=1`，主模型仍 accept。修复：任务文本显式给出素材并要求传完整素材 + CLI 增加程序侧验收校验（`marker`、`text` 长度、`count`、`chars`）。该次运行不再作为 AC-10 证据。

## 7. CLI 行为核验

| 命令 | 退出码 | 结果 |
|---|---|---|
| `multiagent:probe --help` | 0 | 打印任务输入、脚本化验证入口、限制、退出码 |
| `multiagent:probe --provider deepseek`（无 key） | 2 | `configuration: DEEPSEEK_API_KEY is not set…` |
| `multiagent:inspect`（缺 `--task-id`） | 2 | `configuration: --task-id <task id> is required` |
| `multiagent:inspect --db <不存在>` | 1 | `database not found: …`（不创建空库） |
| `multiagent:probe --provider deepseek`（真实运行） | 0 | §6；`accepted` + 证据校验 + 提示校验通过 |

## 8. 未执行的验证 / 限制

- **真实运行**：smoke1 误验收（作废）+ smoke3/4/5/6 四次成功（每次的记录见 §6，各次的 SHA/DB/requestId/标识独立）；**仅 deepseek-flash、单任务**。
- **真实分支只覆盖 accept**：返工/失败/取消/并发由确定性测试（faux）覆盖，未用真实模型演练。
- 压缩测试收窄 `compaction.keepRecentTokens` 为 48（默认 20000）；默认阈值下未另行实测。
- **未实测**：并行/递归委派、后台 Agent（Issue 非目标）；多主会话共享子会话；跨机器恢复；超 500 页证据（会显式报错）。
- **`pauseMs` 与 `beforeSubmit`/`afterOutcome` 是演练钩子**：`pauseMs` 仅延迟执行（上限 60 s），两个屏障仅在提供时被 await；三者都不改变结果、不写业务数据。
- 并发测试中"谁先拿到执行权"不确定（两个调用在同一消息内），断言因此只固定"恰好一个赢家"的事实，不固定是哪一个。
- Windows 上 SIGKILL 表现为退出码 1（非 137）；恢复语义以库状态断言。

## 9. 提交范围

`git diff --name-only <base>...HEAD` 仅覆盖 Issue 允许范围：`src/multiagent/`、`prompts/multiagent/`、`test/`（含 `test/helpers/`）、`package.json`（3 个脚本）、`src/runtime.ts`（仅新增 3 个可选参数）、`intent-spec/TASK-003-multiagent-lifecycle.md`、本报告。未触碰 Durable 核心、Vacation demo、article/notion 入口；未提交数据库、日志、凭据、`node_modules`；`data/` 下的临时探针已在提交前删除。

## 10. 二轮审阅的逐条回应（本轮实现）

1. **P1 操作绑定与轮次/状态占用不在同一 commit** → `ledger.ts` 新增 `claimRound`：在**一个 commit** 内完成"检查 + 预留轮次 + 写绑定 + 写轮次记录 + 占用执行权（`activeOpKey`/`activeRound`）"，并推进 `currentRound`；`releaseRound` 只允许持有者释放；`recordTransition` 在离开轮次时清空占用。`delegate`/`revise` 都改为"先校验再 claim"，第二个不同操作被拒（`ExecutionRightError`）。测试：`multiagent-concurrency.test.ts` 并发委派/并发返工各 1 项。
2. **P1 review 轮次可选** → `task_review` 的 `round` 改为**必填**；同一 commit 内校验 `activeOpKey`（执行中的轮次不可审阅）、状态、目标轮次；陈旧请求被拒。测试：`multiagent.test.ts` 陈旧审阅；`multiagent-concurrency.test.ts` 同消息两次 accept。
3. **P1 取消无持久化屏障** → 台账新增 `cancelRequested`；`task_cancel` 先落意图（阻止新 submit），再 abort 子会话，再在 commit 内扫描子会话任务确认无活跃，最后落 `cancelled`；**`failRound` 检查 `cancelRequested`**，取消期间不写 failed；`runDelegationRound` 在 Stage 0、Stage 2（submit 前）与 outcome commit 三处检查意图；完成阶段若发现任务是其它终态，如实报告 `cancel did not apply`（`ok:false`）。测试：`multiagent-cancel.test.ts`（返工在途并发取消）、`multiagent-concurrency.test.ts`（委派与取消同消息；全局中止后不算失败并可随后取消）。
4. **P1 已结算轮次的原操作重放** → `runDelegationRound` Stage 0 先查"该 requestId 的轮次是否已结算"，是则直接返回**持久化收据**（submission/answer entry/answer text/evidence），不再 submit、不再 transition；outcome commit 前校验 `activeOpKey`，权利已失则不改任何状态。测试：恢复边界 6（version 与 events 完全不变）。
5. **P2 inspect 手写 delta 解释错误** → 删除自写 applier，改用 **Chord 公开 `apply`**；`["r", value]` 等所有合法 op 由定义方处理。测试：注入合法 `s` op 能正确读出；非法 op 退出 1。
6. **P1 AC-07 缺 pre-submit 边界** → 在 `runDelegationRound` 的意图 commit 之后、`handle.submit` 之前设置 **`beforeSubmit` 验证屏障**；恢复边界 5 在该屏障 kill，并断言 kill 时该 requestId 的 submission **0 条**、重启后**恰 1 条**；另加边界 6（post-outcome 收据）与边界 7（省略 `taskId` 的派生 ID 稳定性）。

## 11. 三轮审阅的逐条回应（本轮实现）

1. **P1 取消与提交仍分离；Stage1 缺检查** → 引入**执行权协议**：轮次从 claim 起一直持有 `activeOpKey`（记录持有者 `activeToolTaskId`），直到 outcome/fail commit 才交回；`task_cancel` 的完成阶段**只在没有轮次持有执行权、且子会话无活跃任务时才落终态**，否则保留意图并报告 `cancel pending`（工具内做有界重试）；Stage 0/Stage 1 与 submit 前检查都在**各自的 commit 内**校验取消意图与执行权，任何被拒出口都**交回执行权**；`failRound` 遇到取消意图时**让位并交回执行权**（否则 abort 产生的 unanswered 会把任务写成 failed）；被中止（`unanswered/aborted`）的提交同样交回执行权。持有者任务已 terminal 时该权利视为陈旧并回收（避免永久阻塞）。测试：`multiagent-cancel-admission.test.ts` 两项（首轮/返工各一）。
2. **P1 `task_revise` 无目标轮次** → `round` 改为**必填**，在 claim 的同一个 commit 内校验 `args.round === currentRound`，陈旧反馈被拒且**不消耗返工额度、不改动 rounds/operations/version**；已绑定操作的重放仍返回原绑定。测试：`multiagent.test.ts`「refuses feedback aimed at a round that has already moved on」；并发返工的败者现在也以"陈旧/已被占用"被拒（`multiagent-concurrency.test.ts`）。
3. **P2 返工 pre-submit 未实测** → 新增恢复边界 8：先完成首轮并合法发起返工，在**round 2 的 `beforeSubmit` 屏障**kill，直接只读确认 `status=revising`、round 2 记录（含 feedback、opKey）存在、round 2 submission **0 条**；重启后 round 2 submission **恰 1 条**、无 round 3、round 1 证据与审阅记录不变。原首轮 pre-submit 测试保留。
4. **报告口径** → 本报告与本 PR 正文改用**完整 SHA**，并区分实现提交（`1bcddc5…`）与其后的清理提交（`3baeccf…`）；本轮实现提交的完整 SHA 见 PR 正文，不再使用"见 HEAD"。

## 12. 四轮审阅的逐条回应（本轮实现）

1. **P2 准入测试没有握手、屏障不在闸口之后** → ① 把取消意图的检查**收敛到唯一的准入闸口**（Stage 2 第二次准入，紧邻 `handle.submit`）：claim、Stage 0、Stage 1、第一次准入只查执行权与终态，因此持有执行权的轮次**总能到达该闸口**，不会因为并发的取消而在更早阶段被拒绝（这也修掉了"测试可能只证明取消先到"的漏洞）；② `beforeSubmit` 屏障移到闸口**之前**，正好覆盖"闸口已过、提交未发"的窗口；③ 测试改为**显式 enter/release 握手**：先等 `entered` 触发（证明真的进入了窗口），在 park 期间断言执行权被持有、意图已记录、状态非终态、该轮 submission 为 0，并断言取消的返回是 **`cancel pending`**（不再把工具返回与取消终态混称完成），随后释放并断言**仍然 0 条 submission**，最后重试取消得到终态 `cancelled`；首轮与返工各一项。④ 每个拒绝出口（Stage 1、两次准入、failRound、abort、reservation 缺失）都交回执行权，保证 pending 的取消最终能关闭。
2. **P2 AC-10 证据归属** → §6 改为**逐次分列**：每次运行的被测 SHA、绝对 DB、requestId、子工具白名单、工具结果 entry/call、delegate op、review op 全部独立记录；smoke4/5/6 的 call/op 标识互不相同（已核对）；smoke1 的误验收保留为历史失败记录。本轮以 **smoke6**（在 `202005f…` 上运行）作为 AC-10 证据。
3. **计数同步** → 全文改为 125 tests / 13 文件、八个恢复边界、四次成功运行；历史条目注明其所属提交。
