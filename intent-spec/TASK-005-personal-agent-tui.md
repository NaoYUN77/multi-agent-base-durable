# TASK-005：通用个人 Multi-Agent 与 TUI

状态：已授权拆分实施；具体认领条件以关联 Issue 标签和依赖为准。本文是行为合同，新增函数名属于应用 API 设计，不是 Pi Durable 原生 API。

## 目标与范围

用户通过 TUI 自由输入。Main Agent 在长期会话中澄清需求、保存计划，使用动态配置工厂为不同子任务创建独立 Sub-Agent，并行执行、收集证据、审阅返工和汇总。Notion 是可选业务工具，不作为核心职责。

复用锁定 Pi f44707e7f7190a8cc86ce105790c72c6b0f5fd5f 的循环、Conversation、Document、Storage 和恢复机制。主子使用同模型；不修改上游核心、不实现 Agent Loop、不引入模型路由/递归委派/Web UI/VPS/新 Sandbox。工具白名单不等于进程或网络隔离。

## 已确认底座与差距

现有 src/multiagent/delegation.ts 使用 tx.createConversation、configure、submit、Submission.wait；工具通过 tools/modelTools 配置。ledger.ts 已有操作绑定、执行权、审阅/返工、取消与收据。现有技术失败会进入 failed 终态，需要区分轮次失败和最终业务失败。

Pi packages/durable/src/harness/types.ts 公开 Conversation.configure/submit/abort/watch、Harness.watchTaskGraph 及 ToolRegistration；generation.ts 的并行受设置与同轮工具模式影响。packages/tui/src/index.ts 导出 Editor、Loader、ScrollView、SelectList 和终端组件。TUI 不在当前 pi-pin 构建闭包，需追加精确本地链接和构建验证，不安装 registry 同名包。源码可用不等于 Windows 交互已验证。

## Main Agent 合同

- 输入及补充回答都重新检查目标、材料、范围、授权、交付条件。
- 关键疑惑提问等待；简单明确任务可直接处理。
- 用户回答由应用记录来源，模型不能代填用户回答。收到回答不等于语义已经充分。
- request_clarification 保存问题、原因、阻塞范围；save_plan 保存可版本化草案；dispatch_tasks 仅引用已保存计划/任务 ID。
- 问题结束当前模型轮次，不能无限挂起工具。回答以新输入进入同一主 Conversation。
- 启动前检查计划版本、相关问题、前置 accepted、权限及额度。读到旧版本一律拒绝；计划保存并非执行授权。
- 一期父会话模型等待当前批次结算；TUI 输入/取消/状态线程保持响应。普通新任务在忙碌时排队并显示，用户可撤回未执行输入；紧急停止走控制接口，不排在普通输入后。
- 补材料可继续原子会话，不计质量返工；目标实质变化需新计划版本，未启动工作替换，受影响运行工作先取消并确认停止，旧结果标为旧版本。

## 任务、Skill、工厂与权限

TaskSpec 包含 schemaVersion、应用生成/映射的稳定 ID、目标/用途、材料及来源、范围/排除项、约束、输出合同、验收项、Skill ID、工具请求、依赖、预算。自由 taskPrompt 不得覆盖结构字段；程序从校验后的合同生成提交文本，模型生成的正文保留明确边界。

buildSubAgentConfig 解析本地受控 Skill manifest（ID/版本/哈希/入口/工具需求），不执行 Skill 脚本、不按任意路径加载。基础协议+Skill 是应用组装指令；任务和材料通过 submit 输入。固定策略不能靠字符串顺序获得安全保证。

authorizeTask 产生已授权能力集合；工厂仅接受该集合，未知/越权/必需工具缺失明确拒绝，不静默削减或扩权。tools 与 modelTools 均设准确集合，extensions 使用明确集合避免继承业务指令；空工具集合合法。Main 可委派集合与 Main 直接工具集合分别定义。

第一版提供两个纯本地文本工作流程（统计核验、基于给定材料归纳），使用 text_stats/text_check 或空工具集合，验证组合而非强制每任务用工具。不默认接入 Notion 写入；保留其独立现有入口。

最终配置快照保存 schemaVersion、需求/计划版本、Prompt、Skill 版本/哈希、实际工具版本标识、模型、预算、配置哈希；不保存凭据。恢复配置不可悄悄改变；注册实现不兼容时拒绝恢复并报告。

## 生命周期、并行与额度

一子任务一实例一 Conversation；同轮最多一个执行者；返工复用会话；终态不可再执行；新任务新会话；历史保留。

不同任务在无依赖/资源冲突时按批次并行。状态逐项持久化，批次按任务分别返回正常结果/失败/阻塞/取消/超时，不因普通单项失败丢弃独立项。不采用无超时的无限等待。

业务状态候选为 planned/running/awaiting_review/awaiting_input/accepted/failed/cancelled；轮次为 queued/running/retry_wait/completed/failed/cancelled。首个合同 Issue 必须给出转换表与旧 revising 数据兼容方式。accepted/failed/cancelled 为业务终态；取消先持久化意图，确认无活跃执行后终态。

运行配置显式给出 maxConcurrentSubAgents、maxSubAgentsPerRequest、maxToolInvocationsPerRound、maxFailedToolCallsPerRound、maxAttemptsPerOperation、maxTechnicalRestarts、roundTimeoutMs，以及 provider/harness retry 策略。无配置/无效配置启动前报错，不设无依据无限值；质量返工沿用上限2。测试自行给出有限 fixture 数值，不代表产品默认值。

配额按用户请求和轮次持久化；预留+检查同 commit；恢复核对真实持有者。读写资源声明用于调度，同资源写互斥、读可共享；一期纯文本工具无外部写入，新增副作用工具另审其冲突/授权/重放规则。

## 三层故障与结果

模型暂时故障按 provider/harness 策略有限重试，不计质量返工；工具失败允许轮内有限自救；整轮失败或不合格由 Main 决策。鉴权/权限失败不自动反复调用；结果不确定的副作用不盲重试。内部 SDK attempt 若无法观测则关闭其重试并由受控层实施，不允许隐藏无限重试。

操作计数绑定程序生成的 operationId；模型引用已存在操作，参数修改不新获额度。每轮总调用和总失败兜底，换操作ID/工具也受总额限制。Schema/授权拒绝计入模型失败请求预算；恢复重放同调用不得重复扣费，真正新尝试计数。耗尽后停止业务调用并结算，finish/status 控制通道不被业务额度堵住。

TaskResult 是版本化结构对象，存 Durable Document；JSON/Markdown 仅导出。Runtime 填身份、真实运行状态、错误分类、次数、副作用未知及证据引用；模型填摘要/发现/未解决项/产物引用。证据来自 Entry/Task/Submission 并校验归属，不能从模型文本推测成功。Main 最终交付也保存结构化结果并关联 accepted 子任务；终态收据不可改写，review另存。

finish_task 可作为模型结构化提交入口，但不得自行 accepted。首个 Issue 必须依据源码验证“提交后停止本轮”的可行机制；若无可靠公开机制，采用结构校验的最终答案+Submission.wait，明确记录替代协议，不能改核心或靠提示保证终止。

## TUI 正式入口

npm run agent:tui -- --db <path> --config <path>，参数/脚本由实现提交后成为公开合同。可选 --no-animation。TUI 和 headless入口共用应用服务；呈现层不维护第二份业务状态。

会话输出、中文多行输入、当前澄清问题及选项/自由回答、任务列表/详情/证据可访问。每行显示任务名、轮次、排队/执行/重试等待/待审阅/返工/终态、耗时、工具活动；动画只表示运行，确定总步骤才显示百分比，不捏造任务进度。支持无动画、窄终端、无颜色、resize、长输出滚动。

提供单任务/整请求取消、只读查询证据、重新打开。/quit 停止本机调度并正确关闭 Harness/Storage后退出，不将任务改 cancelled，重开可恢复；退出前明确说明运行将暂停，不能暗示离线后台继续。/cancel 才是业务取消。Ctrl+C 行为与退出一致，终端 raw mode/光标必须恢复。状态/取消不等待父模型批次返回。

待澄清、权限错误、网络错误、空状态明确显示且可恢复。Windows PowerShell/Windows Terminal 与 Linux CI 交互记录分别验证，不能用组件快照代替真实键盘操作。

## 实施边界

新实现集中 durable-cli-probe/src/agent、src/multiagent、src/tui、skills、test、必要脚本与配置；组织可以局部调整但不得全仓库重构。旧 CLI/smoke/Notion 独立入口保持回归。任何对外合同变更更新本文及相关 Issue；未确认实现方式先提交调查结论，不自行扩展目标。

## 验收总览

需求澄清/复问/无需提问；计划版本和阻塞检查；动态Skill+Prompt隔离；工具白名单及空集合；不同任务真正并行、同任务唯一执行；持久配额和故障三层；每轮/主结果结构化证据；审阅返工；取消与崩溃恢复；TUI中文输入/忙碌响应/恢复/终端清理；CI执行确定性测试；真实模型澄清与双子任务验证。

真实服务只用本机已有配置且显式运行，不将凭据交普通 PR CI。不自动写 Notion、不发布、不合并。验收依据见 TASK-005-REVIEW.md，分项精确 AC 见关联 Issues。
