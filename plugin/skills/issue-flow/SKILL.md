---
name: issue-flow
version: 0.5.0 # x-release-please-version
description: "Label-based issue 状态流转工具。通过统一 issue-flow CLI 操作 GitHub/GitLab issue、labels、comments、PR/MR 和 review。在使用 issue-flow managed labels（type::/status::/flow:: 等）或包含 .issue-flow/ 目录的仓库中处理 issue/PR 时使用。"
metadata:
  requires:
    bins: ["node"]
---

# Issue Flow

issue-flow 定义了一套基于 issue、Plan 审批和 Build PR/MR 的 agent 自动化开发流程。

Issue 是需求、缺陷、运维事项和技术债的总入口，也是状态机的 source of truth。Plan 默认使用 Markdown 审阅；只有 issue 带 `feature:visual-plan:on` 时才使用 Decision/Visual Plan 页面。`feature:visual-plan:off` 和未设置开关都保持 Markdown 模式。实际代码始终通过 Build PR/MR 审批。

在 issue-flow 下工作时，agent-facing provider 操作必须使用统一入口：

```bash
node ${CLAUDE_SKILL_DIR}/cli.cjs <resource> <action> [options]
```

如果环境已安装 bin，也可以使用：

```bash
issue-flow <resource> <action> [options]
```

`${CLAUDE_SKILL_DIR}` 由 Claude 运行时注入；未定义时，用本 SKILL.md 所在目录替代（`cli.cjs` 与 SKILL.md 同目录）。

不要为 issue-flow 已覆盖的动作直接调用 `gh`、`glab`、`gh api`、`glab api`，也不要手写 GitHub/GitLab REST/GraphQL 请求。provider 内部可以使用 token API 或 CLI fallback，但这个选择由 issue-flow 封装。

## Label 体系

所有 managed label 按 prefix 分组，同一 prefix 内互斥。未指定某个 prefix 时，命令不触碰该 prefix 的现有 label。

| Prefix | Scope | 作用 | Values |
|--------|-------|------|--------|
| `type::` | Issue | 需求类型 | `feature`, `bug`, `debt`, `ops` |
| `status::` | Issue | 生命周期状态 | `active`, `done`, `drop`, `suspend` |
| `flow::` | Issue | 下一步工作流动作 | `triage`, `plan`, `build`, `clarify`, `approve` |
| `decision::` | Issue | Decision 审批状态 | `pending`, `approved`, `changes-requested` |
| `visual-plan::` | Issue | Visual Plan 审批状态 | `pending`, `approved`, `changes-requested` |
| `feature:visual-plan:` | Issue | Plan 模式开关；未设置时默认 off | `on`, `off` |
| `automation::` | Issue | 允许自动化推进到的级别，或显式关闭 | `off`, `plan`, `build` |
| `priority::` | Issue | 处理优先级 | `p0`, `p1`, `p2`, `p3` |
| `size::` | Issue | 工作量规模与 Weighted Throughput 权重 | `XS`, `S`, `M`, `L`, `XL` |
| `mr-by::` | PR/MR | 标记 Decision、Visual/Markdown Plan 或 Build PR/MR 的来源动作 | `plan`, `build` |

详情请参考：`references/labels.md`。

### CI failure intake label policy

`dispatch pipeline-failed` 创建或更新的 CI failure issue 默认使用 `type::ops`、`status::active`、`flow::build`、`automation::build`、`failure::ci` 和单一 `size::`。它仍走 build action，但 agent 必须先定位根因再调整标签或提交修复；根因分类与 `type::`/`status::` 流转细则见 build CI failure prompt（`.issue-flow/prompts/build-ci-failure.prompt.md`，未自定义时为 skill 内置默认版本）。

## Provider 操作

### Issue

```bash
node ${CLAUDE_SKILL_DIR}/cli.cjs issue get --issue 123
node ${CLAUDE_SKILL_DIR}/cli.cjs issue create --title "<normalized title>" --body-file <tmp-issue-body-file> \
  --type type::feature --status status::active --flow flow::plan --priority priority::p2 --size size::M
node ${CLAUDE_SKILL_DIR}/cli.cjs issue apply --issue 123 --flow flow::build --automation automation::build --size size::M
node ${CLAUDE_SKILL_DIR}/cli.cjs issue apply --issue 123 --type type::bug --normalized-body-file <tmp-normalized-body-file>
node ${CLAUDE_SKILL_DIR}/cli.cjs issue intake --issue 123
node ${CLAUDE_SKILL_DIR}/cli.cjs issue comments list --issue 123
node ${CLAUDE_SKILL_DIR}/cli.cjs issue comments create --issue 123 --body-file <tmp-comment-body-file>
node ${CLAUDE_SKILL_DIR}/cli.cjs issue acknowledge --issue 123
```

- `issue apply` 只移除指定 prefix 的旧 label，不动其他 prefix。
- 规范化正文：按 issue 的 `type::` 对应 `.issue-flow/templates/type-*.md` 重写正文，写到 repo 外临时文件，用 `--normalized-body-file` 随标签一起应用。
- 设置 `flow::clarify` 时不会更新 issue body（会忽略 `--normalized-body-file`）。
- 创建 issue 时，body 先按 `.issue-flow/templates/type-*.md` 整理，写到 repo 外临时文件（如 `mktemp`）；不要把 body 文件提交到 git。
- `type::`、`status::`、`flow::`、`priority::`、`automation::`、`size::` 必须通过对应参数传入，不能放在 `--label`。
- 进入 `flow::plan` 或 `flow::build` 前，issue 必须有且仅有一个 `size::`。缺失时根据标题、正文、评论和仓库上下文选择一个；无法判断时用 `size::M` 并留下低置信度说明。
- `--label` 只用于 unmanaged label；`mr-by::*` 只用于 PR/MR，不能用于 issue。
- 有 `AGENTRIX_TASK_ID` 时创建命令会自动在 body 顶部写入带 `source_runtime=agentrix` 的隐藏 source marker，agent 不需要手写。

### PR/MR

```bash
node ${CLAUDE_SKILL_DIR}/cli.cjs pr get --pr 45
node ${CLAUDE_SKILL_DIR}/cli.cjs pr submit plan --issue 123 --title "Plan #123: Add auth" --body-file <tmp-plan-pr-body-file>
node ${CLAUDE_SKILL_DIR}/cli.cjs pr submit plan --issue 123 --artifact decision
node ${CLAUDE_SKILL_DIR}/cli.cjs pr submit plan --issue 123 --artifact plan
node ${CLAUDE_SKILL_DIR}/cli.cjs pr submit build --issue 123 --title "Build #123: Add auth" --body-file <tmp-pr-body-file>
node ${CLAUDE_SKILL_DIR}/cli.cjs pr comments list --pr 45
node ${CLAUDE_SKILL_DIR}/cli.cjs pr comments create --pr 45 --body-file <tmp-comment-body-file>
node ${CLAUDE_SKILL_DIR}/cli.cjs pr review-comments list --pr 45
node ${CLAUDE_SKILL_DIR}/cli.cjs pr review --pr 45 --body-file <tmp-review-body-file> [--comments-file <tmp-inline-comments-json>] [--as-comment]
node ${CLAUDE_SKILL_DIR}/cli.cjs pr merged --event <event-json-file>
```

`pr submit plan` 会读取 source issue 的特性开关。默认/`feature:visual-plan:off` 发布 Markdown Plan；`feature:visual-plan:on` 发布 Decision 或 Visual Plan。发布后的审阅和批准由 Issue Flow 处理。Markdown Plan 和 Build 的 `--body-file` 必须放在 repo 外临时文件。

### Labels 和 Dispatch

```bash
node ${CLAUDE_SKILL_DIR}/cli.cjs labels sync
node ${CLAUDE_SKILL_DIR}/cli.cjs labels check
node ${CLAUDE_SKILL_DIR}/cli.cjs dispatch auto --event <event-json-file>
node ${CLAUDE_SKILL_DIR}/cli.cjs dispatch comment --event <event-json-file>
node ${CLAUDE_SKILL_DIR}/cli.cjs dispatch review --pr 45
node ${CLAUDE_SKILL_DIR}/cli.cjs dispatch review-comment --event <event-json-file>
node ${CLAUDE_SKILL_DIR}/cli.cjs dispatch resume --event <event-json-file>
node ${CLAUDE_SKILL_DIR}/cli.cjs dispatch pipeline-failed --event <event-json-file>
```

所有新统一入口成功时 stdout 输出单个 JSON 文档，便于 agent 和 CI 消费。

`dispatch review-comment` 用于带 `<!-- issue-flow:source source_task_id=<id> source_runtime=agentrix -->` PR/MR body marker 的新 review comment 事件；它会 resume 该 task，不替代 `dispatch review`。该入口不按评论作者类型过滤，带 review batch id 的 inline comment 通过 PR/MR scoped review-batch lock 去重；普通 PR/MR comment 或缺少 batch id 的 payload 回退到 comment id lock。

## 典型 Agent 工作流

### Triage

`flow::`（下一步动作）与 `automation::`（自动化推进上限）是独立判断，不要求一致：

```bash
# 实现路径已确定的简单改动，直接进入 build：
node ${CLAUDE_SKILL_DIR}/cli.cjs issue apply --issue 123 \
  --type type::feature --priority priority::p1 --flow flow::build --automation automation::build
# 需要先规划；默认使用 Markdown Plan：
node ${CLAUDE_SKILL_DIR}/cli.cjs issue apply --issue 123 \
  --type type::feature --priority priority::p1 --flow flow::plan --automation automation::build

# 为单个 issue 开启 Visual Plan：
node ${CLAUDE_SKILL_DIR}/cli.cjs issue apply --issue 123 \
  --visual-plan-feature feature:visual-plan:on
```

### Plan → Submit / Publish

```bash
# 默认或 feature:visual-plan:off：提交 Markdown Plan：
node ${CLAUDE_SKILL_DIR}/cli.cjs pr submit plan \
  --issue 123 --title "Plan #123: Add auth" --body-file <tmp-plan-pr-body-file>

# feature:visual-plan:on 且有阻塞选择时只发布 Decision：
node ${CLAUDE_SKILL_DIR}/cli.cjs pr submit plan \
  --issue 123 --artifact decision

# feature:visual-plan:on 且无阻塞选择或 Decision 已批准时发布 Plan：
node ${CLAUDE_SKILL_DIR}/cli.cjs pr submit plan \
  --issue 123 --artifact plan
```

Markdown Plan 批准后进入 `flow::build`。Visual 模式下，Decision 提交后进入 `decision::pending + flow::approve`；收到修改意见时恢复原 Plan task；全部批准后进入 `decision::approved + flow::plan`，并恢复同一个 Plan task。Visual Plan 提交后进入 `visual-plan::pending + flow::approve`；收到修改意见时恢复原 task；批准后进入 `visual-plan::approved + flow::build`。

### Build → Submit

```bash
# 1. 按 plan 实现代码
# 2. 提交 PR/MR
node ${CLAUDE_SKILL_DIR}/cli.cjs pr submit build \
  --issue 123 --title "Build #123: Add auth" --body-file <tmp-body-file>
```

### Review

```bash
node ${CLAUDE_SKILL_DIR}/cli.cjs pr review --pr <num> --body-file <tmp-review-body-file> [--comments-file <tmp-inline-comments-json>] [--as-comment]
```

### 信息不足

```bash
node ${CLAUDE_SKILL_DIR}/cli.cjs issue apply --issue 123 --flow flow::clarify
# 然后按照具体 agent runtime 的说明在指定的位置进行问题澄清
```

## 兼容入口

旧脚本（`apply.cjs`、`create-issue.cjs`、`submit.cjs`、`review.cjs`、`sync-labels.cjs`、`dispatch.cjs`、`pr-merged.cjs`）保留为兼容入口和内部实现。新的 agent-facing 使用说明应优先使用 `cli.cjs` / `issue-flow` 总入口。
