# TASK-003 验证报告：主子 Agent 协作闭环

本报告记录 Issue #9（TASK-003）的验收证据。只写实际执行过的命令与实际读回的库记录；未执行项单列。所有标识（conversation id、submission id、entry id、SHA、路径）均从本机日志或 SQLite 查询结果抄录。

## 1. 被测对象

| 项 | 值 |
|---|---|
| 被测 commit | 见 PR 正文（`workbuddy/issue-9-multiagent-lifecycle` 分支 HEAD） |
| 底座（本地 Pi checkout） | `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`（未改动） |
| 环境 | Windows，Node `v22.22.2`，`@notionhq/client` 5.27.0（既有依赖，本任务未用到） |
| 测试数 | `npm test`：**98 passed**（87 既有 + 11 新增） |
| typecheck | `tsc --noEmit` 退出 0 |

## 2. Ownership 实测（Issue 标注的未知边界）

Issue 要求实测「跨多个已结束工具 Task 的子会话复用」。探针结论（PR 正文附 isolation 探针输出）：

- 首轮委派的工具 Task A 创建 task-owned 子会话（`owner={conversationId, taskId:A}`，`parent=undefined`）；
- 返工由**另一个**工具 Task B 执行，经 `tx.scanConversations({ ownerConversationId })` 找回同一子会话，submit 成功 `settled=done/input`；
- 重开 harness 后 root、子会话、transcript（entries）全部可读，`inspect` 无活跃任务。

结论：**foreground task-owned ownership 满足合同**，无需后台模式、无需 fork、无需新建会话。

## 3. 自动化检查

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 通过 |
| `npm test` | 0 | 98 passed（87 既有 + 11 新增） |
| `npm run multiagent:test` | 0 | 与 `npm test` 中 multiagent 部分一致（AC-01~08 + 跨进程恢复） |

## 4. 确定性证据（AC-01 ~ AC-08）

| AC | 证明方式（测试文件） | 关键断言 |
|---|---|---|
| AC-01 | `multiagent.test.ts` | 主子 conversation id 不同；子 `parent=undefined`；返工命中同一子会话；新任务新子会话 |
| AC-02 | `multiagent.test.ts` / `multiagent-revision.test.ts` | faux `FauxResponseFactory` 捕获**实际 provider 请求**：主哨兵（`MAIN-SENTINEL-*`）请求存在；所有子请求不含哨兵；分发材料（`MATERIAL-*`）在子请求可见 |
| AC-03 | `multiagent.test.ts` | `conversation.agent()` 解析：主工具集恰为 5 个管理工具；子工具集恰为授权白名单；未授权已注册工具（`text_check`）与未知工具（`not_a_tool`）均被 harness 拒绝且留下 error 证据 |
| AC-04 | `multiagent.test.ts` / `multiagent-evidence.test.ts` | ledger 证据与真实 entry 逐字段一致（entryId/toolCallId/toolName/isError/byTaskId）；轮次边界不混入旧轮；截断标识 + `task_evidence` 取回全文；越权（他会话 entry）、非本轮证据、不存在 ID 三类拒绝各有可解释消息 |
| AC-05 | `multiagent-revision.test.ts` 端到端 + `multiagent.test.ts` 单元 | reject→返工→accept 闭环；三轮 reject → `failed(revision_limit)` 不冒充通过；终态/错误状态转换被 `assertTransition` 拒绝；重复同轮同决定幂等 |
| AC-06 | `multiagent.test.ts` | 终态（accepted）后 `task_revise` 被程序拒绝（`not revisable`）；历史与 reviews 保留；新任务得新子会话 |
| AC-07 | `multiagent-recovery.test.ts` | 真实子进程 SIGKILL 两个边界（见 §5） |
| AC-08 | `multiagent-compaction.test.ts` | 主/子各自 `conversation.compact`：有效上下文消息数 5→2 且含摘要、被压缩原文（`count it`）从 context 消失；旧 entry 仍可读；台账/审阅/证据引用不变 |

## 5. 跨进程恢复（AC-07）细节

测试用 `test/helpers/multiagent-runner.ts` 作为真实子进程，边界点在**模型请求路径上**触发 SIGKILL（非优雅关闭；Windows 上表现为退出码 1，库状态证实为 unclean stop）。

**边界 1 —— 意图已提交、submission in flight**（kill 点：子会话首次请求，即子会话已创建、round-1 submission `placed`）：

- kill 后库状态：1 个 ledger 文档、1 个子会话、`multiagent-round:task-smoke:1` 一条 submission（`placed`，无 tool-result）；
- 重启后完成：`status=awaiting_review`、rounds=1、子会话仍 1 个、该 requestId 的 submission 仍 1 条且 `done`；
- 子会话 transcript 中 tool-result entry 恰 1 条——中断未留结果，重放精确执行一次（`replay: "safe"` 工具的实际重放行为，非完成后 reopen）。

**边界 2 —— round settled、未 review**（kill 点：主模型收到 delegate tool-result，即 `awaiting_review` 之后、review 之前）：

- kill 后：`status=awaiting_review`、rounds=1、reviews=0；
- 重启后 review：`status=accepted`、rounds 仍 1、子会话不变、reviews 恰 1 条（round 1 / accept）。

## 6. 真实 DeepSeek smoke（AC-10）

```
DEEPSEEK_API_KEY=…（本机已有配置，未出现在命令/日志/库中）
npm run multiagent:probe -- --provider deepseek \
  --db C:/Users/l/.workbuddy-ai/issue9-work/multiagent-smoke.sqlite \
  --request-id multiagent-smoke-1
```

退出码 0。`multiagent:inspect -- --db <同一库> --task-id task-smoke` 读回（原文摘录）：

```
task: task-smoke
status: accepted
main conversation: 1
child conversation: 14
model: {"provider":"deepseek","modelId":"deepseek-flash"}
child tools: text_stats
current round: 1

round 1 (initial) requestId=multiagent-round:task-smoke:1
  task: 统计文本 MATERIAL 中 MATERIAL 的出现次数，并说明是否 found。
  submissionId: 21
  answerEntryId: 28
  evidence entry=26 kind=pi.tool-result tool=text_stats byTask=25 error=false truncated=false
  evidence entry=28 kind=pi.assistant tool=- byTask=- error=false truncated=false

review round 1: accept -> accepted (from awaiting_review)
  reason=text_stats 工具成功执行（entry=26，对文本 "MATERIAL" 以 marker="MATERIAL" 统计，返回 count=1），
  答案与工具证据一致，也正确说明了 found=true。
```

主模型最终结论文本还指出：子 Agent 把任务描述中的「文本 MATERIAL」理解成了字面量 `MATERIAL`（原始素材 `MATERIAL-SMOKE- alpha beta MATERIAL gamma` 中 MATERIAL 实际出现 2 次）。这与库证据一致（entry 26 的实际参数即 `text="MATERIAL"`），是真实模型行为的诚实观察，未修改任何数据。

- 返工分支由 AC-05 的确定性测试保证，**未要求真实模型伪造拒绝**。
- 凭据不可用时 probe 以退出码 2 明确阻塞（实测：`DEEPSEEK_API_KEY` 未设置 → `configuration: DEEPSEEK_API_KEY is not set`，exit 2）。

## 7. CLI 行为核验

| 命令 | 退出码 | 结果 |
|---|---|---|
| `multiagent:probe --help` | 0 | 打印任务输入、脚本化验证入口、限制、退出码 |
| `multiagent:probe --provider deepseek`（无 key） | 2 | `configuration: DEEPSEEK_API_KEY is not set…` |
| `multiagent:inspect`（缺 `--task-id`） | 2 | `configuration: --task-id <task id> is required` |
| `multiagent:inspect --db <不存在>` | 1 | `database not found: …`（不创建空库） |
| `multiagent:inspect`（真实 smoke 库） | 0 | §6 输出；证据引用逐条解析成功 |

## 8. 未执行的验证 / 限制

- **仅一次真实运行、一个模型**（deepseek-flash）、一个任务；未测其他 provider/模型/任务。
- **真实分支只覆盖 accept**：返工与失败路径由确定性测试（faux 脚本）覆盖，未用真实模型演练。
- **压缩测试收窄了策略阈值**：`compaction.keepRecentTokens` 设为 48（默认 20000），使短确定性 transcript 触发真实压缩；默认阈值下的压缩行为未另行实测。
- **未实测并行/递归委派、后台 Agent**（Issue 非目标）。
- Windows 上 SIGKILL 表现为退出码 1 而非 137；恢复语义以库状态断言，不依赖信号编号。
- 恢复测试的 kill 点选择在模型请求路径上（确定性执行中），不是随机的 wall-clock 中断。

## 9. 提交范围

`git diff --name-only <base>...HEAD` 仅覆盖 Issue 允许范围：`src/multiagent/`、`prompts/multiagent/`、`test/`（含 `test/helpers/`）、`package.json`（新增 3 个脚本）、`src/runtime.ts`（仅新增 `fauxRouter` / `registryExtensions` / `settings` 三个可选参数）、`intent-spec/TASK-003-multiagent-lifecycle.md`、本报告。未触碰 Durable 核心、Vacation demo、article/notion 入口；未提交数据库、日志、凭据或 `node_modules`。`data/` 下的临时探针脚本已在提交前删除。
