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

链路本身工作正常：真实 DeepSeek 处理了全部 15 个段落，页面创建成功，标题、来源链接、原文与顺序、逐段解读全部读回一致。**AC-02 未通过：解读语言错误（中文，应为英文）**；此外，章节上下文要求也未满足（§9.1）。见 §9，已另开 Issue #6，未在本任务中修改实现或规范。

**两处待处理事项，均不构成本次验收的通过依据：**

- **§9.1** —— 章节标题未传给模型，是一处**未获用户认可**的 spec 偏离，需用户决定。
- **§7** —— 运行 2 是**删库后重新提交**，不是"同一请求恢复"；首版表述易被误读，已改写。

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
- **模型只通过段落内容间接获得章节上下文**。

⚠️ **这是一处未经用户确认的 spec 偏离，不构成本次验收的通过依据**，详见 §9.1。

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

本次共执行三次 CLI 运行。**三次是三个独立的运行，不是同一个请求的"失败—恢复"**：
运行 2 之前数据库被删除，因此它是一次**全新提交**，不是"设置 `NOTION_PIN_IP` 后同一请求恢复"。
下表逐次记录数据库、requestId 与删除操作，避免把不同运行混为一谈。

| # | 数据库 | requestId | 运行前是否删库 | `NOTION_PIN_IP` | 退出码 | 结果 |
|---|---|---|---|---|---|---|
| 1 | `…/issue5-work/article-real.sqlite` | `article-real-anthropic-35-sonnet-20261012` | 是（`rm -f …article-real.sqlite*`） | 未设置 | **1** | `fetch failed` → 归类为「结果不明」 |
| 2 | 同上（路径相同，但文件已被删除重建） | 同上 | 是（`rm -f …article-real.sqlite*`） | `208.103.161.2` | **0** | 页面创建，`title: matches`，`read-back: matches` |
| 3 | 同上（**未删除**，沿用运行 2 的库） | 同上 | 否 | `208.103.161.2` | **0** | 引用原 tool-result(13) 与 pageId，父页面未新增 |

非 CLI 的核对命令：

| 实际执行的命令 | 退出码 | 结果 |
|---|---|---|
| `git diff --check 7b3ba4c...HEAD` | **0** | 无空白错误 |
| `git diff --name-only 7b3ba4c...HEAD` | **0** | 仅本报告一个文件 |

### 运行 1 的失败发生在哪个阶段

**不在 submit 之前。** 从运行 1 的日志可以定位到确切阶段：

```
[article] submission=article-real-anthropic-35-sonnet-20261012 status=done
[article] transcript kinds: pi.user, pi.system, pi.assistant, pi.tool-result, pi.assistant
[article] tool-result entries (this submission): 13
[article] --- tool-result 13 (isError) ---
[article]   Write outcome unknown: article write indeterminate (transport_error): fetch failed
```

即：提交已 settle 为 `done`，模型**已成功调用** `notion_write_article`（存在 `pi.tool-result` 条目），
失败发生在**工具内部的 `pages.create` 传输层**，被归类为「结果不明」。

### 恢复步骤与"先核查未创建"的证据

1. 运行 1 失败后，先尝试核查父页面 —— **同样失败**（`ECONNRESET`），此时无法判断是否已创建。
2. 排查 DNS：`api.notion.com` 解析出 4 个 IPv4（`208.103.161.1 / .2 / .16 / .17`）。
3. 逐个直连测试（TLS 直连指定地址、SNI 保持 `api.notion.com`）：
   **`.1` 被 RST**；`.2` 与 `.16` 返回 `200 OK`。
4. 带 `NOTION_PIN_IP=208.103.161.2` 重新核查父页面，列出全部子页面：

   ```
   父页面 child_page 数量: 4
     - 可复现：运维工作的第一性要求  id=3f7b0f7a-39e1-819f-b478-c78e55c1fd41
     - 可复现：运维工作的第一性要求  id=3f7b0f7a-39e1-817c-b922-cabb62037614
     - 可复现：运维工作的第一性要求  id=3f7b0f7a-39e1-8162-a7ec-f7da6844dfd6
     - 可复现：运维工作的第一性要求  id=3f7b0f7a-39e1-8179-8e65-e53b9bd519ec
   ```

   4 个页面**全部来自 Issue #3 的运行**（标题均为「可复现：运维工作的第一性要求」），
   **没有**标题为 `Claude 3.5 Sonnet` 的页面。
5. 因此判定运行 1 **没有创建页面**，可以安全重跑。
6. 运行 2 **删除了数据库**后重新执行 —— 即**放弃运行 1 的记录、以全新提交重跑**，
   而不是让运行 1 的那个 submission 继续。

**本次为何选择重建数据库**：Durable 在相同 Conversation/requestId 时会返回已有 submission。运行 1 的 requestId 已 settle 为 `done`，其 `pi.tool-result` 是一条 `isError`；若**不删库**用同一 requestId 再跑，会重放回**运行 1 的旧错误**，而不会因为设置了 `NOTION_PIN_IP` 就重新发起写入。

本次选择**删除数据库后重建**，是为了保留同一 requestId 并重新提交； alternatively 也可以保留失败库、换另一个独立数据库和新的唯一 requestId 提交。**删库是本次实际执行方式，不是 Durable 的恢复操作规范。**

运行 3（未删库）证明的是**成功 submission 的重放引用原结果**；而**失败 submission 的重放行为**（同一 DB + 同一 requestId 会回到旧错误）是源码可推导的，并非本次实测——运行 1 的数据库已被删除，无法直接演示失败重放。

### 环境问题的性质

`api.notion.com` 的 `.1` 地址被 RST、`.2`/`.16` 正常，与 2026-10-11 记录的现象一致，
属**环境网络问题**，不是本仓库代码缺陷。使用仓库既有的 `NOTION_PIN_IP`（把传输固定到指定地址、
保持 SNI 与 Host 正确）后正常。

值得记录的是**失败的处理方式**：运行 1 的 `fetch failed` 被正确归类为「结果不明」、退出码 1、
并要求先核查父页面 —— 这正是 Issue #3 第二轮修复引入的行为，在真实场景中得到验证。

## 8. 未执行 / 未覆盖

- **解读语言未通过** —— 见 §9。
- **未实测写入中断后的恢复**：工具声明 `replay: "unsafe"`，但本次没有制造进程中途崩溃去观察其行为。§6 的重放是「完成后重放」，不是崩溃恢复。
- **未触发真实 429 限流**；退避逻辑属 SDK 自身，本次只观察到传输层失败。
- **章节标题未作为结构化上下文传给模型**：`ArticleInput` 合同没有承载章节结构的字段，本任务不得改核心源码，因此标题只记录在报告中，模型仅通过段落内容间接推断章节。这是**未获用户认可的 spec 偏离**，不构成本次验收的通过依据，会影响长文的结构感知，建议后续评估是否需要在合同中表达章节。
- **仅验证了 1 篇文章、1 个模型**（`deepseek-flash`）。未测试其他语言、其他格式或其他模型。
- **未在 Linux/macOS 上运行**。

## 9. 发现的缺陷（未在本任务中修复）

**解读语言错误。**

- 现象：英文文章产出的 `summary` / `roleInArticle` **全部是中文**。
- 期望（AC-02）：「英文文章生成英文解读」。用户已明确确认**跟随原文正文语言**，
  因此中文输出**不符合合同**，不能通过修改验收标准来接受。
- 处理：已另开 **Issue #6**，附复现证据与受影响验收项。该 Issue 现已补齐最小修复合同并标为 `status:ready`。
- **本任务未修改实现或规范** —— 按 Issue 要求「不为通过验收悄悄调整实现」。

### 根因是假设，不是已确认的因果

下面这条是**假设**，本次**没有做隔离变量的对照实验**，因此不能当作已证实的根因：

> 假设：`prompts/article-analysis.md` 的语言规则只给了「中文输入」的例子，
> 缺少英文例子与对不遵循的明确约束，模型因此被锚定到中文。

**至少还有三个未被排除的候选因素**：

1. **规范全文是中文** —— 模型可能把"指令语言"当成"输出语言"；
2. **`source` 字段是中文**（`Anthropic 官方博客`）—— 输入中唯一的非英文元数据；
3. **模型采样随机性** —— 单次运行的观测不足以排除偶发。

在做出对照实验（例如只改规范措辞、其余不变，跑多次）之前，**这条只能写作假设**。
Issue #6 已按此要求记录。

## 9.1 未获认可的 spec 偏离（待用户决定）

Issue 第 2 步要求「章节标题作为上下文保留」。本次**未把章节标题传给模型**，理由是
`ArticleInput` 的合同只有 `requestId / title / source / sourceUrl / paragraphs` 五个字段，
而本任务不得修改核心源码。章节标题因此只记录在本报告与提取元数据中。

**这是一处未经用户确认的偏离，不构成本次验收的通过依据。** 用户此次确认的是输出语言，
**不表示接受章节上下文缺失**。若认为必须让模型看到章节结构，需要先修改合同（属独立任务）。

## 10. 提交范围（AC-06）

本 PR **只新增本报告一个文件**。

以下内容**未进入提交**，全部位于仓库之外（`C:\Users\l\.workbuddy-ai\issue5-work\`）：

- 抓取的 HTML 与提取脚本
- `ArticleInput` JSON（含文章全文）
- 独立 SQLite 数据库与运行日志
- 页面读回文本

报告中未粘贴文章全文、完整模型输出、凭据或运行数据库内容；引用的模型输出仅为短句示例。

---

## 11. 修订记录

**`2026-10-12`（首版，commit `53d8f0b`）** —— 首次提交。

**`2026-10-12`（第二版，本轮）** —— 按 PR #7 的审阅意见修订，**不改写首版的失败结论**：

| 修订 | 原因 |
|---|---|
| §7 重写为逐次运行记录（数据库、requestId、是否删库、`NOTION_PIN_IP`、退出码） | 首版把运行 2 写得像"同一请求恢复"。实际是**删库后重新提交**；不删库用同一 requestId 会重放回运行 1 的旧错误，见 §7 |
| §7 补充失败阶段定位与"先核查未创建"的完整证据 | AC-05 要求准确复现证据 |
| §9 把根因改为**假设**，并列出三个未排除的候选因素 | 首版把"单一中文例子"写成了根因。没有对照实验就不能称因果 |
| 新增 §9.1：章节标题偏离标注为**未获认可** | 该偏离需要用户决定，不能作为验收通过依据 |
| §2 的章节标题说明指向 §9.1 | 同上 |

**未改动**：首版记录的失败事实、AC 结论、命令与退出码。

---

## 12. 修复后补充（Issue #6，commit `c925794`）

**本节不修改上文任何结论。** 上文 §1–§11 记录的是**被测 commit `7b3ba4c` 版本**的验收结果，
其中 AC-02 未通过。本节记录**新版本 `c925794`** 的复测结果，两者分开陈述，
**不把旧 SHA 的结果重新标注为新版本结果**。

### 改了什么

`prompts/article-analysis.md` 的「语言」一节：由「用与输入文章相同的主要语言输出……输入是中文就用中文」
（只有中文方向的例子）扩写为完整规则 —— 正文语言对照表、五个不能作为依据的诱因
（规范自身的语言、`source`、`title`、页面分区名称、模型默认倾向）、正反例对照表、混合语言与术语边界。

未改 `src/article/spec.ts`、`ArticleInput` 合同、Durable 核心、依赖。详见 PR #8。

### 复测结果

三次独立运行，每次新库、新 requestId，同一篇英文文章与同一篇中文样例：

| # | 输入 | 数据库 | requestId | 退出码 | 语言核验 |
|---|---|---|---|---|---|
| 1 | 英文全文 15 段 | `issue6-work/en-a.sqlite` | `article-lang-en-a` | 0 | **英文**（模型文本 CJK 0 / Latin 4901；30 CJK 来自模板标签 `作用：`） |
| 2 | 同上 | `issue6-work/en-b.sqlite` | `article-lang-en-b` | 0 | **英文**（模型文本 CJK 0 / Latin 4646；30 CJK 来自模板标签 `作用：`） |
| 3 | 中文样例 5 段 | `issue6-work/zh.sqlite` | `article-lang-zh` | 0 | **中文**（模型文本 CJK 620 / Latin 9） |

- 三页 `title: matches` 与 `read-back: matches` 均为真；逐段条目 15/15、15/15、5/5；编号连续唯一。
- 英文两页的少量 CJK 字符全部来自固定渲染文案（`摘要：`、`作用：`），不是模型输出。
- 人工语义核验：英文第 3 段（GPQA/MMLU/HumanEval）、第 5 段（64% / 38%，保留「内部评测」定性）、
  第 13 段（「later in the year」表述为**计划**）均与原文一致。

`npm run typecheck` 退出 0；`npm test` **87 passed**。

页面：
- 英文 A https://app.notion.com/p/Claude-3-5-Sonnet-3f7b0f7a39e18116900de34c14d3cb81
- 英文 B https://app.notion.com/p/Claude-3-5-Sonnet-3f7b0f7a39e181489faaec54d68e36f4
- 中文 https://app.notion.com/p/3f7b0f7a39e18137a29ceca4db8f131b

### 对本报告结论的影响

| 项 | `7b3ba4c` 版本 | `c925794` 版本 |
|---|---|---|
| AC-02 语言 | **未通过**（中文） | 通过（英文 ×2、中文 ×1） |
| 其余验收项 | 通过 | 通过（未退化） |

**本报告 §1–§11 的 AC 结论不变**，因为它们记录的是旧版本的运行。
按 Issue #5 的 AC-06 与 Issue #6 的 AC-05，旧失败事实予以保留。

### 仍然保留的限制

- **提示修复不是语言正确的硬保证。** 三次运行不足以支撑概率结论。
- **根因仍未确认。** 未做隔离变量的对照实验；规范全文为中文、`source` 为中文、
  模型采样随机性这三个候选因素仍然存在，只是被更明确的规则覆盖。
- 本节由 Issue #6 的修复 PR #8 引入，验收由该 PR 承担；本报告只做关联记录。

