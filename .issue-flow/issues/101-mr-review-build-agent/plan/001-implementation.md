## 目标

- 为单个 open PR/MR 提供明确、可发现、可逆的自动 review 暂停开关，建议使用 PR/MR 级 managed label `review::off`；维护者添加标签即可暂停，移除标签即可恢复。
- 暂停同时覆盖两条会延续 review/build 循环的入口：`dispatch review` 创建或恢复 reviewer task，以及 `dispatch review-comment` 根据 PR/MR body marker 恢复原 task。
- 每次触发都以 provider 上最新 PR/MR 状态和 labels 为准；命中暂停时不创建、不恢复 Agentrix task，并返回稳定的结构化原因 `pull_request_review_disabled`，便于 GitHub Actions、GitLab CI 和 CLI 日志诊断。
- 保持 GitHub 与 GitLab 行为一致，并明确仓库级 `ISSUE_FLOW_REVIEW_ENABLED` 与单 PR/MR 开关的优先级：仓库级关闭时全局禁用，仓库级开启时 `review::off` 仍可对单个 PR/MR 进行更严格覆盖，单 PR/MR 标签不能反向开启仓库级已关闭的 review。
- 移除 `review::off` 后不修改 source issue、不重建 PR/MR、不清理既有 task marker；下一次既有 opened/synchronize/ready-for-review、review comment 或手动 review 触发按原流程执行。

## 非目标

- 不取消、终止或回滚在添加 `review::off` 前已经进入 Agentrix 执行中的 task；门禁只保证后续触发在创建或 resume 前被阻止。
- 不新增 issue 级状态，不复用 `automation::off` 或 `status::suspend`，也不读取 source issue 的 flow/status 作为 PR/MR review 门禁。
- 不改变 plan、build、approve、merged 的状态迁移，不改变 `mr-by::plan` / `mr-by::build` 的来源语义。
- 不在移除标签时自动补跑暂停期间错过的 review/comment 事件；需要立即恢复时使用现有手动 review 入口，后续正常事件也会自然恢复。
- 不在 workflow/job 的事件过滤表达式中仅依赖 webhook payload labels 直接跳过，因为 payload 可能过期、GitHub/GitLab 字段形态不同，且手动入口没有同等 payload；最终判定统一放在 dispatch 拉取最新 PR/MR 之后。

## 当前上下文

- 相关模块：
  - `plugin/skills/issue-flow/scripts/dispatch.cjs` 的 `runReview()` 先检查 `ISSUE_FLOW_REVIEW_ENABLED`，再通过 provider fetch 当前 PR/MR，调用 `shouldSkipPullRequestReview()` 过滤 draft、merged 和非 open 状态，最后进入 `startPullRequestReview()`；这里是自动 review 创建/恢复的统一门禁点。
  - 同文件的 `runReviewComment()` 会解析 GitHub/GitLab review comment 事件、过滤 issue-flow 自身评论、fetch 当前 PR/MR、调用同一个 `shouldSkipPullRequestReview()`，再从 PR/MR body 提取 Agentrix task id 并执行 `resumeTaskForReviewComment()`；当前不会读取 source issue，符合新增 PR/MR 级门禁的落点。
  - `plugin/skills/issue-flow/scripts/providers.cjs` 已把 GitHub `labels[].name` 和 GitLab label 字符串/对象统一归一为名称数组，且 `fetchCurrentGithubPullRequest()` / `fetchCurrentGitlabPullRequest()` 都返回最新 labels，不需要新增 provider API。
  - `plugin/skills/issue-flow/scripts/labels.cjs` 是 managed label catalog 单一来源；`labelsForScope('merge_request')` 当前只包含 `mr-by::plan` 和 `mr-by::build`，`labels sync/check` 会从 catalog 自动向 GitHub/GitLab 确保 label metadata。
  - `plugin/skills/issue-flow/assets/agentrix/bootstrap/workflows/github/issue-flow-pr-review.yml` 监听 opened、synchronize、ready-for-review 和 manual dispatch；`issue-flow-pr-review-comment.yml` 监听普通 PR comment 与 inline review comment。
  - `plugin/skills/issue-flow/assets/agentrix/bootstrap/workflows/gitlab/issue-flow.gitlab-ci.yml` 对应提供 `issue-flow-review` 和 `issue-flow-review-comment` jobs；两者最终调用相同 dispatch 命令，因此 label 判定不应在 provider-specific workflow 中重复实现。
  - `plugin/test/dispatch.test.cjs` 已覆盖 review enable flag、review task 去重/按 head resume、manual draft skip，以及 GitHub/GitLab review-comment resume 与 skip；`plugin/test/labels.test.cjs`、`plugin/test/bootstrap.test.cjs` 和 provider 测试可扩展验证 label catalog、安装产物与双 provider 标签归一化。
- 相关接口 / 数据 / 状态：
  - 新增 managed label `review::off`，prefix 为 `review::`、scope 为 `merge_request`，建议颜色 `6A737D`，描述为 `Automatic review and review-comment task resume are disabled for this PR or MR`。
  - `review::off` 是“存在即关闭”的单标签开关，不新增 `review::on`；无标签表示继承仓库默认，避免给所有正常 PR/MR 批量加标签，也使移除标签自然恢复。
  - 有效决策顺序为：PR/MR 必须存在且 open、非 draft、未 merged；仓库级 review 必须启用；PR/MR 不得含 `review::off`。仓库级关闭返回既有 `review_disabled`，单 PR/MR 暂停返回新增 `pull_request_review_disabled`。
  - `dispatch review-comment` 也应接收 `ISSUE_FLOW_REVIEW_ENABLED`，使文档中的“仓库级总开关”真实覆盖 review task 创建和 comment resume；GitHub/GitLab comment workflow 只负责传递变量，具体 skip 仍由 dispatch 输出。
  - 暂停期间保留 PR/MR body 中的 source/task marker、review task lock comments 和 source issue 状态，不写入额外持久化状态；恢复后现有 task 去重与按 head SHA resume 规则继续生效。
- 既有约束：
  - 所有 provider 操作继续通过 issue-flow provider abstraction 和统一 CLI，不直接调用 `gh`、`glab` 或 provider API。
  - label 判定必须基于 fetch 后的当前 PR/MR，不能只信任触发事件中的 labels；这样添加标签与并发事件相邻发生时，尚未启动的 dispatch 能看到最新开关。
  - 并发窗口内若 task 已经开始，新增门禁不能强制取消，符合 issue 非目标；实现只需确保在 `startPullRequestReview()` 或 `resumeTaskForReviewComment()` 前完成最终判定。
  - bootstrap 管理 GitHub workflows、GitLab CI include 和已安装 skill；实现应先更新 `plugin/skills/issue-flow` 源资产，再通过现有 bootstrap/manifest 测试保证安装副本一致，避免手工维护派生文件。

## 方案

1. 在 managed label catalog 中增加 PR/MR 级暂停标签。
   - 在 `plugin/skills/issue-flow/scripts/labels.cjs` 增加独立 `review` group：prefix `review::`、scope `merge_request`、唯一值 `review::off`，使用稳定颜色和描述。
   - 不把它加入 issue create/apply 参数，也不允许 issue 使用；继续由 `labels sync` / `labels check` 从 catalog 同步到 GitHub/GitLab，安装或升级后无需额外 provider-specific 配置。
   - 扩展 `plugin/test/labels.test.cjs`，确认 `labelsForScope('merge_request')` 同时包含 `mr-by::*` 和 `review::off`、metadata 稳定、issue scope 不包含该标签，且现有 label 组不受影响。

2. 将 review 是否可运行收敛为 dispatch 的统一决策。
   - 扩展 `shouldSkipPullRequestReview()` 或提取等价 helper，在现有 PR/MR 状态检查后读取归一化 labels；命中 `review::off` 时返回 `pull_request_review_disabled`。
   - 让 `runReview()` 和 `runReviewComment()` 都在 fetch 最新 PR/MR 后、任何 Agentrix task 创建/resume 与 review-comment acknowledgement 之前调用该决策，确保暂停时没有 task side effect，也不会用 reaction 误示“已开始处理”。
   - 保留现有 draft、merged、closed、source provenance、reply、missing marker 与 duplicate lock 语义；新增 label 只增加一道更严格门禁，不改变其它 skip reason 的含义。
   - 日志和返回对象继续使用现有 `{ action: 'skipped', reason, pullRequest, ... }` 形态；review comment 路径保留 comment id，便于从 CI 输出定位触发源。

3. 统一仓库总开关在 review-comment 路径的行为与优先级。
   - 让 `runReviewComment()` 在事件合法且能够定位 PR/MR 后，使用与 `runReview()` 相同的 `resolveReviewEnabled()` 判断；仓库级关闭时返回既有 `review_disabled`，不读取 task marker 或恢复 task。
   - 在 GitHub `issue-flow-pr-review-comment.yml` 和 GitLab `issue-flow-review-comment` job 中传入 `ISSUE_FLOW_REVIEW_ENABLED`，但不增加 label-based workflow `if/rules`，确保统一 dispatch 仍能返回诊断原因并覆盖 manual/native/bridge payload 差异。
   - 决策优先级固定为“仓库级 off > PR/MR `review::off` > 原有 review 行为”；移除 `review::off` 只能恢复到仓库当前配置，不能覆盖全局 off。

4. 覆盖启用、暂停、恢复和双 provider 行为。
   - 在 `plugin/test/dispatch.test.cjs` 增加自动 review 用例：仓库开启且 label 缺失时继续创建/恢复 review task；当前 PR/MR 带 `review::off` 时返回 `pull_request_review_disabled` 且 runtime 未调用；移除 label 后同一 PR/MR 的后续/manual 触发恢复原行为。
   - 增加 review-comment 用例：GitHub 普通 PR comment、GitHub inline review comment、GitLab bridge/native note 在 `review::off` 下都不 acknowledge、不创建 lock、不 resume；无标签时继续使用 body task marker resume。
   - 增加优先级用例：仓库级关闭时两条路径都返回 `review_disabled`；仓库级开启但单 PR/MR 关闭时返回 `pull_request_review_disabled`；两者均开启时保持现有结果。
   - 扩展 provider/fixture 覆盖 GitHub label object 与 GitLab label string/object 形态，证明 fetch 后归一化结果都能命中 `review::off`，无需 provider 分支逻辑。
   - 扩展 bootstrap/workflow 测试，确认 GitHub/GitLab review-comment job 都传递仓库级开关，且安装 manifest、managed workflow 内容和已有触发事件保持正确。

5. 更新标签与使用文档，明确维护者交互路径。
   - 在 `plugin/skills/issue-flow/references/labels.md` 和 `plugin/skills/issue-flow/SKILL.md` 的 managed label 表中加入 `review::`，注明只用于 PR/MR、`review::off` 同时暂停自动 review 与 review-comment task resume。
   - 在面向安装/运行的 README 或 review 自动化说明中记录操作：给目标 PR/MR 添加 `review::off` 暂停，移除后由下一次原有事件恢复，需要立即恢复时运行现有手动 review；无需修改 source issue。
   - 增加优先级表，明确全局关闭、单 PR/MR 关闭、正常开启三种组合；同时注明不会取消已运行 task、不会补放暂停期间事件，避免维护者误判开关能力。
   - 说明 `labels sync` / 安装升级负责提供标签；`labels check` 可用于诊断仓库缺少或 metadata 漂移，不要求用户手工创建 label。

6. 完成分层验证与回归收口。
   - 先运行 labels、dispatch、provider、bootstrap 相关单元测试，再运行 plugin 全量测试，确认两条 review 路径和 managed label 同步无回归。
   - 使用 dry-run/manual dispatch fixtures 验证新增 skip reason 的 CLI JSON 与日志可读，并确认暂停时没有 Agentrix create/resume 调用。
   - 在具备 provider 凭证的环境分别执行 GitHub/GitLab `labels sync` 与 `labels check`，再对测试 PR/MR 添加/移除 `review::off`，验证暂停、恢复和仓库级开关优先级。

## 验证方案

- 自动验证：
  - `node --test plugin/test/labels.test.cjs`：验证 `review::off` catalog、scope、metadata 与 sync 输入。
  - `node --test plugin/test/dispatch.test.cjs`：验证自动 review、review-comment、仓库级开关、PR/MR 级暂停、移除后恢复、无 task side effect 与稳定 skip reason。
  - `node --test plugin/test/providers.test.cjs`：验证 GitHub/GitLab 当前 PR/MR labels 的归一化以及 comment payload 路由不受影响。
  - `node --test plugin/test/bootstrap.test.cjs plugin/test/gitlab-ci-include.test.cjs`：验证 GitHub workflows、GitLab CI jobs、变量传递和安装 manifest。
  - `npm test -w issue-flow`：运行 plugin 全量单元回归，覆盖 submit、merged、runtime、provider 和 label 生命周期。
  - `npm run test:integration -w issue-flow`：在 CI/provider 凭证可用时验证 GitHub/GitLab label sync/check 与真实 PR/MR 行为；无凭证的本地环境不作为失败条件，由对应集成 CI 执行。
- 手动验证：
  - 仓库级 review 开启时，对一个 open、非 draft PR/MR 添加 `review::off`，分别触发 synchronize、manual review 和新 review comment，确认 CI 输出 `pull_request_review_disabled`，且 Agentrix 不出现新 task 或 resume。
  - 移除 `review::off` 后执行 manual review，再新增一条 review comment，确认复用既有 task marker、review lock 与 head SHA 去重逻辑恢复，不需要重建 PR/MR 或修改 source issue。
  - 将 `ISSUE_FLOW_REVIEW_ENABLED` 关闭，确认有无 `review::off` 都不会创建或恢复 review task，并返回 `review_disabled`；重新开启后，仍带 `review::off` 的 PR/MR 继续保持暂停。
  - 分别在 GitHub 和 GitLab 执行 `labels sync` / `labels check`，确认 `review::off` 名称、颜色、描述一致且可在 PR/MR 标签选择器中发现。
- 回归范围：
  - PR/MR opened、synchronize、ready-for-review、manual review 的 task 创建、按 head SHA resume 与重复触发去重。
  - GitHub ordinary PR comments、inline review comments，GitLab bridge comments、native note/diff discussions 的事件识别、source provenance 过滤、reply 过滤、acknowledgement 和 task resume。
  - `mr-by::plan` / `mr-by::build` 标签、Plan/Build PR/MR submit、merge 后 source issue 状态迁移，以及 issue 级 `automation::` / `status::` 语义。
  - managed labels 的 GitHub/GitLab sync/check、bootstrap 安装/升级、workflow manifest 和项目级已安装 skill 一致性。
