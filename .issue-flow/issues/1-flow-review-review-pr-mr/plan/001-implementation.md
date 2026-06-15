## 目标

- 从 issue managed label 和 issue action 路由中移除 `flow::review`，让 `flow::` 只表示 source issue 的下一步动作：`triage`、`plan`、`build`、`clarify`、`approve`。
- 将 review 改为 PR/MR 级别的独立自动检查任务，在 PR/MR opened、synchronize、ready_for_review 或人工触发时运行。
- 新增独立开关 `ISSUE_FLOW_REVIEW_ENABLED` 控制 PR/MR review 是否自动运行，默认关闭；不复用 `automation::` 或 `ISSUE_FLOW_AUTO_DEFAULT`。
- 更新源码文档、安装产物、项目级插件副本和测试，避免继续声明或接受 `flow::review`。

## 非目标

- 不新增 `automation::review`。
- 不把 `review` 加入 source issue 的 `flow::` 状态机。
- 不改变 `flow::approve` 作为 plan/build PR 等待人工审批的语义。
- 不要求 review 结果直接推进或关闭 source issue；review 只对 PR/MR 运行检查任务。

## 当前上下文

- 相关模块：
  - `skills/issue-flow/scripts/apply.cjs` 和 `.agentrix/plugins/issue-flow/skills/issue-flow/scripts/apply.cjs` 的 `MANAGED_LABELS.flow.values` 仍包含 `flow::review`。
  - `skills/issue-flow/scripts/resolve.cjs` 和项目级插件副本仍将 `flow::review` 映射到 `review` action，并在 `automationCanRunAction` 中把 `review` 视为 build 级别。
  - `skills/issue-flow/scripts/dispatch.cjs` 当前只有 issue 事件入口：`auto`、`comment`、`resume`、`triage`、`plan`、`build`、`general`、`pr-merged`。
  - `skills/issue-flow/scripts/runtimes/agentrix.cjs` 的 `SUPPORTED_ACTIONS` 是 `triage`、`plan`、`build`、`general`，当前没有 review prompt 或 PR/MR 上下文 builder。
  - GitHub 安装产物在 `skills/issue-flow/assets/agentrix/bootstrap/workflows/github/` 下只有 issue auto、issue comment、PR merged 三个 workflow；GitLab 安装产物在 `skills/issue-flow/assets/agentrix/bootstrap/workflows/gitlab/issue-flow.gitlab-ci.yml` 中只有对应三个 job。
  - `skills/issue-flow/scripts/events.cjs` 已能把 Agentrix GitLab bridge 的 `pull_request` / `pull_request_review` 事件规范为 merge request payload，也已将 GitHub `pull_request`、`pull_request_review`、`pull_request_review_comment` 识别为相关事件名。
- 相关接口 / 数据 / 状态：
  - Source issue 状态由 `status::`、`flow::`、`automation::` 驱动；`submit.cjs plan|build` 会将 source issue 改为 `flow::approve`，`pr-merged.cjs` 在 PR/MR merge 后推进到 `flow::build` 或 `status::done`。
  - PR/MR 来源 label 当前只有 `mr-by::plan` 和 `mr-by::build`，由 `submit.cjs` 管理；review 需求不需要新增 `mr-by::review`。
  - Repo 默认 issue 自动化由 `ISSUE_FLOW_AUTO_DEFAULT` 控制，合法等级是 `off`、`triage`、`plan`、`build`；这套策略不应影响 PR/MR review。
- 既有约束：
  - 安装逻辑会把 `skills/issue-flow` 的脚本和引用文档复制到 `.agentrix/plugins/issue-flow`，所以 build 需要同步更新源码和当前仓库内已安装的项目级插件副本。
  - PR body 文件必须使用仓库外临时文件传给 `submit.cjs --body-file`，不能提交到 git。
  - 当前测试使用 Node 内置 test runner，命令为 `npm test`。

## 方案

1. 收紧 issue managed label schema。
   - 从源码和项目级插件副本的 `apply.cjs` 中删除 `flow::review`。
   - 更新 usage/help 文案和 `docs/provider-api.md`，让 `--flow` 只展示 `flow::triage|plan|build|clarify|approve`。
   - 在 `test/labels.test.cjs` 增加断言：`collectDesiredLabels({ flow: 'flow::review' })` 抛出合法值错误；必要时增加 CLI 层 dry-run/parse 覆盖。

2. 从 issue 路由中移除 review action。
   - 从 `resolve.cjs` 的 `SUPPORTED_FLOW_COMMANDS` 删除 `flow::review -> review`。
   - 删除 `automationCanRunAction` 中对 `review` 的特殊 build 级别兼容。
   - 保持未知 `flow::` label 的处理为 `unsupported_flow`，但返回不再包含 `action: 'review'`；这样旧 issue 上残留的 `flow::review` 不会执行。
   - 调整 `test/resolve.test.cjs` 和 `test/dispatch.test.cjs`：旧 `flow::review` 场景应断言 `unsupported_flow` 且没有可执行 action，而不是 runtime unsupported。

3. 新增 PR/MR review 路由入口。
   - 在 `dispatch.cjs` 增加 `pr-review` command，入口只处理 PR/MR payload，不读取 source issue `flow::` label。
   - 新增 `resolveReviewEnabled(options)`：优先读 `options.reviewEnabled`，否则读 `process.env.ISSUE_FLOW_REVIEW_ENABLED`；只有大小写不敏感的 `true` 或 `1` 视为启用，未设置、空值、`false`、`0` 都视为关闭。
   - `pr-review` 在关闭时返回 `{ action: 'skipped', reason: 'review_disabled' }`；在非 PR/MR 事件、draft PR/MR、closed/merged PR/MR 时返回明确 skip reason。
   - `pr-review` 不调用 `resolveAutomationDecision`、`resolveResumeDecision` 或 `ISSUE_FLOW_AUTO_DEFAULT`，避免 issue 自动化策略影响 review。

4. 增加 PR/MR 上下文读取能力。
   - 在 provider 层新增 `buildPullRequestContext(payload, options)`，返回统一字段：`provider`、`repoFullName`、`number`、`title`、`body`、`htmlUrl`、`state`、`draft`、`merged`、`baseRef`、`headRef`、`labels`、`author`。
   - GitHub 从 `payload.pull_request` 读取；GitLab 从 `payload.object_attributes` / `payload.merge_request` 读取，并复用 `events.cjs` 中 Agentrix bridge 已有的 PR/MR payload 构造。
   - 解析 PR/MR body/title/branch 中既有 source issue marker 作为提示上下文，但不要求存在；缺失时 review 仍可运行。

5. 在 Agentrix runtime 中实现独立 review task。
   - 新增 `review.prompt.md`，要求 agent 以代码审查立场检查 PR/MR diff、行为风险、测试缺口，并将结果发布到 PR/MR；提示中明确不得修改 source issue label。
   - 新增 runtime 方法或 action 分支用于 `pr-review`，构造 PR/MR prompt，而不是复用 `formatIssueForPrompt`。
   - Agentrix metadata 使用 `issue_flow_action=pr-review`、`issue_flow_pr=<repo>#<number>`，如果识别到 source issue，再补充 `issue_flow_source_issue=<repo>#<number>`。
   - 任务防重使用 PR/MR 评论 marker，例如 `<!-- issue-flow:task:agentrix:pr-review -->`，评论写在 PR/MR 上；不要在 source issue 上创建任务锁评论。

6. 新增安装产物。
   - GitHub 新增 `.github/workflows/issue-flow-pr-review.yml` 源模板，触发：
     - `pull_request` types: `opened`、`synchronize`、`ready_for_review`
     - `workflow_dispatch`，输入 `pr_number` 供人工触发
   - GitHub job 的 `if` 同时检查 `vars.ISSUE_FLOW_REVIEW_ENABLED == 'true'` 且 PR 不是 draft；人工触发也使用同一开关，避免误运行。
   - GitLab CI 新增 `issue-flow-review` job，匹配 Agentrix bridge 的 `pull_request` opened/synchronize/ready_for_review 类事件，并提供 `when: manual` 人工触发路径；脚本调用 `dispatch.cjs pr-review --provider gitlab`。
   - 更新 `bootstrap.cjs` 的 GitHub/GitLab install spec、manifest 测试和 README “What It Installs”，确保新 workflow/job 会被安装和升级跟踪。

7. 更新项目级插件和文档。
   - 同步更新 `.agentrix/plugins/issue-flow/skills/issue-flow/` 下的脚本、runtime prompt、label reference，因为当前仓库跟踪了安装后的项目级插件副本。
   - 更新 `skills/issue-flow/SKILL.md` 和 `.agentrix/.../SKILL.md` 的 label 表，移除 `review`。
   - 更新 `skills/issue-flow/references/labels.md` 和项目级副本，删除 `flow::review` 行。
   - 更新 `docs/state-machine.md`，新增 “PR/MR Review Check” 小节：review 是 PR/MR 自动检查，不是 issue gate；`flow::approve` 仍是人工审批 gate。
   - 更新 `README.md` 的配置项，说明 `ISSUE_FLOW_REVIEW_ENABLED` 默认关闭，启用后才在 PR/MR opened/synchronize/ready_for_review 或人工触发时排队 review。

8. 测试覆盖。
   - `test/labels.test.cjs`：覆盖 `flow::review` 被 `apply.cjs` 拒绝。
   - `test/resolve.test.cjs`：覆盖带旧 `flow::review` label 的 issue 返回 `unsupported_flow`，且没有 `action: 'review'`。
   - `test/dispatch.test.cjs`：覆盖 `pr-review` 在 `ISSUE_FLOW_REVIEW_ENABLED` 未设置/false 时 skip，在 true 时 dry-run 排队 runtime review；同时确认 `ISSUE_FLOW_AUTO_DEFAULT=build` 不会启用 review。
   - `test/bootstrap.test.cjs`：覆盖 GitHub 新 workflow 被安装，GitLab CI 包含 `issue-flow-review` job，并传递 `ISSUE_FLOW_REVIEW_ENABLED`。
   - `test/agentrix-runtime.test.cjs`：覆盖 review prompt 使用 PR/MR 上下文，不包含 `flow::`/`automation::` 作为 issue action 指令。

## 验证方案

- 自动验证：
  - 运行 `npm test`。
  - 重点检查 `test/labels.test.cjs`、`test/resolve.test.cjs`、`test/dispatch.test.cjs`、`test/bootstrap.test.cjs`、`test/agentrix-runtime.test.cjs` 的新增断言。
- 手动验证：
  - `node skills/issue-flow/scripts/apply.cjs --issue-number 1 --flow flow::review --dry-run` 应失败并提示合法 flow 值不包含 `flow::review`。
  - 构造带 `flow::review` label 的 issue payload 调用 `dispatch.cjs auto --dry-run`，应 skip `unsupported_flow`，且不会出现 `action=review`。
  - 构造 PR opened payload，在未设置 `ISSUE_FLOW_REVIEW_ENABLED` 时调用 `dispatch.cjs pr-review --dry-run` 应 skip `review_disabled`。
  - 设置 `ISSUE_FLOW_REVIEW_ENABLED=true` 后用同一 PR payload 调用 `dispatch.cjs pr-review --dry-run`，应输出 Agentrix review dry-run prompt 和 PR/MR task metadata。
- 回归范围：
  - Issue intake、auto、comment、resume 的 source issue flow 路由。
  - Plan/build submit 后的 `flow::approve` 转移。
  - `mr-by::plan` / `mr-by::build` merge 后的 source issue 转移。
  - GitHub/GitLab bootstrap 安装和 reinstall manifest。
  - 项目级 `.agentrix/plugins/issue-flow` 副本与源码 skill 的一致性。
