# TASK-003 验证报告：主子 Agent 协作闭环

本报告记录 Issue #9（TASK-003）的验收证据，以及 PR #10 首轮审阅（commit `c6fcd6b`）后逐条修复的结果。所有标识（conversation / submission / entry / task id、SHA、路径）均从本机 SQLite 查询结果或实际命令输出抄录。

## 0. 首轮审阅后的修订摘要

首轮审阅提出 6 项 P1、2 项 P2 与一批测试/报告修正。逐条修复如下（每条给出改动位置与验证方式）：

| 审阅项 | 修复 | 验证 |
|---|---|---|
| P1 返工重放递增轮次 | `ledger.ts` 引入操作绑定 `OperationBinding`（`<kind>:<toolTaskId>:<callId>` → round/requestId/decision）；`delegation.ts` 的轮次号由绑定提供，重放不再 `currentRound+1` | `multiagent-recovery.test.ts` 边界 3：kill 于返工提交在途，重启后仍为 round 2，且不存在 round 3 的 submission |
| P1 省略 taskId 的重放生成新 ID | 业务任务 ID 改为稳定派生 `task-${api.taskId}`（工具任务标识），不再用 `Date.now()` | `multiagent.test.ts` 断言操作绑定与任务 ID 稳定；恢复测试断言同一任务 |
| P1 delegate 无前置生命周期检查 | 委派前在事务内检查：终态拒绝、已有轮次拒绝（"already delegated"）；绑定记录先于提交 | `multiagent.test.ts`「refuses a second delegate…」 |
| P1 review 无轮次/版本绑定 | `task_review` 增加 `round` 参数（期望轮次）；检查与写入在同一 commit 内完成；操作绑定保证同操作幂等 | `multiagent.test.ts`「refuses a stale review…」；`multiagent-cancel.test.ts`「two conflicting reviews…」（同消息两次 accept → 恰好 1 条事件） |
| P1 cancelled 未实现 | 新增第 6 个工具 `task_cancel`：abort 子会话（`ConversationHandle.abort`）→ 确认子会话无活跃任务 → 转 `cancelled`；`failRound` 遇到取消请求不再抢写 failed | `multiagent-cancel.test.ts` 3 项：返工在途时取消（revise 与 cancel 同消息并发）、取消后拒绝后续操作且新任务新子会话、子会话任务全 terminal |
| P1 父模型可见结果缺字段 | `tools.ts` 的报告行输出 `entry/kind/tool/byTask/call/error/truncated/args/diagnostics`；证据提取读取 `data.diagnostics` | `multiagent.test.ts` 在**捕获的主 provider 请求**中断言 `entry=`、`byTask=`、`call=`、`error=false`、`kind=pi.tool-result` |
| P1 inspect 非只读 | `cli-multiagent-inspect.ts` 重写为裸 SQLite `readOnly` 连接 + 文档 revision 重建（`s`/`d`/`r` 三类 op，遇到未知 op 直接失败）；不启动 Harness、不迁移、不建 root | `multiagent-inspect.test.ts`：中断库（含 running 任务）检查前后**文件字节与全部逻辑记录完全一致**；副本同样一致；非 Durable 库拒绝且不初始化；缺库/缺任务不创建任何文件；未知 delta op 显式失败 |
| P1 CLI 未审阅也 exit 0；smoke 误验收 | CLI 只在 `accepted` + 非空最终答案 + 程序侧证据校验通过时 exit 0；任务文本显式给出素材并要求 `text` 传完整素材；程序侧校验 `marker:"MATERIAL"`、`text` 长度=素材长度、`count=2`、`chars=41` | 见 §6：真实 DeepSeek 运行 exit 0 并打印 `── verified: entry 26 counted MATERIAL in the material (count=2) ──`；`awaiting_review` 现在是非成功退出 |
| P2 提示文件未加载 | CLI 读取 `prompts/multiagent/main.md` 作为主会话 instructions（`root.configure`）、`sub.md` 作为子会话 instructions；并在运行后校验两者确实进入 `pi.system` 的 `sections` | `multiagent-prompts.test.ts`；CLI 输出 `── prompts verified: main.md and sub.md are the installed instructions ──` |
| P2 子工具 structuredOutput 无 schema | `child-tools.ts` 用 `Type.Object` 声明参数与 `structuredOutputSchema`；去掉 `parameters as never` | `multiagent.test.ts` 断言 `runtime.reports` 为空（无契约违规报告） |
| 测试修正：AC-02 循环论证 | 子请求身份改由**子指令标记**（`SUBAGENT-INSTRUCTION-MARKER-*`，位于 `pi.system` 的 `sections`）判定，与"不含哨兵"无关；并显式断言 beta 的子请求不含 alpha 材料与 alpha 子答案 | `multiagent.test.ts`「isolates the main context…」 |
| 测试修正：beta 脚本污染 | 子回答改为由本轮任务文本派生（`CHILD-ANSWER for <material>`），不再固定返回 alpha 材料 | 同上 |
| 测试修正：分页无覆盖 | 新增 151 次工具调用的一轮：断言 152 条证据（151 结果 + 1 答案）全部在报告中，且每个 entry id 可在子会话解析 | `multiagent.test.ts`「collects every tool result of a round across scan pages」；提取循环超过 500 页改为显式报错，不静默返回部分 |
| 测试修正：argsSummary 未脱敏 | `evidence.ts` 的 `redactArgs`：结构保留、超过 40 字符的字符串替换为 `<string:N>`、整体截断 400 字符 | 真实 smoke 的 `argsSummary` 即 `{text:<string:41>,marker:"MATERIAL"}` |
| 测试修正：answer 取值 | `extractRoundEvidence` 改为接收 `settled.answer` 并要求该 entry 在本轮范围内；空答案 → 轮次与任务 `failed(empty_answer)` | `multiagent.test.ts`「fails a round whose settled answer is empty」 |
| 台账缺口 | 台账新增 `operations`（含 toolTaskId/callId）、`events`（全量转换，含 opKey）、`version`（每次转换 +1）、`createdAt` 真实时间；`ReviewEvent` 带 `opKey` | `multiagent.test.ts` 断言 events 序列、operations 序列、`createdAt>0`、`version>0` |
| AC-07 边界不足 | 恢复边界从 2 个扩到 4 个：子会话建立/提交在途、awaiting_review 未审阅、**返工意图已落账但提交未完成**、**本地安全工具执行中中断**（`text_stats` 的 `pauseMs` 钩子 + 定时 SIGKILL） | `multiagent-recovery.test.ts` 4 项全过 |

## 1. 被测对象与环境

| 项 | 值 |
|---|---|
| 被测 commit | 见 PR #10 正文（`workbuddy/issue-9-multiagent-lifecycle` 分支 HEAD） |
| 底座（本地 Pi checkout） | `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`（未改动） |
| 环境 | Windows，Node `v22.22.2` |
| 自动化检查 | `npm run typecheck` 退出 0；`npm test` **114 passed**（87 既有 + 27 新增） |

## 2. Ownership 实测（Issue 标注的未知边界）

- 首轮委派的工具 Task A 创建 task-owned 子会话（`owner={conversationId, taskId:A}`，`parent=undefined`）；
- 返工由**另一个**工具 Task B 执行，经 `tx.scanConversations({ ownerConversationId })` 找回同一子会话并 submit 成功；
- 重开 harness 后 root、子会话、transcript 全部可读。

结论：**foreground task-owned ownership 满足合同**，无需后台模式、无需 fork、无需新建会话。

## 3. 确定性证据（AC-01 ~ AC-08）

| AC | 证明方式（测试文件） | 关键断言 |
|---|---|---|
| AC-01 | `multiagent.test.ts` | 主子 conversation id 不同；子 `parent=undefined`；返工命中同一子会话；新任务新子会话 |
| AC-02 | `multiagent.test.ts` | 子请求按**子指令标记**识别（独立身份）；子请求不含主哨兵；alpha 子请求不含 beta 材料；beta 子请求不含 alpha 材料与 alpha 子答案 |
| AC-03 | `multiagent.test.ts` | `conversation.agent()` 解析：主工具集恰为 6 个管理工具；子工具集恰为授权白名单；未授权已注册工具与未知工具均被拒且留 error 证据 |
| AC-04 | `multiagent.test.ts` / `multiagent-evidence.test.ts` | 证据与真实 entry 逐字段一致；主模型**实际请求**含 `entry/byTask/call/error/kind`；轮次边界；截断标识 + 全文取回；三类越权拒绝；151 次工具调用的跨页收集；空答案 → failed |
| AC-05 | `multiagent.test.ts` / `multiagent-cancel.test.ts` | reject→返工→accept 闭环；重复委派拒绝；陈旧审阅拒绝；同消息两次 accept 只落 1 条事件；三轮 reject → `failed(revision_limit)` |
| AC-06 | `multiagent.test.ts` / `multiagent-cancel.test.ts` | 终态拒绝后续操作；取消后无活跃子工作、历史可读、新任务新子会话 |
| AC-07 | `multiagent-recovery.test.ts` / `multiagent-inspect.test.ts` | 四个 unclean stop 边界 + inspect 前后字节/记录一致 |
| AC-08 | `multiagent-compaction.test.ts` | 主/子各自 `conversation.compact`：有效上下文消息数 5→2 且含摘要、被压缩原文从 context 消失；旧 entry 仍可读；台账/审阅/证据引用不变 |

## 4. 跨进程恢复（AC-07）细节

测试用 `test/helpers/multiagent-runner.ts` 作为真实子进程；Windows 上 SIGKILL 表现为退出码 1，库状态证实为 unclean stop。

| 边界 | kill 点 | 重启后断言 |
|---|---|---|
| 1 子会话建立、提交在途 | 子会话首次模型请求 | 1 个 ledger、1 个子会话、该 requestId 恰 1 条 submission（`done`）、rounds=1 |
| 2 round 已 settled 未审阅 | 主模型收到 delegate 结果 | review 落在**同一轮**：rounds=1、reviews=1、子会话不变 |
| 3 **返工意图已落账、提交在途** | 子会话收到返工任务 | 重放恢复 **round 2**：rounds=2、round2 submissionId 已填、round 2 submission 恰 1 条、**不存在 round 3 的 submission** |
| 4 **本地安全工具执行中** | 工具 `pauseMs` 睡眠期间（`tasks` 表中 `pi.tool` 为 `running`，无 tool-result） | 重放后 round 1 结算、tool-result **恰 1 条**、无 running 的 `pi.tool` |

## 5. 只读检查（inspect）

- 实现：裸 `node:sqlite` `readOnly` 连接 + 文档 revision 重建（`["s",path,value]`、`["d",path]`、`["r",value]`；未知 op → 失败退出 1），**不**打开 Harness、**不**迁移、**不**创建 root。
- 验证（`multiagent-inspect.test.ts`）：
  - 中断库（含 running 任务）检查前后：文件 SHA-256 相同、`conversations/entries/tasks/submissions/documents/document_revisions/record_ids` 全部行内容相同；
  - 副本检查前后同样一致；
  - 非 Durable 的 SQLite 文件：退出 1（`not a Durable database`），文件字节不变，且未创建 `durable_schema`；
  - 缺库、缺任务：退出 1 且不创建任何文件；缺参数：退出 2；
  - 旧版（v1）台账文档：读取时不报错（缺失字段按空处理），台账定义另带 `migrate` 供 Harness 路径补齐。

## 6. 真实 DeepSeek smoke（AC-10）

```
DEEPSEEK_API_KEY=…（本机已有配置，未出现在命令/日志/库中）
npm run multiagent:probe -- --provider deepseek \
  --db C:/Users/l/.workbuddy-ai/issue9-work/multiagent-smoke3.sqlite \
  --request-id multiagent-smoke-3
```

退出码 **0**，末尾打印 `── verified: entry 26 counted MATERIAL in the material (count=2) ──`。
`multiagent:inspect -- --db <同一库> --task-id task-smoke` 读回（原文摘录）：

```
task: task-smoke
status: accepted
version: 2
main conversation: 1
child conversation: 14
model: {"provider":"deepseek","modelId":"deepseek-flash"}
child tools: text_stats, text_check
current round: 1

round 1 (initial) requestId=multiagent-round:task-smoke:1
  task: 统计子串 "MATERIAL" 在下面素材中原样出现的次数…素材（原样，不要改动）：MATERIAL-SMOKE- alpha beta MATERIAL gamma…
  submissionId: 21
  answerEntryId: 28
  evidence entry=26 kind=pi.tool-result tool=text_stats byTask=25 call=call_00_d3WIELqu4dq7VRAICe3Y9269 error=false truncated=false
    args={text:<string:41>,marker:"MATERIAL"}
  evidence entry=28 kind=pi.assistant tool=- byTask=- call=- error=false truncated=false

review round 1: accept -> accepted (from awaiting_review) reason=text_stats 证据显示 text 参数为 41 字符（与完整素材长度一致），marker="MATERIAL"，count=2… op=review:36:call_00_HTZnIEWf8puDJxjzHs6p4025
event running -> awaiting_review round=1 op=delegate:12:call_00_l29wjVahqU1xiy4B6qGX5325
event awaiting_review -> accepted round=1 op=review:36:call_00_HTZnIEWf8puDJxjzHs6p4025
operation delegate:12:call_00_l29wjVahqU1xiy4B6qGX5325 kind=delegate task=12 call=… round=1
operation review:36:call_00_HTZnIEWf8puDJxjzHs6p4025 kind=review task=36 call=… round=1 decision=accept
```

主模型最终结论文本亦按素材逐项核对（41 字符 / 5 词 / count=2 / found=true）。

**首轮的误验收（已修复，保留记录）**：`multiagent-smoke.sqlite`（首版代码，`c6fcd6b`）中，子 Agent 把任务描述里的「文本 MATERIAL」当成了字面量，`text_stats` 收到 `text="MATERIAL"`、`count=1`，主模型仍然 accept。修复分两步：任务文本显式给出素材并要求 `text` 传完整素材；CLI 增加**程序侧验收校验**（`marker:"MATERIAL"` + `text` 长度=素材长度 + `count=2` + `chars=41`），不满足即退出 1。该旧库不再作为 AC-10 证据。

- 返工分支由 AC-05 确定性测试保证，**未要求真实模型伪造拒绝**。
- 凭据不可用时 probe 以退出码 2 阻塞（实测：`configuration: DEEPSEEK_API_KEY is not set`）。

## 7. CLI 行为核验

| 命令 | 退出码 | 结果 |
|---|---|---|
| `multiagent:probe --help` | 0 | 打印任务输入、脚本化验证入口、限制、退出码 |
| `multiagent:probe --provider deepseek`（无 key） | 2 | `configuration: DEEPSEEK_API_KEY is not set…` |
| `multiagent:inspect`（缺 `--task-id`） | 2 | `configuration: --task-id <task id> is required` |
| `multiagent:inspect --db <不存在>` | 1 | `database not found: …`（不创建空库） |
| `multiagent:probe --provider deepseek`（真实运行） | 0 | §6；`accepted` + 证据校验通过 + 提示已加载 |

## 8. 未执行的验证 / 限制

- **真实运行次数**：首版 1 次（误验收，已作废）+ 修复后 1 次成功；**仅 deepseek-flash、单任务**，未测其他 provider/模型/任务。
- **真实分支只覆盖 accept**：返工/失败/取消由确定性测试（faux 脚本）覆盖，未用真实模型演练。
- **压缩测试收窄了 `compaction.keepRecentTokens` 为 48**（默认 20000）以使短确定性 transcript 触发真实压缩；默认阈值下未另行实测。
- **未实测并行/递归委派、后台 Agent**（Issue 非目标）。
- **`pauseMs` 是中断演练钩子**：仅延迟执行，不改变结果、不写任何东西；上限 60 s。
- Windows 上 SIGKILL 表现为退出码 1（非 137）；恢复语义以库状态断言，不依赖信号编号。
- **未验证**：多个主会话共享同一子会话、跨机器恢复、超 500 页证据（会显式报错而非截断）。

## 9. 提交范围

`git diff --name-only <base>...HEAD` 仅覆盖 Issue 允许范围：`src/multiagent/`、`prompts/multiagent/`、`test/`（含 `test/helpers/`）、`package.json`（3 个脚本）、`src/runtime.ts`（仅新增 3 个可选参数）、`intent-spec/TASK-003-multiagent-lifecycle.md`、本报告。未触碰 Durable 核心、Vacation demo、article/notion 入口；未提交数据库、日志、凭据、`node_modules`；`data/` 下的临时探针已在提交前删除。
