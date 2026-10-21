# CI 第一版：能力、边界与后续计划

本文件说明 TASK-004 已交付的 CI，以及下一版应补充的保障。配置事实以源码为准；通过一次 CI 表示该次检查通过，不代表 Agent 功能、模型输出或真实服务均已验收。

本文基线：2026-10-13，应用合并提交 `f732f6cee8786cafe7483a2be5c4753445afabcd`（[PR #13](https://github.com/NaoYUN77/personal-agent/pull/13)）。后续建议尚未实施。

## 1. 第一版做了什么

| 能力 | 实际实现 | 能证明什么 |
| --- | --- | --- |
| 自动触发 | 所有 PR、推送到 main、手动 workflow_dispatch | 这些事件会启动检查；没有路径过滤 |
| 类型检查 | 独立 job `typecheck`，执行 `tsc --noEmit`，strict 开启 | 本应用 src/test 的 TypeScript 类型一致 |
| 静态规则 | 独立 job `lint`，Biome 2.3.5，recommended 规则，noExplicitAny 为 error | 配置范围内没有使命令失败的 lint 错误 |
| 可重复准备 | 三个 job 各自执行同一个 prepare.mjs | 检查依赖脚本从锁定版本准备环境，而非开发机已有产物 |
| 版本记录 | 输出应用 checkout SHA、Pi SHA、Node/npm 版本 | 能追溯该次检查实际使用的代码和工具链 |
| 下载缓存 | 缓存 ~/.npm；key 包含 Pi SHA 和应用 lockfile hash | 加速下载；node_modules 和 dist 均不缓存 |
| 工作流权限 | contents: read，不读取模型/Notion凭据 | 普通检查不需要真实服务授权 |
| 并发与超时 | 同 ref 的旧运行被取消，每个 job 最多 45 分钟 | 避免重复等待；不会无限占用 runner |

工作流使用 Ubuntu 托管 runner（`ubuntu-latest`），Node 固定为 **22.22.2**。npm 随该 Node 分发，记录的版本为 **10.9.7**；没有独立固定或断言 npm 版本。checkout、setup-node、cache 均固定到完整 Action commit SHA。

两个 job 没有互相依赖，也没有 `continue-on-error`。PR 默认检查 GitHub 生成的合并提交，日志的 checkout SHA 可能不同于 PR 分支 head SHA；追溯时应同时看运行元数据和 checkout 日志。

> 现状补充：本文写于两个 job 的版本。当前工作流已加入第三个 job `test`（`npm test`），三个 job 互不依赖，均先执行 `node scripts/prepare.mjs`。下文的“两项静态检查”仍准确，只是不再覆盖全部 job。

源码入口：[workflow](../.github/workflows/ci.yml)、[package.json](../package.json)、[tsconfig.json](../tsconfig.json)、[biome.json](../biome.json)。

## 2. 依赖准备具体做了什么

[pi-pin.json](../pi-pin.json) 将官方 Pi 源码锁定为：

- 仓库：`https://github.com/earendil-works/pi.git`
- 提交：`f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`

[scripts/prepare.mjs](../scripts/prepare.mjs) 的准备顺序是：

1. 读取 pin，校验参数和路径，取得准确的 Pi checkout；已有 checkout 若版本不同或有本地修改则失败。
2. 对 Pi 和应用执行 `npm ci --ignore-scripts`，按各自 lockfile 安装。
3. 从 Pi 的 `nix/model-catalog.json` 读取 catalog revision，下载对应模型目录并验证原始字节 SHA-256，再运行上游 hydration 脚本生成数据。
4. 按 `chord → telemetry → ai(build:offline) → durable` 构建依赖闭包。
5. 将应用需要的 Chord、Pi AI、Pi Durable 链接到该 checkout；验证 SHA、包名、链接目标、类型声明产物及上游受跟踪文件状态。

这避免把同名 npm registry 包当成本地 Pi 包，也避免使用未构建的类型声明。不会运行上游全仓库 build 或会改写源码的 `npm run check`。

默认 checkout 在仓库根的 `base-durable-vaction-agent/pi`。覆盖顺序为 `--checkout-dir`、`PI_CHECKOUT`、默认路径。准备过程会安装依赖并生成构建产物；只有后面的 lint/typecheck/test 是不写源码的检查。

`build:offline` 不刷新实时模型目录，但整个准备过程仍需要 GitHub、npm、pi.dev 网络访问；不能把它理解为完全离线构建。

## 3. 检查范围及如何读结果

| 检查 | 覆盖 | 边界 |
| --- | --- | --- |
| typecheck | src/**/*.ts、test/**/*.ts | scripts/*.mjs 和 vitest.config.ts 不在 tsconfig include 内；skipLibCheck 为 true |
| lint | src/**/*.ts、test/**/*.ts、scripts/**/*.mjs、vitest.config.ts | formatter/assist 均关闭；warning 不导致失败 |
| 依赖构建 | pin 中的四个 Pi package | 不等于检查整个 Pi monorepo，也没有独立的应用构建 job |

先定位失败步骤。准备失败通常属于依赖、路径、版本或网络问题；只有走到 lint/typecheck 步骤，才应按对应静态检查诊断。

**绿色**表示这次环境准备和两项静态检查成功。它不会证明会话恢复、子 Agent 上下文隔离、任务状态转换、工具证据反馈、Notion 保真写入或模型解读质量。

历史报告中的 117 warnings / 14 info 是 TASK-004 当时的基线记录，不是每次运行都固定的数量。第一版允许 warning，因此绿色也不等于零告警。

## 4. 已有验证证据

| 验证 | 结果与依据 |
| --- | --- |
| 人为加入类型错误 | [run 38342293591](https://github.com/NaoYUN77/personal-agent/actions/runs/38342293591)：typecheck 失败（TS2322），lint 成功 |
| 人为加入 explicit any | [run 38342436066](https://github.com/NaoYUN77/personal-agent/actions/runs/38342436066)：lint 失败（noExplicitAny），typecheck 成功 |
| PR 最终修订 | [run 38345499721](https://github.com/NaoYUN77/personal-agent/actions/runs/38345499721)：两项成功 |
| 合并后的 main | [run 38359956732](https://github.com/NaoYUN77/personal-agent/actions/runs/38359956732)：合并 SHA 为本文基线，lint/typecheck 及各自准备步骤均成功 |

Codex 核查了源码、相关 Actions 记录，并只读查询了合并后运行的 job/step 结果。此前复审还实际执行了针对 prepare.mjs 参数、相对路径及删除路径边界的 8 项断言，结果通过；它们是临时审阅验证，尚未作为永久 CI 测试提交。

更完整的净室验证、问题修复和实施者命令记录保留在 [TASK-004-VERIFICATION.md](reports/TASK-004-VERIFICATION.md)。不要将实施者报告标成审阅者亲自运行：本次文档整理没有在本机执行 npm 安装、构建、测试或真实模型/Notion调用。

## 5. 合并门禁现状

实施者提供的分支保护读回记录显示：main 要求 `lint` 和 `typecheck`（GitHub Actions app id 15368）；`strict=false`，`enforce_admins=false`，没有必需 PR review，禁止 force push 和删除分支。

这是**实施者提供的设置证据**。Codex 查询 branch protection 时收到 integration 403，未独立确认当前设置。工作流源码本身也不能证明 GitHub 端分支保护已配置。

因此应区分：

- CI 检查是否存在并成功：可以从 Actions 核查。
- 红色检查是否必然阻止所有人合并：取决于分支保护、身份及绕过权限。
- 当前记录允许管理员绕过，也不强制先更新到最新 main；不能宣称任何人都无法带红合并。

## 6. 后续应补充什么

以下为下一版候选任务，需分别制定验收标准，本文不修改工作流或仓库设置。

| 优先级 | 补充项 | 建议验收方式 |
| --- | --- | --- |
| P1 | 将已有无需凭据的行为测试加入 CI | 在干净 runner 运行 npm test；覆盖持久化、幂等、上下文隔离、工具白名单/证据、审阅修订、取消与恢复等已有合同；失败必须阻止合并 |
| P1 | prepare.mjs 永久回归测试 | 固定参数拒绝、CLI/env checkout 优先级、无 HEAD 的安全恢复、路径逃逸/junction 等夹具；故意引入回归时测试变红 |
| P1 | 明确 main 分支保护策略 | 决定是否要求分支基于最新 main、禁止管理员绕过、要求 review；使用有权限的账号读回并验证，保留设置证据 |
| P2 | 管理 lint warnings | 先整理现有基线，再决定逐步清理或禁止新增；不直接大规模 suppress，不混入无关重构 |
| P2 | Windows 验证 | 对本项目实际使用的 Windows/Node 组合验证路径、链接、子进程和 SQLite 行为；Linux 通过不能覆盖 Windows 问题 |
| P2 | 补齐静态检查范围 | 评估 vitest.config.ts 类型检查及脚本 checkJs；明确新增范围、现有诊断和修复规模 |
| P2 | 工具链维护 | 定期更新固定的 Action SHA，核查运行时兼容性；评估显式 npm 版本断言；ubuntu-latest 镜像仍会变化 |
| P2 | 证据与文档自动检查 | 生成含 SHA/版本的摘要及可保留的测试报告；检查文档链接，必要时检查受跟踪文件未被检查命令改写 |
| P3 | 格式检查、依赖审计与运行时边界检查 | 分开引入 formatter、依赖审计策略，以及确有需要的输入/模型/工具结果 schema 验证；类型检查不能验证外部 JSON |

真实模型和 Notion 测试应作为单独、显式启动的验证流程设计，限制凭据访问、成本与测试目标。第一版普通 PR CI 无凭据；不应为了“覆盖更多”就让每个 PR 自动写入真实 Notion。

目前也没有应用执行 sandbox 的验收项。GitHub 托管 runner 提供 CI 运行环境，不代表部署后的 Agent 工具具备文件系统或网络隔离。

## 7. 本地复现

以下为复现步骤，**不是本次文档任务已执行的命令**。先使用 Node 22.22.2，在仓库根目录执行：

```powershell
node --version
npm --version
npm run pi:prepare
npm run typecheck
npm run lint
```

预期：Node 输出 v22.22.2；npm 显示实际版本；prepare 输出准确 Pi SHA 并成功完成构建与链接；typecheck 无类型错误并退出 0；lint 无 error 并退出 0，允许 warning。

已有 checkout 冲突时使用独立目标目录，例如：

```powershell
npm run pi:prepare -- --checkout-dir "E:/Code/pi-ci-local/pi"
```

该目录应是新的或符合 pin 的 checkout。不要为了通过准备脚本而覆盖有本地修改的上游目录。可选 `--clean` 会删除部分依赖/构建产物，应按 [探针笔记 §18](probe-notes.md#18-task-004--typecheck-lint-and-the-pinned-pi-checkout) 的说明使用。

## 8. 文档维护约定

本文件负责当前 CI 能力和边界；workflow、package scripts、配置文件负责可执行规则；TASK-004 验证报告负责历史证据。更改触发方式、检查范围、版本、门禁或新增 job 时，同一个 PR 应同步更新本文。

验收记录应标明完整被测 SHA、命令或 run URL、实际结果、执行者和未覆盖项。历史失败保留在验证报告，不用新一次成功覆盖旧事实。
