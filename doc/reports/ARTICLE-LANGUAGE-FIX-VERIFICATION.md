# Issue #6 修复验证：解读语言跟随正文

修复「英文文章产出中文解读」。本文档只记录必要的元数据、核验统计与短句示例，不含完整原文或完整模型输出。

## 1. 改了什么

只改了 `prompts/article-analysis.md` 的「语言」一节（原为 3 行，现为一节完整规则）。

**修改前**：

```
## 语言

用与输入文章**相同的主要语言**输出 `summary` 和 `roleInArticle`。输入是中文就用中文。
```

**修改后**：明确三件事 ——

1. **输出语言只由正文的主要语言决定**，并给出英/中/其他的对照表；
2. **列出不能用来判断输出语言的五个诱因**：规范自身的语言（本规范是中文写的，这不代表要输出中文）、
   `source` 字段、`title` 字段、页面分区名称、模型自身的默认倾向；
3. **给出反例与正例对照表**，以及混合语言、引文与术语的边界处理。

**未改动**：`src/article/spec.ts`、`ArticleInput` 合同、Durable 核心、依赖与 lockfile。
按 Issue 要求未新增语言检测依赖，未新增调用方语言参数，也未把 `source` 改成英文来绕过。

## 2. 自动化检查

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 类型检查通过 |
| `npm test` | 0 | **87 passed**（59 文章 + 28 既有回归） |

新增 2 个测试，锁定规范的规则形态：语言规则必须**双向**给出（英文→英文、中文→中文），
且必须点名「本规范自身的语言」与 `source` / `title` 这些不能作为依据的诱因。

## 3. 真实运行

三次运行，**每次都是独立的新数据库与新 requestId**（无删库重跑、无换 ID 重试）。
被测 commit 完整 SHA：`c925794fc662a5dbb12eab8480aa0f46f3cf3a63`（`workbuddy/issue-6-output-language` 分支，本 PR 的代码提交）。
模型 `deepseek-flash`，Notion 真实 workspace，专用测试父页面 `3f7b0f7a-39e1-8146-b782-cf4edff81d74`。

| # | 输入 | 输入原始 requestId | 数据库绝对路径 | requestId | 退出码 | pageId |
|---|---|---|---|---|---|---|
| 1 | 英文全文 15 段（Anthropic 官方文章） | `article-real-anthropic-35-sonnet-20261012` | `C:/Users/l/.workbuddy-ai/issue6-work/en-a.sqlite` | `article-lang-en-a` | 0 | `3f7b0f7a-39e1-8116-900d-e34c14d3cb81` |
| 2 | 同上 | `article-real-anthropic-35-sonnet-20261012` | `C:/Users/l/.workbuddy-ai/issue6-work/en-b.sqlite` | `article-lang-en-b` | 0 | `3f7b0f7a-39e1-8148-9faa-ec54d68e36f4` |
| 3 | 中文人工样例 5 段（仓库内 `test/fixtures/article-sample.json`） | `article-sample-1` | `C:/Users/l/.workbuddy-ai/issue6-work/zh.sqlite` | `article-lang-zh` | 0 | `3f7b0f7a-39e1-8137-a29c-eca4db8f131b` |

英文两页的输入文件绝对路径：`C:/Users/l/.workbuddy-ai/issue5-work/article-input.json`
（来自 Issue #5 的爬取产物，`source` 含中文 14 字，`title` 为英文，15 段共 5592 字符）。
中文样例使用仓库内自带 fixture，与英文输入**不是同一个文件**。

### Durable 标识（从各 SQLite 只读核查）

三个库的 Durable 标识一致（每个库都是首次写入，只有一条 submission）：

| 项 | 值（三库相同） | 来源 |
|---|---|---|
| root conversation id | `1`（**数字 id，不是 UUID**） | 各日志 `[article] root conversation id=1`；各库 `conversations` 表 `id=1` |
| submission id | `8`，`status=done` | 各库 `submissions` 表 |
| tool-result entry | `13`（`toolName=notion_write_article`） | 各日志与各库 `entries` 表 |

**逐条命令**（凭据均来自本机已有环境变量/配置文件，未出现在命令、日志或仓库中；均在 `durable-cli-probe` 目录下执行）：

```bash
# 运行 1（英文 A）
NOTION_PIN_IP=208.103.161.2 \
  npm run article:probe -- --provider deepseek \
  --input C:/Users/l/.workbuddy-ai/issue5-work/article-input.json \
  --db C:/Users/l/.workbuddy-ai/issue6-work/en-a.sqlite \
  --request-id article-lang-en-a

# 运行 2（英文 B）
NOTION_PIN_IP=208.103.161.2 \
  npm run article:probe -- --provider deepseek \
  --input C:/Users/l/.workbuddy-ai/issue5-work/article-input.json \
  --db C:/Users/l/.workbuddy-ai/issue6-work/en-b.sqlite \
  --request-id article-lang-en-b

# 运行 3（中文样例）
NOTION_PIN_IP=208.103.161.2 \
  npm run article:probe -- --provider deepseek \
  --input test/fixtures/article-sample.json \
  --db C:/Users/l/.workbuddy-ai/issue6-work/zh.sqlite \
  --request-id article-lang-zh
```

三份日志显示 CLI 会以 `--request-id` 覆盖输入文件自带的 requestId（`requestId overridden by --request-id: …`），但**不会替换输入内容本身**；中文运行读入的就是 5 段中文样例（`paragraphs=5`，`title="可复现：运维工作的第一性要求"`）。

环境说明：`api.notion.com` 解析出的 4 个地址中 `.1` 被 RST、`.2`/`.16` 正常，
`NOTION_PIN_IP=208.103.161.2` 属环境网络问题，与本仓库代码无关（与 PR #7 报告 §7 记录一致）。

## 4. 读回核验

读回数据有两个独立来源，已交叉核对一致：
① Notion SDK 读回三个页面及其子 block；
② 各 SQLite `entries` 表 entry 11 中保存的模型原始输出（`notion_write_article` 的 toolCall 参数）。

对三个页面分别读回并统计（`摘要：` 与 `作用：` 位于同一个 block，以换行分隔）：

| 页面 | 分区 | 逐段条目 | `摘要：` | `作用：` | 编号 | 语言判定 |
|---|---|---|---|---|---|---|
| 英文 A | 来源 / 原文 / 逐段解读 | 15 / 15 | 15 | 15 | 1…15 连续唯一 | **英文** |
| 英文 B | 来源 / 原文 / 逐段解读 | 15 / 15 | 15 | 15 | 1…15 连续唯一 | **英文** |
| 中文样例 | 来源 / 原文 / 逐段解读 | 5 / 5 | 5 | 5 | 1…5 连续唯一 | **中文** |

语言判定方式：统计解读正文（去掉 `摘要：`/`作用：` 前缀与「第 N 段」标题）中的
CJK 字符数与拉丁字母数。

| 页面 | 仅模型文本 CJK | 仅模型文本 Latin | 语言判定 |
|---|---|---|---|
| 英文 A | 0 | 4901 | **英文** |
| 英文 B | 0 | 4646 | **英文** |
| 中文样例 | 620 | 9 | **中文** |

英文两页统计中出现的 30 个 CJK 字符**并非模型输出**，而是固定的渲染文案 `作用：`
（15 个段落块 × 每个块 2 字 = 30 字）；若把 `摘要：` 也计入，额外还有 30 字。
这些标签在 Notion 页面中作为结构化前缀呈现，不属于模型生成的解读内容。

三个页面的 `title: matches` 与 `read-back: matches` 均为真；原文段落数与字符数与输入一致
（英文 15 段 / 5592 字符，中文 5 段 / 506 字符）。

## 5. 人工语义核验

**全部 35 段已逐段核验**（英文 A 15 段 + 英文 B 15 段 + 中文样例 5 段），无漏段、无语言偏差、无明显语义错误。

核验方法：从各 SQLite 只读提取 entry 11 的真实模型输出（`notion_write_article` 的 toolCall 参数），
与输入 JSON 的逐段原文人工比对。以下为代表性示例（均已核对原文）：

- **第 2 段（可用性与定价）**：解读准确写出「Claude.ai 与 iOS 应用免费、Pro 与 Team 订阅者更高限额、经 Anthropic API / Amazon Bedrock / Google Cloud Vertex AI 提供、输入 $3 / 输出 $15 每百万 token、200K 上下文」。与原文逐项一致。
- **第 5 段（agentic coding 内部评测）**：`64%` 与 `38%` 两个数字准确；保留了「内部评测」这一定性与方法描述（依据自然语言描述修复漏洞或为开源代码库增加功能），未把内部结论包装成外部基准。
- **第 6 段（视觉能力）**：准确提炼 visual reasoning（图表解读）与「从模糊图像转录文本」两项，并保留零售、物流、金融服务三个应用领域。
- **第 10 段（外部安全测试）**：准确写出「提供给英国 AISI 做预部署评估，UK AISI 在 US–UK 两国 AISI 合作框架下的谅解备忘录（MoU）中与 US AISI 共享结果」。原文该段确为外部安全机构合作，无企业 Memory 内容。
- **第 13 段（路线图）**：把「年内发布 Haiku 与 Opus」表述为将来时的**计划**（`later this year`），未写成已发生的事实。这是一篇 2024 年的发布文章，时间性表述处理正确。
- **第 14 段（后续方向）**：准确写出「面向业务的新模态与功能、企业应用集成、以及处于探索阶段的 Memory（记住用户偏好与交互历史）」。原文该段确为未来方向，没有 Claude Code / Computer Use 的权限边界内容。
- **中文样例第 3 段**：对照案例（脚本仓库、数据库迁移/配置下发/灰度切换、检出 tag 十分钟回滚）与原文一致。
- **中文样例第 5 段**：判断标准「不是能不能写成脚本，而是下一次还要不要重来一遍」准确转述原文。

英文两页全部 30 段的 `roleInArticle` 均描述该段在全文中的作用（如第 3 段定位为「为开篇的智能主张提供基准证据」、第 7 段定位为「从模型能力切换到产品功能」），不是对单段的复述；无段落被错误归类为「总结」或「过渡」。

**修订说明（透明记录）**：本文档 `18af048` 版本的 §5 曾把第 10 段错标为「企业扩展与 Memory」、第 14 段错标为「Claude Code / Computer Use 权限」、第 2 段错写为「3.5 Opus 仅面向付费层级」。经审阅比对本机原文后确认：**这三处是报告描述写错，不是模型输出错误** —— 上述三段乃至全部 35 段的模型输出均与原文一致，本版已按真实原文改写。

## 6. 限制（必须保留）

- **提示修复不是语言正确的硬保证。** 本次只观测到三次运行的语言正确；
  这不能推广为「任何输入、任何模型、任何次数都会正确」。没有概率保证。
- **根因仍未确认。** Issue #6 已写明根因尚未确认。本次只改了规范措辞，
  **没有做隔离变量的对照实验**，因此无法证明「原措辞是唯一原因」，也无法证明
  「新措辞是本次改善的唯一原因」。规范全文为中文、`source` 字段为中文、模型采样随机性
  这三个候选因素仍然存在，只是被更明确的规则覆盖了。
- **覆盖范围有限**：2 篇英文（同一篇的两次运行）+ 1 篇中文，1 个模型。
  未测试其他语言、其他模型或更多次数。
- **`NOTION_PIN_IP` 仍是本次环境下的必需项**，不是默认路径。
- **PR #7 的旧失败事实未改动。** 那份报告记录的失败属于旧 commit 的版本，本修复不追溯修改它。
