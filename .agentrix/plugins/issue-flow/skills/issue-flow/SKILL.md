---
name: issue-flow
version: 0.1.0
description: "Label-based issue 状态流转工具。通过确定性脚本操作 GitHub/GitLab issue labels、body、PR/MR。当需要变更 issue label、提交 plan/build PR 时使用。"
metadata:
  requires:
    bins: ["node"]
---

# Issue Flow

确定性 issue 状态流转。Agent 通过脚本操作 git provider，不直接调 API。

## Quick Reference

```bash
# 变更 label
node ${CLAUDE_SKILL_DIR}/scripts/apply.cjs --issue-number 123 --flow flow::plan --type type::feature

# 提交 PR
node ${CLAUDE_SKILL_DIR}/scripts/submit.cjs plan --issue-number 123 --title "Plan #123: ..." --body-file plan.md
```

## Label 体系

| Prefix | Values | 互斥规则 |
|--------|--------|----------|
| `type::` | feature, bug, debt, ops | 同 prefix 只留一个 |
| `status::` | active, done, drop, suspend | 同 prefix 只留一个 |
| `flow::` | triage, plan, build, review, clarify, approve | 同 prefix 只留一个 |
| `automation::` | plan, build | 同 prefix 只留一个 |
| `priority::` | p0, p1, p2, p3 | 同 prefix 只留一个 |
| `mr-by::` | plan, build | PR/MR 专属 |

详情请参考：`references/labels.md`。

## 脚本详情

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
- `flow::clarify` 时忽略 `--normalized-body-file`
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

## Hard Rules

1. **不直接调 provider API** — 所有 label/body/PR 操作走脚本
2. **`mr-by::*` 只加在 PR/MR** — 不加在 source issue
3. **`flow::clarify` 永不改写 body** — 脚本自动忽略
4. **无 token 时** — 脚本输出可重跑命令，不静默失败
5. **Label 互斥** — 同 prefix 只保留一个（脚本自动处理）
