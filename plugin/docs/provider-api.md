# issue-flow CLI 参考

Agent-facing provider 操作统一通过 `issue-flow <resource> <action> [options]` 完成。安装前或目标仓库内可直接使用：

```bash
node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs <resource> <action> [options]
```

本仓库 checkout 中可使用：

```bash
node skills/issue-flow/cli.cjs <resource> <action> [options]
```

不要为 issue-flow 已覆盖的动作直接调用 `gh`、`glab`、`gh api`、`glab api`，也不要手写 GitHub/GitLab API 请求。provider 内部的 token API 或 CLI fallback 是实现细节。

## 通用选项

统一 CLI 和兼容脚本支持：

| 选项 | 说明 |
|------|------|
| `--provider github\|gitlab` | 指定 git provider（默认自动检测） |
| `--repo owner/repo` | 仓库路径覆盖 |
| `--dry-run` | 打印意图但不执行 API 调用 |

## 命令树

### Issue

```bash
issue-flow issue get --issue 123
issue-flow issue create --title ... --body-file ...
issue-flow issue apply --issue 123 --flow flow::build --size size::M
issue-flow issue intake --issue 123
issue-flow issue comments list --issue 123
issue-flow issue comments create --issue 123 --body-file /tmp/body.md
issue-flow issue comments update --issue 123 --comment-id ... --body-file /tmp/body.md
issue-flow issue comments delete --issue 123 --comment-id ...
issue-flow issue acknowledge --issue 123
issue-flow issue reaction create --issue 123 --content eyes
```

### PR/MR

```bash
issue-flow pr get --pr 45
issue-flow pr submit plan --issue 123 --title ... --body-file /tmp/pr.md
issue-flow pr submit build --issue 123 --title ... --body-file /tmp/pr.md
issue-flow pr comments list --pr 45
issue-flow pr comments create --pr 45 --body-file /tmp/body.md
issue-flow pr comments update --pr 45 --comment-id ... --body-file /tmp/body.md
issue-flow pr comments delete --pr 45 --comment-id ...
issue-flow pr review-comments list --pr 45
issue-flow pr review --pr 45 --body-file /tmp/review.md [--comments-file /tmp/inline-comments.json] [--as-comment]
issue-flow pr merged --event /tmp/event.json
```

### Labels 和 Dispatch

```bash
issue-flow labels sync
issue-flow labels check
issue-flow dispatch auto --event /tmp/event.json
issue-flow dispatch comment --event /tmp/event.json
issue-flow dispatch review --event /tmp/event.json
issue-flow dispatch review --pr 45
issue-flow dispatch review-comment --event /tmp/event.json
issue-flow dispatch pr-merged --event /tmp/event.json
issue-flow dispatch pipeline-failed --event /tmp/event.json
issue-flow dispatch resume --event /tmp/event.json
issue-flow dispatch triage --issue 123
issue-flow dispatch plan --issue 123
issue-flow dispatch build --issue 123
issue-flow dispatch general --issue 123 --instruction "..."
```

所有统一 CLI 成功命令 stdout 输出单个 JSON 文档。旧脚本继续兼容，但不作为新的 agent-facing 首选 API。

## 旧脚本兼容参考

## Provider 自动检测顺序

1. `--provider` 参数
2. `ISSUE_FLOW_PROVIDER` env
3. Agentrix bridge env（`AGENTRIX_PROVIDER=gitlab`）
4. GitLab 特有 env（`GITLAB_BASE_URL` 等）
5. repo 路径中包含 gitlab/github
6. GitLab token env（`GITLAB_TOKEN` 等）
7. event payload 结构（`object_kind` → gitlab）
8. git remote host
9. 默认 github

## Token

### GitHub

读取顺序：`GITHUB_TOKEN` → `GH_TOKEN` → git remote URL 中的 token（如存在）。

有 token 时，GitHub provider 操作直接调用 GitHub REST API。API 认证或授权失败会直接报错，不会静默 fallback 到 CLI。

只有没有可用 token 时，才尝试 `gh` CLI fallback。

GitHub API token 至少需要：
- issue/label 写权限：更新 source issue label/body，创建 PR label，并给 PR 添加 `mr-by::*` label
- pull request 写权限：创建或更新 PR

同步 provider labels 需要 token/CLI 账号具备仓库 label 管理权限。

`submit.cjs` 的 `git push` 优先使用本地 git remote/credential helper；当没有自定义 `GIT_ASKPASS` 且存在 `GITHUB_TOKEN`/`GH_TOKEN` 时，会为本次 push 创建临时 askpass 凭据。

Agentrix runtime 启动或 resume task 时会从子进程环境中移除 provider token（`GITHUB_TOKEN`、`GH_TOKEN`、`ISSUE_FLOW_GITLAB_TOKEN`、`GITLAB_TOKEN`、`GL_TOKEN`、`GITLAB_PRIVATE_TOKEN`、`CI_JOB_TOKEN`、`ISSUE_FLOW_GIT_TOKEN`）。这些 token 只供 issue-flow routing job 调用 provider API；Agentrix task 里的 provider 凭据由 Agentrix worker 环境提供。

### GitLab

读取顺序：`ISSUE_FLOW_GITLAB_TOKEN` → `GITLAB_TOKEN` → `GL_TOKEN` → `GITLAB_PRIVATE_TOKEN` → `CI_JOB_TOKEN` → git remote URL 中的 token（如存在）。

有 token 时，GitLab provider 操作直接调用 GitLab API。API 认证或授权失败会直接报错，不会静默 fallback 到 CLI。

只有没有可用 token 时，才尝试 `glab` CLI fallback。

GitLab API token 至少需要 issue/label 与 merge request 写权限。`submit.cjs` 的 `git push` 优先使用本地 git remote/credential helper；当没有自定义 `GIT_ASKPASS` 且存在 `ISSUE_FLOW_GITLAB_TOKEN`/`GITLAB_TOKEN`/`GL_TOKEN`/`GITLAB_PRIVATE_TOKEN`/`CI_JOB_TOKEN` 时，会为本次 push 创建临时 askpass 凭据。

同步 provider labels 需要 token/CLI 账号具备项目 label 管理权限。

## Event payload

GitHub Actions 使用 `GITHUB_EVENT_PATH` 读取事件文件。

GitLab 的推荐入口是 Agentrix daemon webhook bridge。bridge 触发 pipeline 时没有事件文件，
脚本会优先从当前 bridge 默认的 `GITLAB_BRIDGE_EVENT_NAME`、`GITLAB_BRIDGE_EVENT_ACTION`、
`GITLAB_BRIDGE_ISSUE_NUMBER`、`GITLAB_BRIDGE_PR_NUMBER`、`GITLAB_BRIDGE_LABELS_JSON`、
`GITLAB_BRIDGE_PR_BODY` 等变量合成兼容 payload；旧的 `AGENTRIX_*` bridge 变量仍作为 fallback。

如果显式传入 `--event` 或设置 `GITLAB_EVENT_PATH`，事件文件优先。

## pipeline-failed

分析 GitHub Actions workflow run 或 GitLab pipeline/job 失败，创建或更新 issue-flow issue，并交由 Agentrix 判断根因与下一步。

```bash
issue-flow dispatch pipeline-failed --event /tmp/event.json
issue-flow dispatch pipeline-failed --provider gitlab --repo group/project --log-file /tmp/failed-job.log
```

行为：

1. 收集 workflow/pipeline、job、step、run URL、commit、branch、PR/MR 和关键日志摘要
2. 不在 intake 阶段用规则判断是否可执行；失败上下文会进入 issue body，作为 Agentrix task 的 prompt 输入
3. 为失败创建或更新 issue，根因、类型、是否瞬时故障和验证方式由后续 agent 判断
4. 去重只查询 open issue 上的 `ci-fp::<hash8>` label，再读取 body marker 比对完整 `sha256:<fingerprint>`
5. 命中 open issue 时追加 comment；命中 `status::suspend` 时恢复为 `status::active`
6. 命中 closed similar issue 时默认新建 issue，并在 body 中引用 closed issue
7. 创建或更新 issue 后，`dispatch pipeline-failed` 会在同一个 job 中直接续跑普通 `auto` 路由；GitHub 不依赖 `GITHUB_TOKEN` 创建 issue 后再次触发 `issues` workflow，GitLab 也不依赖后续 Agentrix issue webhook

创建的新 issue 带有 `failure::ci`、`ci-fp::<hash8>`、`type::ops`、`status::active`、`flow::build`、`automation::build`、`size::M`。它仍使用 `build` action，但 Agentrix 会按 `failure::ci` label 或 body marker 选择 `build-ci-failure.prompt.md`，先定位根因再决定是否修改代码。只有确认根因是仓库代码回归时，agent 才应改成 `type::bug` 并按 build 修复；如果属于 CI/workflow/provider 配置、权限、secret、variable、runner、瞬时基础设施或外部服务范围，应保持 `type::ops`，并按情况流转到 `status::suspend`、`status::drop` 或 `status::done`。

GitHub 默认安装产物为 `.github/workflows/issue-flow-failure-intake.yml`，初次安装时会扫描 `.github/workflows/*.yml` / `.github/workflows/*.yaml` 并生成 GitHub Actions 要求的显式 `workflow_run.workflows` 列表，监听 completed failure 并要求 `actions: read` 与 `issues: write`，同时需要 Agentrix 相关变量/密钥以便 intake 后直接启动自动路由。后续重装会保留已配置的 workflow 列表，不会自动加入新发现的 workflow，避免覆盖用户手动排除的项；如果要监听新增 workflow，需要手动编辑 `.github/workflows/issue-flow-failure-intake.yml` 的 `workflow_run.workflows`。

GitLab 默认安装产物为 `.gitlab/issue-flow.gitlab-ci.yml` 内的 `issue-flow-failure-intake` job，仅由 Agentrix daemon webhook bridge 触发。当前 bridge 会把 GitLab pipeline failure 映射成 `workflow_run` / `completed`，并设置 `GITLAB_BRIDGE_WORKFLOW_RUN_CONCLUSION=failure`；旧的 `AGENTRIX_WORKFLOW_RUN_CONCLUSION=failure` 或 `AGENTRIX_PIPELINE_STATUS=failed` 仍可触发。GitLab 安装产物的 `issue-flow-auto` 会跳过 bridge issue 事件中带 `failure::ci` 或使用 `Fix CI failure:` 生成标题的 issue，避免 failure-intake direct auto-resume 后又为同一个 CI failure issue 消耗一条重复 auto job。

## apply.cjs

变更 issue 的 managed labels 和 body。

```bash
node apply.cjs --issue-number <num> [label-options] [body-options] [common-options]
```

### Label 选项

| 选项 | 值 |
|------|-----|
| `--type` | `type::feature\|bug\|debt\|ops` |
| `--status` | `status::active\|done\|drop\|suspend` |
| `--flow` | `flow::triage\|plan\|build\|clarify\|approve` |
| `--automation` | `automation::off\|automation::plan\|automation::build` |
| `--priority` | `priority::p0\|p1\|p2\|p3` |
| `--size` | `size::XS\|size::S\|size::M\|size::L\|size::XL` |
| `--clear-flow` | 移除所有 `flow::` label（不添加新的） |
| `--clear-automation` | 移除所有 `automation::` label |

### Body 选项

| 选项 | 说明 |
|------|------|
| `--normalized-body <markdown>` | 直接传入 normalized body |
| `--normalized-body-file <path>` | 从文件读取 normalized body |

注意：`flow::clarify` 时 body 更新自动跳过。

### 行为

1. 只处理你指定的 prefix
2. 移除指定 prefix 下的旧 label
3. 添加指定 prefix 的新 label
4. 不触碰未指定 prefix 的 label
5. 设置 `flow::plan` 或 `flow::build` 时，按最终 labels 校验有且仅有一个 `size::`

## submit.cjs

创建或更新 plan/build PR/MR。

```bash
node submit.cjs plan|build --issue-number <num> --title "<title>" --body-file <path> [options]
```

### 选项

| 选项 | 说明 |
|------|------|
| `--base <branch>` | 目标分支（默认：origin/HEAD → develop → main → master） |
| `--head <branch>` | 源分支（默认：当前分支） |
| `--label <label>` | PR label 覆盖（默认由 kind 决定） |
| `--draft` | 创建 draft PR/MR |
| `--no-push` | 不 push 分支 |

### 行为

`pr submit plan` 先读取 source issue 的 `feature:visual-plan:` 开关。

默认、无开关或 `feature:visual-plan:off` 使用 Markdown Plan PR/MR；`feature:visual-plan:on` 使用 Decision/Visual Plan PR/MR。三种产物统一执行：

1. 检查 worktree clean、head ≠ base、source issue 有且仅有一个 `size::`；缺失或冲突时不 push、不创建 PR/MR
2. 确保 `mr-by::plan` label 存在且颜色/说明匹配 catalog（优先 token API；无 token 时 fallback CLI）
3. push 当前 `{issue-number}-{slug}/plan` 分支
4. 从 `.issue-flow/issues/{issue-number}-{slug}/` 定位 `decision.html`、`plan/index.html` 或 Markdown Plan 文件
5. 使用 `.issue-flow/config.json` 的 `visionPlan.gitServerId`、`visionPlan.projectId`、`visionPlan.repositoryId` 和 `ISSUE_FLOW_BASE_URL` 生成统一 Engine URL
6. 创建或更新带 `mr-by::plan` label 的 PR/MR；body 写入 source/task marker、Engine URL 和 `issue-flow:plan-artifact` marker
7. Decision 设置 `flow::clarify`；Visual Plan 和 Markdown Plan 设置 `plan::pending + flow::approve`

Engine 从 `mr-by::plan` PR/MR 发现产物。草稿和历史评论按 repository、issue、Decision/Plan 分区保存在浏览器 LocalStorage。提交审阅时，Issue Flow 使用页面当前登录用户的 OAuth token 在该 PR/MR 下评论，由 review-comment pipeline resume 原 Plan task。Decision 批准只评论同一个 open MR并进入 `flow::plan`，不合并；恢复后的 Plan task 更新同一分支和 MR。Visual/Markdown Plan 批准后才合并 MR，并进入 `plan::approved + flow::build`。

如果 on/off 同时存在，命令失败且不发布。`pr submit build` 保持 PR/MR 行为：校验 source issue、确保 `mr-by::build` label、push 分支，在 body 写入 source/task marker、创建或更新 PR/MR，并把 source issue 转到 `flow::approve`。

## PR/MR review comments

`issue-flow pr review-comments list` 读取历史 review comments。`issue-flow dispatch review-comment --event <event>` 只路由单个新 review comment 事件：当 PR/MR open 且 body 带 `issue-flow:source source_task_id=<id> source_runtime=agentrix` marker 时，它会给触发 comment 加 `eyes` reaction，然后 resume 该 Agentrix task。该路径不再创建 PR/MR 顶层排队 comment。

被 resume 的 agent 处理完成后，应使用受控入口在 PR/MR 下发布一条普通总结 comment：

```bash
issue-flow pr comments create --pr 45 --body-file /tmp/body.md
```

## create-issue.cjs

创建标准化 provider issue。

```bash
node create-issue.cjs --title "<title>" --body-file <tmp-body-file> [label-options] [common-options]
```

### Label 选项

| 选项 | 值 |
|------|-----|
| `--type` | `type::feature\|bug\|debt\|ops` |
| `--status` | `status::active\|done\|drop\|suspend` |
| `--flow` | `flow::triage\|plan\|build\|clarify\|approve` |
| `--automation` | `automation::off\|automation::plan\|automation::build` |
| `--priority` | `priority::p0\|p1\|p2\|p3` |
| `--size` | `size::XS\|size::S\|size::M\|size::L\|size::XL` |
| `--label` | unmanaged provider label，可重复 |

### 行为

1. 要求 `--title` 和 repo 外 `--body-file`
2. 校验 issue managed labels，拒绝 `mr-by::*` 和通过 `--label` 传入 managed label
3. 如果创建时设置 `flow::plan` 或 `flow::build`，必须同时传 `--size size::<value>`
4. GitHub 有 token 时调用 `POST /repos/{owner}/{repo}/issues`，无 token 时 fallback 到 `gh api`
5. GitLab 创建前读取每个 managed label，缺失或颜色/说明漂移时失败并提示先运行 `sync-labels.cjs`
6. GitLab 有 token 时调用 `POST /projects/{project}/issues`，无 token 时 fallback 到 `glab api`
7. 有 `AGENTRIX_TASK_ID` 或 `--agentrix-task-id` 时，在 issue body 顶部写入 `<!-- issue-flow:source source_task_id=<id> source_runtime=agentrix -->`
8. 输出稳定 JSON：provider、repo、issueNumber、issueUrl、labels、dryRun

## sync-labels.cjs

将 issue-flow 内置 managed labels 同步到 GitHub/GitLab provider。同步范围包含 issue labels
`type::`、`status::`、`flow::`、`plan::`、`feature:visual-plan:`、`automation::`、`priority::`、`size::`，以及 PR/MR labels `mr-by::plan` 和 `mr-by::build`。

```bash
node sync-labels.cjs [--provider github|gitlab] [--repo owner/repo|group/project] [--dry-run] [--check]
```

### 行为

- 默认执行 upsert：缺失则创建，颜色或说明漂移则更新，已一致则跳过。
- `--dry-run` 不读取或写入 provider，只输出所有将被确保的 label 定义。
- `--check` 读取 provider 当前 label，发现缺失或漂移时非零退出，适合 CI 定期检查。
- `--dry-run` 和 `--check` 互斥，避免“只检查但不读取远端”的语义歧义。
- 任一 label 创建、更新或检查失败会记录失败 label，命令最终非零退出。

### 颜色和字段兼容

Catalog 中颜色保存为 GitHub 兼容的 6 位 hex（例如 `1D76DB`）。GitHub 同步时提交 `RRGGBB`，
GitLab 同步时提交 `#RRGGBB`。名称和说明在两个 provider 上保持一致。如果某个 GitLab 实例版本或权限
不接受 description/update 字段，命令会失败并暴露 provider 错误，不会静默降级成部分成功。

### 内置 Label Catalog

| Label | Scope | Color | Description |
|-------|-------|-------|-------------|
| `type::feature` | Issue | `0E8A16` | Issue is a feature or enhancement |
| `type::bug` | Issue | `D73A4A` | Issue reports a defect or regression |
| `type::debt` | Issue | `5319E7` | Issue tracks technical debt or cleanup |
| `type::ops` | Issue | `1D76DB` | Issue tracks operations or maintenance work |
| `status::active` | Issue | `0052CC` | Issue is active and eligible for workflow actions |
| `status::done` | Issue | `0E8A16` | Issue is complete |
| `status::drop` | Issue | `6A737D` | Issue has been dropped and should not continue |
| `status::suspend` | Issue | `FBCA04` | Issue is suspended until conditions change |
| `flow::triage` | Issue | `BFDADC` | Waiting for triage |
| `flow::plan` | Issue | `0052CC` | Waiting for a plan action |
| `flow::build` | Issue | `1D76DB` | Waiting for implementation |
| `flow::clarify` | Issue | `D4C5F9` | Waiting for clarification |
| `flow::approve` | Issue | `0E8A16` | Waiting for approval of a plan or build PR/MR |
| `plan::pending` | Issue | `FBCA04` | Plan is published and waiting for approval |
| `plan::approved` | Issue | `0E8A16` | Plan has been approved and merged |
| `plan::changes-requested` | Issue | `D93F0B` | Plan needs revision |
| `feature:visual-plan:on` | Issue | `5319E7` | Use Visual Decision and Visual Plan for this issue |
| `feature:visual-plan:off` | Issue | `BFD4F2` | Use the Markdown Plan PR or MR flow for this issue |
| `automation::off` | Issue | `6A737D` | Automation is explicitly disabled for this issue |
| `automation::plan` | Issue | `7057FF` | Automation may execute the configured plan flow |
| `automation::build` | Issue | `006B75` | Automation may create plan and build PRs/MRs |
| `priority::p0` | Issue | `B60205` | Highest priority issue |
| `priority::p1` | Issue | `D93F0B` | High priority issue |
| `priority::p2` | Issue | `FBCA04` | Normal priority issue |
| `priority::p3` | Issue | `C5DEF5` | Low priority issue |
| `size::XS` | Issue | `C2E0C6` | Size XS; throughput weight 0.5 |
| `size::S` | Issue | `BFDADC` | Size S; throughput weight 1 |
| `size::M` | Issue | `C5DEF5` | Size M; throughput weight 2 |
| `size::L` | Issue | `D4C5F9` | Size L; throughput weight 3 |
| `size::XL` | Issue | `F9D0C4` | Size XL; throughput weight 5 |
| `mr-by::plan` | PR/MR | `0052CC` | PR or MR was created by the Markdown plan action |
| `mr-by::build` | PR/MR | `1D76DB` | PR or MR was created by the build action |

### 安装后和维护

`bootstrap.cjs` / `install.sh` 安装默认 CI workflow。目标项目 commit 并 push 安装文件后：

- GitHub 的 `.github/workflows/issue-flow-labels.yml` 会在 issue-flow 相关文件变更时自动运行 `sync-labels.cjs`。
- GitLab 的 `.gitlab/issue-flow.gitlab-ci.yml` 包含 `issue-flow-labels` job，会在 push 改动 issue-flow 相关文件时自动运行 `sync-labels.cjs`。
- 自动同步会创建缺失 label，并更新颜色/说明漂移的 label。
- 如果 CI token 没有 provider label 管理权限，label sync job 会失败；修复 token 权限后重新运行 job 或再次 push 即可。

也可以由具备 label 管理权限的用户或 CI token 手动执行：

```bash
node .agentrix/plugins/issue-flow/skills/issue-flow/scripts/sync-labels.cjs --provider github --repo owner/repo
node .agentrix/plugins/issue-flow/skills/issue-flow/scripts/sync-labels.cjs --provider gitlab --repo group/project
```

维护时可使用：

```bash
node .agentrix/plugins/issue-flow/skills/issue-flow/scripts/sync-labels.cjs --check
```

### PR Title 规范化

如果 title 不含 `#<issueNumber>`，自动加前缀：
- plan: `Plan #123: <title>`
- build: `Build #123: <title>`

## pr-merged.cjs

处理 merged PR/MR 事件，转移 source issue。

```bash
node pr-merged.cjs --event <path> [common-options]
```

### 行为

1. 忽略非 merge 的关闭事件
2. PR/MR 必须有恰好一个 `mr-by::plan` 或 `mr-by::build` label
3. 解析 source issue number
4. 执行对应转移
5. 只执行 source issue 状态流转；是否启动后续 agent 由 `dispatch.cjs pr-merged` 负责

## dispatch.cjs

开箱调度入口。默认内置 Agentrix runtime，负责 event routing、duplicate task lock、prompt 构建和启动 Agentrix task。

```bash
node dispatch.cjs auto --event <path> [--runtime agentrix] [common-options]
node dispatch.cjs comment --event <path> [--runtime agentrix] [common-options]
node dispatch.cjs review --event <path> [--runtime agentrix] [common-options]
node dispatch.cjs review --pr-number <num> [--runtime agentrix] [common-options]
node dispatch.cjs pr-merged --event <path> [common-options]
node dispatch.cjs resume --event <path> [--runtime agentrix] [common-options]
```

## review.cjs

Submit a PR/MR review result. `--body-file` is the overall review body. `--comments-file` may include inline review comments as a JSON array.

```bash
node review.cjs --pr-number <num> --body-file <path> [--comments-file <path>] [--as-comment] [common-options]
```

GitHub submits one Pull Request Review payload with the overall body and inline comments, so GitHub shows the review as an associated reviewed-commit event. GitLab posts one MR note for the overall body and creates diff discussions for inline comments. With `--as-comment`, issue-flow posts the body as a normal PR/MR comment and rejects non-empty inline comments; this is the preferred shape for no-finding review summaries.

Inline comment JSON entries use:

```json
[
  {
    "path": "src/app.js",
    "line": 42,
    "body": "Please handle this edge case."
  }
]
```

### Agentrix 路径配置

只支持配置路径，不支持改文件名、branch pattern 或 label/flow 语义。

```json
{
  "agentrix": {
    "promptsDir": ".issue-flow/prompts",
    "templatesDir": ".issue-flow/templates",
    "planRootDir": ".issue-flow/issues"
  }
}
```

### Agentrix 行为

1. comment mention 固定为 `@agentrix`
2. prompt 文件名固定：`triage.prompt.md`、`general.prompt.md`、`plan-bug.prompt.md`、`plan-impl.prompt.md`、`build.prompt.md`、`review.prompt.md`
3. template 文件名固定：`plan-bug.md`、`plan-impl.md`
4. plan 查找固定为 `<planRootDir>/<issue-number>-<slug>/plan/*.md`
5. branch 固定为 `<issue-number>-<slug>/plan` 和 `<issue-number>-<slug>/build`
6. prompt 首位固定注入项目级 `issue-flow` skill 文件路径，例如 `.agentrix/plugins/issue-flow/skills/issue-flow/SKILL.md`
7. task lock marker 使用 `<!-- issue-flow:agentrix:task:<action> -->`
8. `pr-merged` 在应用 source issue 状态流转后会立即执行一次自动路由；`mr-by::plan` merge 后可直接启动 build，`mr-by::build` merge 后因 `status::done` 跳过
9. `review`: PR/MR check; controlled by `ISSUE_FLOW_REVIEW_ENABLED=true` or `1`

## bootstrap.cjs

安装 runtime 约定的最小运行时文件、CI 文件和配置。默认 runtime 是 `agentrix`。

```bash
node bootstrap.cjs github [--runtime agentrix] [--force] [--dry-run]
node bootstrap.cjs gitlab [--runtime agentrix] [--force] [--dry-run]
```

### 行为

- Runtime：写入 `.agentrix/plugins/issue-flow/`，只包含运行时需要的 skill、脚本和默认 prompt/template；安装期 workflow/config 不进入该目录
- GitHub：写入 `.github/workflows/issue-flow-auto.yml`、`.github/workflows/issue-flow-comment.yml`、`.github/workflows/issue-flow-pr-merged.yml`
- GitLab：写入 `.gitlab-ci.yml` 和 `.gitlab/issue-flow.gitlab-ci.yml`
- 如果目标项目已有 `.gitlab-ci.yml` 且尚未 include issue-flow，该文件按安装冲突处理：经确认（交互提示、
  `--force` 或 `--decision-file`）后向简单的顶层 `include` 追加 `.gitlab/issue-flow.gitlab-ci.yml`；
  复杂 include 结构只报告冲突交给用户手工处理，不做改写
- issue-flow 项目配置：写入 `.issue-flow/config.json`、`.issue-flow/prompts/`、`.issue-flow/templates/`、`.issue-flow/issues/README.md`
- Runtime 资源来自 `skills/issue-flow/assets/agentrix/runtime/`，workflow/config 资源来自 `skills/issue-flow/assets/agentrix/bootstrap/`
- 不提供 workflow/plugin 目录选项；路径由 runtime preset 约定
- 已存在文件默认跳过，`--force` 才覆盖
- 安装后的 push 会通过默认 workflow job 自动同步 provider labels；安装命令本身仍只写文件

### Source Issue 解析优先级

1. `<!-- issue-flow:source-issue=123 -->` hidden marker
2. `Source issue: #123` / `Source: #123` visible text
3. PR title: `Plan #123` / `Build #123` pattern
4. Branch: `123-slug/plan` / `123-slug/build` / `issue/123/plan`

## intake.cjs

给新 issue 添加默认 label。

```bash
node intake.cjs --issue-number <num> [common-options]
```

### 行为

- 缺 `status::` → 添加 `status::active`
- 缺 `flow::` → 添加 `flow::triage`
- 已有则不覆盖

## resolve.cjs

纯决策，无副作用。输出 JSON 到 stdout。

```bash
node resolve.cjs auto --event <path> [--auto-default <level>]
node resolve.cjs resume --event <path>
node resolve.cjs comment --event <path>
```

### auto 输出

```json
{
  "shouldRun": true,
  "action": "plan",
  "flowLabel": "flow::plan",
  "effectiveLevel": "build"
}
```

或：

```json
{
  "shouldRun": false,
  "reason": "automation_level_too_low",
  "action": "build",
  "effectiveLevel": "plan"
}
```

### comment 输出

```json
{
  "action": "general",
  "issueNumber": 123,
  "instruction": "please investigate this"
}
```
