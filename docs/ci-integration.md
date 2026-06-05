# CI 接入

## GitHub Actions

推荐用 bootstrap 安装默认 Agentrix runtime workflows：

```bash
node <issue-flow-package>/skills/issue-flow/scripts/bootstrap.cjs github
```

这会按 Agentrix runtime 约定写入最小运行时文件、workflow 和配置：

- `.agentrix/plugins/issue-flow/`
- `.github/workflows/issue-flow-auto.yml`
- `.github/workflows/issue-flow-comment.yml`
- `.github/workflows/issue-flow-pr-merged.yml`
- `.github/agentrix/issue-flow/config.json`

workflow 和默认配置由 `skills/issue-flow/assets/agentrix/bootstrap/` 提供；运行时入口固定安装到 `.agentrix/plugins/issue-flow/`，只包含 CI/agent 执行会用到的 skill、脚本和默认 prompt/template。

已有文件默认跳过，需要覆盖时使用 `--force`。

### Issue 自动路由（内置 Agentrix runtime）

```yaml
name: Issue Flow Auto
on:
  issues:
    types: [opened, edited, reopened, labeled]

jobs:
  issue-flow:
    if: ${{ !github.event.issue.pull_request }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: |
            .github/agentrix/issue-flow
            .agentrix/plugins/issue-flow
            .agentrix/issues
      - name: Intake labels
        run: node .agentrix/plugins/issue-flow/skills/issue-flow/scripts/intake.cjs --issue-number ${{ github.event.issue.number }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Dispatch action
        run: node .agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs auto --event "$GITHUB_EVENT_PATH"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AGENTRIX_BASE_URL: ${{ vars.AGENTRIX_BASE_URL }}
          AGENTRIX_API_KEY: ${{ secrets.AGENTRIX_API_KEY }}
          AGENTRIX_RUNNER_ID: ${{ vars.AGENTRIX_RUNNER_ID }}
          AGENTRIX_CAPABILITY_PROFILE: ${{ vars.AGENTRIX_CAPABILITY_PROFILE }}
          AGENTRIX_ISSUE_FLOW_AGENT: ${{ vars.AGENTRIX_ISSUE_FLOW_AGENT }}
          ISSUE_FLOW_AUTO_DEFAULT: ${{ vars.ISSUE_FLOW_AUTO_DEFAULT }}
```

### Issue Comment 路由

```yaml
name: Issue Flow Comment
on:
  issue_comment:
    types: [created]

jobs:
  issue-flow:
    if: |
      !github.event.issue.pull_request &&
      github.event.issue.state == 'open' &&
      github.event.comment.user.type != 'Bot' &&
      contains(github.event.comment.body, '@agentrix')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Dispatch comment
        run: node .agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs comment --event "$GITHUB_EVENT_PATH"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AGENTRIX_BASE_URL: ${{ vars.AGENTRIX_BASE_URL }}
          AGENTRIX_API_KEY: ${{ secrets.AGENTRIX_API_KEY }}
          AGENTRIX_RUNNER_ID: ${{ vars.AGENTRIX_RUNNER_ID }}
          AGENTRIX_CAPABILITY_PROFILE: ${{ vars.AGENTRIX_CAPABILITY_PROFILE }}
          AGENTRIX_ISSUE_FLOW_AGENT: ${{ vars.AGENTRIX_ISSUE_FLOW_AGENT }}
```

### Plan/Build PR Merged

```yaml
name: Issue Flow PR Merged
on:
  pull_request:
    types: [closed]

jobs:
  issue-flow:
    if: |
      github.event.pull_request.merged &&
      (contains(github.event.pull_request.labels.*.name, 'mr-by::plan') ||
       contains(github.event.pull_request.labels.*.name, 'mr-by::build'))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: |
            .github/agentrix
            .agentrix/plugins/issue-flow
            .agentrix/issues
      - name: Apply merge transition
        run: node .agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs pr-merged --event "$GITHUB_EVENT_PATH"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AGENTRIX_BASE_URL: ${{ vars.AGENTRIX_BASE_URL }}
          AGENTRIX_API_KEY: ${{ secrets.AGENTRIX_API_KEY }}
          AGENTRIX_RUNNER_ID: ${{ vars.AGENTRIX_RUNNER_ID }}
          AGENTRIX_CAPABILITY_PROFILE: ${{ vars.AGENTRIX_CAPABILITY_PROFILE }}
          AGENTRIX_ISSUE_FLOW_AGENT: ${{ vars.AGENTRIX_ISSUE_FLOW_AGENT }}
          ISSUE_FLOW_AUTO_DEFAULT: ${{ vars.ISSUE_FLOW_AUTO_DEFAULT }}
```

`dispatch.cjs pr-merged` 会先应用 source issue 状态流转，然后在同一个 workflow 中立即执行一次自动路由。这样 GitHub 不需要依赖 `GITHUB_TOKEN` 改 label 后再次触发 `issues:labeled`。

## GitLab CI

推荐用 bootstrap 安装默认 Agentrix runtime include 片段：

```bash
node <issue-flow-package>/skills/issue-flow/scripts/bootstrap.cjs gitlab
```

这会按 Agentrix runtime 约定写入 `.agentrix/plugins/issue-flow/` 最小运行时文件、`.gitlab/issue-flow.gitlab-ci.yml` 和 `.github/agentrix/issue-flow/config.json`。GitLab 项目仍需要在自己的 `.gitlab-ci.yml` 中 include 该文件。

### Issue 事件

```yaml
issue-flow-auto:
  rules:
    - if: $CI_PIPELINE_SOURCE == "trigger"
      when: never
    - if: $GITLAB_EVENT_NAME == "issue"
  script:
    - node <plugin-scripts>/dispatch.cjs auto --event "$GITLAB_EVENT_PATH"
  variables:
    GITLAB_TOKEN: $CI_JOB_TOKEN
```

### Merge Request Merged

```yaml
issue-flow-merged:
  rules:
    - if: $CI_MERGE_REQUEST_EVENT_TYPE == "merged"
  script:
    - node <plugin-scripts>/dispatch.cjs pr-merged --event "$GITLAB_EVENT_PATH"
  variables:
    GITLAB_TOKEN: $CI_JOB_TOKEN
```

## 环境变量

### Provider 检测

| 变量 | 说明 |
|------|------|
| `ISSUE_FLOW_PROVIDER` | 强制指定 provider |

### GitHub

| 变量 | 说明 |
|------|------|
| `GITHUB_TOKEN` / `GH_TOKEN` | API token |
| `GITHUB_EVENT_PATH` | event payload 路径 |
| `GITHUB_REPOSITORY` | 仓库 full name |
| `GITHUB_API_URL` | API base URL（GitHub Enterprise） |

### GitLab

| 变量 | 说明 |
|------|------|
| `GITLAB_TOKEN` / `GL_TOKEN` / `GITLAB_PRIVATE_TOKEN` | API token |
| `CI_JOB_TOKEN` | CI job token |
| `GITLAB_EVENT_PATH` | event payload 路径 |
| `GITLAB_PROJECT_PATH` / `CI_PROJECT_PATH` | 项目路径 |
| `GITLAB_BASE_URL` / `CI_SERVER_URL` | GitLab 实例 URL |
| `GITLAB_API_URL` | API base URL 覆盖 |

### 自动化

| 变量 | 说明 |
|------|------|
| `ISSUE_FLOW_AUTO_DEFAULT` | 仓库默认自动化级别 |

### Agentrix runtime

| 变量 | 说明 |
|------|------|
| `AGENTRIX_BASE_URL` | Agentrix API 地址 |
| `AGENTRIX_API_KEY` | Agentrix API key |
| `AGENTRIX_RUNNER_ID` | 可选 runner |
| `AGENTRIX_CAPABILITY_PROFILE` | 可选能力 profile |
| `AGENTRIX_ISSUE_FLOW_AGENT` | 可选 agent，默认 `codex` |

Agentrix runtime 只支持三个路径配置，默认从 `.github/agentrix/issue-flow/config.json` 读取：

```json
{
  "agentrix": {
    "promptsDir": ".github/agentrix/issue-flow",
    "templatesDir": ".github/agentrix/issue-flow/templates",
    "planRootDir": ".agentrix/issues"
  }
}
```

如果 prompt/template 在项目目录中不存在，dispatcher 会使用 plugin 内置默认。

## 注意事项

- `<plugin-scripts>` 应替换为 plugin 安装后脚本的实际路径
- Agentrix runtime 约定 plugin 路径为 `.agentrix/plugins/issue-flow`
- 所有脚本支持 `--dry-run`，建议 CI 接入前先 dry-run 验证
