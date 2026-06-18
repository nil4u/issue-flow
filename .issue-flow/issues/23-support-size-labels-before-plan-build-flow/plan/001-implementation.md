## 目标

- 在 issue-flow 中新增 issue-scoped managed label 组 `size::`，支持 `size::XS`、`size::S`、`size::M`、`size::L`、`size::XL`，权重分别为 `0.5 / 1 / 2 / 3 / 5`。
- 在 issue 进入 `flow::plan` 或 `flow::build` 的脚本入口处，要求最终 labels 有且仅有一个 `size::` label；不满足时直接报错，提示 agent 设置或修正 size。
- 在创建 issue 时，如果请求中包含 `flow::plan` 或 `flow::build`，必须同时传入 `--size size::<value>`；不满足时直接报错。
- 在提交 plan/build PR/MR 前，再次读取 source issue 并校验唯一 `size::`；不满足时不 push、不创建或更新 PR/MR、不推进 `flow::approve`。
- 更新文档，说明 size 标签语义、默认选择策略和 Weighted Throughput 的计算方式。

## 非目标

- 不在本次实现中提供吞吐量报表、仪表盘、时间窗口查询或 provider milestone/project 统计。
- 不追溯修复历史 issue 的 size label；历史数据回填可在后续单独处理。
- 不改变 `type::`、`status::`、`flow::`、`automation::`、`priority::` 和 `mr-by::` 的既有语义。
- 不要求脚本层估算 size；脚本层只做确定性校验和错误提示，size 估算由 agent 根据 issue 标题、正文、评论和仓库上下文完成。

## 当前上下文

- 相关模块：
  - `skills/issue-flow/scripts/labels.cjs` 集中维护 managed label catalog，`sync-labels.cjs` 通过 `labelsForScope('all')` 同步 provider labels。
  - `skills/issue-flow/scripts/apply.cjs` 和 `create-issue.cjs` 都从 `labelGroupsForScope('issue')` 派生可接受的 issue managed label 参数；新增 issue group 后可自然支持 `--size size::M`，但 help、测试和文档需要显式补齐。
  - `skills/issue-flow/scripts/resolve.cjs` 目前用 `findSingleLabel()` 校验 `status::` 和 `flow::` 单值，并将 `flow::plan` / `flow::build` 解析为可执行 action；size 校验应优先落在 agent-facing 写入/提交脚本入口，避免把错误推迟到 runtime。
  - `skills/issue-flow/scripts/dispatch.cjs` 是 CI/runtime 调度入口，不作为 agent 补 size 的主交互界面；自动路由可复用 size helper 做防线，但不在 `dispatch plan/build` direct path 里承担 agent-facing 校验职责。
  - `skills/issue-flow/scripts/runtimes/agentrix.cjs` 会把 issue labels 注入 prompt，当前只过滤 `status::`、`flow::`、`automation::`，因此 `size::` label 会出现在 agent 可见上下文中。
  - `skills/issue-flow/assets/agentrix/runtime/prompts/triage.prompt.md` 已要求 triage 在 `flow::plan` 与 `flow::build` 之间做判断；triage/general prompt 需要指导 agent 在设置 plan/build flow 时同步设置 size，plan/build prompt 需要指导 agent 在 submit 报错后补 size 再重试。
  - `skills/issue-flow/references/labels.md`、`docs/state-machine.md`、`docs/provider-api.md` 和 `README.md` 是 label 语义、状态机和 CLI 行为的主要文档位置。
  - `.agentrix/plugins/issue-flow/skills/issue-flow/SKILL.md` 是当前 project-level agent 指令来源；安装资产中的 skill/prompt/template 也需要同步。
- 相关接口 / 数据 / 状态：
  - managed label 同 prefix 互斥；`apply.cjs` 在显式设置某个 prefix 时会移除该 prefix 下的旧 label。
  - `issue-flow labels sync` / `labels check` 当前只校验 provider label 元数据是否缺失或 drift，不校验某个 issue 实例上是否有多枚同 prefix label。
  - `issue-flow issue apply` 只移除调用方指定 prefix 的旧 label；新增 `size::` 后，`--size size::M` 应只触碰 `size::`，不影响 type/status/flow/automation/priority。
  - `create-issue.cjs` 禁止把 managed label 放进 `--label`，因此 `size::` 也应通过 `--size` 传入。
  - `dispatch auto` 对 labeled 事件有路由白名单，`size::` 不应单独触发 plan/build；补 size 后是否继续执行应由原 action 重试、comment resume 或重新设置 flow 负责。
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

2. 让 `issue apply/create` 接受 `--size`，并提供共享 size 校验 helper。
   - `apply.cjs` 和 `create-issue.cjs` 的核心校验已从 `labelGroupsForScope('issue')` 派生；新增 group 后补齐 usage/help、CLI 文档和测试即可把 `--size size::M` 作为一等 managed label 参数。
   - `collectDesiredLabels()` 应拒绝非法值，例如 `size::XXL`，错误信息列出合法 size labels。
   - `computeLabelChanges()` 应覆盖 size 互斥：当前 labels 中已有 `size::S` 时，执行 `issue-flow issue apply --issue 123 --size size::M` 会添加 `size::M` 并移除 `size::S`。
   - `collectCreateLabels()` 应拒绝 `--label size::M`，提示改用 `--size size::M`；创建 issue 时允许同时带 `--size` 与其他 managed labels。
   - 在 `labels.cjs` 或新建小模块中提供纯函数，供 `apply.cjs`、`create-issue.cjs`、`submit.cjs` 和 `resolve.cjs` 复用：
     - `labelsWithPrefix(labels, prefix)`
     - `findSingleManagedLabel(labels, prefix)`
     - `resolveIssueSizeLabel(labels)`
     - `requireSingleIssueSize(labels, context)`
   - `resolveIssueSizeLabel()` 返回三态结果：
     - `{ ok: true, label: 'size::M', weight: 2 }`
     - `{ ok: false, code: 'missing_size_label', reason: 'This issue needs exactly one size:: label before it can enter flow::plan or flow::build.' }`
     - `{ ok: false, code: 'multiple_size_labels', reason: 'This issue has more than one size:: label; choose one size label before continuing.', labels: [...] }`
   - `reason` 必须是自然语言句子，面向 agent 直接阅读；`code` 才能使用 `missing_size_label` / `multiple_size_labels` 这类稳定短标识。
   - `requireSingleIssueSize()` 用于脚本错误提示：
     - 缺失时抛错：`This issue needs exactly one size:: label before it can enter flow::plan or flow::build. Choose size::XS, size::S, size::M, size::L, or size::XL and pass --size size::<value>. If you are unsure, use size::M and leave a low-confidence note.`
     - 多个时抛错：`This issue has more than one size:: label: size::S, size::M. Choose one size and re-run with --size size::<value>; issue-flow will replace the conflicting size labels.`
   - 保留 `findSingleLabel()` 的兼容导出或用新 helper 包装它，降低测试和外部 require 的破坏面。

3. 在 `issue apply` 中校验设置 `flow::plan/build` 时的最终 size。
   - `apply.cjs` 在读取当前 issue labels 后，先用现有 `computeLabelChanges()` 计算将要添加/移除的 labels，再构造 `nextLabels`。
   - 如果本次调用设置了 `--flow flow::plan` 或 `--flow flow::build`，对 `nextLabels` 执行 `requireSingleIssueSize()`。
   - 有以下行为：
     - `issue-flow issue apply --issue 123 --flow flow::plan --size size::M` 通过。
     - 当前 issue 已有唯一 `size::S`，执行 `--flow flow::build` 通过。
     - 当前 issue 没有 size，执行 `--flow flow::plan` 报错，不写 provider。
     - 当前 issue 有多个 size，执行 `--flow flow::build` 报错，提示用 `--size` 修正为一个。
   - 校验发生在 `provider.applyLabels()` 之前；失败时不修改任何 label，也不更新 issue body。
   - `--flow flow::triage/clarify/approve` 不强制 size，避免 clarify/approve 这类 gate 被 size 校验卡住。
   - `--clear-flow` 不触发 size 校验。

4. 在 `issue create` 中校验设置 `flow::plan/build` 时必须同时设置 size。
   - `create-issue.cjs` 在 provider create 前检查请求 labels。
   - 如果 `--flow flow::plan` 或 `--flow flow::build` 存在，则必须有且仅有一个 `size::`，并且 managed size 必须通过 `--size` 传入。
   - 缺失时直接报错，不创建 issue：
     ```text
     Creating an issue with flow::plan/build requires --size size::<value>. Choose size::XS/S/M/L/XL; if unsure, use size::M and mention low confidence in the body or a follow-up comment.
     ```
   - `--flow flow::triage/clarify/approve` 不强制 size。
   - `--label size::M` 继续被拒绝，避免绕过 managed label 校验。

5. 在 `pr submit plan/build` 中校验 source issue 已有唯一 size。
   - `submit.cjs` 在 clean worktree、head/base 校验之后，push 分支和创建/更新 PR/MR 之前，读取 source issue 当前 labels。
   - 对 source issue 执行 `requireSingleIssueSize()`；失败时直接退出：
     - 不 push 分支。
     - 不创建或更新 PR/MR。
     - 不把 source issue 转到 `flow::approve`。
   - 缺失 size 的错误提示应给出下一步命令模板：
     ```bash
     issue-flow issue apply --issue 123 --size size::M
     ```
     并说明 agent 应基于 issue 标题、正文、评论选择具体 size；无法判断时使用 `size::M` 并留下低置信度说明。
   - 多个 size 的错误提示应列出现有冲突 labels，并提示用同一个命令选择一个 size；`apply.cjs` 的 prefix 替换会移除其它 `size::` labels。
   - `--dry-run` 也输出该校验意图；如果 dry-run 下没有 provider 读取能力，可返回 planned check，而不是假装通过。

6. 调整自动路由防线和 prompt，让 agent-facing 错误提示驱动 agent 补 size。
   - `resolveAutomationDecision()` / `resolveResumeDecision()` 可复用 size helper 作为 auto/comment resume 的防线：plan/build + 多个 size 返回 `code: 'multiple_size_labels'` 和自然语言 `reason`，避免启动明显错误的 runtime。
   - 不在 `dispatch.cjs startAction()` 增加 agent-facing size 校验：
     - `dispatch` 是 CI/runtime 调度入口，不是 agent 选择 size 的主要交互面。
     - 真正需要提示 agent 的入口是 `issue apply`、`issue create` 和 `pr submit`。
     - direct `issue-flow dispatch plan/build` 若被内部流程或人工直接调用，仍会在最终 `pr submit plan/build` 前被 source issue size 校验兜住，不会产出未带 size 的 plan/build PR/MR。
   - plan/build + 缺失 size 不在 dispatch 中自动补标；预期路径是：
     - triage/general 在调用 `issue apply --flow flow::plan/build` 时收到错误，补 `--size` 后重试。
     - plan/build 在调用 `pr submit plan/build` 时收到错误，先调用 `issue apply --size ...`，必要时创建低置信度说明评论，再重试 submit。
   - `shouldRunAutoForEvent()` 不把 `size::` labeled 事件加入路由白名单，避免单独补 size 触发新的重复任务。
   - 更新 `triage.prompt.md`、`general.prompt.md`、`plan-impl.prompt.md`、`plan-bug.prompt.md` 和 `build.prompt.md`：
     - 设置 `flow::plan/build` 时要在同一条 `issue apply` 命令中设置 `--size`，或确认 issue 已有唯一 size。
     - `issue apply/create/pr submit` 因缺失 size 失败时，agent 应根据 issue 标题、正文、评论选择 size 后重试。
     - 无法判断时默认 `size::M`，并用 `issue-flow issue comments create --issue <n> --body-file <tmp>` 留下低置信度说明；`--issue` 必须显式传入 source issue number。
     - 多个 size 失败时，agent 应选择一个 size 并用 `issue apply --size ...` 统一修正后重试。
   - 更新 `skills/issue-flow/SKILL.md` 和安装资产，明确 `--size` 是 issue managed label 参数，不能放进 unmanaged `--label`。

7. 文档说明 size 语义和 Weighted Throughput。
   - `skills/issue-flow/references/labels.md` 增加 `size::` 小节和互斥规则：
     - 每个 issue 最多一个 `size::`。
     - `flow::plan` / `flow::build` 执行前必须有且仅有一个。
     - `size::M` 是无法判断时的默认值，不代表“精确估算”。
   - `README.md` 和 `docs/state-machine.md` 增加 plan/build 前置 size gate：
     - triage/general 设置 `flow::plan/build` 时必须让最终 issue labels 包含唯一 `size::`。
     - create issue 设置 `flow::plan/build` 时必须在同一次请求中传 `--size`。
     - submit plan/build PR/MR 前会再次校验 source issue 唯一 size；缺失或多个 size 都通过错误提示要求 agent 修正后重试。
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
     - `--flow flow::plan/build` 缺少 `--size` 时抛错，且不调用 provider create。
   - 扩展 `test/submit.test.cjs`：
     - source issue 缺少 size 时，`pr submit plan/build` 在 push 前失败并给出 `issue apply --size` 提示。
     - source issue 有多个 size 时，`pr submit plan/build` 在 push 前失败并列出冲突 labels。
     - source issue 有唯一 size 时，保持现有 PR/MR submit 行为。
   - 扩展 `test/sync-labels.test.cjs`：
     - dry-run/check definitions 覆盖 size labels。
   - 扩展 `test/resolve.test.cjs`：
     - plan/build + 单一 size 正常返回 `shouldRun: true`。
     - plan/build + 多个 size 返回 `shouldRun: false`、`code: 'multiple_size_labels'` 和自然语言 `reason`，作为 submit/apply/create 之外的防线。
     - size 相关 `reason` 不使用 `missing_size_label` / `multiple_size_labels` 这类简写。
     - triage 不要求 size。
     - `size::` labeled event 不触发 auto route。
   - 扩展 `test/dispatch.test.cjs`：
     - auto/comment resume 通过 resolver 发现多个 size 时不调用 runtime.run，并返回自然语言 reason 和冲突 labels。
     - direct `dispatch plan/build` 不作为 agent-facing size 校验入口；相关行为由 `pr submit plan/build` 的 source issue size 校验兜底。
     - 缺失 size 不由 dispatch 自动补标；`issue apply/create/pr submit` 的错误提示负责驱动 agent 修正。
   - 扩展 `test/agentrix-runtime.test.cjs`：
     - triage/general prompt 要求设置 `flow::plan/build` 时同步设置或确认唯一 size。
     - plan/build prompt 要求 submit 因 size 失败时先补 size，再重试 submit。
     - 低置信度说明的示例命令必须包含 `issue comments create --issue <n> --body-file <tmp>`。
     - issue prompt context 中 `size::` label 不被过滤。
   - 回归 `npm test`。

## 验证方案

- 自动验证：
  - `npm test`
  - `node skills/issue-flow/cli.cjs labels sync --dry-run`，确认输出包含五个 `size::` labels。
  - `node skills/issue-flow/cli.cjs issue apply --issue 23 --flow flow::plan --dry-run --provider github --repo nil4u/issue-flow`，在无 size 的测试 issue 上确认报错提示需要 `--size`。
  - `node skills/issue-flow/cli.cjs issue create --title ... --body-file <tmp> --flow flow::plan --dry-run`，确认缺少 `--size` 时不创建 issue。
  - `node skills/issue-flow/cli.cjs pr submit plan --issue 23 --body-file <tmp> --dry-run`，在 source issue 缺少或有多个 size 时确认不 push、不提交 PR，并提示先修正 size。
- 手动验证：
  - 在测试 issue 上移除 size 后执行 `issue apply --flow flow::plan`，确认脚本直接失败并提示添加 `--size`。
  - 在测试 issue 上手动添加两个 `size::` labels 后执行 `pr submit plan/build`，确认不会 push 或创建 PR/MR，并提示选择一个 size。
  - 在 label sync 有权限的仓库运行 `issue-flow labels check`，确认 size labels 不缺失、不 drift。
- 回归范围：
  - label catalog 与 provider label sync/check。
  - issue create/apply 的 managed label 参数校验。
  - auto/resume routing 的 plan/build 决策。
  - Agentrix triage/plan/build prompt 的执行顺序。
  - PR/MR submit、merge 后状态流转和已有 automation 语义。
