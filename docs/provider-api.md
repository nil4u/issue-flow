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
3. GitLab 特有 env（`GITLAB_BASE_URL` 等）
4. repo 路径中包含 gitlab/github
5. GitLab token env（`GITLAB_TOKEN` 等）
6. event payload 结构（`object_kind` → gitlab）
7. git remote host
8. 默认 github

## Token

### GitHub

读取顺序：`GITHUB_TOKEN` → `GH_TOKEN`

无 token 时尝试 `gh` CLI fallback。

### GitLab

读取顺序：`GITLAB_TOKEN` → `GL_TOKEN` → `GITLAB_PRIVATE_TOKEN` → `CI_JOB_TOKEN`

无 token 时尝试 `glab` CLI fallback。

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
| `--flow` | `flow::triage\|plan\|build\|review\|clarify\|approve` |
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
node pr-merged.cjs --event <path> [--auto-resume] [common-options]
```

### 行为

1. 忽略非 merge 的关闭事件
2. PR/MR 必须有恰好一个 `mr-by::plan` 或 `mr-by::build` label
3. 解析 source issue number
4. 执行对应转移
5. `--auto-resume` 时，调用 resolve.cjs 决定是否继续

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
