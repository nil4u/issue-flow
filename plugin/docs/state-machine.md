# 状态机

## 核心流程

```text
Issue Created
    │
    ▼
[intake] → status::active + flow::triage
    │
    ▼
flow::triage ──(triage agent)──┬── flow::clarify
                               ├── flow::plan
                               ├── flow::build（简单且无需方案审批）
                               ├── status::suspend / status::drop
                               └── status::done
    │
    ▼
flow::plan ──(plan agent)──┬── 默认 / feature:visual-plan:off
                           │     └── Markdown Plan MR → plan::pending + flow::approve
                           │           ├── 修改请求 → 评论 MR + resume Plan task
                           │           └── approve → merge → flow::build
                           └── feature:visual-plan:on
                                 ├── 可选 Decision → 同一 Plan MR + flow::clarify
                                 └── Visual Plan → 同一 Plan MR + plan::pending + flow::approve

Decision 审阅：
  讨论/修改 → 评论 Plan MR + flow::clarify
            → resume 原 Plan task 修改 Decision
  全部通过 → 当前页面用户评论 Plan MR，不合并
            → flow::plan
            → review-comment pipeline resume 原 Plan task
            → 原分支和原 MR 更新为 Visual Plan

Visual Plan 审阅：
  修改请求 → 评论 Plan MR + plan::changes-requested + flow::approve
           → resume 原 Plan task 修改 Plan
  Approve → 当前页面用户 merge Plan MR
          → plan::approved + flow::build
  合并失败/冲突 → 保持 MR open + plan::pending + flow::approve

flow::build ──(build agent)── build PR/MR → flow::approve
    │
    ▼
merge build PR/MR → status::done + clear flow
```

Decision 和 Plan 是两个独立页面，不是 tab；Markdown Plan 复用 Plan 页面并由 provider Markdown API 渲染：

- `{ISSUE_FLOW_BASE_URL}/repos/{git-server-id}/{project-id}/plan/{issue-number}/decision`
- `{ISSUE_FLOW_BASE_URL}/repos/{git-server-id}/{project-id}/plan/{issue-number}/plan`

两种模式的产物都保存在 `.issue-flow/issues/{issue-number}-{slug}/`，Plan 分支继续沿用 `{issue-number}-{slug}/plan` 规则。未设置开关时默认 Markdown 模式，以保持已有线上行为。Decision 和后续 Visual Plan 更新同一个分支与 `mr-by::plan` PR/MR；Markdown Plan 使用相同的 Plan MR 规则；Build PR/MR 保持不变。

## 发布与审阅

| 动作 | 结果 |
|------|------|
| 提交 Markdown Plan PR/MR | MR body 写入 Plan Engine URL；`mr-by::plan` + `plan::pending` + `flow::approve` |
| 提交 Markdown Plan 修改请求 | 审阅记录写入 LocalStorage、评论 MR 并 resume 原 Plan task；`plan::changes-requested` + `flow::approve` |
| Approve Markdown Plan | 页面当前用户 merge MR；`plan::approved` + `flow::build` |
| 提交 Decision | MR body 写入 Decision Engine URL；`mr-by::plan` + `flow::clarify` |
| 提交 Decision 讨论/修改 | 审阅记录写入 LocalStorage、评论同一个 Plan MR 并 resume 原 Plan task；保持 `flow::clarify` |
| 提交 Decision 全部通过 | 清除 Decision 本地记录、评论同一个 Plan MR；`flow::plan`；review-comment pipeline resume 原 Plan task，不合并 MR |
| 提交 Visual Plan JSON | 删除已完成的 Decision JSON，更新同一分支/MR；Engine 内置渲染；`plan::pending` + `flow::approve` |
| 提交 Visual Plan 修改请求 | 审阅记录写入 LocalStorage、评论 MR 并 resume 原 Plan task；`plan::changes-requested` + `flow::approve` |
| Approve Visual Plan | 清除 Plan 本地记录并 merge Plan MR；`plan::approved` + `flow::build` |
| Plan 合并失败 | 保持 MR open 和当前 pending/approve 状态 |
| 提交 Build PR/MR | `mr-by::build` + `flow::approve` |
| 合并 Build PR/MR | `status::done` + clear `flow::` |

Engine 页面保留元素锚点、`data-ref`、`data-comment-scope`、点/区域标注、Decision Approve/Discuss、草稿增删改、Review Submit 和历史记录。Agent 只提交 Decision/Plan JSON；Engine 根据 JSON 使用固定组件、统一布局和统一样式生成 HTML、CSS、JavaScript、图形和评论锚点。草稿与已提交审阅按 repository、issue、Decision/Plan 分区保存在浏览器 LocalStorage；Approve 后删除对应分区。提交审阅时使用页面当前登录用户的 OAuth token 评论对应 PR/MR，只有 Plan Approve 使用同一身份合并。JSON 产物由 Issue Flow 服务通过 GitHub/GitLab provider API 按 MR marker 中的 commit 读取。

## Build 输入

Visual Plan Approve 后，Runtime 只向 Build Agent 提供已合并到默认分支的 `plan/data/plan-data.json` 仓库路径，由 Build Agent 自行读取完整结构化内容；不会把 JSON 正文或 `visual-brief.md` 注入提示词，也不从 HTML 抓取文字。`visual-brief.md` 仅用于 Plan Agent 生成方案时自检和组织视觉模型，保存在 Runtime 注入的系统临时目录中，不属于仓库产物。Markdown 模式继续读取 `plan/*.md`。

## 路由决策

`resolve.cjs` 仍提供无副作用的 auto/resume 决策。可自动执行的 flow 为 `triage`、`plan`、`build`；`clarify` 和 `approve` 是人工 gate。进入 `flow::plan` 或 `flow::build` 前，issue 必须有且仅有一个 `size::` label。

有效自动化级别优先使用 issue 上的 `automation::` label；未设置时使用 `ISSUE_FLOW_AUTO_DEFAULT`。`automation::off` 禁止自动 intake 和自动推进。

## Plan 模式开关

- `feature:visual-plan:on`：启用 Decision/Visual Plan。
- `feature:visual-plan:off`：使用 Markdown Plan PR/MR。
- 无开关：默认 off。
- 同时出现 on/off：阻断 Plan，要求先修正。

Decision、Visual Plan 和 Markdown Plan 都使用 `mr-by::plan` PR/MR。Decision 和 Visual Plan 使用同一个 open MR；Plan 提交会将 MR body marker 从 Decision 更新为 Plan。

| PR/MR Label | Merge 后 Source Issue 变化 |
|-------------|--------------------------|
| `mr-by::plan` + Decision marker | 非预期手工 merge 时回到 `flow::plan` |
| `mr-by::plan` + Visual Plan marker | `plan::approved + flow::build` |
| `mr-by::plan` + Markdown Plan marker | `plan::approved + flow::build` |
| `mr-by::build` | `status::done` + clear `flow::` |

Source issue 仍按 marker、body 文本、标题和 branch 名解析。

## Weighted Throughput

Weighted Throughput 按完成 issue 的唯一 `size::` label 求和：`size::XS=0.5`、`size::S=1`、`size::M=2`、`size::L=3`、`size::XL=5`。完成口径建议使用 `status::done`，或 build PR/MR merge 后由 `pr merged` 转为 done 的 source issue。没有 size 或有多个 size 的 issue 不进入统计；plan/build 前置 gate 的目的就是避免新执行流继续产生这类数据。

## PR/MR Review Check

| 项 | 值 |
|----|----|
| Scope | PR/MR |
| Trigger | opened, synchronize, ready_for_review, manual |
| Command | `issue-flow dispatch review` |
| Submit result | `issue-flow pr review` |
| Config | `ISSUE_FLOW_REVIEW_ENABLED=true` or `1` |
| Issue state | 不读取或修改 source issue `flow::` |

## Review Comment Resume

| 项 | 值 |
|----|----|
| Scope | 带 Agentrix source marker 的 PR/MR |
| Trigger | review comment created |
| Command | `issue-flow dispatch review-comment` |
| Issue state | 不读取 source issue state，不修改 label |
| Task target | 从 PR/MR body 的 `<!-- issue-flow:source source_task_id=<id> source_runtime=agentrix -->` marker 解析 |
| Acknowledge | 给触发 comment 加 `eyes` reaction |
| Close loop | task 处理后用 `issue-flow pr comments create` 在 PR/MR 下发一条普通总结 comment |
| Skip | 非 open/draft/merged PR、缺少 PR/MR task marker、非 review comment created event |

旧脚本仍作为兼容入口和内部实现保留；新的 agent-facing 文档和 prompt 使用 `issue-flow` 总入口。
