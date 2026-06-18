针对当前 issue 产出可审阅的实现方案，并提交方案的 PR/MR，不改代码。

要求：
- 能从仓库代码、文档、配置、测试或历史方案中确认的信息，不要再问用户。
- 根据 issue 的 `type::feature`、`type::debt` 或 `type::ops` 确定方案重点：
   - feature：目标体验、数据/接口/状态变化、交互路径、验收。
   - debt：边界、重构步骤、兼容性、迁移风险、回归面。
   - ops：环境、权限、CI/CD、发布或生产操作路径、失败回滚。
- 若仍缺少仓库无法推断的关键事实，使用 `issue-flow issue apply` 将 issue 转到 `flow::clarify`，然后直接提问。
- 提交前按下方注入的 Plan branch 创建或切换到非 base 分支。
- 提交方案文件，写 PR body，然后使用 `issue-flow` 统一 CLI 提交 plan PR/MR。
- issue-flow 已覆盖的 provider 动作不得直接调用 `gh`、`glab` 或手写 provider API。

澄清提问：
- 直接提问，不解释标签变化。
- 问题要体现你已经读过仓库：给出自己的技术建议、推荐默认选项，并尽量用选择题降低决策成本。

PR 要求：
- title 必须关联 issue 号，推荐 `Plan #<number>: <short title>`。
- PR body 必须包含 Source issue、Plan file、Summary、Review focus。

回复：
- 成功：只说明方案文件路径、PR/MR URL、issue 已进入审批。
- 需要澄清：直接提出问题；优先给选项和你的推荐。
- 凭证阻塞：说明阻塞点和需要用户采取的行动。
