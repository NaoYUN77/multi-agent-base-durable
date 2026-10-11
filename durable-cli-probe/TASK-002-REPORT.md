# TASK-002 完成报告：Notion API 的 Durable 只读集成

工作目录：`E:\Code\pi-durable\durable-cli-probe`
参考仓库：`E:\Code\pi-durable\base-durable-vaction-agent\pi`（HEAD `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`）
完成时间：2026-10-11

---

## 0. 结论摘要

在不修改 Pi Durable 核心源码、不污染 Vacation Demo 的前提下，建成了一套**只读**的 Notion 集成，并通过 Durable
的 `notion_read` 工具跑通了「工具 → registry → transcript → 重启恢复」全链路。

- 5 项第一阶段接口全部实现：`users/me`、`search`、`pages/{id}`、`blocks/{id}/children`、Durable 只读工具。
- `npm run typecheck` exit 0；`npm test` **28 passed**（Notion 26 + TASK-001 持久化 2）。
- **真实链路已通**：用假 token 时请求确实发到 `api.notion.com`，带 `Notion-Version: 2026-03-11`，
  返回真实的 `unauthorized / 401` 并带 request_id。
- **`pi.tool-result` 已被真实写入并在重启后可读**（entry 13，126 字符）。
- **`requestId` 幂等已验证**：同 key 重放不新增 entry。
- ✅ **2026-10-11 更新：已用真实 Personal Access Token 补齐实测**（详见 §5.5 与 README §15）。
  四个命令全部真实跑通：`notion:me`（token 有效）、`notion:search`（`results=35 pages=30 data_sources=5`）、
  `notion:read-page`（真实页面 `Student Planner`，`blocks=14 lines=7 nested=true`）、
  `notion:tool`（真实 API 调用，7 entries 含 2×`pi.tool-result`，重启后 re-read 260 字符，requestId 幂等）。
  **原先「未读到任何真实页面内容 / 未产出成功认证读取」的缺口已关闭。**
- **仍未验证**：真实 429 限流、真实大页面上的 `truncated` vs `hasMore` 边界（本次 search 一次拿全，
  `has_more=false`）。这两项仍只有离线 fixture 覆盖。

---

## 1. 修改文件清单

### 新建文件（12 个）

| 文件 | 职责 |
|---|---|
| `src/config.ts` | `NOTION_TOKEN` / `NOTION_PAGE_ID` 读取、`Notion-Version` 常量、token 脱敏、配置错误类型 |
| `src/notion/types.ts` | 窄化后的 JSON 投影类型（允许进入 transcript 的白名单） |
| `src/notion/client.ts` | SDK client 构造（锁定版本头、429 重试）、错误归一化、`Retry-After` 解析、`pinnedFetch()` 可选 IP 固定应急开关 |
| `src/notion/read.ts` | 四个只读操作 + 分页 + 文本渲染 + 属性渲染 |
| `src/notion/tool.ts` | `notion_read` 工具与 `notion-read` 扩展定义 |
| `src/notion/runtime.ts` | 四个 CLI 共用的 client 构造、横幅打印、退出码约定、`NOTION_PIN_IP` 读取 |
| `src/notion/cli-me.ts` | `npm run notion:me` |
| `src/notion/cli-search.ts` | `npm run notion:search -- "<query>"` |
| `src/notion/cli-read-page.ts` | `npm run notion:read-page -- "<page_id>"` |
| `src/notion/cli-tool.ts` | `npm run notion:tool`（Durable 端到端） |
| `test/notion-read.test.ts` | 26 个离线测试（假 fetch，无网络无 token） |
| `TASK-002-REPORT.md` | 本报告 |

### 修改的既有文件（3 个）

| 文件 | 改动 | 为什么必须改 |
|---|---|---|
| `package.json` | 新增 `@notionhq/client@5.27.0` 到 devDependencies；新增 4 个 `notion:*` script | 依赖与验收命令 |
| `src/runtime.ts` | 加可选字段 `extensions`；`openProbe` 安装扩展并记录名字；`openRoot` 选择扩展；faux 支持脚本化 tool call（含 `stopReason: "toolUse"`） | 让扩展能进 registry，并让 faux 能真正触发 `pi.tool` |
| `README.md` | 追加 §7–§15（TASK-002 全部文档） | 交付文档 |

### 未修改（约束遵守证据）

```
$ cd E:\Code\pi-durable\base-durable-vaction-agent\pi
$ git status --short          # 无输出
$ git rev-parse HEAD
f44707e7f7190a8cc86ce105790c72c6b0f5fd5f
```

- `packages/durable` **未修改**
- `packages/coding-agent/src/experimental/vacation` **未修改**
- checkout 内**没有**新建 `node_modules`

---

## 2. `@notionhq/client` 锁定版本

| 项 | 值 |
|---|---|
| 包 | `@notionhq/client` |
| 版本 | **5.27.0**（精确，非 `^`、非 `latest`） |
| integrity | `sha512-JnkLtAzSDrEnvtZ8dQ5L4KO+xyL5g01xK5qmKTmhJ5KFY8LWsMyFG033vHCj0mFcsz9thAMjfcAQz/SWxiexag==` |
| engines | `node >=18`（probe 要求 `>=22.19.0`，实机 v22.22.2） |
| 依赖类型 | `devDependencies`（本 probe 不发布） |
| 选择理由 | 2026-09-29 发布的最新版；`>=5.12.0` 是该 SDK 支持 `Notion-Version: 2026-03-11` 的起始版本 |

安装前已核对 `package-lock.json` 与 Node 版本，见本报告 §5。

---

## 3. Notion-Version

**`Notion-Version: 2026-03-11`**（Notion 官方当前版本，已核对官方 versioning 文档）。

在 `src/config.ts` 定义为 `NOTION_VERSION` 常量，在 `createNotionClient()` 里一次性设到 client 上，
**任何调用点都无法遗漏或漂移**。

该版本的三处破坏性变更与本任务的关系：

| 变更 | 前 | 后 | 对本任务影响 |
|---|---|---|---|
| 块定位参数 | `after`（字符串） | `position`（对象） | 无（本任务不 append） |
| 回收站字段 | `archived` | `in_trash` | 无（本任务不读该字段） |
| 块类型重命名 | `transcription` | `meeting_notes` | 已兼容：两种拼写都在 `TEXT_BLOCK_TYPES` 里 |

即使不影响，仍锁定版本，避免将来读 `archived` 静默拿到 undefined。

---

## 4. 实际 API endpoint

| 命令 | 方法与路径 |
|---|---|
| `notion:me` | `GET /v1/users/me` |
| `notion:search` | `POST /v1/search` |
| `notion:read-page` | `GET /v1/pages/{page_id}` **和** `GET /v1/blocks/{block_id}/children` |
| `notion:tool` | 同样这三个读，经 Durable `notion_read` 工具抵达 |

Base URL：`https://api.notion.com`（SDK 默认值；正常运行从不覆盖）。

---

## 5. 真实执行命令和结果

环境：Node `v22.22.2`；managed npm `10.9.7`（其 `install` 在本机损坏，见 §10）；安装用系统 npm `11.17.0`。

### 5.1 版本

```
$ node --version      → v22.22.2
$ npm --version       → 10.9.7   (managed, install 不可用)
$ <system> npm -v     → 11.17.0  (实际执行安装)
```

### 5.2 类型检查

```
$ npm run typecheck
> tsc --noEmit
（无输出）exit 0
```

### 5.3 测试

```
$ npm test
 ✓ test/notion-read.test.ts (26 tests) 30ms
 ✓ test/persistence-reopen.test.ts (2 tests) 2237ms
 Test Files  2 passed (2)
      Tests  28 passed (28)
```

### 5.4 验收命令 `cli.ts`（原样，未改 src/cli.ts）

```
$ npm run cli -- --provider faux --request-id notion-tool-test-1 "读取 Notion 页面并总结"
[probe] db=./data/probe.sqlite provider=faux model=faux-1
[probe] root conversation id=1
[probe] submission=notion-tool-test-1 status=done
[probe] answer: Hello from durable.
[probe] transcript kinds: pi.user, pi.assistant
```

### 5.5 真实网络：token 被拒（无有效 token）

```
$ NOTION_TOKEN='ntn_fake_token_for_probe' node --conditions=source --experimental-strip-types src/notion/cli-me.ts
[notion] target=users.me version=2026-03-11 base_url=https://api.notion.com
[notion] error code=unauthorized status=401 request_id=ab7db75f-0907-4e87-9160-08cbde9ddd60
[notion] API token is invalid.
exit: 1
```

这是**在没有有效 token 的情况下能拿到的最强证据**：版本头、base_url、鉴权头、错误路径全部是活的。
`code=unauthorized`（而**不是** `object_not_found`）对无效 token 是正确判定。

同一会话稍后再试时遇到 `ECONNRESET`，归一化为 `code=transport_error`。这是沙箱网络出口的问题，
不是 probe 的问题——同一个调用几分钟前刚成功过。该现象**后来自行恢复**（不固定 IP 连续 8 次全部成功）；
诊断过程与新增的 `NOTION_PIN_IP` 应急开关见 README §15。

### 5.5.1 真实凭证下的实测结果（2026-10-11 补齐）

用真实 **Personal Access Token**（`ntn_` 前缀）重跑全部四条命令，**均已真实跑通**：

```
$ npm run notion:me
[notion] target=users.me version=2026-03-11 base_url=https://api.notion.com
[notion] bot id=3f6b0f7a-39e1-8134-a5ea-00274599291a
[notion] name=personal-agent-access-token
[notion] type=bot
[notion] workspace=Dennys ronny的工作空间
[notion] owner=user
[notion] token is valid

$ npm run notion:search
[notion] query=(none: listing all shared) object=any
[notion] results=35 has_more=false truncated=false
[notion] pages=30 data_sources=5

$ npm run notion:read-page -- 8f2b0f7a-39e1-8273-9062-01d29eb894b4
[notion] page title="Student Planner"
[notion] page url=https://app.notion.com/p/Student-Planner-8f2b0f7a39e18273906201d29eb894b4 parent=workspace
[notion] properties (1):
[notion]   title = Student Planner
[notion] blocks=14 lines=7 nested=true truncated=false

$ NOTION_PAGE_ID=8f2b0f7a-... npm run notion:tool
[notion] selected extensions: notion-read
[notion] offered tools: notion_read
[notion] submission=notion-tool-test-1 status=done
[notion] transcript kinds: pi.user, pi.system, pi.assistant, pi.tool-result, pi.assistant, pi.tool-result, pi.assistant
[notion] tool-result entry: 13
[notion] reopened transcript kinds: (同上)
[notion] transcript survived restart: true
[notion] tool-result recovered: id=13 chars=260
[notion] replay status=done entries=7 (was 7)
[notion] requestId idempotent: true
[notion] token ok: bot=personal-agent-access-token id=3f6b0f7a-39e1-8134-a5ea-00274599291a
```

**两条从实测中确认的事实**：

1. **PAT 无需 `Add connections` 共享页面即可读取**。search 直接返回了 token 创建者可见的真实页面，
   期间**没有对任何页面执行过 share**。这与官方文档一致，也解释了为什么本 probe 没有实现共享/能力配置步骤。
2. **PAT 下 `/v1/users/me` 返回的是凭证而非人**：`type=bot`、`owner.type=user`、`name` 是 token 自己的名字。
   把它当成"用户名"来读会误判。

**仍未覆盖**：真实 429 限流、真实大页面上的 `truncated` vs `hasMore` 边界（本次 `has_more=false`，一次拿全）。

### 5.6 Durable 工具路径（脚本化 tool call）

```
$ NOTION_TOKEN='ntn_fake' NOTION_PAGE_ID='00000000-0000-0000-0000-000000000000' npm run notion:tool
[notion] tool=notion_read extension=notion-read page_id=00000000-0000-0000-0000-000000000000
[notion] root conversation id=1
[notion] selected extensions: notion-read
[notion] offered tools: notion_read
[notion] submission=notion-tool-test-1 status=done
[notion] transcript kinds: pi.user, pi.system, pi.assistant, pi.tool-result, pi.assistant, pi.tool-result, pi.assistant
[notion] tool-result entry: 13
[notion] reopened root conversation id=1 (first open: 1)
[notion] reopened transcript kinds: pi.user, pi.system, pi.assistant, pi.tool-result, pi.assistant, pi.tool-result, pi.assistant
[notion] transcript survived restart: true
[notion] tool-result recovered: id=13 chars=126
[notion] tool-result preview: Notion error: transport_error — fetch failed...
[notion] replay status=done entries=7 (was 7)
[notion] requestId idempotent: true
```

### 5.7 配置守卫（均 exit 2）

```
$ npm run notion:me                      # 无 NOTION_TOKEN
[notion] NOTION_TOKEN is not set. → exit 2   （配置错误）

$ NOTION_TOKEN=ntn_fake npm run notion:read-page    # 无 page id
[notion] NOTION_PAGE_ID is not set. → exit 2 （配置错误）

$ NOTION_TOKEN=ntn_fake npm run notion:me           # token 无效
[notion] error code=unauthorized status=401 → exit 1（API 错误）
```

退出码约定：**2 = 配置缺失，1 = API/其他失败**。

---

## 6. connection 可见页面数量

`npm run notion:search` 不带 query 会列出所有共享给该 connection 的对象，并打印
`results=` / `pages=` / `data_sources=`。

**本次未能得到真实数字**：无有效 token，所有 search 调用都停在认证层（`unauthorized`）。
`0` 是假 token 下的必然结果，不是真实可见数量。**本报告不声称任何真实可见页面数。**

带真实 token 时该数字由命令直接输出，无需人工推断。

---

## 7. 页面与 block 读取结果摘要

**本次未读到任何真实页面或 block 内容**（无有效 token）。此处只说明数据通路与形状：

- `read_page` → `GET /v1/pages/{id}` → 投影为 `{id, title, url, parentType, properties, lastEditedTime}`。
  `properties` 被摊平成 `name → 短字符串`（title/number/checkbox/select/status/multi_select/date/people/
  files/relation/formula/rollup 均已实现渲染）。超过上限会被截断并置 `propertiesTruncated=true`。
- `read_blocks` → `GET /v1/blocks/{id}/children` → 投影为 `TextLine[]`，渲染成 `[blockType] 文本 ⟶` 的大纲。
- **属性 ≠ 正文**：`read_page` 对纯页面只会返回 `title`；`read_blocks` 对数据库行通常只有标题。
  这是两个 endpoint、两个问题，probe 刻意分开，并在 `read_page` 输出末尾加提示句避免模型误判。

两处均有 26 个离线测试用固定响应覆盖（含分页、截断、类型渲染）。

---

## 8. Durable transcript 中的 entry kind

实测（`notion:tool` 一次运行）：

| kind | 出现次数 | 写入方 |
|---|---|---|
| `pi.user` | 1 | submission |
| `pi.system` | 1 | 位置性 prompt |
| `pi.assistant` | 3 | `pi.generation` |
| **`pi.tool-result`** | **2** | **`pi.tool`（`tool.ts:609` 的 `appendToolResult`）** |

`pi.tool-result` 是关键：它由内置 `pi.tool` 任务在模型发起的调用 settle 时写入。
其 `model` 是 `[ToolResultMessage]`，其 `data` 是 `{diagnostics}`。

---

## 9. 重启后的 Conversation ID

- 首次打开：root conversation id = **1**
- 重新打开同一 SQLite：root conversation id = **1**（一致）
- 重启后 entry kind 序列完全一致（7 条）
- **重启后 tool result 可读**：通过 `root.commit((tx) => tx.entry(ToolResultEntry, 13))` 重新读回
  entry 13，得到 126 字符内容 → 证明它被真正持久化，而不是内存回声。

---

## 10. 429、权限、分页与幂等风险

### 429（速率限制）

- **处理方式**：`createNotionClient()` 设 `retry: { maxRetries: 3 }`，由 SDK 依据服务端 `Retry-After`
  退避重试；`normalizeNotionError` 额外提取 `retryAfterSeconds`，`describeNotionError` 打印 `retry_after=Ns`。
- **风险**：本次**未触发真实 429**。Notion 的限流按 connection 计算，短时突发难以稳定复现。
  重试逻辑只经过单元测试（用一个归一化后的限流错误），未经真实限流验证。
- **附加风险**：429 在并发 `notion:tool` 多工具调用时会成倍放大，因为每个 `pi.tool` 任务独立发请求。
  缓解手段是 `maxRetries` + 输出上限，但没有全局令牌桶。

### 权限

- `403 restricted_resource` = token 有效但缺能力（缺 read content）。
- **`404 object_not_found` = token 有效但页面没共享给 connection。** 这是最高频的操作失误。
- 因此 probe **按 Notion 的 `code` 分支，不按 HTTP status**：`unauthorized`(401) 与 `object_not_found`(404)
  在语义上完全不同，都塌缩成「401/404」会把排查引向错误方向。

### 分页

- `search` 与 `blocks.children.list` 都返回 `has_more` + `next_cursor`。
- probe 跟随 cursor 直到自身边界，并**分别上报两个不同标志**：
  - `hasMore` = Notion 还有更多页
  - `truncated` = probe 自己先停了（`maxPages` / `limit` / `page_size` 上限 100）
- **风险**：把两者合并会掩盖「结果不完整」这件事。当前实现刻意区分。
- **未验证**：真实大页面上的 `truncated` vs `hasMore` 行为（无有效 token）。

### 幂等

- `requestId` 幂等**已验证**：同 key 重放，entry 数保持 7 不变。
- `replay: "safe"`：所有动作都是 GET，崩溃后重跑无害且正确（重新附着到已提交结果，而不是留缺口）。
- **风险**：`replay: "safe"` 的前提是「只读」。一旦加入写操作，必须改成 `unsafe`，
  否则崩溃后重跑会产生重复写入。

---

## 11. 明确声明：Durable 核心与 Vacation Demo 未修改

```
$ cd E:\Code\pi-durable\base-durable-vaction-agent\pi
$ git status --short
                      # 空输出 —— 零改动
$ git rev-parse HEAD
f44707e7f7190a8cc86ce105790c72c6b0f5fd5f
```

- `packages/durable/**` —— **未修改**
- `packages/coding-agent/src/experimental/vacation/**` —— **未修改**
- checkout 内未创建任何 `node_modules`
- 未自行实现 Agent Loop（全部走内置 `pi.generation` / `pi.tool` 任务）
- 未提交任何 git commit

### token 安全声明

- token 仅从环境变量读取，仅作为内存字符串交给 `new Client({ auth })`
- **未写入**源码 / SQLite / transcript / 日志
- 已实测：所有 `data/*.sqlite` 中 token 形状字符串计数为 **0**
- `normalizeNotionError()` 会把 `secret_…` / `ntn_…` 形状从错误消息中改写掉
- token 从不经 argv 传入，因此不进 shell history、不进进程列表

---

## 12. 未完成与已知缺口（如实列出）

| 项 | 状态 |
|---|---|
| 成功的真实 Notion 认证读取 | ❌ 无有效 token，从未读到真实页面/block |
| 真实 429 触发与退避验证 | ❌ 未触发 |
| 真实大页面分页 / 截断 | ❌ 未验证 |
| 真实成功模型回答 | ❌ 未产出（DeepSeek 路径此前仅用假 key 跑过） |
| Notion 写操作 | 未实现（设计上不提供） |
| 嵌套 block 递归 | 未递归，只读一层，置 `hasNestedChildren` |
| OAuth / Sub-Agent / RAG / MCP / Telegram / 飞书 / UI 自动化 | 按任务要求全部不做 |

沙箱网络出口在会话后段变为 `ECONNRESET`，因此 §5.5 之后的所有真实网络探测均不可用；
该情况已如实标注，未伪装成通过。

---

## 13. 复现方式

```bash
cd E:/Code/pi-durable/durable-cli-probe
npm run link                 # 若刚做过 npm install，重建 checkout 软链
npm run typecheck            # 期望 exit 0
npm test                     # 期望 28 passed

# 真实路径（需要有效 token）
read -rs NOTION_TOKEN && export NOTION_TOKEN
export NOTION_PAGE_ID='<32-hex page id>'
npm run notion:me
npm run notion:search -- "任意关键词"
npm run notion:read-page -- "$NOTION_PAGE_ID"
npm run notion:tool
```
