## 目标

- 在 issue-flow 中新增 issue-scoped managed label 组 `size::`，支持 `size::XS`、`size::S`、`size::M`、`size::L`、`size::XL`，权重分别为 `0.5 / 1 / 2 / 3 / 5`。
- 在实际执行 `flow::plan` 或 `flow::build` 前，确保 source issue 有且仅有一个 `size::` label。
- 当 issue 缺少 `size::` 时，由执行 agent 根据 issue 标题、正文和评论补打一个 size label；无法可靠判断时默认 `size::M`，并留下低置信度说明。
- 当 issue 同时存在多个 `size::` label 时阻断 plan/build，不提交 plan/build PR/MR，并要求人工修正为一个。
- 更新文档，说明 size 标签语义、默认选择策略和 Weighted Throughput 的计算方式。

## 非目标

- 不在本次实现中提供吞吐量报表、仪表盘、时间窗口查询或 provider milestone/project 统计。
- 不追溯修复历史 issue 的 size label；历史数据回填可在后续单独处理。
- 不改变 `type::`、`status::`、`flow::`、`automation::`、`priority::` 和 `mr-by::` 的既有语义。
- 不要求脚本层用固定启发式完全替代 agent 判断；脚本层负责确定性校验和阻断，size 估算仍由 agent 基于上下文完成。

## 当前上下文

- 相关模块：
  - `skills/issue-flow/scripts/labels.cjs` 集中维护 managed label catalog，`sync-labels.cjs` 通过 `labelsForScope('all')` 同步 provider labels。
  - `skills/issue-flow/scripts/apply.cjs` 和 `create-issue.cjs` 都从 `labelGroupsForScope('issue')` 派生可接受的 issue managed label 参数；新增 issue group 后可自然支持 `--size size::M`，但 help、测试和文档需要显式补齐。
  - `skills/issue-flow/scripts/resolve.cjs` 目前用 `findSingleLabel()` 校验 `status::` 和 `flow::` 单值，并将 `flow::plan` / `flow::build` 解析为可执行 action。
  - `skills/issue-flow/scripts/dispatch.cjs` 在 auto/resume/manual action 前会 fetch 当前 issue，再根据 resolve 结果决定是否启动 Agentrix runtime。
  - `skills/issue-flow/scripts/runtimes/agentrix.cjs` 会把 issue labels 注入 prompt，当前只过滤 `status::`、`flow::`、`automation::`，因此 `size::` label 会出现在 agent 可见上下文中。
  - `skills/issue-flow/assets/agentrix/runtime/prompts/triage.prompt.md` 已要求 triage 在 `flow::plan` 与 `flow::build` 之间做判断；`plan-impl.prompt.md` 和 `build.prompt.md` 是缺失 size 时补标的主要 agent-facing 入口。
  - `skills/issue-flow/references/labels.md`、`docs/state-machine.md`、`docs/provider-api.md` 和 `README.md` 是 label 语义、状态机和 CLI 行为的主要文档位置。
  - `.agentrix/plugins/issue-flow/skills/issue-flow/SKILL.md` 是当前 project-level agent 指令来源；安装资产中的 skill/prompt/template 也需要同步。
- 相关接口 / 数据 / 状态：
  - managed label 同 prefix 互斥；`apply.cjs` 在显式设置某个 prefix 时会移除该 prefix 下的旧 label。
  - `issue-flow labels sync` / `labels check` 当前只校验 provider label 元数据是否缺失或 drift，不校验某个 issue 实例上是否有多枚同 prefix label。
  - `issue-flow issue apply` 只移除调用方指定 prefix 的旧 label；新增 `size::` 后，`--size size::M` 应只触碰 `size::`，不影响 type/status/flow/automation/priority。
  - `create-issue.cjs` 禁止把 managed label 放进 `--label`，因此 `size::` 也应通过 `--size` 传入。
  - `dispatch auto` 对 labeled 事件有路由白名单，目前 `size::` 不应单独触发 plan/build；补 size 后是否继续执行应由原 plan/build action 或显式 resume 负责。
- 既有约束：
  - agent-facing provider 操作必须继续通过统一 `issue-flow` CLI / `cli.cjs`。
  - 统一 CLI 成功时 stdout 输出单个 JSON 文档。
  - PR body 文件必须放在 repo 外临时文件，不提交到 git。
  - 旧脚本仍作为兼容入口和内部实现保留，新增能力不能破坏现有工作流和测试。

## 方案

1. 新增 `size::` managed label group。
   - 在 `skills/issue-flow/scripts/labels.cjs` 增加 issue-scoped group：
     - `size::XS`，权重 `0.5`，用于文案/配置/单点小改。
     - `size::S`，权重 `1`，用于局部低风险改动。
     - `size::M`，权重 `2`，默认值，用于常规单 issue 工作。
     - `size::L`，权重 `3`，用于跨模块或高回归面工作。
     - `size::XL`，权重 `5`，用于大范围、架构性或需要拆分评估的工作。
   - label description 写入权重，例如 `Size M; throughput weight 2`，让 GitHub/GitLab label 页面可直接读出含义。
   - 颜色选择使用一组可区分但不过度强调的 issue label 颜色；GitLab 仍由 provider adapter 负责 `#` 前缀规范化。
   - 因 `sync-labels.cjs` 使用 catalog 派生 definitions，新增 group 后 `issue-flow labels sync` 自动创建/更新五个 size label，`labels check` 自动检查缺失和 drift。

2. 让 `issue apply/create` 接受 `--size`。
   - `apply.cjs` 和 `create-issue.cjs` 的核心校验已从 `labelGroupsForScope('issue')` 派生；新增 group 后补齐 usage/help、CLI 文档和测试即可把 `--size size::M` 作为一等 managed label 参数。
   - `collectDesiredLabels()` 应拒绝非法值，例如 `size::XXL`，错误信息列出合法 size labels。
   - `computeLabelChanges()` 应覆盖 size 互斥：当前 labels 中已有 `size::S` 时，执行 `issue-flow issue apply --issue 123 --size size::M` 会添加 `size::M` 并移除 `size::S`。
   - `collectCreateLabels()` 应拒绝 `--label size::M`，提示改用 `--size size::M`；创建 issue 时允许同时带 `--size` 与其他 managed labels。

3. 抽出 issue label 单值校验能力。
   - 在 `labels.cjs` 或新建小模块中提供纯函数，例如：
     - `labelsWithPrefix(labels, prefix)`
     - `findSingleManagedLabel(labels, prefix)`
     - `validateIssueManagedLabels(labels, { singlePrefixes })`
     - `resolveIssueSizeLabel(labels)`
   - `resolveIssueSizeLabel()` 返回三态结果：
     - `{ ok: true, label: 'size::M', weight: 2 }`
     - `{ ok: false, reason: 'missing_size_label' }`
     - `{ ok: false, reason: 'multiple_size_labels', labels: [...] }`
   - `resolve.cjs` 复用该 helper，避免继续把 `status::`、`flow::` 和 `size::` 的单值规则散落在不同函数中。
   - 保留 `findSingleLabel()` 的兼容导出或用新 helper 包装它，降低测试和外部 require 的破坏面。

4. 在 plan/build 前增加 size gate。
   - 在 `resolveAutomationDecision()` 和 `resolveResumeDecision()` 完成 `flow::` 到 action 的解析后，如果 action 是 `plan` 或 `build`，执行 size 校验。
   - 多个 size label：
     - 决策返回 `shouldRun: false`、`reason: 'multiple_size_labels'`、`sizeLabels: [...]`、`action`、`flowLabel`。
     - `dispatch.cjs` 不启动 runtime，不创建 plan/build task。
     - `dispatch.cjs` 尝试创建 issue comment，说明发现多个 `size::` label，要求保留一个后重新触发；为避免重复噪音，使用稳定隐藏 marker 去重。
     - `dispatch.cjs` 将 issue 转到 `flow::clarify`，让冲突进入人工修正 gate；若已经是 `flow::clarify`，只返回阻断原因，不重复写入相同评论。
   - 缺少 size label：
     - 决策允许启动原 action，但在返回值中附带 `sizeLabel: undefined`、`sizeRequired: true`、`sizeReason: 'missing_size_label'`。
     - 这样已处于 `flow::plan` / `flow::build` 的历史 issue 不会永久卡死，而是由 agent 在开始实际 plan/build 前先补 size。
   - 已有单一 size label：
     - 决策返回 `sizeLabel` 和 `sizeWeight`，dispatch 将这些字段传入 runtime data，供 prompt 自检和日志使用。

5. 让 agent 在缺失 size 时自动补标。
   - 更新 `plan-impl.prompt.md`、`plan-bug.prompt.md` 和 `build.prompt.md`：
     - 在产出方案或改代码前，先检查 issue labels 中是否有单一 `size::`。
     - 缺失时读取 issue 标题、正文和评论，选择 `size::XS/S/M/L/XL`，然后调用：
       ```bash
       node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs issue apply --issue <n> --size size::<value>
       ```
     - 无法可靠判断时默认 `size::M`，再用 `issue-flow issue comments create --body-file <tmp>` 留下低置信度说明，例如“默认标记为 size::M；依据不足，review 时可调整”。
     - 如果看到多个 `size::` label，停止 plan/build，不提交 PR/MR，并要求人工修正为一个。
   - 更新 `triage.prompt.md` 和 `general.prompt.md`：
     - 当 agent 准备把 issue 推进到 `flow::plan` 或 `flow::build` 时，应同时补上 `--size`。
     - 如果 triage 阶段无法判断 size，则默认 `size::M` 并留下低置信度说明，而不是先把 issue 推进到 plan/build 后再缺 size。
   - 更新 `skills/issue-flow/SKILL.md` 和安装资产，明确 `--size` 是 issue managed label 参数，不能放进 unmanaged `--label`。

6. 调整 dispatch 事件入场和评论行为。
   - `shouldRunAutoForEvent()` 不把 `size::` labeled 事件加入路由白名单，避免“只补 size”触发新的 plan/build 任务；原 plan/build agent 补标后继续完成当前任务。
   - 如果后续需要人工补 size 后继续执行，用户可以通过现有 comment resume 或重新设置 `flow::plan/build` 触发。
   - `dispatch.cjs` 的 size conflict comment 使用 repo-external 临时 body 或 provider port 直接写入，但 agent-facing 操作仍保持通过统一 CLI。
   - task lock comment 的创建应发生在 size gate 通过之后；多个 size 时不应留下 plan/build task lock。

7. 文档说明 size 语义和 Weighted Throughput。
   - `skills/issue-flow/references/labels.md` 增加 `size::` 小节和互斥规则：
     - 每个 issue 最多一个 `size::`。
     - `flow::plan` / `flow::build` 执行前必须有且仅有一个。
     - `size::M` 是无法判断时的默认值，不代表“精确估算”。
   - `README.md` 和 `docs/state-machine.md` 增加 plan/build 前置 size gate：
     - triage 或 create issue 可直接带 `--size`。
     - 缺失 size 的 plan/build agent 会先补标。
     - 多个 size 会进入人工修正 gate。
   - `docs/provider-api.md` 更新 CLI 参考：
     - `issue-flow issue apply --issue 123 --size size::M`
     - `issue-flow issue create ... --size size::S`
     - label sync/check 会覆盖 size label definitions。
   - Weighted Throughput 计算写成最小定义：
     - 对给定时间窗口内完成的 issue，按其唯一 `size::` label 映射权重并求和。
     - 建议完成口径为 `status::done` 或 merge build PR 后被 `pr merged` 转为 done 的 source issue。
     - 没有 size 或多个 size 的 issue 不应进入统计；本次 gate 的目的就是让新执行流避免继续产生这类数据。

8. 测试覆盖。
   - 扩展 `test/labels.test.cjs`：
     - `labelsForScope('issue')` 包含五个 `size::` labels。
     - 每个 size label 有合法颜色和非空 description。
     - `collectDesiredLabels({ size: 'size::M' })` 通过，非法 size 抛错。
     - `computeLabelChanges(['size::S'], { size: 'size::M' })` 只替换 size prefix。
   - 扩展 `test/create-issue.test.cjs`：
     - `--size size::S` 会进入创建 labels。
     - `--label size::S` 被拒绝并提示使用 `--size`。
   - 扩展 `test/sync-labels.test.cjs`：
     - dry-run/check definitions 覆盖 size labels。
   - 扩展 `test/resolve.test.cjs`：
     - plan/build + 单一 size 正常返回 `shouldRun: true`。
     - plan/build + 缺失 size 返回 `shouldRun: true` 且 `sizeRequired: true`。
     - plan/build + 多个 size 返回 `shouldRun: false` 和 `multiple_size_labels`。
     - triage 不要求 size。
     - `size::` labeled event 不触发 auto route。
   - 扩展 `test/dispatch.test.cjs`：
     - 多个 size 时不调用 runtime.run，并返回阻断原因。
     - 缺失 size 时 runtime data 包含 `sizeRequired`，prompt 可据此补标。
     - task lock 在 size conflict 时不会创建 plan/build lock。
   - 扩展 `test/agentrix-runtime.test.cjs`：
     - plan/build prompt 包含 size preflight 和默认 `size::M` 低置信度说明要求。
     - issue prompt context 中 `size::` label 不被过滤。
   - 回归 `npm test`。

## 验证方案

- 自动验证：
  - `npm test`
  - `node skills/issue-flow/cli.cjs labels sync --dry-run`，确认输出包含五个 `size::` labels。
  - `node skills/issue-flow/cli.cjs issue apply --issue 23 --size size::M --dry-run --provider github --repo nil4u/issue-flow`，确认只计划添加 `size::M`。
- 手动验证：
  - 在测试 issue 上移除 size 后触发 plan，确认 agent 先补一个 size label，再产出 plan PR。
  - 在测试 issue 上手动添加两个 `size::` labels 后触发 plan/build，确认不会创建 plan/build PR/MR，并提示人工保留一个 size label。
  - 在 label sync 有权限的仓库运行 `issue-flow labels check`，确认 size labels 不缺失、不 drift。
- 回归范围：
  - label catalog 与 provider label sync/check。
  - issue create/apply 的 managed label 参数校验。
  - auto/resume routing 的 plan/build 决策。
  - Agentrix triage/plan/build prompt 的执行顺序。
  - PR/MR submit、merge 后状态流转和已有 automation 语义。
