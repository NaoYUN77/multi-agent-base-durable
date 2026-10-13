# TASK-005 审阅规范

适用于本任务所有 PR，补充 WORKFLOW.md，不替代其认领、Draft、合并授权规则。

## 函数与注释规范

- 新增导出的函数/类型使用 TypeScript strict；显式参数、Promise 返回类型与readonly合同。外部输入以 unknown 接收并校验；禁止以 any/as 强制绕过验证。
- 参数较多使用具名 options 对象；依赖显式注入。配置解析/Prompt组装与IO/持久化/会话启动分离，不以模块全局变量保存额度或任务状态。
- 应用API使用camelCase，持久化字段和命名保持一致，记录schemaVersion；管理工具名称用snake_case。函数名的局部调整可以说明，行为合同不可变。
- 所有新增公开函数/工厂/状态转换函数有JSDoc：职责、参数及授权来源、返回/错误语义、副作用、幂等/恢复边界。纯函数明确无IO；副作用函数说明写哪些Document或启动哪些工作。
- 非显而易见的事务边界、取消准入、额度预留与状态竞争有解释“为什么”的注释；不要用重复代码的逐行注释或过期Task描述代替说明。
- 审阅检查注释与实现一致；不得将replay safe写成外部副作用exactly-once。
- 函数样式示例（概念签名，不是现成Durable API）：

```ts
/** Builds a validated config from authorized capabilities.
 * Performs no storage writes or model calls.
 * Throws a typed configuration error for missing skills or tools.
 */
function buildSubAgentConfig(
  input: ValidatedTaskSpec,
  dependencies: BuilderDependencies,
): SubAgentConfig;
```

## API检查

逐项核对锁定源码导出与实际签名：configure/tools/modelTools/extensions；createConversation ownership；submit/wait；abort；Document commit；watch句柄释放；工具参数及structuredOutputSchema。有可用接口不等于已证明运行行为。不得引用其他版本或OpenHands名字当Pi API。

所有管理工具以Schema校验，拒绝旧计划/未知任务/跨任务证据。模型字段与Runtime字段分权。终态不能被模型重写。错误返回应有稳定code及可恢复信息，不泄漏token。

## 必须检查的竞争与恢复边界

- 同任务不同调用、并发返工：仅一个执行者；不同任务确实重叠运行。
- 配额耗尽、排队取消、运行取消、quota释放与新启动：原子校验，无取消终态后的提交。
- 意图保存后未提交、创建后未输入、结果已保存未回父、配额占用时kill：重启同ID/同配置/同会话，不重复收据或副作用。
- 需求变更、陈旧review、迟到子结果：不污染新计划，不错误宣称完成。
- 工具修参、改操作ID、并行失败调用、SDK内部尝试：预算无法绕过；重放不双扣。
- finish提交后行为、异常无finish：两者都有真实结算结果，不能以提交工具名字推断已停止。

## 测试与证据

每PR提供AC→源码→测试→证据表。记录完整被测SHA、Node/npm/Pi pin、完整非敏感命令、退出码和计数；真实运行记录DB绝对路径、requestId、plan/task/round、Conversation/Submission/Entry等标识。

区分类型/lint、faux、真实模型、正常reopen、强制中断恢复、手工TUI；一个不能替代另一个。测试不得仅断言模型声称成功或计时“看起来并行”：以双进入握手和DB记录证明执行重叠与边界。

新测试合入CI，用已有faux router、临时库和明确屏障；不带生产凭据。真实样例需逐项人工核查澄清是否必要、计划覆盖、结果依据和Main审阅质量；报告实际失败，不选成功结果覆盖失败。

TUI实际录屏/截图或终端交互记录至少覆盖中文/粘贴、resize、长输出、动画关闭、等待用户、双任务、取消、退出重开、错误恢复；记录尺寸/终端。无TTY退出明确错误，不挂起CI。

## PR与合并

正文沿用八栏目：关联Issue、问题与结果、修改范围、AC对应、实际验证、未执行、风险、spec差异。仅关闭自身子Issue，不提前关闭总任务。实现或强制验证不全保持Draft。

每次复审对新SHA核对全部diff及受影响检查。静态绿色不代表语义通过；faux不代表真实服务。合同偏离需用户确认链接。

P1/P2实质缺陷和必需AC未通过不得验收；明确指出路径/行号/触发条件/结果/修复要求。同账号不能APPROVE时以COMMENT给出结论。未经用户单独授权不合并、不关闭总Issue。

## 总体验收

全部依赖PR合入后，在main准确SHA重跑集成，证据归属一致，文档/命令/配置/CI同步。产品数量默认值仍未决定；运行必须显式有限配置，fixture数字仅用于验证。任何Sandbox声明必须有环境证据；本任务不承诺Sandbox。
