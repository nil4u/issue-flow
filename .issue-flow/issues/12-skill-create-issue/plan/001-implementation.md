## 目标

- 为 issue-flow 增加一个确定性的“创建标准化 issue”能力，让 AI 在和用户讨论清楚需求后，可以把整理后的 issue title、body 和可确定的 managed labels 一次性提交到 GitHub/GitLab。
- 创建时支持设置 `type::`、`status::`、`flow::`、`priority::`、`automation::` 等 issue managed labels，并在信息充分时允许新 issue 直接进入 `flow::plan` 或 `flow::build`，避免重复 intake/triage。
- 将该能力暴露给项目级 `issue-flow` skill，使 agent 在开放讨论后能按仓库模板整理正文、校验标签、创建 issue，并向用户返回 provider URL。
- 保持现有状态机和 `apply.cjs` / `submit.cjs` 语义不变：已存在 issue 的 label/body 更新仍走 `apply.cjs`，plan/build PR/MR 仍走 `submit.cjs`。

## 非目标

- 不新增新的 managed label prefix 或 label 值。
- 不改变 `intake.cjs` 的默认行为；它仍只在新 issue 缺少 `status::` 或 `flow::` 时补 `status::active` / `flow::triage`。
- 不引入自由格式的自动分类模型到脚本层；脚本只做确定性校验和 provider 写入，是否标某个 label 由 agent 根据上下文判断。
- 不把“创建 issue”并入 `apply.cjs`。`apply.cjs` 继续只处理已有 issue。
- 不要求 provider labels 自动存在；若远端缺 label，创建应暴露 provider 错误，继续依赖已有 `sync-labels.cjs` 负责 label 同步。

## 当前上下文

- 相关模块：
  - `skills/issue-flow/SKILL.md` 定义了 label 体系和 `apply.cjs`、`submit.cjs`、`sync-labels.cjs` 的写操作约束，目前没有创建 issue 的操作说明。
  - `skills/issue-flow/scripts/apply.cjs` 能更新已有 issue 的 managed labels 和 body，并从 `labels.cjs` 派生 issue label 合法值。
  - `skills/issue-flow/scripts/intake.cjs` 会在新 issue 缺少 `status::` / `flow::` 时添加默认 label；如果创建时已经带上这两个 prefix，intake 不会覆盖。
  - `skills/issue-flow/scripts/providers.cjs` 已封装 GitHub/GitLab repo 解析、token/CLI fallback、issue comment、issue label 更新、PR/MR 创建更新，但目前没有 `createIssue` provider 方法。
  - `skills/issue-flow/scripts/labels.cjs` 已集中维护 issue 和 PR/MR managed label catalog，可复用来校验 create issue 的 label 参数。
  - `skills/issue-flow/assets/agentrix/runtime/templates/type-feature.md`、`type-debt.md`、`type-ops.md` 等模板已存在，可作为 agent 生成标准化 issue body 的格式来源。
  - `.issue-flow/prompts/general.prompt.md` 和默认 runtime prompt 目前只说明开放指令处理，没有指导 agent 在需求已成形时创建 issue。
- 相关接口 / 数据 / 状态：
  - Issue managed labels：`type::*`、`status::*`、`flow::*`、`automation::*`、`priority::*`，同 prefix 互斥。
  - GitHub 创建 issue API 支持 `title`、`body`、`labels`。
  - GitLab 创建 issue API 支持 `title`、`description`、`labels`，labels 以逗号分隔或等价 API 字段提交。
  - 自动流转依赖 `status::active`、`flow::*` 和 `automation::*`：新 issue 若创建为 `flow::plan` 且自动化级别允许，自动任务可直接进入 plan；若创建为 `flow::build` 且允许，则可直接实现。
- 既有约束：
  - Provider 写操作必须通过确定性脚本完成，而不是让 agent 自行调用 `gh issue create` 或 provider API。
  - Managed label 同一 prefix 只能有一个值；创建脚本应在提交前拒绝同 prefix 冲突。
  - `automation::` label 只能提升自动化上限，不确定时不标，沿用仓库默认。
  - GitHub/GitLab 的新 issue 事件可能触发 intake；为了避免 race，脚本应尽量在创建请求中同时传入 `status::` 和 `flow::`，创建后补标只作为 provider 不支持或兼容路径。

## 方案

1. 新增 `create-issue.cjs` CLI。
   - 文件：`skills/issue-flow/scripts/create-issue.cjs`。
   - 推荐用法：
     ```bash
     node create-issue.cjs \
       --title "Add create issue support to issue-flow" \
       --body-file /tmp/issue-body.md \
       --type type::feature \
       --status status::active \
       --flow flow::plan \
       --priority priority::p2 \
       --automation automation::build
     ```
   - 参数：
     - `--title <text>` 必填。
     - `--body-file <path>` 必填，要求是 repo 外临时文件或至少不要求纳入 git；issue 正文由 agent 按模板写入该文件。
     - `--type`、`--status`、`--flow`、`--priority`、`--automation` 使用与 `apply.cjs` 一致的合法 label 值。
     - `--label <name>` 可选，允许传入非 managed label；managed label 仍必须走上面的 prefix 参数，以便校验互斥。
     - `--provider`、`--repo`、`--dry-run` 与现有脚本保持一致。
   - 输出稳定 JSON，至少包含 `provider`、`repo`、`issueNumber`、`issueUrl`、`labels`、`dryRun`。

2. 复用 managed label catalog 做创建前校验。
   - 从 `labels.cjs` 读取 issue-scoped groups，抽出与 `apply.cjs` 相同的 `collectDesiredLabels` 风格校验逻辑；实现时可在 `labels.cjs` 新增小型 helper，或在 `create-issue.cjs` 内部复用同一数据源。
   - 拒绝以下输入：
     - 非法 managed label 值，例如 `flow::review`、`automation::off`。
     - 同一 prefix 多值，例如同时通过 `--flow flow::plan` 和 `--label flow::build`。
     - `mr-by::*`，因为它只用于 PR/MR。
   - 默认策略：
     - 不自动猜测 `type::`、`priority::`、`automation::`。
     - 如果用户/agent 已判断下一步 flow，建议同时传 `--status status::active` 和对应 `--flow`，让 intake 不覆盖。
     - 如果 agent 只能创建待整理需求，则传 `status::active` + `flow::triage`。

3. 在 provider 层新增 issue 创建能力。
   - 在 `providers.cjs` 为 GitHub/GitLab provider 增加统一方法：
     ```js
     createIssue({ repo, title, body, labels, options })
     ```
   - GitHub：
     - 有 `GITHUB_TOKEN` / `GH_TOKEN` 时调用 `POST /repos/{owner}/{repo}/issues`。
     - 无 token 时 fallback 到 `gh api` 或 `gh issue create`；优先使用 `gh api` 以保持 body/labels 参数语义接近 REST API。
     - 返回规范化对象：`number`、`title`、`body`、`htmlUrl`、`labels`。
   - GitLab：
     - 有 `GITLAB_TOKEN` / `GL_TOKEN` / `GITLAB_PRIVATE_TOKEN` / `CI_JOB_TOKEN` 时调用 `POST /projects/{project}/issues`。
     - 无 token 时走现有 `glab api` fallback。
     - 返回规范化对象：`number` 使用 issue `iid`，`htmlUrl` 使用 `web_url`。
   - `--dry-run` 不调用 provider，只打印将创建的 repo、title、body 摘要和 labels。

4. 处理创建时打标与创建后补标。
   - 首选在 create issue API 请求中带 `labels`，这是避免 intake race 的主要路径。
   - 如果某 provider fallback 只能先创建再加 label，脚本应在创建成功后立即复用 provider 的 issue label 更新能力补齐 labels，并在输出里标明 `labelsAppliedAfterCreate: true`。
   - 对正常 GitHub/GitLab REST API 路径，不需要创建后再调用 `apply.cjs`，避免二次读取和重复写入。
   - 如果 provider 因 label 不存在或权限不足拒绝创建，应直接失败，不创建一个无标签 issue 后继续静默成功；否则会违背“避免默认 intake/triage”的目标。

5. 更新 skill 和 Agentrix runtime 说明。
   - 在 `skills/issue-flow/SKILL.md` 增加 “create-issue.cjs - 创建标准化 issue” 小节，列出用法、label 规则、body file 规则和适用场景。
   - 更新 `skills/issue-flow/assets/agentrix/runtime/prompts/general.prompt.md`：
     - 当用户在开放讨论后要求“创建 issue”或需求已经足够明确时，agent 应先按 `.issue-flow/templates/type-*.md` 整理正文，再调用 `create-issue.cjs`。
     - 缺少仓库无法推断的关键事实时，直接提问；不先创建模糊 issue。
     - 能判断的 managed labels 应直接设置；若实现路径已清楚可用 `flow::build`，需要方案则用 `flow::plan`，仍需分类则用 `flow::triage`。
   - 同步更新安装资产下对应 skill、prompt、template 文档，确保 `install.sh` 后目标仓库获得新能力。

6. 明确用户交互路径。
   - 讨论阶段：
     - 用户描述未成形需求，agent 继续追问或给选项。
     - 当目标、用户故事、边界和下一步 flow 足够清楚时，agent 生成标准化 issue body。
   - 创建阶段：
     - Agent 根据需求类型选择 `type-feature.md` / `type-debt.md` / `type-ops.md` / `type-bug.md`。
     - Agent 写 repo 外临时 body 文件。
     - Agent 调用 `create-issue.cjs` 并传入可确定 managed labels。
   - 创建结果：
     - 对待规划 feature，创建为 `type::feature` + `status::active` + `flow::plan` + 合适 priority，可选 `automation::build`。
     - 对简单明确 feature，创建为 `type::feature` + `status::active` + `flow::build`。
     - 对仍需人工补充的需求，不创建或创建为 `flow::clarify` 需要谨慎；推荐在创建前先澄清，避免产生不可执行 issue。

7. 文档更新。
   - `README.md` 增加创建标准化 issue 的能力说明和最小示例。
   - `docs/provider-api.md` 增加 GitHub/GitLab create issue API 路径、token/CLI fallback、权限要求和失败策略。
   - `docs/state-machine.md` 增加从 AI discussion 创建 issue 的入口说明，强调创建时带 `status::active` + `flow::*` 可跳过默认 triage。
   - `skills/issue-flow/references/labels.md` 增加 create issue 场景下各 managed label 的推荐使用边界。

8. 测试覆盖。
   - 新增 `test/create-issue.test.cjs`：
     - 参数解析和必填项校验。
     - managed label 合法值校验、同 prefix 冲突校验、拒绝 `mr-by::*`。
     - dry-run 输出包含 title、labels、provider、repo，不调用 fetch/CLI。
   - 扩展 `test/providers.test.cjs`：
     - GitHub token 路径调用 `POST /issues`，body 使用 `body`，labels 使用数组。
     - GitHub 无 token fallback 调用 `gh api`。
     - GitLab token 路径调用 `POST /projects/:id/issues`，body 使用 `description`，labels 格式正确。
     - GitLab fallback 调用 `glab api`。
   - 扩展 `test/install.test.cjs` / `test/bootstrap.test.cjs`：
     - `create-issue.cjs`、更新后的 prompt 和 skill 文件会被安装。
   - 扩展 runtime/prompt 相关测试：
     - 确认 general prompt 或生成 prompt 中包含 create issue 能力提示。
   - 回归 `npm test`，确保现有 `apply`、`submit`、`dispatch`、`intake`、`sync-labels` 行为不变。

## 验证方案

- 自动验证：
  - 运行 `npm test`。
  - 重点检查新增 `test/create-issue.test.cjs`，以及 `test/providers.test.cjs`、`test/install.test.cjs`、`test/bootstrap.test.cjs`、`test/agentrix-runtime.test.cjs` 的新增断言。
- 手动验证：
  - GitHub dry-run：
    ```bash
    node skills/issue-flow/scripts/create-issue.cjs --provider github --repo owner/repo --title "Example" --body-file /tmp/body.md --type type::feature --status status::active --flow flow::plan --priority priority::p2 --dry-run
    ```
  - GitLab dry-run：
    ```bash
    node skills/issue-flow/scripts/create-issue.cjs --provider gitlab --repo group/project --title "Example" --body-file /tmp/body.md --type type::feature --status status::active --flow flow::build --priority priority::p2 --dry-run
    ```
  - 在测试仓库真实创建一个 `flow::plan` issue，确认 provider issue 页面已有 `status::active`、`flow::plan`、`type::feature`、`priority::p2`，且 intake 不把它改回 `flow::triage`。
  - 真实创建一个 `flow::build` + `automation::build` issue，确认自动化路由可以直接选择 build。
- 回归范围：
  - 新 issue intake 默认补标行为。
  - `apply.cjs` 对已有 issue 的 managed label 互斥更新。
  - `submit.cjs` plan/build PR/MR 创建、`mr-by::*` label、source issue 转 `flow::approve`。
  - GitHub/GitLab provider token 优先和 CLI fallback。
  - 安装资产同步和项目级 skill 可用性。
