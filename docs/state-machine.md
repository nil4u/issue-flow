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

### 自动流转（由脚本确定性执行）

| 触发条件 | 脚本 | 结果 |
|----------|------|------|
| submit plan PR | `submit.cjs plan` | source issue → `flow::approve` |
| submit build PR | `submit.cjs build` | source issue → `flow::approve` |
| merge `mr-by::plan` PR | `pr-merged.cjs` | source issue → `flow::build` |
| merge `mr-by::build` PR | `pr-merged.cjs` | source issue → `status::done` + clear flow |
| 新 issue 缺默认 label | `intake.cjs` | 添加 `status::active` + `flow::triage` |

### Agent 主动流转（通过 apply.cjs）

Agent 根据自己的判断决定流转方向，通过 `apply.cjs` 执行：

```bash
# triage 完成，进入 plan
node apply.cjs --issue-number 123 --flow flow::plan --type type::feature

# 信息不足，需要人工补充
node apply.cjs --issue-number 123 --flow flow::clarify

# issue 已经解决了
node apply.cjs --issue-number 123 --status status::done --clear-flow
```

## 路由决策

`resolve.cjs` 提供纯决策逻辑（无副作用）：

### auto 决策

输入：issue 当前状态
输出：shouldRun + action + reason

决策规则：
1. 非 open 状态 → skip (reason: issue_not_open)
2. 终态 status → skip (reason: status::done/drop/suspend)
3. 无 flow:: label → skip (reason: missing_flow_label)
4. flow:: 不是可执行的 → skip (reason: unsupported_flow)
5. 有效自动化级别 < 所需级别 → skip (reason: automation_level_too_low)
6. 通过 → shouldRun: true, action: triage/plan/build

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
