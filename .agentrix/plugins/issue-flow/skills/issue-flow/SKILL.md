---
name: issue-flow
version: 0.1.0
description: "Label-based issue 状态流转工具。通过确定性脚本操作 GitHub/GitLab issue labels、body、PR/MR。当需要变更 issue label、提交 plan/build PR 时使用。"
metadata:
  requires:
    bins: ["node"]
---

# Issue Flow

issue-flow 定义了一套基于 issue 和 PR/MR 的 agent 自动化开发流程。

Issue 是需求、缺陷、运维事项和技术债的总入口，也是状态机的 source of truth。PR/MR 是 human review 和审批介入的关键环节；agent 通过 PR/MR 提交 plan/build 产物，merge 后再推进 source issue。

在 issue-flow 下工作时，必须遵循两条操作规范：

1. 使用 `apply.cjs` 操作 issue 的 managed labels。
2. 使用 `create-issue.cjs` 创建标准化 issue。
3. 使用 `submit.cjs` 创建或更新 plan/build PR/MR。

## Label 体系

所有 managed label 按 prefix 分组，同一 prefix 内互斥。未指定某个 prefix 时，脚本不触碰该 prefix 的现有 label。

| Prefix | Scope | 作用 | Values |
|--------|-------|------|--------|
| `type::` | Issue | 需求类型 | `feature`, `bug`, `debt`, `ops` |
| `status::` | Issue | 生命周期状态 | `active`, `done`, `drop`, `suspend` |
| `flow::` | Issue | 下一步工作流动作 | `triage`, `plan`, `build`, `clarify`, `approve` |
| `automation::` | Issue | 允许自动化推进到的级别，或显式关闭 | `off`, `plan`, `build` |
| `priority::` | Issue | 处理优先级 | `p0`, `p1`, `p2`, `p3` |
| `mr-by::` | PR/MR | 标记 PR/MR 来源动作 | `plan`, `build` |

详情请参考：`references/labels.md`。

## Provider 写操作

### apply.cjs — 变更 Label / Body

```bash
node ${CLAUDE_SKILL_DIR}/scripts/apply.cjs \
  --issue-number <num> \
  [--type type::bug] \
  [--status status::active] \
  [--flow flow::plan] \
  [--priority priority::p2] \
  [--automation automation::off|automation::plan|automation::build] \
  [--clear-flow] [--clear-automation] \
  [--normalized-body-file <path>] \
  [--dry-run]
```

- 只移除指定 prefix 的旧 label，不动其他 prefix
- 设置 `flow::clarify` 时不会更新 issue body（会忽略 `--normalized-body-file`）
- 不接受 `mr-by::*`

### create-issue.cjs — 创建标准化 Issue

```bash
node ${CLAUDE_SKILL_DIR}/scripts/create-issue.cjs \
  --title "<normalized title>" \
  --body-file <tmp-issue-body-file> \
  [--type type::feature] \
  [--status status::active] \
  [--flow flow::plan] \
  [--priority priority::p2] \
  [--automation automation::off|automation::plan|automation::build] \
  [--label <unmanaged-label>] \
  [--provider github|gitlab] [--repo owner/repo|group/project] \
  [--dry-run]
```

- 用于开放讨论后，需求已经足够明确，可以沉淀成 provider issue。
- issue body 先按 `.issue-flow/templates/type-*.md` 整理，写到 repo 外临时文件（如 `mktemp`）；不要把 body 文件提交到 git。
- `type::`、`status::`、`flow::`、`priority::`、`automation::` 必须通过对应参数传入，不能放在 `--label`。
- `--label` 只用于 unmanaged label；`mr-by::*` 只用于 PR/MR，不能用于 issue。
- 如果已判断下一步 flow，通常同时传 `--status status::active` 和对应 `--flow`，避免默认 intake。
- 如果只想记录讨论结果且暂不希望自动化介入，传 `--automation automation::off`。
- 有 `AGENTRIX_TASK_ID` 时脚本会自动在 body 顶部写入隐藏 task marker，agent 不需要手写。

### submit.cjs — 发布 PR/MR

```bash
node ${CLAUDE_SKILL_DIR}/scripts/submit.cjs plan|build \
  --issue-number <num> \
  --title "<title>" \
  --body-file <path> \
  [--base <branch>] [--head <branch>] \
  [--draft] [--no-push] [--dry-run]
```

`--body-file` 用 repo 外临时文件（如 `mktemp`）；不要提交 PR body 文件。

### sync-labels.cjs — 同步 Provider Labels

```bash
node ${CLAUDE_SKILL_DIR}/scripts/sync-labels.cjs \
  [--provider github|gitlab] [--repo owner/repo|group/project] \
  [--dry-run] [--check]
```

- 同步全部内置 managed labels 的名称、颜色和说明
- `--dry-run` 不读取或写入 provider，只打印将确保的 labels
- `--check` 只检查缺失或漂移，发现不一致时非零退出
- 安装不会自动执行同步；同步失败通常表示 token/CLI 缺少 label 管理权限

## 典型 Agent 工作流

### Triage

`flow::`（下一步动作）与 `automation::`（自动化推进上限）是独立判断，不要求一致：

```bash
# 实现路径已确定的简单改动，直接进入 build：
node ${CLAUDE_SKILL_DIR}/scripts/apply.cjs --issue-number 123 \
  --type type::feature --priority priority::p1 --flow flow::build --automation automation::build
# 需要先规划，plan PR 合并后自动续推到 build：
node ${CLAUDE_SKILL_DIR}/scripts/apply.cjs --issue-number 123 \
  --type type::feature --priority priority::p1 --flow flow::plan --automation automation::build
```

### Plan → Submit

```bash
# 1. 编写 plan，输出到文件
# 2. 提交 PR
node ${CLAUDE_SKILL_DIR}/scripts/submit.cjs plan \
  --issue-number 123 --title "Plan #123: Add auth" --body-file <tmp-body-file>
```

### Build → Submit

```bash
# 1. 按 plan 实现代码
# 2. 提交 PR
node ${CLAUDE_SKILL_DIR}/scripts/submit.cjs build \
  --issue-number 123 --title "Build #123: Add auth" --body-file <tmp-body-file>
```

### Review

PR/MR review check:

- Publish review result: `review.cjs --pr-number <num> --body-file <tmp-body-file>`

### 信息不足

```bash
node ${CLAUDE_SKILL_DIR}/scripts/apply.cjs --issue-number 123 --flow flow::clarify
# 然后按照具体agent的说明在指定的位置进行问题澄清
```
