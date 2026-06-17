# Label 语义

## Managed Label Groups

所有 managed label 按 prefix 分组，同一 prefix 内互斥（apply.cjs 自动处理替换）。
Provider 侧 label 可通过 `sync-labels.cjs` 同步创建或更新。Catalog 中颜色统一保存为 6 位 `RRGGBB`；GitHub API 使用 `RRGGBB`，GitLab API 使用 `#RRGGBB`。

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

当前所处的工作流阶段（下一步动作）。

「可自动化」列指该步是否可被自动化驱动（而非人工 gate）；标 `是` 的步骤是否真正自动触发，还要由 `automation::` 上限决定（见下）。

| Label | 语义 | 可自动化？ |
|-------|------|-----------|
| `flow::triage` | 等待分类/规范化 | 是 |
| `flow::plan` | 等待方案规划 | 是 |
| `flow::build` | 等待实现 | 是 |
| `flow::clarify` | 等待人工补充信息 | 否（gate） |
| `flow::approve` | 等待人工审批 | 否（gate） |

### automation::

Issue 级别的自动化策略：**允许自动化推进到的上限**。与 `flow::` 正交——`flow::` 是当前这一步，`automation::` 是这个 issue 能自动跑多远。

| Label | 语义 |
|-------|------|
| `automation::plan` | 自动推进到 plan 为止，build 需人工触发 |
| `automation::build` | 自动推进到 build；若走 plan，plan PR 合并后自动续推 |

自动化级别排序：`off` < `triage` < `plan` < `build`

有效级别 = max(repo 默认级别, issue automation:: label)

重要：issue label 只能**提升**自动化级别，不能降低 repo 默认级别。不确定时不标，沿用 repo 默认。

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

## Provider Label Catalog

| Label | Scope | Color | Description |
|-------|-------|-------|-------------|
| `type::feature` | Issue | `0E8A16` | Issue is a feature or enhancement |
| `type::bug` | Issue | `D73A4A` | Issue reports a defect or regression |
| `type::debt` | Issue | `5319E7` | Issue tracks technical debt or cleanup |
| `type::ops` | Issue | `1D76DB` | Issue tracks operations or maintenance work |
| `status::active` | Issue | `0052CC` | Issue is active and eligible for workflow actions |
| `status::done` | Issue | `0E8A16` | Issue is complete |
| `status::drop` | Issue | `6A737D` | Issue has been dropped and should not continue |
| `status::suspend` | Issue | `FBCA04` | Issue is suspended until conditions change |
| `flow::triage` | Issue | `BFDADC` | Waiting for triage |
| `flow::plan` | Issue | `0052CC` | Waiting for a plan action |
| `flow::build` | Issue | `1D76DB` | Waiting for implementation |
| `flow::review` | Issue | `5319E7` | Waiting for human review |
| `flow::clarify` | Issue | `D4C5F9` | Waiting for clarification |
| `flow::approve` | Issue | `0E8A16` | Waiting for approval of a plan or build PR/MR |
| `automation::plan` | Issue | `7057FF` | Automation may create plan PRs/MRs |
| `automation::build` | Issue | `006B75` | Automation may create plan and build PRs/MRs |
| `priority::p0` | Issue | `B60205` | Highest priority issue |
| `priority::p1` | Issue | `D93F0B` | High priority issue |
| `priority::p2` | Issue | `FBCA04` | Normal priority issue |
| `priority::p3` | Issue | `C5DEF5` | Low priority issue |
| `mr-by::plan` | PR/MR | `0052CC` | PR or MR was created by the plan action |
| `mr-by::build` | PR/MR | `1D76DB` | PR or MR was created by the build action |
