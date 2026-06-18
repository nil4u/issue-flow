## 目标

- 为 issue-flow 增加一个稳定的 agent-facing 总 CLI：`issue-flow <resource> <action> [options]`，安装前也可用 `node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs ...` 调用。
- 将当前分散的 `apply.cjs`、`create-issue.cjs`、`submit.cjs`、`review.cjs`、`sync-labels.cjs`、`dispatch.cjs`、`pr-merged.cjs` 收敛到类似 `gh` 的 subcommand 体验，让 agent 只需要记住一个入口和一致的参数风格。
- 让 issue、PR/MR、label、comment、review、dispatch 等受控 provider 读写都通过 issue-flow 语义层完成，并输出稳定 JSON，便于 agent、CI 和测试消费。
- 补齐统一 CLI 所需的受控 provider 原语，尤其是读取 issue/PR、列评论、创建/更新/删除评论、acknowledge/reaction；同时保持“不提供任意 provider API passthrough”的边界。
- 更新 skill 文档、runtime prompts、安装资产和人类文档，让新入口成为首选 agent-facing API，并明确禁止 agent 对已覆盖动作直接调用 `gh`、`glab` 或手写 provider API。

## 非目标

- 不删除旧脚本。旧脚本继续作为兼容入口和内部实现使用，避免破坏现有 CI、历史 prompt、用户脚本和测试。
- 不新增通用 `provider api request`、任意 REST path、任意 `gh api` / `glab api` passthrough。
- 不暴露 issue-flow 未纳入语义的 provider 管理面，例如任意 close/reopen、assign、milestone、project、branch protection 或 repo settings 操作。
- 不改变 label 状态机语义：`apply.cjs` 的 managed label 互斥规则、`submit.cjs` 的 source issue `flow::approve` 转移、`pr-merged.cjs` 的 merge 后转移保持不变。
- 不要求 provider 内部放弃 token API 或 CLI fallback；只是把 token/API/CLI 的选择继续封装在 provider 层，不暴露给 agent。

## 当前上下文

- 相关模块：
  - `skills/issue-flow/scripts/apply.cjs` 已负责已有 issue 的 managed label/body 更新，支持 `--type`、`--status`、`--flow`、`--automation`、`--priority`、`--clear-flow`、`--clear-automation` 和 normalized body。
  - `skills/issue-flow/scripts/create-issue.cjs` 已负责标准化 issue 创建，输出稳定 JSON，并通过 provider abstraction 创建 GitHub/GitLab issue。
  - `skills/issue-flow/scripts/submit.cjs` 已负责 plan/build PR/MR 创建或更新，并把 source issue 转到 `flow::approve`。
  - `skills/issue-flow/scripts/review.cjs` 已负责提交 PR/MR review，GitHub 走 Pull Request Review API，GitLab 走 MR note。
  - `skills/issue-flow/scripts/sync-labels.cjs` 已负责 provider labels sync/check。
  - `skills/issue-flow/scripts/dispatch.cjs` 已负责 `auto`、`comment`、`review`、`pr-merged`、`resume`、`general`、`triage`、`plan`、`build` 等 runtime 调度入口。
  - `skills/issue-flow/scripts/pr-merged.cjs` 已负责 merged PR/MR 事件后的 source issue 状态推进。
  - `skills/issue-flow/scripts/providers.cjs` 已有 GitHub/GitLab provider abstraction，导出的 provider 对象包含 `fetchCurrentIssue`、`fetchCurrentPullRequest`、`listIssueComments`、`createIssueComment`、`updateIssueComment`、`deleteIssueComment`、`listPullRequestComments`、`createPullRequestComment`、`updatePullRequestComment`、`deletePullRequestComment`、`submitPullRequestReview`、`addTriggerCommentReaction`、`addIssueReaction` 等方法，但这些能力目前没有统一 CLI 命令完整暴露。
  - `docs/provider-api.md` 目前是“脚本 CLI 参考”，按独立脚本组织命令，且仍把多个脚本作为主要用户入口。
  - `skills/issue-flow/SKILL.md` 和安装后的 `.agentrix/plugins/issue-flow/skills/issue-flow/SKILL.md` 目前要求 agent 记住多个脚本：`apply.cjs`、`create-issue.cjs`、`submit.cjs`、`sync-labels.cjs`、`review.cjs` 等。
  - `skills/issue-flow/scripts/runtimes/agentrix.cjs` 会把 skill 路径、plan output、PR body file rule、review submission 等注入给 agent，目前注入的示例仍指向独立脚本。
  - GitHub/GitLab workflow 安装资产目前直接调用 `scripts/intake.cjs`、`scripts/dispatch.cjs` 和 `scripts/sync-labels.cjs`；其中 newly opened issue 路径必须先执行 intake，再进入 dispatch auto。
  - `package.json` 没有 `bin` 字段；项目依赖 Node.js built-ins 和 `node --test`，没有外部 CLI 框架。
- 相关接口 / 数据 / 状态：
  - 现有 provider 检测顺序由 `providers.cjs` 统一处理：`--provider`、env、Agentrix bridge env、event payload、remote 等。
  - 现有通用选项分散在各脚本中，包括 `--provider`、`--repo`、`--event`、`--dry-run`、GitLab URL/token override、runtime config/prompt/template override 等。
  - 现有脚本输出并不完全一致：`create-issue.cjs`、`review.cjs` 输出 JSON，`submit.cjs` 也会输出 provider 操作结果，但 `dispatch.cjs` 有 `[issue-flow]` 日志，`apply.cjs`/`sync-labels.cjs` 的输出风格各自维护。
  - PR/MR comment 在 GitHub 上复用 issue comment API；GitLab 上 issue note 和 MR note 是不同资源，但 provider 层已经提供了统一方法。
  - Reaction/acknowledge 目前主要用于 comment routing 的 trigger comment reaction 和 issue reaction，命令层需要定义清晰的受控语义，而不是暴露任意 reaction endpoint。
- 既有约束：
  - Provider 写操作必须通过确定性脚本/provider abstraction 完成。
  - Managed label 必须遵循 `labels.cjs` catalog 和同 prefix 互斥规则。
  - PR body 文件必须使用 repo 外临时文件传给提交命令，不能把 PR body 文件提交进 git。
  - 安装器会把 runtime 文件复制到 `.agentrix/plugins/issue-flow/`，因此源码 skill、安装资产、当前项目级插件副本的 agent-facing 文档都要保持一致。
  - 旧脚本兼容很重要：测试、workflow 和已有项目可能仍直接调用独立脚本。

## 方案

1. 新增总 CLI 文件和薄路由层。
   - 新增 `skills/issue-flow/cli.cjs`，作为安装后的推荐入口：`node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs <resource> <action> [options]`。
   - 同步让安装资产复制该文件到 `.agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs`。
   - 可选新增 `skills/issue-flow/scripts/issue-flow.cjs` 或保留 `cli.cjs` 作为唯一实现；若新增包装文件，应只转调 `../cli.cjs`，避免两份路由表。
   - 在 `package.json` 增加 `bin`：
     ```json
     {
       "bin": {
         "issue-flow": "skills/issue-flow/cli.cjs"
       }
     }
     ```
     这样本仓库作为 npm/package 安装时可直接调用 `issue-flow`。安装到目标 repo 时，仍以 `node .agentrix/plugins/.../cli.cjs` 为稳定路径。
   - CLI 本身只负责解析 `<resource> <action>`、展示 help、校验命令树、把参数转发给现有脚本的 exported `main()` 或新增的小型 service function；不在 CLI 层重复 provider API 细节。
   - 顶层 `--help` 展示资源概览；`issue-flow issue --help`、`issue-flow issue comments --help`、`issue-flow pr submit --help` 等展示局部命令和选项。

2. 设计稳定命令树。
   - Issue：
     ```bash
     issue-flow issue get --issue 123
     issue-flow issue create --title ... --body-file ...
     issue-flow issue apply --issue 123 --flow flow::build
     issue-flow issue intake --issue 123
     issue-flow issue comments list --issue 123
     issue-flow issue comments create --issue 123 --body-file /tmp/body.md
     issue-flow issue comments update --issue 123 --comment-id ... --body-file /tmp/body.md
     issue-flow issue comments delete --issue 123 --comment-id ...
     issue-flow issue acknowledge --issue 123 [--content eyes]
     issue-flow issue reaction create --issue 123 --content eyes
     ```
   - PR/MR：
     ```bash
     issue-flow pr get --pr 45
     issue-flow pr submit plan --issue 123 --title ... --body-file /tmp/pr.md
     issue-flow pr submit build --issue 123 --title ... --body-file /tmp/pr.md
     issue-flow pr comments list --pr 45
     issue-flow pr comments create --pr 45 --body-file /tmp/body.md
     issue-flow pr comments update --pr 45 --comment-id ... --body-file /tmp/body.md
     issue-flow pr comments delete --pr 45 --comment-id ...
     issue-flow pr review --pr 45 --body-file /tmp/review.md
     issue-flow pr merged --event /tmp/event.json
     ```
   - Labels：
     ```bash
     issue-flow labels sync
     issue-flow labels check
     ```
   - Dispatch：
     ```bash
     issue-flow dispatch auto --event /tmp/event.json
     issue-flow dispatch comment --event /tmp/event.json
     issue-flow dispatch review --event /tmp/event.json
     issue-flow dispatch review --pr 45
     issue-flow dispatch pr-merged --event /tmp/event.json
     issue-flow dispatch resume --event /tmp/event.json
     issue-flow dispatch triage --issue 123
     issue-flow dispatch plan --issue 123
     issue-flow dispatch build --issue 123
     issue-flow dispatch general --issue 123 --instruction "..."
     ```
   - 参数别名策略：
     - 新 CLI 对 agent 暴露 `--issue` 和 `--pr`。
     - 转调旧脚本时映射为 `--issue-number`、`--pr-number`。
     - 旧脚本继续接受旧参数；新文档不再把旧参数作为首选。
   - 命名策略：
     - `pr` 在 CLI 文案中解释为 GitHub PR 或 GitLab MR。
     - `pr merged` 保持事件处理语义，内部转调 `pr-merged.cjs` 或 `dispatch.cjs pr-merged`，最终以 state machine 行为为准。

3. 复用现有脚本作为内部实现。
   - `issue create` 转调 `create-issue.cjs main()`，只做 `--issue` 不适用的参数透传。
   - `issue apply` 转调 `apply.cjs main()`，把 `--issue` 映射成 `--issue-number`。
   - `issue intake` 转调 `intake.cjs main()`，把 `--issue` 映射成 `--issue-number`；GitHub/GitLab opened issue workflow 仍保持 intake-before-dispatch 语义，只是入口从独立脚本迁移到总 CLI。
   - `pr submit plan|build` 转调 `submit.cjs main([kind, ...])`，把 `--issue` 映射成 `--issue-number`。
   - `pr review` 转调 `review.cjs main()`，把 `--pr` 映射成 `--pr-number`。
   - `labels sync` 转调 `sync-labels.cjs main()`；`labels check` 等价于 `sync-labels.cjs --check`。
   - `dispatch *` 转调 `dispatch.cjs main([command, ...])`，把 `--issue`/`--pr` 分别映射成旧参数。
   - `pr merged` 可优先转调 `dispatch.cjs pr-merged`，保持 merge 后自动 resume 逻辑；如只需要底层 transition，可在 help 中注明内部使用 dispatch 入口。
   - 对旧脚本目前没有 export `main()` 或返回值不统一的地方，做小幅内部整理：保持 CLI 直接执行路径输出不变，同时让 `main()` 返回结构化对象，方便总 CLI 做 JSON 包装。

4. 重新设计 provider 交界面，按控制反转暴露受控 capabilities。
   - 不把 `resource-ops.cjs` 做成第二套 provider adapter。统一 CLI 的命令 handler 应依赖一个 issue-flow 语义层的 provider port，而不是直接知道 GitHub/GitLab API path、comment endpoint 差异或 dry-run 打印细节。
   - 在 `providers.cjs` 或相邻模块中抽出稳定 port，例如 `resolveProviderPort(options, payload)`，返回当前 provider 的 capability object。GitHub/GitLab 具体实现注入到命令层；命令层只调用 capability 方法。
   - Port 按 issue-flow 资源建模，而不是按 provider REST path 建模：
     ```js
     {
       provider: 'github',
       repo: { fullName: 'owner/repo' },
       issues: {
         get(ref, options),
         create(input, options),
         apply(ref, patch, options),
         intake(ref, options),
         listComments(ref, options),
         createComment(ref, input, options),
         updateComment(ref, commentRef, input, options),
         deleteComment(ref, commentRef, options),
         acknowledge(ref, input, options),
       },
       pullRequests: {
         get(ref, options),
         submit(kind, input, options),
         listComments(ref, options),
         createComment(ref, input, options),
         updateComment(ref, commentRef, input, options),
         deleteComment(ref, commentRef, options),
         review(ref, input, options),
         merged(input, options),
       },
       labels: {
         sync(input, options),
         check(input, options),
       },
       dispatch: {
         run(command, input, options),
       },
     }
     ```
   - 首版可以让 port 方法内部复用现有脚本/service functions：
     - `issues.apply` 调用 apply service。
     - `issues.create` 调用 create issue service。
     - `issues.intake` 调用 intake service。
     - `pullRequests.submit` 调用 submit service。
     - `pullRequests.review` 调用 review service。
     - `labels.sync/check` 调用 sync-labels service。
     - `dispatch.run` 调用 dispatch service。
     这样总 CLI 和旧脚本共享同一业务逻辑，同时把依赖方向改成“命令层依赖 port，provider 实现注入 port”。
   - 对现有 `providers.github` / `providers.gitlab` 中较底层的方法做分层：
     - 保留低层 provider primitives：`requestGithub`、`requestGitlab`、API path builder、token/CLI fallback。
     - 新增 provider capability implementation：把 `fetchCurrentIssue`、`listIssueComments`、`createIssueComment`、`submitPullRequestReview` 等组合成统一 port 方法。
     - 命令层和 runtime 不直接调用低层 primitives，也不直接调用 `gh` / `glab`。
   - 输出统一 JSON envelope：
     ```json
     {
       "action": "fetched",
       "provider": "github",
       "repo": "owner/repo",
       "resource": "issue",
       "issue": 123,
       "data": {}
     }
     ```
     列表命令使用 `items`，创建/更新/删除命令返回 `commentId`、`commentUrl`、`deleted` 等稳定字段。
   - 规范字段命名：
     - issue/PR/MR 编号统一为 `issue`、`pr`。
     - URL 统一输出 `url`，同时可在 `data` 中保留 provider 原字段。
     - comment id 统一为字符串 `commentId`，避免 GitHub numeric id 和 GitLab note id 的类型差异影响 agent。
   - 对 delete 命令输出 `{ "action": "deleted", "deleted": true }`；provider 返回 404/权限错误时不吞错。
   - 对 reaction/acknowledge：
     - `issue acknowledge` 默认 `eyes`，只允许 provider 支持且 issue-flow 已使用的受控 content。
     - `issue reaction create --content <content>` 限制在 provider 支持的安全枚举内，默认先支持 `eyes`。
     - 不提供任意 reaction subject/path；comment reaction 若未来需要，可作为 `issue comments acknowledge --comment-id ...` 加入，不在首版硬塞到通用 API passthrough。

5. 统一 JSON 和日志策略。
   - 新总 CLI 所有成功命令只向 stdout 输出单个 JSON 文档。
   - 诊断日志如果必须保留，输出到 stderr，避免污染 agent/CI 解析 stdout。
   - 转调 `dispatch.cjs` 这类已有 stdout 日志的脚本时，优先重构脚本内部日志函数支持 `{ json: true }` 或 `{ quiet: true }`，由总 CLI 开启；直接调用旧脚本仍保持当前日志体验。
   - 对 provider helper 里现有的 dry-run stdout 也要同步处理，不能只处理 `dispatch.cjs`。例如 `createGithubIssueComment()`、`createGitlabPullRequestComment()`、reaction helper 等目前会在 dry-run 时直接 `console.log(JSON.stringify(...))`；总 CLI 调用这些 helper 前必须通过以下二选一方式保证 stdout 只有一个 envelope：
     - 推荐把 provider port 的 dry-run 契约定义成“返回 planned result，不自行写 stdout”。旧脚本直接执行时由脚本 main 负责打印；总 CLI 由 envelope printer 负责打印。
     - 低层 provider helper 如仍保留 dry-run 打印，必须受 `options.quiet` / `options.dryRunReporter` 控制；provider port 调用它们时强制 quiet，避免双重 JSON。
   - 所有命令支持 `--dry-run` 时，JSON 输出包含 `dryRun: true` 和 planned action，不调用 provider 写 API。
   - 错误输出保持 stderr 文本并使用非零 exit code；可附带一行 JSON error 作为后续增强，但首版不要求 agent 解析失败 JSON。

6. Help 和参数校验。
   - 不引入外部 CLI 依赖，继续使用 Node.js built-ins，减少安装/复制复杂度。
   - 实现轻量命令树：
     - 每个 node 定义 `summary`、`usage`、`options`、`children` 或 `handler`。
     - 未知 resource/action 返回该层 help 和非零 exit。
     - `--help` 在任意层级只打印对应层 help，不访问 provider。
   - 把通用选项集中展示：
     - `--provider github|gitlab`
     - `--repo owner/repo|group/project`
     - `--event <path>`
     - `--dry-run`
     - GitLab override 选项沿用旧脚本支持，但放在 advanced/common provider options。
   - 必填参数由 handler 在转调前校验，例如 `issue get` 必须有 `--issue` 或 event 能推导出 issue；`pr get` 必须有 `--pr` 或 event 能推导出 PR/MR。

7. 更新 agent-facing 文档和 prompts。
   - `skills/issue-flow/SKILL.md` 改成以总 CLI 为唯一首选入口：
     - Provider 写操作规范改为“使用 `issue-flow ...` 子命令”；旧脚本只作为兼容/内部实现简短说明，不再放在主要路径。
     - Triage 示例改为 `issue-flow issue apply --issue 123 --flow flow::build ...`。
     - Plan/Build 提交示例改为 `issue-flow pr submit plan --issue 123 ...`。
     - Review 提交示例改为 `issue-flow pr review --pr 45 --body-file ...`。
     - 信息不足示例改为 `issue-flow issue apply --issue 123 --flow flow::clarify`。
   - `skills/issue-flow/assets/agentrix/runtime/prompts/*.prompt.md` 更新：
     - 明确 agent 不得用 `gh`、`glab` 或手写 provider API 完成 issue-flow 已覆盖动作。
     - 对 plan/build/review 的注入文案使用 `issue-flow` 总 CLI。
     - PR body 仍要求 repo-external temp file，并传给 `issue-flow pr submit ... --body-file`。
   - `skills/issue-flow/scripts/runtimes/agentrix.cjs` 的注入函数更新：
     - `formatPrBodyFileRule()` 提到总 CLI。
     - `formatReviewSubmission()` 输出 `node <skillRoot>/cli.cjs pr review --pr ... --body-file ...`。
     - Required skill 仍注入 `SKILL.md`。
   - 同步更新安装资产和当前项目级 `.agentrix/plugins/issue-flow/skills/issue-flow/SKILL.md`，确保运行时看到的是同一套首选入口。

8. 更新 workflow、README 和 provider API 文档。
   - Bootstrap workflow 可以分两步迁移：
     - 首版保持旧 workflow 调用旧脚本以降低 CI 风险，但 README/SKILL 教 agent 使用总 CLI。
     - 或同步改 workflow 调用 `node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs issue intake ...`、`... dispatch ...` 和 `... labels sync`；推荐首版同步迁移，因为验收要求 `issue-flow` 成为 agent-facing 唯一入口，CI 也能验证总 CLI。
   - 如果 workflow 迁移到总 CLI，opened issue 路径必须保留顺序：
     ```bash
     node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs issue intake --issue "$ISSUE_NUMBER"
     node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs dispatch auto --event "$EVENT_PATH"
     ```
     GitLab bridge/manual 环境同理使用 `--issue "$AGENTRIX_ISSUE_NUMBER"` 或事件推导；不能因为总 CLI 迁移而跳过 intake。
   - `docs/provider-api.md` 从“脚本 CLI 参考”改为“issue-flow CLI 参考”，按 resource/action 组织，并保留“Legacy script compatibility”小节。
   - `README.md` 的 Create Normalized Issues 示例改为：
     ```bash
     node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs issue create \
       --title "Add export support" \
       --body-file /tmp/issue-body.md \
       --type type::feature \
       --status status::active \
       --flow flow::plan \
       --priority priority::p2
     ```
   - `CLAUDE.md` 更新开发约定：provider operations are accessed through issue-flow CLI/provider abstraction; direct `gh`/`glab` remains internal fallback only.
   - `docs/state-machine.md` 的 command 表改为总 CLI 命令，同时保留括号说明旧脚本兼容。

9. 兼容和迁移策略。
   - 旧脚本文件名、参数和直接执行行为保持兼容。
   - 总 CLI 不改变旧脚本默认分支检测、provider 检测、token fallback、label validation 等核心行为。
   - 若新 CLI 需要重构共享 parse/usage helper，先提取纯函数并保留现有 exported names，避免破坏测试导入。
   - 安装器 manifest 要包含新增 `cli.cjs`；reinstall 时按现有 managed file 规则处理。
   - 对当前已安装项目级插件副本，build 阶段应同步源码和 `.agentrix/plugins/issue-flow/skills/issue-flow/`，因为本仓库测试会检查安装资产和 runtime prompt 一致性。
   - 迁移文档明确：agent prompt 和 docs 首选总 CLI；用户已有直接脚本调用不需要立即改。

10. 验收路径。
   - 目标体验：
     - Agent 能通过单一入口完成 issue create/apply/get、PR submit/review/get、comments CRUD、labels sync/check、dispatch。
     - `--help` 可从顶层逐级发现命令，不需要记忆脚本文件名。
     - 所有新入口成功输出稳定 JSON。
   - 数据/接口/状态变化：
     - 新增 `cli.cjs` 和可选 `bin.issue-flow`。
     - 新增 provider capability port，并让 CLI command handler 依赖 port 而不是直接依赖 provider primitives 或 ad hoc resource helper。
     - 旧状态机 label 和 PR/MR state transition 不变。
     - docs/prompts 从多脚本首选迁移到总 CLI 首选。
   - 交互路径：
     - Plan agent 写 plan 后：`issue-flow pr submit plan --issue 15 --title "Plan #15: Add unified issue-flow CLI entrypoint" --body-file /tmp/body.md`。
     - Build agent 实现后：`issue-flow pr submit build --issue 15 ...`。
     - Review agent 发布审查：`issue-flow pr review --pr <num> --body-file /tmp/review.md`。
     - Comment router acknowledge：内部通过 provider abstraction 受控 reaction，不暴露 provider API path。

## 验证方案

- 自动验证：
  - 运行 `npm test`。
  - 新增 `test/cli.test.cjs` 覆盖：
    - 顶层、resource 层、action 层 `--help`。
    - `issue apply --issue` 参数映射到 `apply.cjs --issue-number`。
    - `issue intake --issue` 参数映射到 `intake.cjs --issue-number`，并可在 opened issue workflow 中先于 `dispatch auto` 使用。
    - `issue create` 转调 create issue 主流程，并保持 JSON 输出。
    - `pr submit plan|build --issue` 参数映射、title/body-file 透传。
    - `pr review --pr` 参数映射到 review。
    - `labels check` 注入 `--check`。
    - `dispatch review --pr`、`dispatch pr-merged --event` 映射正确。
    - 未知 resource/action 返回非零和对应 help。
  - 新增/扩展 provider port 测试：
    - `issue get` 通过 injected port 调用 `issues.get`，输出 normalized JSON。
    - `pr get` 通过 injected port 调用 `pullRequests.get`。
    - issue comments list/create/update/delete 分别调用 `issues.*Comment` capability。
    - pr comments list/create/update/delete 分别调用 `pullRequests.*Comment` capability。
    - reaction/acknowledge 只接受受控 content。
    - port dry-run 只返回 planned result，不直接写 stdout；总 CLI stdout 只包含一个 JSON envelope。
    - command handler 测试使用 fake provider port 注入，避免为 CLI 路由单测 mock GitHub/GitLab REST 细节。
  - 扩展 `test/bootstrap.test.cjs` / `test/install.test.cjs`：
    - 安装结果包含 `cli.cjs`。
    - GitHub/GitLab workflow 若迁移到总 CLI，断言调用 `cli.cjs issue intake ...`、`cli.cjs dispatch ...` 和 `cli.cjs labels sync`，并确认 opened issue 路径中 intake 仍先于 dispatch auto。
  - 扩展 `test/agentrix-runtime.test.cjs`：
    - 注入 prompt 中的 plan/build/review 提交命令使用总 CLI。
    - prompt 明确禁止绕过 issue-flow 使用 `gh`、`glab` 或手写 provider API。
  - 扩展 docs/prompt snapshot 或文本断言：
    - `SKILL.md` 首选入口为 `issue-flow ...`，旧脚本不作为主要 agent-facing API。
- 手动验证：
  - `node skills/issue-flow/cli.cjs --help` 展示资源列表。
  - `node skills/issue-flow/cli.cjs issue --help` 展示 `get/create/apply/comments/acknowledge/reaction`。
  - `node skills/issue-flow/cli.cjs pr submit --help` 展示 `plan` 和 `build`。
  - `node skills/issue-flow/cli.cjs labels check --dry-run` 或等价 check 路径行为清晰；若 `--dry-run` 与 `--check` 互斥，help 需要明确。
  - 使用 dry-run 验证：
    ```bash
    node skills/issue-flow/cli.cjs issue apply --issue 15 --flow flow::plan --dry-run
    node skills/issue-flow/cli.cjs issue create --title "Example" --body-file /tmp/body.md --type type::feature --dry-run
    node skills/issue-flow/cli.cjs pr submit plan --issue 15 --title "Plan #15: Example" --body-file /tmp/pr.md --dry-run --no-push
    node skills/issue-flow/cli.cjs dispatch resume --issue 15 --dry-run
    ```
  - 在测试仓库用 token 路径验证 `issue get`、`issue comments list/create/update/delete`、`pr get`、`pr comments list/create/update/delete` 输出 JSON 且 provider 页面状态正确。
  - 在无 token 但配置 CLI 的环境验证旧 provider fallback 仍由 provider 层处理，agent 命令不出现 `gh api` / `glab api`。
- 回归范围：
  - `apply.cjs` label/body 更新与 `flow::clarify` body skip。
  - `create-issue.cjs` 标准化 issue 创建、managed label 校验、GitLab label preflight。
  - `submit.cjs` plan/build PR/MR 创建或更新、branch/base/head 检查、source issue 转 `flow::approve`。
  - `review.cjs` GitHub PR Review / GitLab MR note。
  - `dispatch.cjs` issue auto/comment/review/resume/pr-merged routing。
  - `sync-labels.cjs` dry-run/check/upsert。
  - `bootstrap.cjs` install/reinstall manifest 行为。
