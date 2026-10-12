# TASK-003：主子 Agent 协作闭环（独立子会话、审阅返工与持久化任务台账）

本 spec 与 Issue #9 对应，是该 Issue 的第一版实施合同。Issue 为唯一权威；本文档记录实现结构、状态机与验收对照，出现分歧以 Issue 为准。

## 目标

在 `durable-cli-probe` 中实现最小主/子 Agent 协作闭环：主 Agent 规划、分发任务与允许的工具；子 Agent 在独立会话与独立上下文中执行；主 Agent 依据**程序提取的结果与工具证据**决定返工或验收。

用户已确认的边界：主子同 provider/model（无模型路由）；子 Agent 必须拥有独立 Conversation；返回最终结果＋逐工具结构化证据与可追溯 ID；一个业务任务一个子会话、返工复用、新任务全新会话；同一 SQLite 同时保存底座记录与应用任务台账；台账使用 Durable Document。

## 实现结构（均在 `durable-cli-probe` 内）

| 文件 | 职责 |
|---|---|
| `src/multiagent/ledger.ts` | 任务台账（conversation-scoped `defineDocFamily`，每任务一文档）、状态机与合法转换校验、**操作绑定**（`<kind>:<toolTaskId>:<callId>` → round/requestId/decision）、**轮次预留与执行权**（`claimRound`/`releaseRound`/`activeOpKey`）、**取消意图**（`cancelRequested`）、**全量状态转换事件**、版本号、轮次/审阅事件类型 |
| `src/multiagent/child-tools.ts` | 子侧本地无副作用工具（`text_stats` / `text_check`）与 `ChildTools` 扩展 |
| `src/multiagent/delegation.ts` | 单轮委派执行封装（task-owned 子会话、显式 configure、稳定 requestId、意图先行提交、程序证据提取） |
| `src/multiagent/tools.ts` | 主侧六个管理工具（`task_delegate` / `task_revise` / `task_review` / `task_cancel` / `task_status` / `task_evidence`），全部 `replay: "safe"` + `executionMode: "parallel"` |
| `src/multiagent/evidence.ts` | 证据提取：从真实 Entry 记录按轮次边界提取工具证据（entryId / byTaskId / toolCallId / toolName / isError / 参数概要 / 结果摘录 / 截断标识） |
| `src/multiagent/cli-multiagent.ts` | `multiagent:probe` 入口（真实运行 + 恢复 kill 点） |
| `src/multiagent/cli-multiagent-inspect.ts` | `multiagent:inspect` 只读入口（不建库、不起任务、不调模型） |
| `prompts/multiagent/main.md`、`prompts/multiagent/sub.md` | 主子运行时指令 |
| `test/multiagent*.test.ts` | AC-01~08 确定性证明 + AC-07 跨进程恢复（`test/helpers/multiagent-runner.ts` 为子进程 runner） |

不改 Durable 核心、Vacation demo、article/notion 入口；不自建模型循环。

## 状态机

```
running ──► awaiting_review ──► accepted           （终态）
   │              │  └────────► revising ──► awaiting_review（上限 2 次返工）
   │              └───────────► failed / cancelled  （终态）
   └──────────────────────────► failed / cancelled
```

- 初始轮：`running` → 提交子任务 → `awaiting_review`。
- 拒绝：`awaiting_review` → `revising`（事件入台账）；返工完成后回 `awaiting_review`。
- 验收：`awaiting_review` → `accepted`。
- 取消：任意非终态 → `cancelled`（先 abort 子会话、确认子会话无活跃任务，再落终态）。
- 第三轮仍被拒绝：`awaiting_review` → `failed`（`revision_limit`），不自动接受。
- 技术错误（提交失败、未 done、**空最终答案**）直接 `failed`，不包装成答案。
- 终态后一切执行/返工/取消被程序拒绝；历史与证据仍可读。
- 每次转换追加 `events` 条目并 `version += 1`；同一 commit 内完成"检查 + 写入"。

## 关键设计决策

1. **子会话创建用 foreground task-owned 模式**（`tx.createConversation({ ownership: { kind: "task", taskId } })`），不用 fork。返工跨工具 Task 复用经实测验证：新工具 Task 可用 `tx.scanConversations({ ownerConversationId })` 找回原子会话并继续 submit（探针证据见 PR 正文）。
2. **授权边界是 child 的 `tools` 集合**（configure 显式设置），`modelTools` 只影响可见性；管理扩展从 child 移除，`ChildTools` 显式加入——子既看不到也调不到委派/审阅工具。
3. **意图先行 + 操作绑定 + 轮次预留**：每个工具调用以 `<kind>:<toolTaskId>:<callId>` 绑定到轮次/决定；**绑定、轮次记录与执行权（`activeOpKey`）在同一个 commit 内预留**，因此并发调用只有一个赢家，第二个不同操作被拒。同一调用的重放恢复原轮次与原 requestId；**已结算轮次的重放直接返回持久化收据，不再 submit、不再改状态**。业务任务 ID 由工具任务标识稳定派生（`task-${api.taskId}`），省略 `taskId` 也不受重放影响。
   - 每轮的写入都重新校验执行权；权利被取走（取消或更晚的轮次）时，迟到的轮次不改变任何状态。
   - `beforeSubmit` / `afterOutcome` 是可选**验证屏障**（供中断演练），不改变业务行为。
4. **证据只来自库**：程序从子会话 Entry/Task/Submission 提取（含 `byTaskId`、`toolCallId`、`data.diagnostics`），参数摘要按定义脱敏（长字符串 → `<string:N>`），分页必须完整否则显式失败；最终答案取 `settled.answer`，空答案即失败。模型从不自述 ID 或成功状态。
5. **台账事件显式持久化**在 Document 内（`events`/`reviews`/`operations`），不依赖默认 revision 策略。
6. **只读取证不走 Harness**：`multiagent:inspect` 用裸 SQLite `readOnly` 连接 + **Chord 公开 `apply`** 重建文档值，不迁移、不重整 running 任务、不创建 root；遇到非法 op 显式失败。
7. **取消是持久化屏障 + 与提交准入共享执行权**：`task_cancel` 先写取消意图，再 abort 子会话，**只在没有任何轮次持有执行权且子会话无活跃任务时**才落 `cancelled`；否则保留意图并报告 `cancel pending`（工具内有界重试）。执行权从 claim 一直持有到该轮 outcome/fail commit；持有者任务已 terminal 时视为陈旧并回收；`failRound` 遇取消意图时让位并交回执行权；被中止的提交不算失败。
   - **取消意图同时是"新工作屏障"与"提交闸口"**：`task_delegate`/`task_revise` 在**新 claim 之前**（已绑定重放分支之后）拒绝取消期间的新操作（不写任何东西）；提交侧由**唯一的闸口**（Stage 2 第二次准入，紧邻 `handle.submit`）检查意图与执行权。Stage 0/1 保留执行权与终态守卫。
   - **两个验证屏障**（仅测试注入）：`beforeSubmit`（执行权检查之后、取消闸口之前）与 `atSubmit`（取消闸口之后、提交之前，即评审所指的真正间隙）。
8. **审阅与返工都必须指名目标轮次**：`task_review.round`、`task_revise.round` 均为必填，且在 claim/写入的同一个 commit 内与 `currentRound` 核对；陈旧请求被拒且不改动任何记录（不消耗返工额度）。

## 验收对照（AC-01 ~ AC-10）

| AC | 覆盖方式 |
|---|---|
| 01 | `multiagent.test.ts`：主子不同 conversation id、子无 parent、返工同子会话、新任务新子会话 |
| 02 | provider 实际请求捕获（faux `FauxResponseFactory`）：主哨兵不进子请求、分发材料可见 |
| 03 | `conversation.agent()` 解析断言主/子工具集；未授权已注册工具与未知工具均被拒并留 error 证据 |
| 04 | ledger 证据与真实 entry 逐字段比对；轮次边界；截断标识；`task_evidence` 全文取回与三类越权拒绝 |
| 05 | 返工闭环 + 幂等 + 非法转换 + `revision_limit` → failed + **并发委派/并发返工各只有一个赢家** + **审阅与返工都必填目标轮次、陈旧请求被拒且不改动记录** |
| 06 | 终态后执行拒绝、历史可读、新任务新上下文、**取消屏障（含返工在途并发取消、全局中止、以及"取消完成后被 park 的轮次永不提交"的准入测试）** |
| 07 | 真实子进程 SIGKILL **八个边界**（子会话建立/提交在途、awaiting_review 未审阅、返工意图已落账但提交在途、本地安全工具执行中、首轮 **pre-submit 屏障**、**返工 pre-submit 屏障**、**post-outcome 收据重放**、**省略 taskId 的派生 ID 稳定性**）+ inspect 前后字节与逻辑记录一致 |
| 08 | 主/子真实压缩（`conversation.compact`）：有效上下文改变、旧 Entry 仍可读、台账/证据仍准确 |
| 09 | `npm run typecheck` + `npm test`（125 passed，含 87 既有）+ 改动范围核对 |
| 10 | 真实 DeepSeek 主子同模型闭环一次成功，且 CLI 的程序侧验收校验通过（见验证报告 §6） |

## 交付命令

- `npm run multiagent:test` — 确定性 AC-01~08，无网络
- `npm run multiagent:probe -- --provider deepseek --db <绝对路径> --request-id <ID>` — 真实运行
- `npm run multiagent:inspect -- --db <同一路径> --task-id <业务任务ID>` — 只读取证（裸 SQLite，不启动 Harness）
- `npm run multiagent:probe -- --help` — 用法、入口、限制与退出码
