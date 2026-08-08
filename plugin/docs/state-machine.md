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
flow::plan ──(plan agent)──┬── 默认（无 Visual Plan opt-in）
                           │     └── Markdown Plan MR → flow::approve
                           │           ├── 修改请求 → 评论 MR + resume Plan task
                           │           └── approve → merge → flow::build
                           └── feature:visual-plan:on
                                 ├── 可选 Decision → 同一 Plan MR + flow::clarify
                                 └── Visual Plan → 同一 Plan MR + flow::approve

type::optimization ──(optimizer agent)── Optimization JSON → Plan MR + flow::approve
    ├── Proposal Ignore → 该 Proposal 结束
    ├── Proposal Approve → 创建独立执行 Issue
    └── 全部 Proposal 结束 → close Plan MR + close 优化 Issue
                            → 来源 Issue optimization::analyzed

Decision 审阅：
  讨论/修改 → 评论 Plan MR + flow::clarify
            → resume 原 Plan task 修改 Decision
  全部通过 → 当前页面用户评论 Plan MR，不合并
            → flow::plan
            → review-comment pipeline resume 原 Plan task
            → 原分支和原 MR 更新为 Visual Plan

Visual Plan 审阅：
  修改请求 → 评论 Plan MR + flow::approve
           → resume 原 Plan task 修改 Plan
  Approve → 当前页面用户 merge Plan MR
          → flow::build
  合并失败/冲突 → 保持 MR open + flow::approve

flow::build ──(build agent)── build PR/MR → flow::approve
    │
    ▼
merge build PR/MR → status::done + clear flow
```

`type::docs` 复用现有生命周期，但不经过 Plan：`flow::triage -> flow::build -> flow::approve`，Build PR/MR 合并后进入 `status::done`。纯文档新增、修订、迁移和信息架构调整都走这条路径；不新增 flow、审批模型或提交入口。

所有 Plan 产物使用 Issue Flow Engine 审阅地址：

- `{ISSUE_FLOW_BASE_URL}/repos/{git-server-id}/{project-id}/plan/{issue-number}`

Decision、Visual Plan、Markdown Plan 和 Optimization Plan 共用同一个 Issue 级 URL；页面根据当前 Plan MR marker 中的 artifact 与 format 选择渲染方式。

两种模式的产物都保存在 `.issue-flow/issues/{issue-number}-{slug}/`，Plan 分支继续沿用 `{issue-number}-{slug}/plan` 规则。未设置开关时默认 Markdown 模式，以保持已有线上行为。Decision 和后续 Visual Plan 更新同一个分支与 `mr-by::plan` PR/MR；Markdown Plan 使用相同的 Plan MR 规则；Build PR/MR 保持不变。

## 发布与审阅

| 动作 | 结果 |
|------|------|
| 提交 Markdown Plan PR/MR | MR body 写入 artifact marker 与统一 Engine URL；`mr-by::plan` + `flow::approve` |
| 提交 Markdown Plan 修改请求 | 直接评论 MR 并 resume 原 Plan task；保持 `flow::approve` |
| Approve Markdown Plan | 在 provider 中 merge MR；`flow::build` |
| 提交 Decision | MR body 写入统一 Engine URL，并在 MR 下回复该 URL；`mr-by::plan` + `flow::clarify` |
| 提交 Decision 讨论/修改 | 审阅记录写入 LocalStorage、评论同一个 Plan MR 并 resume 原 Plan task；保持 `flow::clarify` |
| 提交 Decision 全部通过 | 清除 Decision 本地记录、评论同一个 Plan MR；`flow::plan`；review-comment pipeline resume 原 Plan task，不合并 MR |
| 提交 Visual Plan JSON | 删除已完成的 Decision JSON，更新同一分支/MR；Engine 内置渲染；`flow::approve` |
| 提交 Visual Plan 修改请求 | 审阅记录写入 LocalStorage、评论 MR 并 resume 原 Plan task；保持 `flow::approve` |
| Approve Visual Plan | 清除 Plan 本地记录并 merge Plan MR；`flow::build` |
| 提交 Optimization Plan JSON | 同一 Engine URL 渲染目标与 Proposal；`flow::approve` |
| 提交 Optimization 修改请求 | 评论 Plan MR 并 resume 原优化 Plan task |
| Approve Proposal | 创建带关联 marker 的独立执行 Issue；优化 Issue 不进入 Build |
| Ignore Proposal | 在 Plan MR 记录忽略 marker；该 Proposal 视为结束 |
| 全部 Proposal 结束 | 不 merge，关闭 Plan MR 与优化 Issue；来源 Issue 改为 `optimization::analyzed` |
| Plan 合并失败 | 保持 MR open 和当前 `flow::approve` 状态 |
| 提交 Build PR/MR | `mr-by::build` + `flow::approve` |
| 合并 Build PR/MR | `status::done` + clear `flow::` |

Engine 页面保留元素锚点、`data-ref`、`data-comment-scope`、点/区域标注、Decision Approve/Discuss、草稿增删改、Review Submit 和历史记录。Agent 只提交 Decision/Plan JSON；Engine 根据 JSON 使用固定组件、统一布局和统一样式生成 HTML、CSS、JavaScript、图形和评论锚点。草稿与已提交审阅按 repository、issue、Decision/Plan 分区保存在浏览器 LocalStorage；Approve 后删除对应分区。提交审阅时使用页面当前登录用户的 OAuth token 评论对应 PR/MR，只有 Plan Approve 使用同一身份合并。JSON 产物由 Issue Flow 服务通过 GitHub/GitLab provider API 按 MR marker 中的 commit 读取。

## Build 输入

Visual Plan Approve 后，Runtime 只向 Build Agent 提供已合并到默认分支的 `plan/data/plan.json.isv` 仓库路径，由 Build Agent 自行读取完整结构化内容；不会把 JSON 正文或 `visual-brief.md` 注入提示词，也不从 HTML 抓取文字。`visual-brief.md` 仅用于 Plan Agent 生成方案时自检和组织视觉模型，保存在 Runtime 注入的系统临时目录中，不属于仓库产物。Markdown 模式继续读取 `plan/*.md`。

## 路由决策

`resolve.cjs` 仍提供无副作用的 auto/resume 决策。可自动执行的 flow 为 `triage`、`plan`、`build`；`clarify` 和 `approve` 是人工 gate。进入 `flow::plan` 或 `flow::build` 前，issue 必须有且仅有一个 `size::` label。

有效自动化级别优先使用 issue 上的 `automation::` label；未设置时使用 `ISSUE_FLOW_AUTO_DEFAULT`。`automation::off` 禁止自动 intake 和自动推进。

## Plan 模式开关

- `feature:visual-plan:on`：启用 Decision/Visual Plan。
- 无该标签：使用 Markdown Plan PR/MR。

Decision、Visual Plan 和 Markdown Plan 都使用 `mr-by::plan` PR/MR。Decision 和 Visual Plan 使用同一个 open MR；Plan 提交会将 MR body marker 从 Decision 更新为 Plan。

| PR/MR Label | Merge 后 Source Issue 变化 |
|-------------|--------------------------|
| `mr-by::plan` + Decision marker | 非预期手工 merge 时回到 `flow::plan` |
| `mr-by::plan` + Visual Plan marker | `flow::build` |
| `mr-by::plan` + Markdown Plan marker | `flow::build` |
| `mr-by::plan` + Optimization marker | 不允许用 merge 推进；由 Proposal 完成自动关闭 |
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
| Close loop | 仅 resume 原 task；不要求 task 处理后再发布普通总结 comment |
| Skip | 非 open/draft/merged PR、缺少 PR/MR task marker、非 review comment created event |

旧脚本仍作为兼容入口和内部实现保留；新的 agent-facing 文档和 prompt 使用 `issue-flow` 总入口。
