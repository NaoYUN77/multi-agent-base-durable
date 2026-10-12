# 真实文章验收报告：Claude 3.5 Sonnet

用 Issue #3 合并后的 `article:probe` 链路，对一篇真实官方文章做端到端验收。

**结论摘要**

| 验收项 | 结果 |
|---|---|
| AC-01 输入可追溯 | **通过** |
| AC-02 真实模型处理全文 + 语义正确 | **未通过** —— 解读语言错误（中文，应为英文），见 §5 与 §9 |
| AC-03 页面创建 + 读回核验 | **通过** |
| AC-04 重放引用原结果 | **通过** |
| AC-05 证据完整 | **通过** |
| AC-06 提交范围仅报告 | **通过** |

链路本身工作正常：真实 DeepSeek 处理了全部 15 个段落，页面创建成功，标题、来源链接、原文与顺序、逐段解读全部读回一致。**唯一失败的是解读的语言** —— 见 §9，已另开 Issue #6，未在本任务中修改实现或规范。

---

## 1. 被测对象与环境

| 项 | 值 |
|---|---|
| 被测 commit | `7b3ba4ccb8bc2a568e714bd2e4846cbae79e9b76`（`main`，即 PR #4 的 merge commit） |
| 分支 | `workbuddy/issue-5-article-real-validation` |
| 运行时 | Node `v22.22.2`，`@notionhq/client` 5.27.0，Notion-Version `2026-03-11` |
| 模型 | `deepseek-flash`（真实 DeepSeek，非 faux） |
| Notion | 真实 workspace，专用测试父页面 `3f7b0f7a-39e1-8146-b782-cf4edff81d74` |
| Pi checkout | `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f` |

## 2. 输入准备（AC-01）

**来源**：`https://www.anthropic.com/news/claude-3-5-sonnet`
**页面 H1**：`Claude 3.5 Sonnet`
**获取时间（UTC）**：`2026-10-12T05:11:41Z`（HTTP 200，124,166 字节）

### 提取规则（可复现）

1. 抓取上述 URL 的 HTML。
2. 定位最内层正文容器：class 含 `Body-module-scss-module__z40yvW__body`。
3. **只保留 class 含 `__readi` 的 `<p>` 与 `<h2>`** —— 即「阅读列」。这一条同时排除了：
   - `LatestUpdates` 卡片（日期旁的更新提示）
   - `ImageWithCaption` 内的 figure 与 caption
   - 导航、按钮、Related content、页脚（都在 `<article>` 之外）
4. 去标签、解码 HTML 实体、折叠空白。
5. `<p>` 作为 `ArticleInput.paragraphs`；`<h2>` 记为章节标题，**不混入段落**
   （按 Issue：「不要把章节标题单独伪装成需要摘要的自然段」）。

### 实际提取结果

| 项 | 值 |
|---|---|
| 段落数 | **15** |
| 章节标题数 | 5 |
| 段落总字符数 | 5,592 |
| 各段字符数 | 308, 379, 321, 256, 611, 472, 477, 430, 272, 537, 386, 204, 224, 407, 308 |
| 章节标题 | Frontier intelligence at 2x the speed / State-of-the-art vision / Artifacts—a new way to use Claude / Commitment to safety and privacy / Coming soon |

**与 Issue 记载的差异**：Issue 说「Codex 本次读取到正文 17 个自然段」，本次提取到 **15 个**。

差异最可能来自 `LatestUpdates` 卡片：它是一个 `<ul>`，含 2 行 `<p>`（标题行「Consumer Terms and Privacy Policy」与日期行「Aug 28, 2025」）。若把它们计入正文，正好是 17。按 Issue 的规则「去掉……日期旁边的推荐卡片」，这两行应被剔除，因此本次取 15。**未硬凑 17 段。**

### 关于章节标题与 ArticleInput 的约束

Issue 要求「章节标题作为上下文保留」，但 `ArticleInput` 的合同只有 `requestId / title / source / sourceUrl / paragraphs` 五个字段，**没有承载章节结构的字段**。本任务不得修改核心源码，因此：

- 章节标题未进入 `paragraphs`（否则会违反「不要把章节标题伪装成需要摘要的自然段」）；
- 章节标题记录在本报告与提取元数据中，供人工追溯；
- **模型只通过段落内容间接获得章节上下文**。这是合同的一个限制，见 §8。

## 3. 真实运行（AC-02 / AC-03）

**实际执行的命令**（参数中的路径均在仓库外，不含凭据）：

```bash
export NOTION_TOKEN=...            # 来自本机已有配置，未写入命令、日志或仓库
export NOTION_ARTICLE_PARENT_PAGE_ID=3f7b0f7a-39e1-8146-b782-cf4edff81d74
export DEEPSEEK_API_KEY=...        # 同上
export NOTION_PIN_IP=208.103.161.2 # 见 §7「环境问题」

npm run article:probe -- --provider deepseek \
  --input  C:/Users/l/.workbuddy-ai/issue5-work/article-input.json \
  --db     C:/Users/l/.workbuddy-ai/issue5-work/article-real.sqlite \
  --request-id article-real-anthropic-35-sonnet-20261012
```

**结果**：退出码 **0**

```
[article] provider=deepseek model=deepseek-flash
[article] title="Claude 3.5 Sonnet" source="Anthropic 官方博客"
[article] paragraphs=15
[article] spec=prompts/article-analysis.md chars=2104
[article] root conversation id=1
[article] submission=article-real-anthropic-35-sonnet-20261012 status=done
[article] transcript kinds: pi.user, pi.system, pi.assistant, pi.tool-result, pi.assistant
[article] tool-result entries (this submission): 13
[article]   created page 3f7b0f7a-39e1-814e-9a4b-c739d620fc4e
[article]   url: https://app.notion.com/p/Claude-3-5-Sonnet-3f7b0f7a39e1814e9a4bc739d620fc4e
[article]   title: matches
[article]   blocks: 49  paragraphs: 15
[article]   original chars: 5592  analysis chars: 2060
[article]   read-back: matches
```

**标识**：Conversation id `1`；submission requestId `article-real-anthropic-35-sonnet-20261012`；
`pi.tool-result` 条目 id `13`；pageId `3f7b0f7a-39e1-814e-9a4b-c739d620fc4e`。

**文章页面**：https://app.notion.com/p/Claude-3-5-Sonnet-3f7b0f7a39e1814e9a4bc739d620fc4e

## 4. 读回核验（AC-03）

通过 SDK 读回页面及其全部子 block（49 个，`has_more=false`）：

| 核验项 | 结果 |
|---|---|
| 页面标题 | `Claude 3.5 Sonnet` —— 与输入一致 |
| 父页面 | `{"type":"page_id","page_id":"3f7b0f7a-39e1-8146-b782-cf4edff81d74"}` —— 专用测试父页面，非其他页面 |
| 来源链接 | 来源行含可点击链接，href = `https://www.anthropic.com/news/claude-3-5-sonnet` |
| 分区顺序 | `来源` → `原文` → `逐段解读` |
| 原文段落 | **15 段，顺序与输入完全一致**（逐段比对，无缺、无多、无重排） |
| 原文保真 | 页面原文总字符 **5592**，与输入一致 |
| 逐段解读 | `第 1 段` … `第 15 段`，编号连续唯一，每段都有 `摘要：` 与 `作用：` |
| 其他页面 | 未修改：父页面下其余 4 个子页面（Issue #3 的产物）内容与数量均未变化 |

## 5. 人工语义核验（AC-02）

对全部 15 段的 `summary` 与 `roleInArticle` 逐段核对，重点检查漏段、虚构、时间性错误、只复述单段而未联系全文。

**核验结论：语义层面未发现漏段、虚构或时间性错误。** 关键数字与原文一致：

- 第 3 段的评测项（GPQA / MMLU / HumanEval）与原文逐项对应；
- 第 5 段的 `64%` 与 `38%` 两个数字与原文一致，且未把「内部评测」说成第三方基准；
- 第 13 段把「年内发布 Haiku 与 Opus」表述为**计划**（「年内还将发布」），没有写成已发生的事实 —— 这是一篇 2024 年的发布文章，这一点是正确的处理。

以下三段的核验结论（用自己的话描述）：

- **第 1 段（开篇）**：解读抓住了「这是 Claude 3.5 家族的首个发布」以及「以中端价位提供超越旗舰的智能」这一核心张力，`roleInArticle` 明确点出它在为全文立论。与原文一致，无拔高。
- **第 5 段（中间论据）**：这是全文最硬的一处实证。解读既保留了评测数字，也保留了评测方法的限定（要求模型依据自然语言描述修复或扩展开源代码库），`roleInArticle` 把它定位为「对前文基准声明最有力的实证展开」，与文章的行文推进吻合。**未发现把内部评测包装成外部结论的问题。**
- **第 15 段（末段）**：解读把它识别为收尾邀请（听取反馈、影响路线图），而不是又一个产品声明，`roleInArticle` 的定位准确。**未发现把客套收尾误读为能力主张。**

**但 AC-02 仍未通过 —— 语言不对。** 见 §9。

## 6. 重放（AC-04）

同一数据库、同一 `requestId` 再运行一次：

```
[article] submission=article-real-anthropic-35-sonnet-20261012 status=done
[article] tool-result entries (this submission): 13
[article]   created page 3f7b0f7a-39e1-814e-9a4b-c739d620fc4e
[article]   title: matches
[article]   read-back: matches
退出码: 0
```

| 项 | 重放前 | 重放后 |
|---|---|---|
| 父页面 `child_page` 数 | 5 | **5**（未新增） |
| `pi.tool-result` 条目 id | 13 | **13**（同一条） |
| pageId | `...d620fc4e` | **同** |

**这是「已完成 requestId 的重放引用原结果」，不是「中途崩溃恢复」。** 本次没有制造进程中断，中断恢复行为未被验证。

## 7. 命令与结果汇总（AC-05）

| 实际执行的命令 | 退出码 | 结果 |
|---|---|---|
| `npm run article:probe -- --provider deepseek ...`（首次，无 `NOTION_PIN_IP`） | **1** | `fetch failed` → 归类为「结果不明」，拒绝声称成功；核查父页面后确认**未创建页面**，故可安全重跑（见下） |
| `npm run article:probe -- --provider deepseek ...`（加 `NOTION_PIN_IP`） | **0** | 页面创建，`title: matches`，`read-back: matches` |
| 同命令重放 | **0** | 引用原 tool-result 与 pageId，父页面未新增 |
| `git diff --check 7b3ba4c...HEAD` | **0** | 无空白错误 |
| `git diff --name-only 7b3ba4c...HEAD` | **0** | 仅本报告一个文件 |

### 环境问题（如实记录）

首次运行时 `api.notion.com` 出现 `ECONNRESET`。排查结果：

- DNS 解析出 4 个 IPv4：`208.103.161.1 / .2 / .16 / .17`
- 逐个直连测试：**`.1` 被 RST**，`.2` 与 `.16` 返回 `200`
- Node 的地址选择命中 `.1` 时即失败

这与 2026-10-11 记录的现象一致，属**环境网络问题**，不是本仓库代码缺陷。使用仓库既有的 `NOTION_PIN_IP=208.103.161.2`（把传输固定到指定地址、保持 SNI 与 Host 正确）后正常。

**值得记录的是失败的处理方式**：首次运行的 `fetch failed` 被正确归类为「结果不明」并拒绝声称成功，退出码 1，且明确要求先核查父页面 —— 这正是 Issue #3 第二轮修复引入的行为。核查确认未创建页面后才重跑。

## 8. 未执行 / 未覆盖

- **解读语言未通过** —— 见 §9。
- **未实测写入中断后的恢复**：工具声明 `replay: "unsafe"`，但本次没有制造进程中途崩溃去观察其行为。§6 的重放是「完成后重放」，不是崩溃恢复。
- **未触发真实 429 限流**；退避逻辑属 SDK 自身，本次只观察到传输层失败。
- **章节标题未作为结构化上下文传给模型**：`ArticleInput` 合同没有承载章节结构的字段，本任务不得改核心源码，因此标题只记录在报告中，模型仅通过段落内容间接推断章节。这是一个**合同限制**，不是本次运行的失败，但会影响长文的结构感知，建议后续评估是否需要在合同中表达章节。
- **仅验证了 1 篇文章、1 个模型**（`deepseek-flash`）。未测试其他语言、其他格式或其他模型。
- **未在 Linux/macOS 上运行**。

## 9. 发现的缺陷（未在本任务中修复）

**解读语言错误。**

- 现象：英文文章产出的 `summary` / `roleInArticle` **全部是中文**。
- 期望（AC-02）：「英文文章生成英文解读」。
- 根因：`prompts/article-analysis.md` 的语言规则只给了「中文输入」的例子，缺少英文的例子与对不遵循的明确约束，模型被锚定到中文。
- 处理：已另开 **Issue #6**（`type:bug` + `status:needs-clarification`），附复现证据与受影响验收项。
- **本任务未修改实现或规范** —— 按 Issue 要求「不为通过验收悄悄调整实现」。

## 10. 提交范围（AC-06）

本 PR **只新增本报告一个文件**。

以下内容**未进入提交**，全部位于仓库之外（`C:\Users\l\.workbuddy-ai\issue5-work\`）：

- 抓取的 HTML 与提取脚本
- `ArticleInput` JSON（含文章全文）
- 独立 SQLite 数据库与运行日志
- 页面读回文本

报告中未粘贴文章全文、完整模型输出、凭据或运行数据库内容；引用的模型输出仅为短句示例。
