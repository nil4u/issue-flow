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
2. 使用 `submit.cjs` 创建或更新 plan/build PR/MR。

## Label 体系

所有 managed label 按 prefix 分组，同一 prefix 内互斥。未指定某个 prefix 时，脚本不触碰该 prefix 的现有 label。

| Prefix | Scope | 作用 | Values |
|--------|-------|------|--------|
| `type::` | Issue | 需求类型 | `feature`, `bug`, `debt`, `ops` |
| `status::` | Issue | 生命周期状态 | `active`, `done`, `drop`, `suspend` |
| `flow::` | Issue | 下一步工作流动作 | `triage`, `plan`, `build`, `review`, `clarify`, `approve` |
| `automation::` | Issue | 允许自动化推进到的级别 | `plan`, `build` |
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
  [--automation automation::build] \
  [--clear-flow] [--clear-automation] \
  [--normalized-body-file <path>] \
  [--dry-run]
```

- 只移除指定 prefix 的旧 label，不动其他 prefix
- 设置 `flow::clarify` 时不会更新 issue body（会忽略 `--normalized-body-file`）
- 不接受 `mr-by::*`

### submit.cjs — 发布 PR/MR

```bash
node ${CLAUDE_SKILL_DIR}/scripts/submit.cjs plan|build \
  --issue-number <num> \
  --title "<title>" \
  --body-file <path> \
  [--base <branch>] [--head <branch>] \
  [--draft] [--no-push] [--dry-run]
```

## 典型 Agent 工作流

### Triage

```bash
# 1. 读取 issue 内容，判断类型 type、优先级 priority 和自动化级别 automation
# 2. 决定下一步 flow
node ${CLAUDE_SKILL_DIR}/scripts/apply.cjs --issue-number 123 \
  --type type::feature --priority priority::p1 --flow flow::plan
```

### Plan → Submit

```bash
# 1. 编写 plan，输出到文件
# 2. 提交 PR
node ${CLAUDE_SKILL_DIR}/scripts/submit.cjs plan \
  --issue-number 123 --title "Plan #123: Add auth" --body-file plan.md
```

### Build → Submit

```bash
# 1. 按 plan 实现代码
# 2. 提交 PR
node ${CLAUDE_SKILL_DIR}/scripts/submit.cjs build \
  --issue-number 123 --title "Build #123: Add auth" --body-file build.md
```

### 信息不足

```bash
node ${CLAUDE_SKILL_DIR}/scripts/apply.cjs --issue-number 123 --flow flow::clarify
# 然后按照具体agent的说明在指定的位置进行问题澄清
```
