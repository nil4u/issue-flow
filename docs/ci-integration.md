# CI 接入

## GitHub Actions

### Issue 自动路由

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
            .issue-flow
            .github/issue-flow
      - name: Intake labels
        run: node <plugin-scripts>/intake.cjs --issue-number ${{ github.event.issue.number }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Resolve action
        id: resolve
        run: node <plugin-scripts>/resolve.cjs auto --event "$GITHUB_EVENT_PATH" --auto-default "${ISSUE_FLOW_AUTO_DEFAULT:-off}"
      - name: Dispatch action
        if: ${{ fromJSON(steps.resolve.outputs.decision).shouldRun }}
        run: |
          # Start your agent here based on the resolved action
          echo "Action: $(echo '${{ steps.resolve.outputs.decision }}' | jq -r .action)"
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
      contains(github.event.comment.body, '@bot')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Resolve comment
        run: node <plugin-scripts>/resolve.cjs comment --event "$GITHUB_EVENT_PATH"
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
      - name: Apply merge transition
        run: node <plugin-scripts>/pr-merged.cjs --event "$GITHUB_EVENT_PATH" --auto-resume
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## GitLab CI

### Issue 事件

```yaml
issue-flow-auto:
  rules:
    - if: $CI_PIPELINE_SOURCE == "trigger"
      when: never
    - if: $GITLAB_EVENT_NAME == "issue"
  script:
    - node <plugin-scripts>/resolve.cjs auto --event "$GITLAB_EVENT_PATH"
  variables:
    GITLAB_TOKEN: $CI_JOB_TOKEN
```

### Merge Request Merged

```yaml
issue-flow-merged:
  rules:
    - if: $CI_MERGE_REQUEST_EVENT_TYPE == "merged"
  script:
    - node <plugin-scripts>/pr-merged.cjs --event "$GITLAB_EVENT_PATH" --auto-resume
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

## 注意事项

- `<plugin-scripts>` 应替换为 plugin 安装后脚本的实际路径
- 如果使用 `--plugin-dir` 安装，路径通常在 `.claude/skills/issue-flow/scripts/`
- 所有脚本支持 `--dry-run`，建议 CI 接入前先 dry-run 验证
