# TASK-003：主子 Agent 协作闭环（独立子会话、审阅返工与持久化任务台账）

本 spec 与 Issue #9 对应，是该 Issue 的第一版实施合同。Issue 为唯一权威；本文档记录实现结构、状态机与验收对照，出现分歧以 Issue 为准。

## 目标

在 `durable-cli-probe` 中实现最小主/子 Agent 协作闭环：主 Agent 规划、分发任务与允许的工具；子 Agent 在独立会话与独立上下文中执行；主 Agent 依据**程序提取的结果与工具证据**决定返工或验收。

用户已确认的边界：主子同 provider/model（无模型路由）；子 Agent 必须拥有独立 Conversation；返回最终结果＋逐工具结构化证据与可追溯 ID；一个业务任务一个子会话、返工复用、新任务全新会话；同一 SQLite 同时保存底座记录与应用任务台账；台账使用 Durable Document。

## 实现结构（均在 `durable-cli-probe` 内）

| 文件 | 职责 |
|---|---|
| `src/multiagent/ledger.ts` | 任务台账（conversation-scoped `defineDocFamily`，每任务一文档）、状态机与合法转换校验、轮次/审阅事件类型 |
| `src/multiagent/child-tools.ts` | 子侧本地无副作用工具（`text_stats` / `text_check`）与 `ChildTools` 扩展 |
| `src/multiagent/delegation.ts` | 单轮委派执行封装（task-owned 子会话、显式 configure、稳定 requestId、意图先行提交、程序证据提取） |
| `src/multiagent/tools.ts` | 主侧五个管理工具（`task_delegate` / `task_revise` / `task_review` / `task_status` / `task_evidence`） |
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
- 第三轮仍被拒绝：`awaiting_review` → `failed`（`revision_limit`），不自动接受。
- 技术错误（提交失败、未 done）直接 `failed`，不包装成答案。
- 终态后一切执行/返工被程序拒绝；历史与证据仍可读。

## 关键设计决策

1. **子会话创建用 foreground task-owned 模式**（`tx.createConversation({ ownership: { kind: "task", taskId } })`），不用 fork。返工跨工具 Task 复用经实测验证：新工具 Task 可用 `tx.scanConversations({ ownerConversationId })` 找回原子会话并继续 submit（探针证据见 PR 正文）。
2. **授权边界是 child 的 `tools` 集合**（configure 显式设置），`modelTools` 只影响可见性；管理扩展从 child 移除，`ChildTools` 显式加入——子既看不到也调不到委派/审阅工具。
3. **意图先行**：每轮的 round 记录（含稳定 requestId）在提交 submission 之前落账，崩溃恢复后重放同轮不会新增轮次或重复提交；submission 经稳定 requestId 天然去重。
4. **证据只来自库**：程序从子会话 Entry/Task/Submission 提取，模型从不自述 ID 或成功状态。
5. **台账事件显式持久化**在 Document 内，不依赖默认 revision 策略。

## 验收对照（AC-01 ~ AC-10）

| AC | 覆盖方式 |
|---|---|
| 01 | `multiagent.test.ts`：主子不同 conversation id、子无 parent、返工同子会话、新任务新子会话 |
| 02 | provider 实际请求捕获（faux `FauxResponseFactory`）：主哨兵不进子请求、分发材料可见 |
| 03 | `conversation.agent()` 解析断言主/子工具集；未授权已注册工具与未知工具均被拒并留 error 证据 |
| 04 | ledger 证据与真实 entry 逐字段比对；轮次边界；截断标识；`task_evidence` 全文取回与三类越权拒绝 |
| 05 | 返工闭环 + 幂等 + 非法转换 + `revision_limit` → failed（端到端与单元两层） |
| 06 | 终态后执行拒绝、历史可读、新任务新上下文 |
| 07 | 真实子进程 SIGKILL 两个边界（submission in flight / awaiting_review 未 review）+ 工具重放唯一结果 |
| 08 | 主/子真实压缩（`conversation.compact`）：有效上下文改变、旧 Entry 仍可读、台账/证据仍准确 |
| 09 | `npm run typecheck` + `npm test`（98 passed，含 87 既有）+ 改动范围核对 |
| 10 | 真实 DeepSeek 主子同模型闭环一次成功（见验证报告的取证记录） |

## 交付命令

- `npm run multiagent:test` — 确定性 AC-01~08，无网络
- `npm run multiagent:probe -- --provider deepseek --db <绝对路径> --request-id <ID>` — 真实运行
- `npm run multiagent:inspect -- --db <同一路径> --task-id <业务任务ID>` — 只读取证
- `npm run multiagent:probe -- --help` — 用法、入口、限制与退出码
