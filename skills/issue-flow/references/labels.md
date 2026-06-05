# Label 语义

## Managed Label Groups

所有 managed label 按 prefix 分组，同一 prefix 内互斥（apply.cjs 自动处理替换）。

### type::

Issue 类型。一个 issue 只有一个 type。

| Label | 语义 |
|-------|------|
| `type::feature` | 新功能或功能增强 |
| `type::bug` | 已有功能的缺陷或回归 |
| `type::debt` | 重构、可维护性、工程质量 |
| `type::ops` | 发布、环境、权限、CI/CD、生产运维 |

### status::

Issue 生命周期状态。

| Label | 语义 |
|-------|------|
| `status::active` | 活跃，应继续处理 |
| `status::done` | 已完成（终态） |
| `status::drop` | 不再处理（终态） |
| `status::suspend` | 暂停，不自动 resume |

终态（`done`/`drop`/`suspend`）不会被自动化流程 resume。

### flow::

当前所处的工作流阶段。

| Label | 语义 | 自动执行？ |
|-------|------|-----------|
| `flow::triage` | 等待分类/规范化 | 是 |
| `flow::plan` | 等待方案规划 | 是 |
| `flow::build` | 等待实现 | 是 |
| `flow::clarify` | 等待人工补充信息 | 否（gate） |
| `flow::approve` | 等待人工审批 | 否（gate） |
| `flow::review` | 等待 review | 是 |

### automation::

Issue 级别的自动化策略。

| Label | 语义 |
|-------|------|
| `automation::plan` | 允许自动执行到 plan 级别 |
| `automation::build` | 允许自动执行到 build 级别 |

自动化级别排序：`off` < `triage` < `plan` < `build`

有效级别 = max(repo 默认级别, issue automation:: label)

重要：issue label 只能**提升**自动化级别，不能降低 repo 默认级别。

apply.cjs 只接受 `automation::plan` 和 `automation::build`。
`automation::triage` 和 `automation::off` 不是合法 label 值。

### priority::

| Label | 语义 |
|-------|------|
| `priority::p0` | 紧急/严重阻塞 |
| `priority::p1` | 高影响 |
| `priority::p2` | 默认 |
| `priority::p3` | 低优先级 |

### mr-by::

PR/MR 来源标记。**只用于 PR/MR，不用于 issue。**

| Label | 语义 |
|-------|------|
| `mr-by::plan` | PR/MR 由 plan action 创建 |
| `mr-by::build` | PR/MR 由 build action 创建 |

## 互斥规则

- 同一 prefix 内只保留一个 label
- apply.cjs 在变更某个 prefix 时，自动移除该 prefix 下的旧 label
- 不指定某个 prefix 时，不触碰该 prefix 的现有 label
- `--clear-flow` 清除所有 `flow::` label 但不添加新的
- `--clear-automation` 清除所有 `automation::` label 但不添加新的
