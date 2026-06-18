# 状态机

## 核心流程

```
Issue Created
    │
    ▼
[intake] → status::active + flow::triage
    │
    ▼
flow::triage ──(triage agent)──┬── flow::plan
                               ├── flow::build (简单直接)
                               ├── flow::clarify (缺信息)
                               ├── status::done (已解决)
                               └── status::drop (不处理)
    │
    ▼
flow::plan ──(plan agent)──┬── flow::approve (提交 plan PR)
                           └── flow::clarify (缺信息)
    │
    ▼
flow::approve ──(人工审批)──┬── merge plan PR → flow::build
                           └── 关闭/拒绝
    │
    ▼
flow::build ──(build agent)──┬── flow::approve (提交 build PR)
                             └── flow::clarify (缺信息)
    │
    ▼
flow::approve ──(人工审批)──┬── merge build PR → status::done + clear flow
                           └── 关闭/拒绝
```

## 流转触发方式

### 自动流转（由统一 CLI 确定性执行）

| 触发条件 | 命令 | 结果 |
|----------|------|------|
| submit plan PR | `issue-flow pr submit plan` | source issue → `flow::approve` |
| submit build PR | `issue-flow pr submit build` | source issue → `flow::approve` |
| merge `mr-by::plan` PR | `issue-flow pr merged` | source issue → `flow::build` |
| merge `mr-by::build` PR | `issue-flow pr merged` | source issue → `status::done` + clear flow |
| 新 issue 缺默认 label | `issue-flow issue intake` | 添加 `status::active` + `flow::triage` |
| AI 讨论已形成需求 | `issue-flow issue create` | 创建标准化 issue，可直接带 `status::active` + `flow::*` 或 `automation::off` |

### Agent 主动流转（通过统一 CLI）

Agent 根据自己的判断决定流转方向，通过 `issue-flow issue apply` 执行：

```bash
# triage 完成，进入 plan
issue-flow issue apply --issue 123 --flow flow::plan --type type::feature --size size::M

# 信息不足，需要人工补充
issue-flow issue apply --issue 123 --flow flow::clarify

# issue 已经解决了
issue-flow issue apply --issue 123 --status status::done --clear-flow
```

进入 `flow::plan` 或 `flow::build` 前，最终 issue labels 必须有且仅有一个 `size::`。`issue create` 如果直接设置 `flow::plan` / `flow::build`，同一次请求必须传 `--size size::<value>`；`issue apply` 设置 `flow::plan` / `flow::build` 时会按最终 labels 校验唯一 size；`pr submit plan/build` 在 push 和创建 PR/MR 前会再次读取 source issue 校验 size。缺失时由 agent 根据标题、正文、评论和仓库上下文补打；无法判断时用 `size::M` 并留下低置信度说明。多个 size 会阻断流转，必须先修正为一个。

## 路由决策

`resolve.cjs` 提供纯决策逻辑（无副作用）：

### auto 决策

输入：issue 当前状态
输出：shouldRun + action + reason

决策规则：
1. 非 open 状态 → skip (reason: issue_not_open)
2. 无 status:: label → skip (reason: missing_status_label)
3. `status::done/drop/suspend` → skip
4. status 不是 `status::active` → skip (reason: status_not_active)
5. 无 flow:: label → skip (reason: missing_flow_label)
6. flow:: 不是可执行的 → skip (reason: unsupported_flow)
7. plan/build 且存在多个 `size::` → skip (code: multiple_size_labels)
8. `automation::off` → skip (reason: automation_off)
9. 有效自动化级别 < 所需级别 → skip (reason: automation_level_too_low)
10. 通过 → shouldRun: true, action: triage/plan/build

有效自动化级别优先使用 issue 上的 `automation::` label；issue 未设置时才使用 `ISSUE_FLOW_AUTO_DEFAULT`。`automation::off` 也会让 intake 跳过默认 `status::active` / `flow::triage` 补标。labeled 事件只有新增 `flow::*`、`automation::plan`、`automation::build` 或 `status::active` 时才进入自动路由；`type::*`、`priority::*`、`size::*`、unmanaged label 和 `automation::off` 不单独触发 agent。

### resume 决策

输入：issue 当前 labels
输出：shouldRun + action

决策规则：
1. 终态 status → skip
2. 无 flow:: label → skip
3. flow:: 不可执行 → skip
4. 通过 → action = flow 对应的 command

## Merge 转移表

| PR/MR Label | Merge 后 Source Issue 变化 |
|-------------|--------------------------|
| `mr-by::plan` | `flow::build` |
| `mr-by::build` | `status::done` + clear `flow::` |

Source issue 通过以下优先级确定：
1. PR body 中的 `<!-- issue-flow:source-issue=123 -->` marker
2. PR body 中的 `Source issue: #123` 文本
3. PR title 中的 `Plan #123` / `Build #123` 模式
4. Branch 名中的 `123-slug/plan` / `123-slug/build` 模式

## Gate Flow

以下 flow 不会被自动化执行，需要人工介入：

- `flow::clarify` — agent 缺少信息，需人工回答
- `flow::approve` — plan/build PR 等待人工审批

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

旧脚本仍作为兼容入口和内部实现保留；新的 agent-facing 文档和 prompt 使用 `issue-flow` 总入口。
