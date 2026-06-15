# 脚本 CLI 参考

## 通用选项

所有脚本支持：

| 选项 | 说明 |
|------|------|
| `--provider github\|gitlab` | 指定 git provider（默认自动检测） |
| `--repo owner/repo` | 仓库路径覆盖 |
| `--dry-run` | 打印意图但不执行 API 调用 |

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

读取顺序：`GITHUB_TOKEN` → `GH_TOKEN`

无 token 时尝试 `gh` CLI fallback。

### GitLab

读取顺序：`GITLAB_TOKEN` → `GL_TOKEN` → `GITLAB_PRIVATE_TOKEN` → `CI_JOB_TOKEN`

无 token 时尝试 `glab` CLI fallback。

## Event payload

GitHub Actions 使用 `GITHUB_EVENT_PATH` 读取事件文件。

GitLab 的推荐入口是 Agentrix daemon webhook bridge。bridge 触发 pipeline 时没有事件文件，
脚本会从 `AGENTRIX_TRIGGER_SOURCE=agentrix_daemon_webhook`、`AGENTRIX_EVENT_NAME`、
`AGENTRIX_EVENT_ACTION`、`AGENTRIX_ISSUE_NUMBER`、`AGENTRIX_PR_NUMBER`、
`AGENTRIX_LABELS_JSON`、`AGENTRIX_PR_BODY` 等变量合成兼容 payload。

如果显式传入 `--event` 或设置 `GITLAB_EVENT_PATH`，事件文件优先。

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
| `--automation` | `automation::plan\|build` |
| `--priority` | `priority::p0\|p1\|p2\|p3` |
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

1. 检查 worktree 是否 clean
2. 检查 head ≠ base
3. push 分支
4. 创建或更新 PR/MR（存在则 update）
5. 确保 PR label 存在（GitHub: `gh label create`）
6. 在 PR body 中插入 `<!-- issue-flow:source-issue=<num> -->`
7. 调用 apply.cjs 把 source issue 转到 `flow::approve`

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
node dispatch.cjs pr-review --event <path> [--runtime agentrix] [common-options]
node dispatch.cjs pr-review --pr-number <num> [--runtime agentrix] [common-options]
node dispatch.cjs pr-merged --event <path> [common-options]
node dispatch.cjs resume --event <path> [--runtime agentrix] [common-options]
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
7. task lock marker 使用 `<!-- issue-flow:task:agentrix:<action> -->`
8. `pr-merged` 在应用 source issue 状态流转后会立即执行一次自动路由；`mr-by::plan` merge 后可直接启动 build，`mr-by::build` merge 后因 `status::done` 跳过
9. `pr-review` 只处理 PR/MR review check；它不读取 source issue `flow::` label，不受 `ISSUE_FLOW_AUTO_DEFAULT` 影响，只在 `ISSUE_FLOW_REVIEW_ENABLED=true` 或 `1` 时运行

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
- 如果目标项目已有 `.gitlab-ci.yml` 且尚未 include issue-flow，安装器会把原内容保存为
  `.gitlab/issue-flow-project.gitlab-ci.yml`，并将根 `.gitlab-ci.yml` 改成同时 include 原 pipeline 和 issue-flow
- issue-flow 项目配置：写入 `.issue-flow/config.json`、`.issue-flow/prompts/`、`.issue-flow/templates/`、`.issue-flow/issues/README.md`
- Runtime 资源来自 `skills/issue-flow/assets/agentrix/runtime/`，workflow/config 资源来自 `skills/issue-flow/assets/agentrix/bootstrap/`
- 不提供 workflow/plugin 目录选项；路径由 runtime preset 约定
- 已存在文件默认跳过，`--force` 才覆盖

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
