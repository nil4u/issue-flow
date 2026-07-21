---
name: issue-flow
version: 0.6.0 # x-release-please-version
description: "标签驱动的 issue 状态机与 provider 操作工具。通过统一 issue-flow CLI 操作 GitHub/GitLab 的 issue、label、comment、PR/MR 与 review。在含 `.issue-flow/` 目录或使用 issue-flow managed label（type::/status::/flow:: 等）的仓库中处理 issue/PR、提交 Plan/Build PR/MR 或进行 review 时使用。"
metadata:
  requires:
    bins: ["node"]
---

# Issue Flow

issue-flow 定义了一套基于 issue、Plan 审批和 Build PR/MR 的 agent 自动化开发流程。

Issue 是需求、缺陷、运维事项和技术债的总入口，也是状态机的 source of truth。Plan 默认使用 Markdown 审阅；只有 issue 带 `feature:visual-plan:on` 时才使用 Decision/Visual Plan 页面。实际代码始终通过 Build PR/MR 审批。

在 issue-flow 下工作时，agent-facing provider 操作必须使用统一入口：

```bash
node .issue-flow/cli.cjs <resource> <action> [options]
```

如果环境已安装 bin，也可以使用：

```bash
issue-flow <resource> <action> [options]
```

所有命令都从仓库根目录执行。`.issue-flow/cli.cjs` 是安装器创建的稳定入口，Agentrix、Codex 与 Claude Code 共用同一路径。

不要为 issue-flow 已覆盖的动作直接调用 `gh`、`glab`、`gh api`、`glab api`，也不要手写 GitHub/GitLab REST/GraphQL 请求。provider 内部可以使用 token API 或 CLI fallback，但这个选择由 issue-flow 封装。

## Label 体系

所有 managed label 按 prefix 分组，同一 prefix 内互斥。未指定某个 prefix 时，命令不触碰该 prefix 的现有 label。

| Prefix | Scope | 作用 | Values |
|--------|-------|------|--------|
| `type::` | Issue | 需求类型 | `feature`, `bug`, `debt`, `ops` |
| `status::` | Issue | 生命周期状态 | `active`, `done`, `drop`, `suspend` |
| `flow::` | Issue | 下一步工作流动作 | `triage`, `plan`, `build`, `clarify`, `approve` |
| `feature:visual-plan:` | Issue | Visual Plan opt-in；未设置时使用 Markdown | `on` |
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
node .issue-flow/cli.cjs issue get --issue 123
node .issue-flow/cli.cjs issue create --title "<normalized title>" --body-file <tmp-issue-body-file> \
  --type type::feature --status status::active --flow flow::plan --priority priority::p2 --size size::M [--milestone <title|none>]
node .issue-flow/cli.cjs issue apply --issue 123 --flow flow::build --automation automation::build --size size::M [--milestone <title|none>]
node .issue-flow/cli.cjs issue apply --issue 123 --type type::bug --normalized-body-file <tmp-normalized-body-file>
node .issue-flow/cli.cjs issue intake --issue 123
node .issue-flow/cli.cjs issue comments list --issue 123
node .issue-flow/cli.cjs issue comments create --issue 123 --body-file <tmp-comment-body-file>
node .issue-flow/cli.cjs issue acknowledge --issue 123
```

- `issue apply` 只移除指定 prefix 的旧 label，不动其他 prefix。
- 规范化正文：按 issue 的 `type::` 对应 `.issue-flow/templates/type-*.md` 重写正文，写到 repo 外临时文件，用 `--normalized-body-file` 随标签一起应用。
- 设置 `flow::clarify` 时不会更新 issue body（会忽略 `--normalized-body-file`）。
- 用户明确要求创建 issue，或开放讨论已经形成清晰需求时，创建规范化 issue；目标、边界、用户故事或关键事实仍不清楚时先询问，不创建模糊 issue。
- 创建 issue 时，body 先按 `.issue-flow/templates/type-*.md` 整理，写到 repo 外临时文件（如 `mktemp`）；不要把 body 文件提交到 git。
- 创建 issue 前先运行 `milestone list`：返回 `enabled: true` 时必须显式传 `--milestone <title|none>`；用户未指定且有候选项时先询问，没有候选项时传 `none`，返回 `enabled: false` 时省略该参数。
- 创建 issue 时只设置已经能判断的 managed labels：实现路径明确可用 `flow::build`，需要先规划用 `flow::plan`，仍需自动分类用 `flow::triage`，只记录且不自动推进用 `automation::off`。
- `type::`、`status::`、`flow::`、`priority::`、`automation::`、`size::` 必须通过对应参数传入，不能放在 `--label`。
- 进入 `flow::plan` 或 `flow::build` 前，issue 必须有且仅有一个 `size::`。缺失时根据标题、正文、评论和仓库上下文选择一个；无法判断时用 `size::M` 并留下低置信度说明。
- `--label` 只用于 unmanaged label；`mr-by::*` 只用于 PR/MR，不能用于 issue。
- 有 `AGENTRIX_TASK_ID` 时创建命令会自动在 body 顶部写入带 `source_runtime=agentrix` 的隐藏 source marker，agent 不需要手写。

### PR/MR

```bash
node .issue-flow/cli.cjs pr get --pr 45
node .issue-flow/cli.cjs pr submit plan --issue 123 --title "Plan #123: Add auth" --body-file <tmp-plan-pr-body-file>
node .issue-flow/cli.cjs pr submit plan --issue 123 --artifact decision
node .issue-flow/cli.cjs pr submit plan --issue 123 --artifact plan
node .issue-flow/cli.cjs pr submit build --issue 123 --title "Build #123: Add auth" --body-file <tmp-pr-body-file>
node .issue-flow/cli.cjs pr comments list --pr 45
node .issue-flow/cli.cjs pr comments create --pr 45 --body-file <tmp-comment-body-file>
node .issue-flow/cli.cjs pr review-comments list --pr 45
node .issue-flow/cli.cjs pr review --pr 45 --body-file <tmp-review-body-file> [--comments-file <tmp-inline-comments-json>] [--as-comment]
node .issue-flow/cli.cjs pr merged --event <event-json-file>
```

`pr submit plan` 会读取 source issue 的特性开关。默认发布 Markdown Plan；`feature:visual-plan:on` 发布 Decision 或 Visual Plan。发布后的审阅和批准由 Issue Flow 处理。Markdown Plan 和 Build 的 `--body-file` 必须放在 repo 外临时文件。

### Milestone、Labels 和 Dispatch

```bash
node .issue-flow/cli.cjs labels sync
node .issue-flow/cli.cjs labels check
node .issue-flow/cli.cjs milestone list
node .issue-flow/cli.cjs dispatch auto --event <event-json-file>
node .issue-flow/cli.cjs dispatch comment --event <event-json-file>
node .issue-flow/cli.cjs dispatch review --pr 45
node .issue-flow/cli.cjs dispatch review-comment --event <event-json-file>
node .issue-flow/cli.cjs dispatch resume --event <event-json-file>
node .issue-flow/cli.cjs dispatch pipeline-failed --event <event-json-file>
```

所有新统一入口成功时 stdout 输出单个 JSON 文档，便于 agent 和 CI 消费。

项目可在 `.issue-flow/config.json` 中用 `milestone.enabled` 开启 target branch 选择，并用 `milestone.branchPatterns` 配置自动同步规则；缺省规则为 `release/*` 和 `integration/*`。匹配分支创建/删除时 CI 自动创建、重开/关闭同名 Milestone，`none` 使用仓库默认分支。Triage 确认用户倾向后可用 `issue apply --milestone <title|none>` 补选；暂不处理 Plan 或 Build 运行期间的 Milestone 变更。

`dispatch review-comment` 用于带 `<!-- issue-flow:source source_task_id=<id> source_runtime=agentrix -->` PR/MR body marker 的新 review comment 事件；它会 resume 该 task，不替代 `dispatch review`。该入口不按评论作者类型过滤，带 review batch id 的 inline comment 通过 PR/MR scoped review-batch lock 去重；普通 PR/MR comment 或缺少 batch id 的 payload 回退到 comment id lock。

## 典型 Agent 工作流

### Triage

`flow::`（下一步动作）与 `automation::`（自动化推进上限）是独立判断，不要求一致：

```bash
# 实现路径已确定的简单改动，直接进入 build：
node .issue-flow/cli.cjs issue apply --issue 123 \
  --type type::feature --priority priority::p1 --flow flow::build --automation automation::build
# 需要先规划；默认使用 Markdown Plan：
node .issue-flow/cli.cjs issue apply --issue 123 \
  --type type::feature --priority priority::p1 --flow flow::plan --automation automation::build

# 为单个 issue 开启 Visual Plan：
node .issue-flow/cli.cjs issue apply --issue 123 \
  --visual-plan-feature feature:visual-plan:on

# 切回默认 Markdown Plan：
node .issue-flow/cli.cjs issue apply --issue 123 \
  --clear-visual-plan-feature
```

### Plan → Submit / Publish

```bash
# 默认（无 feature:visual-plan:on）：提交 Markdown Plan：
node .issue-flow/cli.cjs pr submit plan \
  --issue 123 --title "Plan #123: Add auth" --body-file <tmp-plan-pr-body-file>

# feature:visual-plan:on 且有阻塞选择时只发布 Decision：
node .issue-flow/cli.cjs pr submit plan \
  --issue 123 --artifact decision

# feature:visual-plan:on 且无阻塞选择或 Decision 已批准时发布 Plan：
node .issue-flow/cli.cjs pr submit plan \
  --issue 123 --artifact plan
```

Markdown Plan 与 Visual Plan 的等待审批与已批准状态分别由 open/merged Plan MR 表示。Visual 模式下，Decision 提交后使用 `flow::clarify`；修改意见和批准结果都评论在同一个 open Plan MR，批准评论把 Issue 转到 `flow::plan` 并恢复原 Plan task。Plan task 继续使用同一分支和 MR 发布 Visual Plan；Plan 批准后合并 MR并进入 `flow::build`。

### Build → Submit

```bash
# 1. 按 plan 实现代码
# 2. 提交 PR/MR
node .issue-flow/cli.cjs pr submit build \
  --issue 123 --title "Build #123: Add auth" --body-file <tmp-body-file>
```

### Review

```bash
node .issue-flow/cli.cjs pr review --pr <num> --body-file <tmp-review-body-file> [--comments-file <tmp-inline-comments-json>] [--as-comment]
```

### 信息不足

```bash
node .issue-flow/cli.cjs issue apply --issue 123 --flow flow::clarify
# 然后按照具体 agent runtime 的说明在指定的位置进行问题澄清
```

## 兼容入口

旧脚本（`apply.cjs`、`create-issue.cjs`、`submit.cjs`、`review.cjs`、`sync-labels.cjs`、`dispatch.cjs`、`pr-merged.cjs`）保留为兼容入口和内部实现。新的 agent-facing 使用说明应优先使用 `cli.cjs` / `issue-flow` 总入口。
