## 目标

- 在仓库级配置中增加显式的 PR/MR 评论作者黑名单，使命中的机器人或自动化账号评论在进入 resume 路由前被忽略，避免 review、build 等 Agentrix task 被无效恢复或形成评论链。
- 保持现有人工评论、未命中评论、未配置黑名单时的 `review-comment` 流程不变，并继续保留 `review::off` 对单个 PR/MR 自动 review 的原有语义。

## 非目标

- 不改变 review、build、resume task 的执行协议、task marker、task lock 或 provider API 行为。
- 不按评论正文做关键词、正则或内容匹配；不增加单个 PR/MR 临时黑名单或默认屏蔽所有 bot 账号的策略。
- 不删除、替代或重新解释 `review::off`；该标签仍只负责关闭对应 PR/MR 的自动 review。
- 不引入跨事件持久化去重机制；重复事件仍由现有事件过滤、task marker 和 provider 幂等机制负责。

## 当前上下文

- 相关模块：
  - `plugin/skills/issue-flow/scripts/dispatch.cjs` 的 `runReviewComment` 是 GitHub PR 与 GitLab MR 评论恢复的统一入口；当前顺序为事件校验、获取归一化评论、source provenance 过滤、PR/MR 状态过滤、task marker 查找、评论 acknowledge 和 task resume。
  - `plugin/skills/issue-flow/scripts/providers.cjs` 已分别实现 `getGithubReviewCommentContext` 与 `getGitlabReviewCommentContext`，并将作者归一化为 `reviewComment.author` 字符串：GitHub 使用 `comment.user.login`，GitLab 使用 `payload.user.username` 或 `payload.user.name`。
  - `plugin/skills/issue-flow/scripts/runtimes/agentrix.cjs` 已统一解析 `.issue-flow/config.json`（支持 `agentrix` 配置段）并暴露 runtime 配置路径；现有配置主要用于 prompt/template/plan 路径。
  - `plugin/test/dispatch.test.cjs` 覆盖 review-comment 的事件动作、回复、source provenance、PR/MR 状态、acknowledge 和 task resume；`plugin/test/providers.test.cjs` 覆盖 provider 归一化行为；`plugin/test/agentrix-runtime.test.cjs` 覆盖项目配置解析。
  - 管理员文档位于 `README.md` 与 `plugin/docs/provider-api.md`；工作流模板位于 `plugin/skills/issue-flow/assets/agentrix/bootstrap/workflows/github/issue-flow-pr-review-comment.yml` 与 GitLab 对应 CI 模板。
- 相关接口 / 数据 / 状态：
  - 新增规范配置字段为 `.issue-flow/config.json` 的 `agentrix.reviewCommentAuthorBlacklist`，类型为字符串数组；每个元素表示一个作者身份，按 provider 已归一化的登录名/用户名做完整匹配。
  - 配置解析阶段去除首尾空白；空数组、字段缺失或配置文件不存在时视为未启用，不改变现有流程。非字符串项或空字符串不参与匹配，并在配置解析测试中固定行为；配置 JSON 语法错误继续按现有显式配置错误处理，不静默放行。
  - 匹配采用 Unicode-aware 的大小写不敏感比较（对作者和条目分别 `trim` 后使用统一大小写形式比较），不使用通配符、模糊匹配或评论正文；作者缺失时不会命中任何黑名单条目。
  - 黑名单判断必须位于 `runReviewComment` 的所有副作用之前，至少早于 `acknowledgeReviewComment`、`resumeTaskForReviewComment` 以及任何 task lock/任务评论操作；命中时返回 `action: 'skipped'`、稳定的 `reason: 'comment_author_blacklisted'`、归一化作者和评论 ID，并记录可诊断日志。
  - 配置对象应由 runtime 暴露给 dispatch（或由共享配置解析 helper 读取），避免 GitHub/GitLab 分别实现不同的规则；provider 只负责提供归一化作者，不根据 `user.type`/`bot` 自动屏蔽。
- 既有约束：
  - agent-facing provider 操作必须通过 `.issue-flow/cli.cjs`；本次方案只提交 plan 文件，不修改实现代码、既有 Prisma migration 或 workflow 行为。
  - GitHub 与 GitLab 的事件载荷字段不同，测试必须分别覆盖 provider 归一化后的作者身份，而不是直接依赖某一个原始字段。
  - `review-comment` 只处理新建的顶层 review comment；编辑、回复、非 PR/MR note 等现有跳过原因优先级保持不变。黑名单配置不应通过评论正文或 `review::off` 实现。

## 方案

1. **定义并解析仓库配置**
   - 在 Agentrix runtime 的项目配置解析中增加 `reviewCommentAuthorBlacklist` 规范化结果，默认值为空数组；保持现有 `.issue-flow/config.json` 的 `agentrix` 命名空间约定，并在配置文档中给出完整示例，例如 `"reviewCommentAuthorBlacklist": ["dependabot[bot]", "ci-bot"]`。
   - 新增小型、可单测的匹配 helper：校验数组形状，过滤非字符串/空项，trim 条目，按大小写不敏感的完整身份比较返回命中结果及规范化作者。不要把 GitHub 的 bot 类型、GitLab 的 bot 字段或评论 body 纳入规则；配置为空时 helper 明确返回未命中。
   - 对显式 `--config`/`ISSUE_FLOW_CONFIG` 保留现有错误边界：配置 JSON 不可解析时失败并给出路径；未提供项目配置时沿用默认空配置。若配置项形状错误，采用“忽略无效项、保留有效字符串”的兼容策略，并让日志/测试明确这一行为，避免单个错误条目阻断全仓库评论处理。

2. **在统一 review-comment dispatch 入口实施前置过滤**
   - 在 `runReviewComment` 取得 provider 归一化的 `reviewComment` 后、source provenance/PR 状态和所有副作用前调用黑名单 helper；命中后只输出诊断日志并返回跳过结果，不 fetch 依赖性更强的当前 PR 状态，不 acknowledge，不创建/更新 task lock，不向已有 task 发送 resume。
   - 返回结构包含 `action: 'skipped'`、`reason: 'comment_author_blacklisted'`、`reviewComment`、`author`，必要时包含 provider/config source，方便 GitHub Actions 与 GitLab CI 日志定位；稳定 reason 不受作者大小写或原始字段变化影响。
   - 保持未命中路径逐行复用现有逻辑：source provenance、关闭/草稿/`review::off` 等 PR/MR 判断、task marker、acknowledge 和 resume 的顺序与语义不变。作者缺失、黑名单未配置及不匹配作者均继续现有流程；重复事件不新增行为，仍由已有事件动作校验和 task resume marker/锁机制处理。

3. **补齐 GitHub/GitLab 事件与边界测试**
   - 在 `plugin/test/agentrix-runtime.test.cjs` 或相邻 runtime 测试中覆盖：默认空配置、合法数组、trim、大小写不敏感、重复条目/空项、非字符串项、缺失配置文件和无效 JSON 的解析边界。
   - 在 `plugin/test/dispatch.test.cjs` 中分别构造 GitHub `comment.user.login` 与 GitLab `payload.user.username`/`name` 的 review-comment 事件，覆盖命中与未命中；断言 GitHub/GitLab 命中均为稳定跳过 reason，且 reaction、resume、创建/更新评论和 task lock 相关 provider mock 均未被调用。
   - 增加作者缺失、大小写差异、仅评论正文包含黑名单字符串但作者不匹配、未配置黑名单、人工作者未命中、编辑/回复/重复事件的测试，证明匹配字段和现有事件语义边界。
   - 保留并运行现有 `review::off`、source provenance、missing task marker、closed PR/MR 与正常 resume 测试，确保新判断不会改变其 reason 优先级或正常 acknowledge/resume 行为；如 helper 独立导出，增加直接单元测试以避免只靠端到端 dispatch 覆盖配置解析。

4. **更新管理员配置与事件流程文档**
   - 在 `README.md` 的安装产物/配置说明中描述字段位置、数组格式、完整匹配、大小写不敏感、trim/无效项、空配置、作者缺失和“只匹配作者不匹配正文”的规则，并明确 GitHub 与 GitLab 共用同一配置。
   - 在 `plugin/docs/provider-api.md` 的 dispatch/review-comment 流程章节增加过滤时机与跳过 reason，说明命中事件不会 acknowledge、创建 task lock 或 resume task；同时说明 `review::off` 仍是 PR/MR 级自动 review 开关，不是作者黑名单。
   - 同步 bootstrap 配置示例/安装文档（若该仓库已有对应示例资源），确保新安装项目能看到可复制的空数组或示例配置；不修改 GitHub/GitLab workflow 触发条件，过滤由统一 dispatch 入口完成。

5. **按验收标准交付与回归**
   - 先运行针对 runtime、provider、dispatch 的 Node test，再运行仓库现有 plugin test 全集；检查输出中的 skip reason 和 provider mock 调用计数。
   - 使用最小 GitHub 与 GitLab fixture 做一次 dry-run/manual dispatch，分别验证命中作者不会触发副作用、未命中作者仍返回现有 resume 结果；验证事件正文含黑名单词但作者不同不会跳过。
   - 在 PR review 中重点审阅配置向后兼容、匹配规范化、过滤位置（所有副作用之前）、两 provider 字段归一化、reason 可诊断性，以及 `review::off` 与重复事件语义是否保持不变。

## 验证方案

- 自动验证：
  - `node --test plugin/test/agentrix-runtime.test.cjs plugin/test/providers.test.cjs plugin/test/dispatch.test.cjs`
  - `npm test`（或仓库当前 package scripts 对应的 plugin/全量测试命令），确认既有 suite 无回归。
  - 配置解析 fixture：缺失/空数组、大小写与空白、重复/无效项、无效 JSON；dispatch fixture：GitHub/GitLab 命中、未命中、作者缺失、正文误匹配、编辑/回复及重复事件。
- 手动验证：
  - 在临时配置中加入 GitHub bot 与 GitLab automation 用户名，分别调用 `dispatch review-comment --event <fixture> --dry-run`，确认命中日志含 `comment_author_blacklisted` 且无 acknowledge/resume/task-lock 输出。
  - 用相同事件将作者改为人工/未配置作者，并用正文包含黑名单字符串的评论做对照，确认继续走既有流程；为带 `review::off` 的 PR/MR 验证其原有自动 review 关闭语义未被改写。
  - 检查管理员文档中的配置示例、dispatch 命令、锚点/链接和字段名与最终实现一致；如新增示例脚本，执行示例命令验证有效。
- 回归范围：
  - `runReviewComment` 的 GitHub PR 与 GitLab MR 新建顶层评论路径，以及 provider 评论作者归一化。
  - acknowledge reaction、task marker/lock、Agentrix task resume、source provenance、PR/MR 状态与 `review::off` 判断。
  - `.issue-flow/config.json` 读取失败/缺失的既有行为、bootstrap 配置说明和相关管理员文档。
