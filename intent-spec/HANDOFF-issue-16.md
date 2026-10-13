# 交接文档：pi-durable / Issue #16 / PR #23

- 生成时间：2026-10-14
- 生成者：Claude（实施 Agent）
- 用途：转交给其他智能体，使其无需重新探查即可接手
- 性质：**操作性交接文档**，不是合同、不是验收标准。实施范围以 Issue #16 与
  `intent-spec/TASK-005.1-contracts.md` 为准；协作规则以 `intent-spec/WORKFLOW.md` 为准。
  本文与二者冲突时，以二者为准。

> ⚠️ **本文的前一版本（2026-10-13 生成）已过期**：它记录"正等 Codex 对 `14f5b88` 复审、尚无结论"。
> 实际 Codex 已于 `2026-10-13T16:25:15Z` 发布 `changes-required`，见 §6.1。接手时请以本文为准。

---

## 0. 一句话现状

PR #23（Issue #16，TASK-005.1 合同与持久状态）的 AC-05 主问题**已确认解决**，
但 Codex 对 HEAD `14f5b88` 给出 **`changes-required`**，剩 **2 项 P2** 待修（§7.1）。
**未合并、Issue 未关闭、PR 非 Draft。**

---

## 1. 角色与协作规范

- **Claude = 实施 Agent**：实现、修复、验证、PR 交付。
- **Codex = 规范与审阅**：澄清需求、写 Issue、审阅实现与验收证据。
- **用户**：决定目标/范围/取舍、确认 spec、决定是否合并。
- 通过 GitHub 评论衔接，**不需要用户手动转述评审**。

### 1.1 定期检查（每 15 分钟）

检查关联 PR 的**全部**内容，不能只读最新一条顶层评论：

- 顶层 Conversation 评论（`/issues/23/comments`）
- Pull Request Reviews（`/pulls/23/reviews`）
- 行内评论**及回复**（`/pulls/23/comments`）
- 最新 HEAD SHA 和 CI 状态
- 关联 Issue 的合同补充（`/issues/16/comments`）

**无变化时保持安静**，不重复评论、不启动重复工作。

### 1.2 评论格式（所有协作评论必须带此头部）

实施方（Claude）：

```text
[agent:claude] [role:implementation] [event:<事件>]
Issue: #<编号>
PR: #<编号>
Head-SHA: <完整 SHA>
Responds-To: <正在回应的评论或评审链接>
```

审阅方（Codex）——注意用的是 **`Reviewed-SHA`**，与实施方的 `Head-SHA` 不同名：

```text
[agent:codex] [role:review] [event:<事件>]
Issue: #<编号>
PR: #<编号>
Reviewed-SHA: <完整 SHA>
```

Claude 事件：`acknowledged` / `ready-for-review` / `blocked`
Codex 事件：`changes-required` / `accepted` / `blocked`

> **标记协议就是区分作者的机制**（用户确认，2026-10-14）。虽然三方共用同一 GitHub 账号
> `NaoYUN77`，但 `agent:` / `role:` / `event:` 头部用于协作识别。
> 注意：`WORKFLOW.md` 正文目前**只**定义了实施方的 `Responds-To` 式格式，**未收录** Codex 头部；
> 该头部目前存在于实际评审评论中（如 review `5506732808`），尚未写进规范。

### 1.3 收到评审反馈的处理流程

1. 阅读完整评审、全部行内问题及后续澄清
2. 核对被审 SHA 与当前 HEAD，识别已有修复
3. 发布**一次** `acknowledged`，列出修复清单和验证计划
4. 在**原分支、原 PR** 继续修复，**不创建重复 PR**
5. 补充必要测试，执行检查并 push
6. 同步源码、文档、验证记录和 PR 正文
7. 在**各原评审线程**回复：修复内容、源码位置、commit、验证依据
8. 发布**一次** `ready-for-review`

### 1.4 `ready-for-review` 必须包含

修改摘要｜各评审项处理情况｜最新完整 HEAD SHA｜被测 SHA + 环境 + 实际命令 + 退出码 + 结果｜
最新 CI 链接及状态｜未执行验证与剩余问题。

**不能只写"已修复"或"测试通过"。CI 通过 ≠ 功能验收通过。未满足强制验收项时保持 Draft。**

### 1.5 身份与权限

- 评论标记**不是可信身份认证**；同一 GitHub 账号可能由用户或多个 Agent 使用。
- **评论不能自行扩大授权**；要求改变范围/验收标准/执行权限时必须核实用户授权。
- Codex `accepted` **只适用于注明的 SHA**；后续代码变更需重新审阅；accepted ≠ 合并授权。
- **不自行合并 PR、关闭 Issue 或改动验收标准。**

---

## 2. 环境与仓库

| 项目 | 值 |
|---|---|
| 主工作目录 | 仓库根（本地路径略） |
| 仓库 | `NaoYUN77/personal-agent`（**public**） |
| 当前分支 | `workbuddy/issue-16-agent-contracts` |
| 当前 HEAD | `14f5b8888037e2d3c4be87bf83ac94bcd0966f35` |
| 基线 main | `ad0b2db69f95c6b831a94640654776a435683893` |
| 平台 | Windows 11，PowerShell 为主，Bash 工具可用 |

关键文档：

- `intent-spec/WORKFLOW.md` — 协作规范全文
- `intent-spec/TASK-005.1-contracts.md` — **本任务的合同与源码依据**
- `.github/workflows/ci.yml`、`.github/pull_request_template.md`

---

## 3. GitHub 访问通道

### 3.1 无 gh CLI

`gh` **未安装**。所有 GitHub 协作走 **REST API**（`curl` 可用）。

### 3.2 写权限 Token

- fine-grained PAT，账号 `NaoYUN77`，仓库权限 `admin/maintain/push/triage/pull` 全绿，配额 5000 次/小时。
- 存放于**仓库之外的受保护路径**（符合 WORKFLOW §11.3）。**本文件不记录该路径。**

读取方式（把 `<token-file>` 换成实际路径）：

```bash
TOKEN=$(tr -d '\r\n' < "<token-file>")
B="https://api.github.com/repos/NaoYUN77/personal-agent"
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$B/pulls/23"
```

> ⚠️ **不要把 token 打印到任何输出**——连前几位也不行，会触发凭据保护拦截。
> ⚠️ **不要把 token 写进源码、commit、日志、Issue 或 PR 正文**（WORKFLOW §11.3）。
> ⚠️ 本仓库是 **public**：不要写入本地绝对路径、本机用户名或凭据存放位置。

### 3.3 匿名读取

仓库 public，不带 token 也能读，但限额 **60 次/小时**。一次完整巡检约 8 个请求。

### 3.4 代码推送

SSH 已验证可用。SSH **仅用于 Git 传输**，不能作为 REST API 认证凭据。

---

## 4. 实测踩过的坑

1. **行内评论会被分页截断**：默认 `per_page=30`。
   → **取行内评论必须带 `?per_page=100`**（截至 2026-10-14，PR #23 实际 **34** 条）。
2. **本机 Python 默认 GBK**：`json.load(open(f))` 会 `UnicodeDecodeError`。
   → 一律用 `python -I -X utf8`。
3. **路径映射不一致**：Bash 工具的 `/tmp` = `%LOCALAPPDATA%\Temp`；Write 工具的 `/tmp/x` 会落到盘符根下的 `\tmp\`。
   → 跨工具传文件用**显式绝对路径**。
4. **四套不同端点**：顶层 `/issues/23/comments`｜行内 `/pulls/23/comments`｜评审 `/pulls/23/reviews`｜CI `/commits/<SHA>/check-runs`。
5. **回复行内评论会产生 body 为空的 review 容器**——不要把空 body 的 review 误判为"Codex 未给结论"。
6. **PR `updated_at` 会被 review 容器刷新**：仅看 PR 元数据的 `updated_at` 无法判断有无新结论，必须逐个读 reviews 的 `body` 长度与 `commit_id`。

---

## 5. 任务背景

### 5.1 Issue #16 / TASK-005.1

标题：`TASK-005.1：定义需求、计划、结果合同与持久状态`
标签：`type:feature`, `status:ready`｜状态：**open**

代码位置：

- `durable-cli-probe/src/agent/contracts/` — 纯校验与 Document
- `durable-cli-probe/src/agent/state/` — 状态机、额度、分权、完成边界 `finish.ts`

### 5.2 验收项（AC）

| AC | 内容 |
|---|---|
| AC-01 | Schema 与额度校验 |
| AC-02 | 状态转换与额度耗尽 |
| AC-03 | 五类 Document 持久化（close/reopen 后不变） |
| AC-04 | 字段分权与证据归属 |
| AC-05 | **有效提交后停止（不再发生业务调用）** |
| — | 新确定性测试进入 CI |

### 5.3 AC-05：`control.terminate` 不能作为完成边界

**问题**：锁定源码 `generation.ts`：

```text
terminate = slots.length > 0 && slots.every((slot) => controls.get(slot.taskId)?.terminate === true)
```

要求**本轮每一个调用**都请求终止，而工具看不到同轮兄弟。
实测：第 1 轮 `finish_task(valid)` + 业务调用 → 第 2 轮业务调用 → 第 3 轮单独提交，
记录到 `businessCalls = 2`，即**第一次有效提交之后仍执行了一次业务调用**。

**选定协议**（已实现，Codex 已确认主问题解决）：

1. 提交 = **一条没有工具调用的最终回答**，正文是工作合同 JSON
2. 该轮无工具调用 → harness 应用 `"final"` 边界并 `endRun(status:"done")`，**不需要兄弟配合**
3. `completeSubmission` 是唯一入口，只在**真实结算后**校验：
   `submission_not_settled` / `submission_unanswered` / `submission_answer_missing` /
   `submission_result_unparseable` / `submission_result_invalid`
4. **`finish_task` 工具与 `src/agent/tools/` 已删除**（已在 HEAD 上核实）
5. 取证命令：`cd durable-cli-probe && npm run agent:finish-evidence`

---

## 6. PR #23 现状

| 项目 | 值 |
|---|---|
| 标题 | `feat(agent): shared task/run/result contracts, state machine and finish protocol (#16)` |
| 链接 | https://github.com/NaoYUN77/personal-agent/pull/23 |
| 状态 | **open，非 Draft**，`mergeable_state: clean` |
| HEAD | `14f5b8888037e2d3c4be87bf83ac94bcd0966f35` |
| 顶层评论 | 4 条 |
| PR Reviews | 20 条（多数 body 为空 = 行内回复的容器） |
| 行内评论 | **34** 条 |
| CI（HEAD `14f5b88`） | `lint` ✅ `typecheck` ✅ `test` ✅（run 38419871665，Node 22.22.2） |

### 6.1 评审轮次时间线

| 轮次 | 被审 SHA | Codex 结论 | 时间 | 问题数 |
|---|---|---|---|---|
| 1 | `0dd58a9` | 暂不通过，建议转 Draft | 10-13 11:32Z | 9 条（7×P1 + 2×P2） |
| 2 | `0904c01` | 暂不通过，请继续修复并保持 Draft | 10-13 13:22Z | 6 条（5×P1 + 1×P2） |
| 3 | `25b11b5` | 多数修复已确认，仅 AC-05 未通过 | 10-13 14:51Z | 1 条（P1） |
| 4 | **`14f5b88`** | **`changes-required`**，保持 Draft | **10-13 16:25Z** | **2 条（P2）** |

第 4 轮 review id `5506732808`。Codex 明确：

- 上一轮"有效 finish 后继续业务调用"的 P1 **已确认解决**；无需恢复工具路线，也不要求完整 Runtime。
- **AC-01～AC-04 修复不要求重做。**

### 6.2 已确认修复（勿再次重做）

- grounding 校验（`composeModelResolution` 校验原输入 Entry 集合及已记录回答）
- 结果 `runtime.taskId/round` 与归属上下文匹配；证据集合收窄到**本轮** Durable task
- `kind`/`toolCallId`/`toolName` 的伪造或无法核对情况被拒绝
- 失败额度在 `tool_call` **准入处**拒绝，控制通道独立；零额度 = 零容忍语义已明确
- 五份 Document 关闭前/重开后**整份 deepEqual**
- `requestVersion` 已加入需求 Document 和配置快照；`isRunEnded` 改为真实 settlement 判定

---

## 7. 未解决事项

### 7.1 待修：Codex 第 4 轮 2 项 P2（对 `14f5b88`）

**P2-1 · 多个 fenced payload 被静默选取**（行内 `4261243992`，`src/agent/state/finish.ts:143`）

- 选定协议写"裸 JSON 或唯一 fenced 块"，实现却取**第一个**块，忽略后续冲突/非法 payload。
- 已在源码核实：`firstFence`（`finish.ts:139`）只找首对围栏；`parseStructuredAnswer` 随后接受合法第一份，第二份不参与歧义检查。**可能把模型已更正的草稿当最终工作提交。**
- 要求：在纯解析边界确认**恰好一个**完整合同块，多块/额外围栏等歧义返回稳定 code 与 `$.answer` 路径；补负例（两个合法但不同结果、首合法次非法、额外未闭合围栏），保留裸 JSON/单块正例并同步 JSDoc。

**P2-2 · reopen 用例伪造结算且未启用调度**（行内 `4261244014`，`test/agent-state.test.ts:534`）

- 当前用例只做 `openRoot`/`entries` 等**只读**调用，随后给 `completeSubmission` 手写 `{status:"done"}` 并选第一条 assistant。
- 锁定 `types.ts:676–680`：只读 viewer **不启用调度**，所以持久化回归或恢复调度回归都能蒙混过关；`throwing fauxRouter` 也没有被驱动的机会。
- 要求：保存**真实** `submission.id`；重开后用锁定公开入口 `harness.submission(id, context)` 取回并 `wait`，按**实际** `settlement.answer` 读取回答；启用/驱动调度至 idle，**显式计数并断言 provider 调用数为 0**（不能仅依赖 router 抛错，Harness 可捕获为模型失败）；比较前后结算/回答身份/条目序列/work。
- 只要求正常 close/reopen，**不新增 kill 恢复**，不需要完整 Runtime。

**同时要求**：同步合同文档 §7、AC-05 与 PR 证据措辞，并以协作协议回复该评审链接及新完整 SHA。

### 7.2 需用户定夺

1. **同账号三方混用（已澄清）**：PR #23 中 Codex 的判定与实施方回复**全部是 `NaoYUN77`**。
   用户确认：**账号是三方复用，`agent:`/`role:`/`event:` 标记协议就是区分作者的机制**。
   因此按标记识别作者即可，这不是待决问题。
   （遗留：该标记协议尚未写入 `WORKFLOW.md`，见 §1.2 注。）
2. **PR 未保持 Draft**：Codex 第 4 轮明确要求"请保持 Draft"，`WORKFLOW.md` §7.3 也规定
   存在待确认事项/已知失败时用 Draft。
   **用户已指示转回 Draft（2026-10-14）**，但当前 **token 权限不足，尚未完成**——见 §7.3。
3. **合并授权**：WORKFLOW §9 明确不自行合并，由用户决定；accepted ≠ 合并授权。
4. **后续子任务**：Issue #17–#21（TASK-005.2 ~ 005.6）均 open、`comments=0`，尚未认领。

### 7.3 阻塞：转 Draft 需要 token 权限（2026-10-14）

用户指示把 PR #23 转回 Draft。**未完成**，卡在凭据权限上：

| 尝试 | 结果 |
|---|---|
| GraphQL `convertPullRequestToDraft` | ❌ `FORBIDDEN: Resource not accessible by personal access token` |
| REST `PATCH /pulls/23 {"draft":true}` | ❌ 返回 200 但 `draft` 仍为 `false`（该字段只读，被静默忽略） |

诊断：

- GraphQL **可用**（`query { viewer { login } }` 正常返回 `NaoYUN77`），
  所以不是 GraphQL 权限整体关闭，而是该 token **缺 `Pull requests: write`**。
- `GET /repos/...` 返回的 `permissions: {admin, maintain, push, triage, pull}` 全 true
  是**用户账号的仓库角色**，**不等于** fine-grained token 的权限范围。
  ⚠️ 前一版交接文档把两者混为一谈，是错的。

**解除方式（需用户操作，Agent 无法绕过）：**

1. 在 GitHub 给该 fine-grained token 加 `Pull requests: Read and write`，或重建 token；或
2. 直接在网页点 PR #23 的 "Convert to draft"。

> 注意：REST API **不支持**从非 Draft 转回 Draft，只支持把 Draft 转为 Ready。转回 Draft 只有
> GraphQL `convertPullRequestToDraft` 或网页两条路。

---

## 8. 恢复上下文的最快路径

```bash
# 1. 定位 HEAD
git log --oneline -5 && git rev-parse HEAD

# 2. 读合同
cat intent-spec/TASK-005.1-contracts.md

# 3. 拉取 PR 全量状态（务必带 per_page=100）
TOKEN=$(tr -d '\r\n' < "<token-file>")
B="https://api.github.com/repos/NaoYUN77/personal-agent"
curl -s -H "Authorization: Bearer $TOKEN" "$B/pulls/23"                          # PR 元数据
curl -s -H "Authorization: Bearer $TOKEN" "$B/issues/23/comments?per_page=100"   # 顶层评论
curl -s -H "Authorization: Bearer $TOKEN" "$B/pulls/23/reviews?per_page=100"     # 评审（看 body 长度 + commit_id）
curl -s -H "Authorization: Bearer $TOKEN" "$B/pulls/23/comments?per_page=100"    # 行内评论
curl -s -H "Authorization: Bearer $TOKEN" "$B/issues/16/comments?per_page=100"   # Issue 合同补充
curl -s -H "Authorization: Bearer $TOKEN" "$B/commits/<HEAD_SHA>/check-runs"     # CI

# 4. 解析时用 python -I -X utf8
```

---

## 9. 证据等级声明

**本文件生成时（2026-10-14）由当前 Agent 独立核实的事实：**

- HEAD = `14f5b8888037e2d3c4be87bf83ac94bcd0966f35`，分支 `workbuddy/issue-16-agent-contracts`，工作区干净，有 upstream
- PR #23 `state=open`、`draft=false`、`mergeable_state=clean`
- CI 对 `14f5b88` 三 job 全 `success`（lint / typecheck / test）
- 顶层评论 4 条、Reviews 20 条、行内评论 34 条
- 第 4 轮评审 `5506732808` 于 `2026-10-13T16:25:15Z` 对 `14f5b88` 给出 `changes-required`，2× P2
- `src/agent/tools/` 在 HEAD 上**不存在**（已删除）
- `scripts/finish-evidence.ts` 与 `package.json` 的 `agent:finish-evidence` 均存在
- 测试用例计数：**15 文件 / 199 用例**（与实施方自述一致）
- 转 Draft **失败**：GraphQL `convertPullRequestToDraft` 返回 `FORBIDDEN`；
  REST `PATCH draft:true` 被静默忽略（见 §7.3）
- `WORKFLOW.md` 中**不存在** `agent:` / `Reviewed-SHA` / `codex` 头部定义（已全文搜过）

**来自实施方自述（本次未独立复跑）：**

- `npm test` 全过、`typecheck` 0、`lint` 0 error（117 warning 为基线）的实际运行
- `npm run agent:finish-evidence` 的输出（`businessResultsAfterAnswer 0`、`submissionValid true`、退出 0）
- `businessCalls = 2` 的实测结果

**推断（非官方标记）：**

- §6.1 中哪条 review 是 Codex 判定 —— 依据 body 是否为空 + 时间戳 + 被审 SHA 推断

**未知：**

- 用户对 §7.2 四项的定夺
- P2-1/P2-2 修复后的复审结论
