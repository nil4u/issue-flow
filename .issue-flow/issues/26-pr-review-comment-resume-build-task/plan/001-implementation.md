## 目标

- 在带有 Agentrix task marker 的 issue-flow PR/MR 收到新的 review comment 后，自动唤醒该 PR/MR 对应的 Agentrix task，让 agent 处理最新 review feedback。
- 首版覆盖 GitHub `pull_request_review_comment` 的 `created` 事件；GitLab 覆盖 Agentrix GitLab bridge 映射出的 `pull_request_review_comment` note payload，以及 native GitLab MR note/diff comment `created` 事件。
- 事件处理不按评论作者类型区分人工、Agentrix 或 bot；只要是可解析出 Agentrix task id 的 PR/MR 上的新 review comment，就进入同一条 resume 路由。
- 事件处理必须能安全跳过非 PR/MR review comment、非 open PR/MR、缺少 PR/MR body 中的 Agentrix task marker、重复 comment 投递等情况，并输出稳定 reason。
- resume instruction 要短而明确，包含评论链接和必要上下文，例如：`有新的 PR/MR review comment，请查看并处理。`
- 被唤醒的 task 需要对触发的 review comment 做闭环：处理反馈、回复该 comment/thread，并在 provider 支持时 resolve 对应 discussion/thread。
- 补齐 bootstrap workflow、dispatch/runtime/provider 文档和单元测试，使该入口成为 issue-flow 自动化闭环的一部分。

## 非目标

- 不改变现有 `dispatch review` 的语义；它仍是 PR/MR opened/synchronize/ready_for_review/manual 上的自动 review check。
- 不在本次实现中处理 GitHub `pull_request_review_comment.edited/deleted`，也不把已有历史评论批量同步给 Agentrix task；这些事件首版返回结构化 skip reason。
- 不限制 PR/MR kind；plan PR/MR、build PR/MR 或后续其它 issue-flow PR/MR 只要带有 task marker 都可 resume 对应 task。
- 不从 source issue body 解析 Agentrix task id，也不把 source issue 上的历史 task marker 作为 fallback；resume 目标必须来自当前 PR/MR body。
- 不把 source issue 当前 `flow::` / `status::` 作为 review comment resume 的 gate；例如 build PR/MR 等待 review 时 source issue 通常已是 `flow::approve`，这不能阻断 task resume。
- 不要求首版自动处理同一 PR/MR 上所有历史未解决评论；事件触发的 comment 是必须闭环项。是否批量处理其它 unresolved comments 可作为后续增强或由 agent 在实现时自行追加。
- 不重新设计 merge 后状态流转。
- 不直接调用 `gh`、`glab`、provider REST/GraphQL passthrough；新增 provider 行为仍走 issue-flow CLI / provider abstraction。

## 当前上下文

- 相关模块：
  - `skills/issue-flow/scripts/dispatch.cjs` 已提供 `auto`、`comment`、`review`、`pr-merged`、`pipeline-failed`、`resume` 和 direct action 入口；`runReview()` 已会从 PR/MR event 解析当前 PR/MR、fetch 当前 PR/MR、按 PR 状态跳过、再启动 Agentrix review action。
  - `skills/issue-flow/scripts/resolve.cjs` 的 `resolveResumeDecision()` 已能根据 source issue 的 `flow::` label 决定是否继续 `triage/plan/build`；本需求不应再依赖该 decision 作为 PR review comment resume 的门槛，因为 task id 已经来自 PR/MR body。
  - `skills/issue-flow/scripts/runtimes/agentrix.cjs` 已支持 source issue prompt、`data.instruction` 注入、PR/MR source issue 解析，以及 `buildTaskCommentMarker()` / `buildTaskComment()` 的 task lock comment；当前未看到从 PR/MR body 解析 Agentrix task id 的 helper。
  - Agentrix run 文档确认可用 `agentrix-run --resume <task-id> --prompt <message>` 向已有 task 追加消息；resume 模式不需要 repository context 或 runner id，`async` response mode 表示确认消息已被后端接受。
  - `skills/issue-flow/scripts/providers.cjs` 已有 GitHub/GitLab `buildPullRequestContext()`、`fetchCurrentPullRequest()`、`fetchCurrentIssue()`、PR/MR comments、PR/MR review comments list 等 provider abstraction。
  - `skills/issue-flow/cli.cjs` 当前只有 `pr review-comments list`；没有受控的 inline review comment reply 或 resolve 命令。仅靠 prompt 要求 agent 回复/resolve 会让 agent 缺少合规 provider 操作入口。
  - `skills/issue-flow/scripts/events.cjs` 已把 Agentrix GitLab bridge 的 `pull_request_review_comment` 映射成 GitLab note payload，`buildGitlabPullRequestContext()` 可从 `payload.merge_request` 定位 MR。
  - `skills/issue-flow/assets/agentrix/bootstrap/workflows/github/issue-flow-pr-review.yml` 当前监听 `pull_request` opened/synchronize/ready_for_review 和 manual，调用 `dispatch.cjs review`。
  - `skills/issue-flow/assets/agentrix/bootstrap/workflows/gitlab/issue-flow.gitlab-ci.yml` 当前已有 `issue-flow-review`、`issue-flow-comment`、`issue-flow-merged` 等 job；comment job 只面向 issue comment mention。
  - `skills/issue-flow/cli.cjs` 已暴露统一 `issue-flow dispatch ...`、`issue-flow pr review-comments list ...` 等入口。
  - `test/dispatch.test.cjs`、`test/providers.test.cjs`、`test/agentrix-runtime.test.cjs`、`test/bootstrap.test.cjs` 和 `test/cli.test.cjs` 是本次主要回归点。
- 相关接口 / 数据 / 状态：
  - plan/build PR/MR 由 `pr submit plan|build` 添加 `mr-by::plan` 或 `mr-by::build` label，并在 body 中写入 `<!-- issue-flow:source-issue=<num> -->`；runtime 还支持从 `Source issue: #<num>`、`Plan/Build #<num>` 和 `<num>-slug/plan|build` 解析 source issue。
  - 当前 `submit.cjs` 只实现了 `SOURCE_ISSUE_MARKER_PATTERN`、`buildSourceIssueMarker()` 和 `buildPrBodyWithSourceMarker()`；没有把 `AGENTRIX_TASK_ID` 或 `--agentrix-task-id` 写入 PR/MR body。`create-issue.cjs` 有 issue body marker：`<!-- issue-flow:agentrix:task=<id> -->`，但这不是本需求的解析来源。
  - 现有 issue action task lock marker 是 `<!-- issue-flow:agentrix:task:<action> -->`；review action 的 PR/MR lock marker 会按 head SHA scoped。
  - `startAction('build', sourceIssue, ..., data)` 当前会启动新的 build action 并创建 issue/action task lock；review comment resume 需要改为对 PR/MR body 中的 Agentrix task id 执行 resume，而不是启动一个无 task id 的新 run。
  - `claimPullRequestActionTask()` 已能在 PR/MR 评论区做 action lock；review comment 路由应使用 PR/MR scoped、comment-scoped lock 防重复，不依赖 source issue 评论区。
  - source issue 上历史普通 action lock marker（例如 `<!-- issue-flow:agentrix:task:build -->`）不会在任务 queued 后被移除；review comment resume 不能把这类历史 marker 当作 active duplicate。
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
     4. 从当前 PR/MR body 解析 Agentrix task id。
     5. 可选解析 source issue number，用于 metadata 和日志；解析失败不阻断 resume。
     6. 校验 PR/MR 和 task id。
     7. 调用 PR/MR comment-scoped resume wrapper，对 PR/MR body 中的 Agentrix task id 发送 resume instruction。
   - 成功启动返回：
     ```json
     {
       "action": "task_resume",
       "result": { "taskId": "...", "status": "..." },
       "sourceIssue": 26,
       "pullRequest": 45,
       "reviewComment": "123456"
     }
     ```
   - 安全跳过返回 `action: "skipped"` 或 `action: "ignored"`，并包含稳定 `reason`，例如 `unsupported_event_action`、`not_pull_request_review_comment`、`pull_request_not_open`、`missing_agentrix_task`、`duplicate_review_comment_resume`。

2. 补齐事件和 comment context 解析。
   - 在 provider abstraction 增加 review comment 事件读取 helper，避免 dispatch 直接理解 provider payload 细节：
     - `getReviewCommentContext(payload, options)` 返回 `{ id, author, body, htmlUrl, path, line, side, createdAt, updatedAt }`。
     - `isReviewCommentCreatedEvent(payload, options)` 只接受 GitHub `action === 'created'`，GitLab bridge/native note 接受 `object_attributes.action === 'create'` 或缺省 created；edited/deleted 返回 `unsupported_event_action`。
   - GitHub context 从 `payload.comment` 读取 `id/body/html_url/path/line/side/diff_hunk/created_at/updated_at`。
   - GitLab context 从 `payload.object_attributes` 读取 `id/note/url`，从 `position` 读取 `new_path/new_line/head_sha`；native discussion payload 缺少 diff position 时仍作为 MR note comment 处理，但 instruction 只包含链接和正文摘要。
   - 如果 payload 无法提供 PR/MR 编号，`runReviewComment()` 返回 `not_pull_request_review_comment`；不通过 list comments 猜测目标。

3. 增加 review comment reply / resolve 受控 CLI。
   - 在统一 CLI 下扩展 `pr review-comments`：
     ```bash
     issue-flow pr review-comments reply --pr <num> --comment-id <id> --body-file <tmp-body-file>
     issue-flow pr review-comments resolve --pr <num> --comment-id <id>
     ```
   - `--body-file` 必须是 repo 外临时文件，和 PR body/review body 规则一致。
   - Provider 层新增能力：
     - GitHub reply：使用 Pull Request Review Comment reply endpoint，以触发 comment id 作为 parent comment id。
     - GitHub resolve：provider 内部解析 review thread id，再调用受控实现 resolve thread；agent 不直接写 GraphQL/API。
     - GitLab reply：对 MR discussion/note 创建 reply；事件 payload 或 `review-comments list` normalization 需保留 `discussionId`。
     - GitLab resolve：对 resolvable discussion 执行 resolve；不可 resolve 时返回结构化 `reason: "review_comment_not_resolvable"`。
   - `review-comments list` normalization 需要保留足够字段供 reply/resolve 使用：
     - `commentId`
     - `discussionId`
     - `reviewId`
     - `url`
     - `resolved`
     - `resolvable`
   - reply 成功输出 `{ action: "replied", resource: "pr_review_comment", pr, commentId, replyUrl }`。
   - resolve 成功输出 `{ action: "resolved", resource: "pr_review_comment", pr, commentId, resolved: true }`。
   - 如果 provider 不支持 resolve 或 comment 已经 resolved，返回稳定 JSON；已 resolved 可视为成功幂等。

4. 让 submit.cjs 在 PR/MR body 中写入 Agentrix task marker。
   - 在 `submit.cjs` 新增 PR body task marker 支持，推荐复用 issue body 已有格式：
     - marker：`<!-- issue-flow:agentrix:task=<id> -->`
     - pattern：`/<!--\s*issue-flow:agentrix:task=([^>]+)\s*-->/i`
   - 新增参数 `--agentrix-task-id <id>`，默认从 `AGENTRIX_TASK_ID` 读取；与 `create-issue.cjs` 保持一致。
   - 把 `buildPrBodyWithSourceMarker()` 升级为 `buildPrBodyWithMarkers(body, issueNumber, taskId)`：
     - 永远写入或替换 `source-issue` marker。
     - 当 `taskId` 存在时，写入或替换 `agentrix:task=<id>` marker。
     - 当 `taskId` 不存在时，不写空 marker；review-comment 路由对缺少 marker 的旧 PR/MR 返回 `missing_agentrix_task`。
   - marker 写入位置建议位于 PR/MR body 顶部：
     ```md
     <!-- issue-flow:source-issue=26 -->
     <!-- issue-flow:agentrix:task=<AGENTRIX_TASK_ID> -->
     ```
   - `submit.cjs build` 和 `submit.cjs plan` 都写入 task marker；本需求对所有带 marker 的 PR/MR 生效，不再按 `mr-by::plan` / `mr-by::build` 分流。
   - 更新 `test/submit.test.cjs`：
     - 有 `AGENTRIX_TASK_ID` 时 PR body 包含 task marker。
     - stale task marker 被替换。
     - 没有 task id 时只写 source issue marker。
     - task marker 文件仍写入 repo-external temp file，不改原始 body file。

5. 限定 PR/MR 状态和 task id 解析。
   - 对当前 PR/MR 复用 `shouldSkipPullRequestReview()` 的状态判断：
     - draft 返回 `draft_pull_request`。
     - merged 返回 `merged_pull_request`。
     - state 非 `open/opened` 返回 `pull_request_not_open`。
   - 不要求 `mr-by::build` label；`mr-by::plan`、`mr-by::build` 或未来其它 issue-flow PR/MR 均可，只要 PR/MR body 能解析出 task marker。
   - source issue number 使用 `runtime.extractSourceIssueNumberFromPullRequest(currentPr)` 尽力解析，保持现有 body/title/branch marker 兼容；解析失败时继续 resume，但返回结果中 `sourceIssue` 为空或省略。
   - Agentrix task id 使用新增 `runtime.extractAgentrixTaskIdFromPullRequest(currentPr)`，只读取 PR/MR body 中的 `<!-- issue-flow:agentrix:task=<id> -->`。
   - Agentrix task id 不从 source issue body 解析，也不从 task lock comment、issue comments 或 branch name 推断；解析失败返回 `missing_agentrix_task`。
   - 该路径不读取 source issue state，也不根据 `flow::` 或 `status::` label 决定是否 resume；task marker 是 resume 目标的 source of truth。
   - 即使 source issue 可解析且当前为 `flow::approve`、`status::done`、size 冲突或其它非 build/resume 状态，也不阻断 PR/MR task resume；这些状态只影响常规 issue-flow automation，不影响对已存在 task 的 review feedback 投递。
   - 该路径不修改 source issue label/body。

6. 设计防重复触发策略。
   - 新增 review-comment-specific PR/MR lock marker，建议由 Agentrix runtime 生成：
     - `buildTaskCommentMarker('task_resume', { reviewComment: { id } })` 或专用 helper 返回 `<!-- issue-flow:agentrix:task:resume-review-comment:<id> -->`。
     - 没有 `reviewComment.id` 时回退到 PR/MR + comment URL hash；不能回退到全局 action marker，否则会阻断同一 PR 上后续不同评论。
   - `runReviewComment()` 不调用 `startAction()`，而是新增一个小 wrapper，例如 `resumeTaskForReviewComment()`：
     - 先在当前 PR/MR 评论区 claim `resume-review-comment:<comment-id>` lock，防止同一评论事件重复投递多次。
     - 再调用 runtime 的 task resume 能力，目标是 `data.agentrixTaskId`，instruction 指向该 review comment。
     - 如果同一 comment-scoped lock 已存在，返回 `duplicate_review_comment_resume`，同时带 existing lock comment URL。
   - 如果实现成本更低，也可以扩展 `claimPullRequestActionTask()` 支持 `data.lockScope`，让 review check、review-comment resume 使用同一 PR/MR claim/update 逻辑但不同 marker。
   - 不读取 source issue comments 来判断 duplicate，也不保留普通 `duplicate_task` issue/action 检查；旧的 source issue build lock marker 只能作为历史记录，不能阻断第一条或后续 review comment resume。
   - 锁评论最终 body 保留：
     - action: `task_resume`
     - trigger: review comment URL
     - pull request number
     - review comment id
     - Agentrix task id
   - 重复投递同一 comment id 时返回 `duplicate_review_comment_resume`，但不得对同一 task 发送第二次 resume。
   - 并发安全沿用 `claimPullRequestActionTask()` 创建后再 list winner 的模式；新增 marker 必须传入 `findActionTaskComment(comments, action, runtime, data)`，不能只查普通 review marker。

7. 构造 resume instruction 并调用 Agentrix task resume。
   - `runReviewComment()` 传入 resume instruction：
     ```text
     有新的 PR/MR review comment，请查看并处理。

     PR/MR: #<pr-number> <pr-url>
     Review comment: <comment-url>
     Review comment id: <comment-id>
     File: <path>:<line>
     Comment author: <author>

     处理完成后，请使用 issue-flow CLI 回复该 review comment，并在 provider 支持时 resolve 对应 discussion/thread。
     ```
   - 评论正文只放短摘要，最多约 500 字符，避免把长评论完整复制进锁评论；完整内容以链接为准。
   - Agentrix runtime 新增 `resumeTask(taskId, instruction, options, data)` 或等价内部函数：
     - 输入 task id 来自 PR/MR body marker。
     - metadata 包含 PR/MR、review comment id，以及可选 source issue。
     - 不创建新的 unrelated task。
   - 新增 `buildResumeTaskArgs(taskId, instruction, options, data, resultFile)`，用 `agentrix-run` 的 resume 模式构造参数：
     ```bash
     npx --yes @agentrix/agentrix-run@<version> \
       --resume <task-id> \
       --prompt "<resume instruction>" \
       --response-mode async \
       --result-file <tmp-result-json> \
       --base-url <AGENTRIX_BASE_URL> \
       --api-key <AGENTRIX_API_KEY>
     ```
   - resume 模式不传 `--agent`、`--title`、`--issue-number`、`--runner-id` 或 repository metadata；这些上下文由已有 task 保留。review comment URL、PR/MR number 和可选 source issue 放进 `--prompt` 文本即可。
   - `resumeTask()` 继续复用当前 runtime 的 `resolveAgentrixRunPackage()`、`resolveResponseMode()`、临时 `result.json` 和 `npx` 执行模式；dry-run 输出 `{ dryRun: true, runtime: "agentrix", action: "task_resume", taskId, prompt }`。
   - `buildTaskComment()` 对 `data.comment.htmlUrl` 已会输出 `Trigger:`；本次补充 `data.reviewComment` fallback，确保 review comment URL 被记录。
   - resume metadata 以 PR/MR 和 task 为主；如果解析到 source issue，再附加 source issue metadata：
     - `issue_flow_pr=<repo>#<pr>`
     - `issue_flow_review_comment=<comment-id>`
     - `issue_flow_agentrix_task=<task-id>`
     - `issue_flow_source_issue=<repo>#<sourceIssue>`（可选）
   - 不新增 `flow::review` 或新的 issue label；这只是已有 Agentrix task 的 review feedback resume 入口。
   - Agentrix runtime prompt / resume instruction 需要明确闭环顺序：
     - 先处理触发 comment 指向的代码或方案反馈。
     - 如果反馈无需改代码，也要说明原因。
     - 用 `issue-flow pr review-comments reply --pr <num> --comment-id <id> --body-file <tmp>` 回复该 comment/thread。
     - 当反馈已处理且 provider 支持 resolve 时，用 `issue-flow pr review-comments resolve --pr <num> --comment-id <id>` resolve。
     - 如果 resolve 失败且返回 `review_comment_not_resolvable`，保留 reply 作为闭环即可。

8. 新增/更新 bootstrap workflow。
   - GitHub 推荐新增独立 workflow `issue-flow-pr-review-comment.yml`，避免和 `issue-flow-pr-review.yml` 的 review check 开关混在一起。
   - GitHub workflow：
     - `on.pull_request_review_comment.types: [created]`
     - permissions: `contents: read`, `issues: write`, `pull-requests: read`
     - job guard：
       - `github.event.pull_request.state == 'open'`
       - `contains(github.event.pull_request.body, 'issue-flow:agentrix:task=')`
     - concurrency group: `issue-flow-review-comment-${{ github.event.pull_request.number }}-${{ github.event.comment.id }}`
     - checkout base ref with sparse checkout `.agentrix/plugins/issue-flow` and `.issue-flow`
     - run `node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs dispatch review-comment --event "$GITHUB_EVENT_PATH"`
   - 不让该 workflow 依赖 `ISSUE_FLOW_REVIEW_ENABLED`；`ISSUE_FLOW_REVIEW_ENABLED` 控制自动 review check，不应关闭 reviewer feedback resume。若需要全局关闭，应通过既有 Agentrix credentials/automation policy 或后续单独变量处理。
   - `bootstrap.cjs` 的 `AGENTRIX_GITHUB_WORKFLOWS` 加入新 workflow；`install-manifest` 会记录 managed 文件。
   - GitLab `.gitlab/issue-flow.gitlab-ci.yml` 新增 `issue-flow-review-comment` job：
     - Agentrix bridge：`AGENTRIX_EVENT_NAME == "pull_request_review_comment"` 且 `AGENTRIX_EVENT_ACTION == "created"`。
     - native note：`GITLAB_EVENT_NAME == "note"` 且 payload 为 MR note 时执行；脚本层再做 PR/MR state 与 task marker 判断。
     - checkout default/base runtime 文件后调用 `cli.cjs dispatch review-comment`.
   - GitLab native note 环境若无法可靠区分 issue note 和 MR note，允许 job 触发后由 dispatch 返回 `not_pull_request_review_comment`；这比在 CI rule 中误过滤 diff comment 更安全。

9. 更新文档。
   - `skills/issue-flow/SKILL.md`：
     - Dispatch 列表增加 `issue-flow dispatch review-comment --event <event-json-file>`。
     - 说明该入口用于带 task marker 的 PR/MR review comment resume，不替代 `dispatch review`，且不按评论作者类型过滤。
   - `docs/provider-api.md`：
     - Dispatch CLI 小节增加 `review-comment`。
     - PR/MR review comments 小节说明 list API 与事件入口的区别：list 用于读取历史评论，review-comment 用于路由单个新事件。
     - PR/MR review comments 小节增加 `reply` / `resolve` 命令，说明它们是 agent 回复和关闭 review feedback 的唯一受控入口。
     - `submit.cjs` 行为小节增加 PR/MR body task marker：有 `AGENTRIX_TASK_ID` 或 `--agentrix-task-id` 时插入 `<!-- issue-flow:agentrix:task=<id> -->`。
     - Agentrix 行为小节增加 review-comment trigger、PR/MR body task id 解析、Agentrix task resume 和 PR/MR scoped duplicate comment lock。
   - `docs/state-machine.md`：
     - 在 PR/MR Review Check 后新增 “Review Comment Resume” 表：
       - Scope: PR/MR with Agentrix task marker
       - Trigger: review comment created
       - Command: `issue-flow dispatch review-comment`
       - Issue state: 不要求读取 source issue state，不改 label
       - Task target: 从 PR/MR body 的 `issue-flow:agentrix:task=<id>` marker 解析
       - Close loop: task 处理完成后 reply 触发 comment，并尽量 resolve thread/discussion
       - Skip: not open、missing PR task marker、duplicate comment event
   - `README.md` 追加工作流概览，说明 reviewer 在带 task marker 的 PR/MR 上留 inline comment 后无需到 issue 或 Agentrix task 手动 resume。

10. 测试覆盖。
   - `test/dispatch.test.cjs`：
     - parser/help 接受 `review-comment`。
     - GitHub `pull_request_review_comment.created` + open PR + PR body task marker 会对该 task id 执行 resume dry-run，并在 instruction 中包含 review comment URL。
     - GitHub bot/Agentrix-authored review comment 和人工 review comment 走同一条 resume 路由，不按 `user.type` 跳过。
     - edited event 返回 `unsupported_event_action`。
     - `mr-by::plan`、`mr-by::build` 和无 `mr-by::*` label 但带 task marker 的 PR 都可以 resume。
     - PR closed/draft/merged 返回现有 PR skip reason。
     - 缺少 source issue marker 不阻断 resume；结果中 source issue metadata 为空。
     - 缺少 PR body task marker 返回 `missing_agentrix_task`。
     - source issue `flow::plan`、`status::done/drop/suspend` 或 size 冲突不阻断 task resume，因为不读取 source issue state。
     - source issue `flow::approve` 不阻断 task resume，覆盖 build PR/MR 等待 human review 的常规生命周期。
     - source issue 上存在历史 `<!-- issue-flow:agentrix:task:build -->` 普通 action lock marker 时，不返回 `duplicate_task`，仍按 PR/MR comment-scoped lock 判断。
     - 同一 review comment 已有 PR/MR lock marker 时返回 duplicate reason，不发送第二次 resume。
   - `test/providers.test.cjs`：
     - GitHub review comment context normalization 覆盖 id、url、path、line、author。
     - GitLab bridge/native note review comment context normalization 覆盖 `object_attributes.note`、`url`、`position.new_path/new_line`、`merge_request.iid`。
     - GitHub review comment reply 使用 parent comment id。
     - GitHub resolve 可从 comment id 找到 thread 并调用 provider 内部 resolve；已 resolved 幂等。
     - GitLab review comment reply 使用 discussion id；resolve 对 resolvable discussion 生效。
   - `test/agentrix-runtime.test.cjs`：
     - `extractAgentrixTaskIdFromPullRequest()` 只从 PR/MR body marker 解析 task id。
     - source issue body 里有 `issue-flow:agentrix:task=<id>` 时不会被 PR/MR task resolver 使用。
     - `buildTaskCommentMarker('task_resume', { reviewComment: { id: 101 } })` 或专用 helper 生成 comment-scoped PR/MR marker。
     - `buildResumeTaskArgs()` 包含 `--resume <task-id>`、`--prompt`、`--response-mode async` 和 `--result-file`，且不包含 `--runner-id`、`--issue-number`、`--title`。
     - task resume dry-run 输出包含 task id、review comment URL 和 source issue metadata。
     - resume instruction / prompt 包含 `pr review-comments reply` 和 `pr review-comments resolve` 命令示例。
   - `test/submit.test.cjs`：
     - `buildPrBodyWithMarkers()` 同时写入 source issue marker 和 task marker。
     - `AGENTRIX_TASK_ID` / `--agentrix-task-id` 能进入 PR body wrapper。
     - stale task marker 被替换；没有 task id 时不写空 marker。
   - `test/bootstrap.test.cjs`：
     - GitHub bootstrap 写出 `.github/workflows/issue-flow-pr-review-comment.yml`。
     - workflow 包含 `pull_request_review_comment`、`created`、task marker body guard、`cli.cjs dispatch review-comment`，且不包含 bot/user-type 或 `mr-by::build` 过滤。
     - GitLab bootstrap job 包含 bridge/native note 规则和 `dispatch review-comment`。
   - `test/cli.test.cjs`：
     - `issue-flow dispatch --help` 包含 `review-comment`。
     - `issue-flow dispatch review-comment --event <tmp> --dry-run` 能转调 dispatch 脚本并输出单个 JSON envelope。
     - `issue-flow pr review-comments --help` 包含 `list`、`reply`、`resolve`。
   - 回归 `npm test`。

## 验证方案

- 自动验证：
  - `npm test`
  - `node skills/issue-flow/cli.cjs dispatch review-comment --event <github-review-comment-event.json> --dry-run`
  - `node skills/issue-flow/cli.cjs dispatch review-comment --event <github-review-comment-edited-event.json> --dry-run`，确认返回 `unsupported_event_action`。
  - `node skills/issue-flow/cli.cjs dispatch review-comment --event <gitlab-mr-note-event.json> --provider gitlab --dry-run`
  - `node skills/issue-flow/cli.cjs pr review-comments list --pr <pr> --dry-run`，确认既有 list 能力未回退。
  - `node skills/issue-flow/cli.cjs pr review-comments reply --pr <pr> --comment-id <id> --body-file <tmp> --dry-run`
  - `node skills/issue-flow/cli.cjs pr review-comments resolve --pr <pr> --comment-id <id> --dry-run`
- 手动验证：
  - 在测试仓库中创建 issue-flow plan PR 和 build PR，确认 PR/MR body 都带 source issue marker 和 `issue-flow:agentrix:task=<id>` marker。
  - 人工 reviewer 或 Agentrix reviewer 在 open PR/MR 上新增 inline review comment，确认 GitHub Actions / GitLab CI 启动 `dispatch review-comment`，PR/MR 出现 comment-scoped lock，PR/MR body 中的 Agentrix task 收到包含 review comment 链接的 resume instruction。
  - task 处理完成后，确认触发 comment 收到 reply；GitHub/GitLab 支持 resolve 的场景下，对应 thread/discussion 进入 resolved 状态。
  - 重放同一个 event payload，确认不会对同一 task 发送第二次 resume，并能看到 duplicate reason。
  - 用 bot/自动化账号评论，确认不会因为作者类型被跳过；只要事件、PR/MR 和 task marker 满足条件就 resume。
  - 在 source issue 已处于 `flow::approve` 且保留历史 build action lock comment 的 build PR/MR 上新增 review comment，确认仍 resume PR/MR body 中的 task id。
  - 在 closed PR、缺少 task marker 的普通 PR 上评论，确认跳过 reason 可读。
- 回归范围：
  - PR/MR review check：`dispatch review` 和 `issue-flow-pr-review.yml` 的行为不变。
  - issue comment mention：`dispatch comment` 仍只处理 issue comment，不把 PR/MR note 当 issue mention。
  - plan/build submit 和 `pr-merged` 状态流转不变，除了 submit PR/MR body 额外写 task marker。
  - Agentrix task lock comment 兼容既有 `triage/plan/build/review` marker，同时新增 PR/MR scoped review-comment resume marker；PR/MR body 新增 `issue-flow:agentrix:task=<id>` marker。
