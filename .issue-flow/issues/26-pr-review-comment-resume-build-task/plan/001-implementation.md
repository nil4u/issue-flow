## 目标

- 在 issue-flow build PR/MR 收到新的 review comment 后，自动唤醒该 PR/MR 对应的 Agentrix build task，让 build agent 处理最新 review feedback。
- 首版覆盖 GitHub `pull_request_review_comment` 的 `created` 事件；GitLab 覆盖 Agentrix GitLab bridge 映射出的 `pull_request_review_comment` note payload，以及 native GitLab MR note/diff comment `created` 事件。
- 事件处理不按评论作者类型区分人工、Agentrix 或 bot；只要是 build PR/MR 上的新 review comment，就进入同一条 resume 路由。
- 事件处理必须能安全跳过非 issue-flow build PR/MR、非 open PR/MR、缺少 source issue marker、缺少 PR body 中的 Agentrix task marker、source issue 当前不可 resume、重复 comment 投递等情况，并输出稳定 reason。
- resume instruction 要短而明确，包含评论链接和必要上下文，例如：`有新的 PR/MR review comment，请查看并处理。`
- 补齐 bootstrap workflow、dispatch/runtime/provider 文档和单元测试，使该入口成为 issue-flow 自动化闭环的一部分。

## 非目标

- 不改变现有 `dispatch review` 的语义；它仍是 PR/MR opened/synchronize/ready_for_review/manual 上的自动 review check。
- 不在本次实现中处理 GitHub `pull_request_review_comment.edited/deleted`，也不把已有历史评论批量同步给 build task；这些事件首版返回结构化 skip reason。
- 不触发 plan PR/MR 的 build resume；该能力仅针对 `mr-by::build` PR/MR。
- 不从 source issue body 解析 Agentrix task id，也不把 source issue 上的历史 task marker 作为 fallback；resume 目标必须来自当前 PR/MR body。
- 不重新设计 merge 后状态流转。
- 不直接调用 `gh`、`glab`、provider REST/GraphQL passthrough；新增 provider 行为仍走 issue-flow CLI / provider abstraction。

## 当前上下文

- 相关模块：
  - `skills/issue-flow/scripts/dispatch.cjs` 已提供 `auto`、`comment`、`review`、`pr-merged`、`pipeline-failed`、`resume` 和 direct action 入口；`runReview()` 已会从 PR/MR event 解析当前 PR/MR、fetch 当前 PR/MR、按 PR 状态跳过、再启动 Agentrix review action。
  - `skills/issue-flow/scripts/resolve.cjs` 的 `resolveResumeDecision()` 已能根据 source issue 的 `flow::` label 决定是否继续 `triage/plan/build`，并阻断 `status::done/drop/suspend`、缺少/不支持 flow 和 size 冲突。
  - `skills/issue-flow/scripts/runtimes/agentrix.cjs` 已支持 source issue prompt、`data.instruction` 注入、PR/MR source issue 解析，以及 `buildTaskCommentMarker()` / `buildTaskComment()` 的 task lock comment；当前未看到从 PR/MR body 解析 Agentrix task id 的 helper。
  - `skills/issue-flow/scripts/providers.cjs` 已有 GitHub/GitLab `buildPullRequestContext()`、`fetchCurrentPullRequest()`、`fetchCurrentIssue()`、PR/MR comments、PR/MR review comments list 等 provider abstraction。
  - `skills/issue-flow/scripts/events.cjs` 已把 Agentrix GitLab bridge 的 `pull_request_review_comment` 映射成 GitLab note payload，`buildGitlabPullRequestContext()` 可从 `payload.merge_request` 定位 MR。
  - `skills/issue-flow/assets/agentrix/bootstrap/workflows/github/issue-flow-pr-review.yml` 当前监听 `pull_request` opened/synchronize/ready_for_review 和 manual，调用 `dispatch.cjs review`。
  - `skills/issue-flow/assets/agentrix/bootstrap/workflows/gitlab/issue-flow.gitlab-ci.yml` 当前已有 `issue-flow-review`、`issue-flow-comment`、`issue-flow-merged` 等 job；comment job 只面向 issue comment mention。
  - `skills/issue-flow/cli.cjs` 已暴露统一 `issue-flow dispatch ...`、`issue-flow pr review-comments list ...` 等入口。
  - `test/dispatch.test.cjs`、`test/providers.test.cjs`、`test/agentrix-runtime.test.cjs`、`test/bootstrap.test.cjs` 和 `test/cli.test.cjs` 是本次主要回归点。
- 相关接口 / 数据 / 状态：
  - build PR/MR 由 `pr submit build` 添加 `mr-by::build` label，并在 body 中写入 `<!-- issue-flow:source-issue=<num> -->`；runtime 还支持从 `Source issue: #<num>`、`Build #<num>` 和 `<num>-slug/build` 解析 source issue。
  - 当前 `submit.cjs` 只实现了 `SOURCE_ISSUE_MARKER_PATTERN`、`buildSourceIssueMarker()` 和 `buildPrBodyWithSourceMarker()`；没有把 `AGENTRIX_TASK_ID` 或 `--agentrix-task-id` 写入 PR/MR body。`create-issue.cjs` 有 issue body marker：`<!-- issue-flow:agentrix:task=<id> -->`，但这不是本需求的解析来源。
  - 现有 issue action task lock marker 是 `<!-- issue-flow:agentrix:task:<action> -->`；review action 的 PR/MR lock marker 会按 head SHA scoped。
  - `startAction('build', sourceIssue, ..., data)` 当前会启动 build action 并创建 issue/action task lock；review comment resume 需要改为对 PR body 中的 Agentrix task id 执行 resume，而不是启动一个无 task id 的新 build run。
  - `claimActionTask()` 当前对 issue/action 只允许一个 active lock；review comment 路由仍可复用 comment-scoped lock 防重复，但真正的 Agentrix resume 目标必须是 PR/MR body 中解析出的 task id。
  - GitHub `pull_request_review_comment` payload 自带 `pull_request` 和 `comment`；GitLab bridge/native note payload 自带 `merge_request` 和 `object_attributes` comment。
  - `issue-flow pr review-comments list` 可读取 review comments，但事件路由不需要先 list 全量评论；它应优先使用 payload 中的新评论上下文。
- 既有约束：
  - provider 操作必须通过 `issue-flow` CLI / `cli.cjs` 或其内部封装，不直接调用 `gh`、`glab`、`gh api`、`glab api` 或手写 provider API。
  - 成功的统一 CLI 命令 stdout 应输出单个 JSON 文档；dispatch 脚本已有 `[issue-flow]` 日志时，新增行为也要返回结构化对象供 CLI 包装。
  - PR body 文件必须放在 repo 外临时文件；本计划 PR body 同样不提交进 git。
  - 工作流应从 base ref checkout `.agentrix/plugins/issue-flow` 和 `.issue-flow`，保持事件处理使用目标分支的 issue-flow runtime 文件。

## 方案

1. 新增 review comment 事件路由命令。
   - 在 `dispatch.cjs` 增加子命令 `review-comment`，并通过 `cli.cjs` 的 `issue-flow dispatch review-comment --event <path>` 暴露。
   - `parseArgs()`、`usage()`、`dispatchHelp()`、`main()` 和 module exports 同步增加该命令。
   - 新增 `runReviewComment(options = {}, provided = {})`，流程保持纯路由：
     1. `loadEvent()` 读取 payload。
     2. 解析 review comment context 和 PR/MR context。
     3. fetch 当前 PR/MR。
     4. 从当前 PR/MR body 解析 source issue number 和 Agentrix task id。
     5. 校验 PR/MR、source issue 和 task id。
     6. fetch source issue 并用 `resolveRuntimeResumeDecision()` 确认当前只能 resume build。
     7. 调用 comment-scoped resume wrapper，对 PR body 中的 Agentrix task id 发送 resume instruction。
   - 成功启动返回：
     ```json
     {
       "action": "build",
       "result": { "taskId": "...", "status": "..." },
       "sourceIssue": 26,
       "pullRequest": 45,
       "reviewComment": "123456"
     }
     ```
   - 安全跳过返回 `action: "skipped"` 或 `action: "ignored"`，并包含稳定 `reason`，例如 `unsupported_event_action`、`not_pull_request_review_comment`、`pull_request_not_open`、`not_build_pull_request`、`missing_source_issue`、`missing_agentrix_task`、`source_issue_not_resumable`、`source_issue_flow_not_build`、`duplicate_review_comment_resume`。

2. 补齐事件和 comment context 解析。
   - 在 provider abstraction 增加 review comment 事件读取 helper，避免 dispatch 直接理解 provider payload 细节：
     - `getReviewCommentContext(payload, options)` 返回 `{ id, author, body, htmlUrl, path, line, side, createdAt, updatedAt }`。
     - `isReviewCommentCreatedEvent(payload, options)` 只接受 GitHub `action === 'created'`，GitLab bridge/native note 接受 `object_attributes.action === 'create'` 或缺省 created；edited/deleted 返回 `unsupported_event_action`。
   - GitHub context 从 `payload.comment` 读取 `id/body/html_url/path/line/side/diff_hunk/created_at/updated_at`。
   - GitLab context 从 `payload.object_attributes` 读取 `id/note/url`，从 `position` 读取 `new_path/new_line/head_sha`；native discussion payload 缺少 diff position 时仍作为 MR note comment 处理，但 instruction 只包含链接和正文摘要。
   - 如果 payload 无法提供 PR/MR 编号，`runReviewComment()` 返回 `not_pull_request_review_comment`；不通过 list comments 猜测目标。

3. 让 submit.cjs 在 PR/MR body 中写入 Agentrix task marker。
   - 在 `submit.cjs` 新增 PR body task marker 支持，推荐复用 issue body 已有格式：
     - marker：`<!-- issue-flow:agentrix:task=<id> -->`
     - pattern：`/<!--\s*issue-flow:agentrix:task=([^>]+)\s*-->/i`
   - 新增参数 `--agentrix-task-id <id>`，默认从 `AGENTRIX_TASK_ID` 读取；与 `create-issue.cjs` 保持一致。
   - 把 `buildPrBodyWithSourceMarker()` 升级为 `buildPrBodyWithMarkers(body, issueNumber, taskId)`：
     - 永远写入或替换 `source-issue` marker。
     - 当 `taskId` 存在时，写入或替换 `agentrix:task=<id>` marker。
     - 当 `taskId` 不存在时，不写空 marker；review-comment 路由对缺少 marker 的旧 build PR/MR 返回 `missing_agentrix_task`。
   - marker 写入位置建议位于 PR/MR body 顶部：
     ```md
     <!-- issue-flow:source-issue=26 -->
     <!-- issue-flow:agentrix:task=<AGENTRIX_TASK_ID> -->
     ```
   - `submit.cjs build` 和 `submit.cjs plan` 都可写入 task marker；本需求只使用 build PR/MR 上的 marker。这样 plan/build PR 的 body wrapper 行为保持统一，也方便未来其它 PR 事件复用。
   - 更新 `test/submit.test.cjs`：
     - 有 `AGENTRIX_TASK_ID` 时 PR body 包含 task marker。
     - stale task marker 被替换。
     - 没有 task id 时只写 source issue marker。
     - task marker 文件仍写入 repo-external temp file，不改原始 body file。

4. 限定 build PR/MR、source issue 和 task id 解析。
   - 对当前 PR/MR 复用 `shouldSkipPullRequestReview()` 的状态判断：
     - draft 返回 `draft_pull_request`。
     - merged 返回 `merged_pull_request`。
     - state 非 `open/opened` 返回 `pull_request_not_open`。
   - 新增 `isIssueFlowBuildPullRequest(pr)`：
     - labels 必须包含 `mr-by::build`。
     - 不接受 `mr-by::plan` 或无 `mr-by::*` label。
   - source issue number 使用 `runtime.extractSourceIssueNumberFromPullRequest(currentPr)`，保持现有 body/title/branch marker 兼容；解析失败返回 `missing_source_issue`。
   - Agentrix task id 使用新增 `runtime.extractAgentrixTaskIdFromPullRequest(currentPr)`，只读取 PR/MR body 中的 `<!-- issue-flow:agentrix:task=<id> -->`。
   - Agentrix task id 不从 source issue body 解析，也不从 task lock comment、issue comments 或 branch name 推断；解析失败返回 `missing_agentrix_task`。
   - fetch source issue 后调用 `resolveRuntimeResumeDecision(sourceIssue, runtime)`：
     - `shouldRun === false` 返回 `source_issue_not_resumable`，并透传 resolver 的 `reason`、`flowLabel`、`statusLabel`、`code` 和冲突 labels。
     - `decision.action !== 'build'` 返回 `source_issue_flow_not_build`，避免 review comment 把 source issue 错误唤醒到 triage/plan。
   - 该路径不读取或修改 source issue 的 `flow::` label；它只依据当前 state machine 决定是否 resume build。

5. 设计防重复触发策略。
   - 新增 review-comment-specific lock marker，建议由 Agentrix runtime 生成：
     - `buildTaskCommentMarker('build', { reviewComment: { id } })` 返回 `<!-- issue-flow:agentrix:task:build:review-comment:<id> -->`。
     - 没有 `reviewComment.id` 时回退到现有 `<!-- issue-flow:agentrix:task:build -->`，但事件路由应尽量要求 id。
   - `runReviewComment()` 不直接调用 `startAction()` 的普通 build lock，而是新增一个小 wrapper，例如 `resumeBuildTaskForReviewComment()`：
     - 先在 source issue 评论区 claim `build:review-comment:<comment-id>` lock，防止同一评论事件重复投递多次。
     - 再调用 runtime 的 task resume 能力，目标是 `data.agentrixTaskId`，instruction 指向该 review comment。
     - 如果同一 comment-scoped lock 已存在，返回 `duplicate_review_comment_resume`，同时带 existing lock comment URL。
   - 如果实现成本更低，也可以扩展 `claimActionTask()` 支持 `data.lockScope`，让普通 build、review-comment resume 使用同一 claim/update 逻辑但不同 marker。
   - 锁评论最终 body 保留：
     - action: `build`
     - trigger: review comment URL
     - pull request number
     - review comment id
     - Agentrix task id
   - 重复投递同一 comment id 时返回 `duplicate_review_comment_resume` 或现有 `duplicate_task`，但不得启动第二个 Agentrix run。
   - 并发安全沿用 `claimActionTask()` 创建后再 list winner 的模式；新增 marker 必须传入 `findActionTaskComment(comments, action, runtime, data)`，不能只查普通 build marker。

6. 构造 resume instruction 并调用 Agentrix task resume。
   - `runReviewComment()` 传入 resume instruction：
     ```text
     有新的 PR/MR review comment，请查看并处理。

     PR/MR: #<pr-number> <pr-url>
     Review comment: <comment-url>
     File: <path>:<line>
     Comment author: <author>
     ```
   - 评论正文只放短摘要，最多约 500 字符，避免把长评论完整复制进锁评论；完整内容以链接为准。
   - Agentrix runtime 新增 `resumeTask(taskId, instruction, options, data)` 或等价内部函数：
     - 输入 task id 来自 PR/MR body marker。
     - metadata 包含 source issue、PR/MR、review comment id。
     - 不创建新的 unrelated build task。
   - 若当前 `@agentrix/agentrix-run` 已有 resume 参数，则 runtime wrapper 使用该参数；如果只支持 API resume，则在 runtime 内封装 Agentrix API 调用。无论实现方式如何，dispatch 层只传 task id 和 instruction，不直接调 Agentrix API。
   - `buildTaskComment()` 对 `data.comment.htmlUrl` 已会输出 `Trigger:`；本次补充 `data.reviewComment` fallback，确保 review comment URL 被记录。
   - resume metadata 保持 source issue scoped：`issue_flow_issue=<repo>#<sourceIssue>`、`issue_flow_action=build`。可额外增加 metadata：
     - `issue_flow_pr=<repo>#<pr>`
     - `issue_flow_review_comment=<comment-id>`
     - `issue_flow_agentrix_task=<task-id>`
   - 不新增 `flow::review` 或新的 issue label；这只是 build action 的一个触发来源。

7. 新增/更新 bootstrap workflow。
   - GitHub 推荐新增独立 workflow `issue-flow-pr-review-comment.yml`，避免和 `issue-flow-pr-review.yml` 的 review check 开关混在一起。
   - GitHub workflow：
     - `on.pull_request_review_comment.types: [created]`
     - permissions: `contents: read`, `issues: write`, `pull-requests: read`
     - job guard：
       - `github.event.pull_request.state == 'open'`
       - `contains(toJson(github.event.pull_request.labels), 'mr-by::build')`
     - concurrency group: `issue-flow-review-comment-${{ github.event.pull_request.number }}-${{ github.event.comment.id }}`
     - checkout base ref with sparse checkout `.agentrix/plugins/issue-flow` and `.issue-flow`
     - run `node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs dispatch review-comment --event "$GITHUB_EVENT_PATH"`
   - 不让该 workflow 依赖 `ISSUE_FLOW_REVIEW_ENABLED`；`ISSUE_FLOW_REVIEW_ENABLED` 控制自动 review check，不应关闭 reviewer feedback resume。若需要全局关闭，应通过既有 Agentrix credentials/automation policy 或后续单独变量处理。
   - `bootstrap.cjs` 的 `AGENTRIX_GITHUB_WORKFLOWS` 加入新 workflow；`install-manifest` 会记录 managed 文件。
   - GitLab `.gitlab/issue-flow.gitlab-ci.yml` 新增 `issue-flow-review-comment` job：
     - Agentrix bridge：`AGENTRIX_EVENT_NAME == "pull_request_review_comment"` 且 `AGENTRIX_EVENT_ACTION == "created"`。
     - native note：`GITLAB_EVENT_NAME == "note"` 且 payload 为 MR note 时执行；脚本层再做 build PR/MR/source issue 判断。
     - checkout default/base runtime 文件后调用 `cli.cjs dispatch review-comment`.
   - GitLab native note 环境若无法可靠区分 issue note 和 MR note，允许 job 触发后由 dispatch 返回 `not_pull_request_review_comment`；这比在 CI rule 中误过滤 diff comment 更安全。

8. 更新文档。
   - `skills/issue-flow/SKILL.md`：
     - Dispatch 列表增加 `issue-flow dispatch review-comment --event <event-json-file>`。
     - 说明该入口用于 build PR/MR 的 review comment resume，不替代 `dispatch review`，且不按评论作者类型过滤。
   - `docs/provider-api.md`：
     - Dispatch CLI 小节增加 `review-comment`。
     - PR/MR review comments 小节说明 list API 与事件入口的区别：list 用于读取历史评论，review-comment 用于路由单个新事件。
     - `submit.cjs` 行为小节增加 PR/MR body task marker：有 `AGENTRIX_TASK_ID` 或 `--agentrix-task-id` 时插入 `<!-- issue-flow:agentrix:task=<id> -->`。
     - Agentrix 行为小节增加 review-comment trigger、PR body task id 解析、Agentrix task resume 和 duplicate comment lock。
   - `docs/state-machine.md`：
     - 在 PR/MR Review Check 后新增 “Review Comment Resume” 表：
       - Scope: build PR/MR
       - Trigger: review comment created
       - Command: `issue-flow dispatch review-comment`
       - Issue state: 只读取 source issue `flow::build`，不改 label
       - Task target: 从 PR/MR body 的 `issue-flow:agentrix:task=<id>` marker 解析
       - Skip: non-build PR/MR、not open、missing source issue、missing PR task marker、non-resumable source issue
   - `README.md` 追加工作流概览，说明 reviewer 在 build PR/MR 上留 inline comment 后无需到 issue 或 Agentrix task 手动 resume。

9. 测试覆盖。
   - `test/dispatch.test.cjs`：
     - parser/help 接受 `review-comment`。
     - GitHub `pull_request_review_comment.created` + open `mr-by::build` PR + PR body task marker + source issue `flow::build` 会对该 task id 执行 resume dry-run，并在 instruction 中包含 review comment URL。
     - GitHub bot/Agentrix-authored review comment 和人工 review comment 走同一条 resume 路由，不按 `user.type` 跳过。
     - edited event 返回 `unsupported_event_action`。
     - `mr-by::plan` 或无 build label 返回 `not_build_pull_request`。
     - PR closed/draft/merged 返回现有 PR skip reason。
     - 缺少 source issue marker 返回 `missing_source_issue`。
     - 缺少 PR body task marker 返回 `missing_agentrix_task`。
     - source issue `flow::plan` 返回 `source_issue_flow_not_build`。
     - source issue `status::done/drop/suspend` 或 size 冲突返回 `source_issue_not_resumable`，并透传 resolver details。
     - 同一 review comment 已有 lock marker 时返回 duplicate reason，不启动第二个 run。
   - `test/providers.test.cjs`：
     - GitHub review comment context normalization 覆盖 id、url、path、line、author。
     - GitLab bridge/native note review comment context normalization 覆盖 `object_attributes.note`、`url`、`position.new_path/new_line`、`merge_request.iid`。
   - `test/agentrix-runtime.test.cjs`：
     - `extractAgentrixTaskIdFromPullRequest()` 只从 PR/MR body marker 解析 task id。
     - source issue body 里有 `issue-flow:agentrix:task=<id>` 时不会被 PR/MR task resolver 使用。
     - `buildTaskCommentMarker('build', { reviewComment: { id: 101 } })` 生成 comment-scoped marker。
     - task resume dry-run 输出包含 task id、review comment URL 和 source issue metadata。
   - `test/submit.test.cjs`：
     - `buildPrBodyWithMarkers()` 同时写入 source issue marker 和 task marker。
     - `AGENTRIX_TASK_ID` / `--agentrix-task-id` 能进入 PR body wrapper。
     - stale task marker 被替换；没有 task id 时不写空 marker。
   - `test/bootstrap.test.cjs`：
     - GitHub bootstrap 写出 `.github/workflows/issue-flow-pr-review-comment.yml`。
     - workflow 包含 `pull_request_review_comment`、`created`、`mr-by::build` guard、`cli.cjs dispatch review-comment`，且不包含 bot/user-type 过滤。
     - GitLab bootstrap job 包含 bridge/native note 规则和 `dispatch review-comment`。
   - `test/cli.test.cjs`：
     - `issue-flow dispatch --help` 包含 `review-comment`。
     - `issue-flow dispatch review-comment --event <tmp> --dry-run` 能转调 dispatch 脚本并输出单个 JSON envelope。
   - 回归 `npm test`。

## 验证方案

- 自动验证：
  - `npm test`
  - `node skills/issue-flow/cli.cjs dispatch review-comment --event <github-review-comment-event.json> --dry-run`
  - `node skills/issue-flow/cli.cjs dispatch review-comment --event <github-review-comment-edited-event.json> --dry-run`，确认返回 `unsupported_event_action`。
  - `node skills/issue-flow/cli.cjs dispatch review-comment --event <gitlab-mr-note-event.json> --provider gitlab --dry-run`
  - `node skills/issue-flow/cli.cjs pr review-comments list --pr <build-pr> --dry-run`，确认既有 list 能力未回退。
- 手动验证：
  - 在测试仓库中创建 issue-flow build PR，确认 PR 带 `mr-by::build`、body 带 source issue marker 和 `issue-flow:agentrix:task=<id>` marker，source issue 仍为 `status::active` + `flow::build`。
  - 人工 reviewer 或 Agentrix reviewer 在 open build PR 上新增 inline review comment，确认 GitHub Actions / GitLab CI 启动 `dispatch review-comment`，source issue 出现 comment-scoped lock，PR body 中的 Agentrix task 收到包含 review comment 链接的 resume instruction。
  - 重放同一个 event payload，确认不会启动第二个 build task，并能看到 duplicate reason。
  - 用 bot/自动化账号评论，确认不会因为作者类型被跳过；只要事件、PR/MR、source issue 和 task marker 满足条件就 resume。
  - 在 plan PR、closed PR、缺少 source issue marker 的普通 PR 上评论，确认跳过 reason 可读。
- 回归范围：
  - PR/MR review check：`dispatch review` 和 `issue-flow-pr-review.yml` 的行为不变。
  - issue comment mention：`dispatch comment` 仍只处理 issue comment，不把 PR/MR note 当 issue mention。
  - plan/build submit 和 `pr-merged` 状态流转不变。
  - Agentrix task lock comment 兼容既有 `triage/plan/build/review` marker，同时新增 review-comment scoped build marker；PR/MR body 新增 `issue-flow:agentrix:task=<id>` marker。
