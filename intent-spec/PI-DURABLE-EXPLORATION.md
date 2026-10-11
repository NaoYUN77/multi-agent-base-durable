# Pi Durable 探索记录

## 当前判断

Pi Durable 是 Earendil Pi 项目中的实验性 agent harness，不是一个现成的聊天应用。它把对话、模型回合、工具调用和应用自己的状态作为可提交的持久化状态管理；进程中途退出后，重新打开存储可以继续尚未完成的工作。

官方文档明确标注 API 仍可能在版本之间变化，因此本工作区把它当作实验框架来研究，不把当前 API 当成稳定协议。

## 它能做什么

### 1. 构建可恢复的长任务

- 用 `MemoryStorage` 做进程内实验。
- 用 SQLite 或 JSONL 保存会话，重启后通过 `resume()` 恢复待处理任务。
- 用幂等 `requestId` 避免重试时重复提交同一个输入。
- 每一步先提交意图，再执行工具；崩溃恢复时根据工具是否声明 `replay: "safe"` 决定重放或返回中断结果。

### 2. 管理多个对话和代理

- 一个 harness 可以同时承载多个 conversation。
- 可以 fork 对话，从历史某个 entry 独立分支，并获得新的 provider session identity。
- 可以创建前台或后台 subagent；后台工作可以在父对话停止后继续。
- 可以用 task graph 表示父子任务、等待关系、失败传播和取消传播。

### 3. 扩展模型能看到的工具和提示

- 用 TypeBox 定义并校验自定义工具。
- 工具可以流式输出，返回 usage，或请求终止当前回合。
- Extension 可以提供 tools、system-prompt sections、hooks、tool wrappers 和自定义 tasks。
- Hooks 可以拦截或改写模型请求、工具参数和工具结果，例如禁止危险的 `bash` 调用。

### 4. 管理应用状态

- 用 typed documents 保存 todo、计划、工单、沙箱元数据等应用状态。
- 状态可以随 entry 一起原子提交，并支持订阅变更。
- 文档可以选择只保留最新值，或保留可回溯历史；fork 时可配置从初始值、当前值或某个历史快照开始。

### 5. 连接 UI、远端执行和多种部署形态

- `viewState()`、`watch()` 和事件流可以为 TUI、Web UI 或远程客户端提供已提交快照和增量更新。
- 环境接口允许工具运行在本机、容器、远端 VM 或 SSH 主机，而 harness 和凭据留在本地。
- 存储核心尽量不依赖 Node API，可以适配 Bun、Cloudflare Durable Object 或其他后端。

### 6. 长上下文和运行控制

- 可以把旧 transcript 压缩成 `pi.compaction` 摘要，同时保留历史记录。
- 忙碌 conversation 支持 follow-up、steer、write 和 reject 四种输入策略。
- 支持 abort、reset、handoff，以及对任务树的等待和 fail-fast 策略。

## 需要验证的关键问题

1. SQLite 和 JSONL 在 Windows 本地环境中的安装、锁定和恢复表现。
2. 工具执行到一半进程被杀死时，`replay: "safe"` 与默认策略的实际差异。
3. 多个 conversation 并发运行时，提交顺序、资源占用和 UI 观察方式。
4. 子代理在父任务 abort、重启和重复投递时是否保持幂等。
5. typed document 与 transcript 的原子性、fork 语义和 compaction 后可见内容。
6. 自定义 `ExecutionEnv` 接入容器或 SSH 时的安全边界和错误恢复。
7. Provider session identity、prompt cache、token/cost usage 在不同模型供应商上的行为。

## 建议的实验顺序

### 实验 A：内存中的一次对话

使用 `MemoryStorage`，提交一个输入，等待结果，观察 entry 和 task 的结构。这个实验只验证 Harness 的基本生命周期，不需要数据库或真实工具。

### 实验 B：JSONL 重启恢复

改用 JSONL，创建一个会延迟的工具，在工具执行期间结束 Node 进程，再重新打开同一目录并调用 `resume()`。记录哪些状态被保留、哪些步骤被重放。

### 实验 C：自定义工具和应用文档

定义一个计数工具和一个 `app.todos` 文档，让工具在同一个 commit 中更新文档并输出结果，再通过 `watchDoc()` 和 `viewState()` 观察变化。

### 实验 D：前台与后台子代理

先运行一个前台 subagent，再运行一个 background subagent；测试父对话的 follow-up、abort、重启和结果回传。

### 实验 E：真实产品形态

最后再接入 SQLite、NodeExecutionEnv、事件流和一个简单 UI，评估它是否适合做本地 coding agent、长时间研究任务、计划执行器或多代理工作台。

## 当前限制和风险

- 项目仍是 experimental，升级可能需要修改代码。
- 一个 storage 同时由一个进程拥有，不提供跨进程锁。
- 内存存储不持久化；SQLite 的最新提交在断电等极端故障下可能丢失；JSONL 可用 `fsync` 换取更强的落盘保证。
- 工具的副作用必须由应用自己设计幂等性和 replay 策略；Durable 只负责记录和调度，不会自动撤销外部副作用。
- 官方内置工具目前面向文件和进程操作，图像读取尚未支持。

## 参考资料

- Pi Durable 官方 README：<https://github.com/earendil-works/pi/blob/main/packages/durable/README.md>
- Pi Durable 设计介绍：<https://earendil.com/posts/pi-durable/>
- npm 包：<https://www.npmjs.com/package/@earendil-works/pi-durable>
- Pi-agents 扩展：<https://pi.dev/packages/pi-agents>

