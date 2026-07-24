## 目标

- 将 `type::docs` 加入 Issue Flow 的一等 issue 类型，使纯文档新增、修订、迁移和信息架构调整能够被准确创建、分类、规划、执行与统计。
- 保持现有生命周期不变：`type::docs` 继续使用 `flow::triage -> flow::plan/build -> flow::approve`，复用实现类 Markdown/Visual Plan 与 Build 流程，不增加新的 flow、审批模型或提交入口。
- 为文档工作提供专用 issue 正文模板，明确目标读者、文档范围、事实来源、验收方式和非目标；triage 能按该模板规范化正文。
- 让 plan/build agent 在处理 `type::docs` 时显式校验链接、示例、命令和事实来源，避免只验证文本格式而遗漏文档可执行性与时效性。
- Console 持久化并独立展示 `docs` 类型，在类型分布、堆叠顺序、颜色、tooltip 和 drill-down 中不再归入“未分类”。
- 更新 CLI/provider 文档、label reference、skill 指引和安装产物，使公开类型枚举统一为 `feature|bug|debt|ops|docs`。

## 非目标

- 不新增 `flow::docs`、独立 docs workflow、独立审批状态或专用 Plan/Build PR 类型。
- 不引入文档站点生成器、自动发布流水线、链接爬虫服务或内容质量评分系统。
- 不自动扫描或重标历史 `type::feature` / `type::debt` issue；已有 issue 仅在用户或 agent 显式执行 `issue apply --type type::docs` 时改变类型。
- 不改变 `type::bug` 的专用 plan prompt/template 路由，也不改变 feature、debt、ops 的既有语义。
- 不修改已有 Prisma migration；Console 面板配置通过新增 append-only migration 演进。

## 当前上下文

- 相关模块：
  - `plugin/skills/issue-flow/scripts/labels.cjs` 是 managed label catalog 的单一源；`labelGroupsForScope('issue')` 同时驱动 `issue create`、`issue apply` 的参数校验与同 prefix 替换，`labels sync/check` 从同一 catalog 生成 GitHub/GitLab 期望标签。
  - `plugin/skills/issue-flow/assets/agentrix/runtime/templates/` 保存安装源模板，bootstrap 将其复制到项目级 `.issue-flow/templates/`，并将完整 skill 安装到 `.agentrix/plugins/issue-flow/skills/issue-flow/`；`.issue-flow/install-manifest.json` 记录 managed/customizable 文件及 hash。
  - `plugin/skills/issue-flow/scripts/runtimes/agentrix.cjs` 仅将 `type::bug` 分流到 bug plan，其余类型统一进入 `plan-impl` / `plan-visual-impl`，build 则统一使用 `build.prompt.md`（CI failure 除外）。因此 docs 不需要新增 prompt 文件或分支，但需要在通用 prompts 中增加 docs-specific 指令并增加路由回归测试。
  - `.issue-flow/prompts/triage.prompt.md`、`plan-impl.prompt.md`、`plan-visual-impl.prompt.md` 和 `build.prompt.md` 是当前仓库安装后的可定制 prompts；实现应先更新插件源资产，再通过 bootstrap 同步这些安装副本，避免源资产与安装结果漂移。
  - `console/api/src/core/issue-projection.ts` 通过 `TYPE_VALUES` 白名单从 provider labels 投影 `issues.type`；当前仅接受 `feature/bug/debt/ops`，所以 `type::docs` 会被保存为空字符串并在指标中显示为“未分类”。
  - `console/api/prisma/migrations/20260708130000_issue_type_distribution/migration.sql` 的查询会把任意非空 `issues.type` 显示为 `type::<value>`，但面板 `visual_config.stackOrder` 只列出现有四类；`20260715150000_issue_distribution_drilldowns` 的 drill SQL 按动态 `issue_type` bucket 过滤，docs 被正确投影后无需改查询结构。
  - `console/web/src/lib/metrics-chart-options.ts` 和 `console/web/src/styles/metrics.css` 分别维护类型 bucket 的图表颜色和 drill drawer 色标；目前都缺少 `type::docs`。
  - 现有测试分别覆盖 label catalog/互斥、create/apply 参数、Agentrix prompt 路由、bootstrap 安装与 manifest、provider 集成、Console issue projection、SQL 指标和 Web 图表配置，可在这些既有套件中扩展，不需要创建新的测试框架。
- 相关接口 / 数据 / 状态：
  - CLI 对外接口新增合法值 `--type type::docs`；参数名、JSON 输出结构和 provider 调用协议保持不变。
  - `type::` 仍是 issue-scoped 互斥组。显式 apply docs 时只移除其他 `type::` 标签，保留 status/flow/automation/priority/size 与 unmanaged labels。
  - 新增 label 元数据建议使用名称 `type::docs`、颜色 `0075CA`、描述 `Issue tracks documentation or information architecture work`；sync/check 在 GitHub 和 GitLab 使用同一稳定定义。
  - 新增模板 `type-docs.md`，字段固定为“目标、目标读者、文档范围、事实来源、验收标准、非目标”；事实来源允许引用仓库代码、配置、命令输出、上游官方文档或现有产品行为。
  - `issues.type` 当前是字符串字段，无 enum/schema 约束，支持保存 `docs`，不需要数据库列迁移或历史回填。
  - 类型分布 query 与 drill query 已按字符串动态分组；数据层修复重点是投影白名单，展示层修复重点是 stack order 和颜色。建议将 `type::docs` 放在 `type::ops` 之后、“未分类”之前，并在 Console 使用独立琥珀色 `#ca8a04`。
- 既有约束：
  - provider 操作必须继续通过统一 `node .issue-flow/cli.cjs ...` / `issue-flow ...` 入口，不能为 docs 增加 provider-specific 分支。
  - 安装副本与 `.issue-flow/install-manifest.json` 应由 bootstrap 生成/刷新，不手工维护重复 hash；可定制文件若无本地冲突应更新，冲突行为沿用现有 bootstrap 规则。
  - Prisma migration 是 append-only 历史；不得编辑 `20260708130000_issue_type_distribution` 或其他已存在 migration。
  - docs issue 仍属于实现类工作；Plan 输出继续写 `plan/001-implementation.md`，Build PR/MR 仍使用 `mr-by::build`。

## 方案

1. 扩展 managed label catalog 和 CLI/provider 类型契约。
   - 在 `plugin/skills/issue-flow/scripts/labels.cjs` 的 `type` group 增加 `type::docs` 定义，保持与其他 `type::` label 同 scope、同互斥机制和稳定 metadata。
   - 依赖现有 `labelGroupsForScope('issue')` 让 `create-issue.cjs` 与 `apply.cjs` 自动接受 `--type type::docs`；不新增重复的类型白名单。
   - 验证 apply 从 feature/bug/debt/ops 切到 docs 时只替换 `type::` prefix，切回其他类型时同样移除 docs；`labels sync/check` 应同时在 GitHub/GitLab 发现、创建和校验该标签。
   - 更新 CLI help/示例中存在的封闭枚举，保持输出与错误信息自动列出五种合法类型。

2. 新增 docs issue 模板并同步安装资产。
   - 在 `plugin/skills/issue-flow/assets/agentrix/runtime/templates/type-docs.md` 新增模板，要求填写目标、目标读者、文档范围、事实来源、验收标准和非目标；验收应覆盖链接、示例、命令、导航和内容准确性。
   - 更新源资产 `templates/README.md`，加入 `type::docs -> type-docs.md`，并注明 docs 与 feature/debt/ops 一样复用 `plan-impl.md`。
   - 使用 bootstrap 同步 `.issue-flow/templates/type-docs.md`、项目级 README、`.agentrix/plugins/...` skill 副本以及 `.issue-flow/install-manifest.json`；安装测试校验新文件在 GitHub/GitLab target 中都被安装并纳入 manifest。

3. 更新 triage、plan、visual plan 和 build prompt 语义。
   - triage prompt 将 `docs` 纳入类型判断，并要求用 `type-docs.md` 规范化纯文档 issue；当 issue 同时包含产品行为改动与文档更新时，以主交付物决定 type，避免把附带文档的 feature 错分为 docs。
   - `plan-impl.prompt.md` 与 `plan-visual-impl.prompt.md` 增加 docs 重点：目标读者与入口、文档范围/信息架构、事实来源、链接/示例/命令验证、验收与非目标；保留 feature/debt/ops 原有分支说明。
   - `build.prompt.md` 增加条件指令：处理 `type::docs` 时，修改内容前从代码/配置/实际 CLI 行为或权威来源核对事实；完成后验证内部/外部链接、复制执行命令和示例、导航入口及术语一致性，并在 PR body 记录验证范围。
   - 不新增 `plan-docs.prompt.md` 或 `plan-docs.md`。在 `agentrix.cjs` 测试中明确证明普通和 Visual Plan 的 docs issue 都选择实现类 prompt/template，build 继续选择通用 build prompt，且 issue labels 上下文保留 `type::docs`。

4. 更新 skill、label reference、用户文档和 provider API。
   - 在 `plugin/skills/issue-flow/SKILL.md` 与 `references/labels.md` 增加 docs 定义、适用边界和五类型枚举；同步生成项目级 `.agentrix/plugins/...` 副本。
   - 更新 `plugin/docs/provider-api.md` 中 `issue create`、`issue apply` 的 `--type` 取值和 managed label 表，记录 GitHub/GitLab 都支持 docs。
   - 更新根 `README.md`、模板说明及所有面向用户/agent 的封闭类型枚举为 `feature|bug|debt|ops|docs`；保留 CI failure 默认 `type::ops` 的专用说明，不将流水线故障归为 docs。
   - 用全仓搜索检查仍表示完整枚举但遗漏 docs 的文本；历史 plan 文件和仅用于单一示例的 `type::feature` 不做机械替换。

5. 修复 Console issue 投影并保持数据兼容。
   - 在 `console/api/src/core/issue-projection.ts` 的 `TYPE_VALUES` 加入 `docs`，覆盖 GitHub webhook、GitLab webhook和 GitLab issue snapshot/backfill 共用的投影路径。
   - 不修改 Prisma schema：新事件和后续 provider refresh 可直接把 `docs` 写入既有字符串列；已有被错误投影为空的事件不做专项数据回填，后续收到 issue 更新或仓库同步时自然纠正。
   - 增加 projection/store 测试，证明 `type::docs` 保存为 `docs`，未知 `type::*` 仍为空，且 status/flow/priority/size/automation 不受影响。

6. 为 Console 类型分布、颜色和 drill-down 增加 docs bucket。
   - 新增 Prisma migration，仅更新 `dashpanel_issue_type_distribution.visual_config`：stack order 使用 `type::feature`、`type::bug`、`type::debt`、`type::ops`、`type::docs`、`未分类`，保留既有 field labels 与其他配置。
   - 不改既有类型分布和 drill SQL：投影保存 `docs` 后，现有 `else 'type::' || i.type` 与 `where issue_type = :bucket` 会自然产生并下钻 `type::docs`。
   - 在 `console/web/src/lib/metrics-chart-options.ts` 为 `type::docs` 增加 `#ca8a04`，确保堆叠图、legend、tooltip 和选择事件使用独立颜色；在 `console/web/src/styles/metrics.css` 为 drill drawer 的 `data-bucket="type::docs"` 增加相同色标。
   - 扩展 metrics SQL/API/Web 测试：docs 行独立计数与加权、stack order 位于未分类前、图表 series 使用 docs 颜色、点击 docs bucket 以 `bucket=type::docs` 查询并返回对应 issue。

7. 完成分层验证和回归收口。
   - 先运行 plugin 单元测试，覆盖 labels、create/apply、Agentrix runtime、dispatch、bootstrap 和 provider adapters；再运行可用的 GitHub/GitLab integration 套件验证 sync/check/create/apply 生命周期。
   - 运行 Console API projection/metrics 测试、Web chart 测试与 workspace build/typecheck，确认新增 migration 可应用且前后端契约不变。
   - 运行根级 `npm test` 和相关 build，最后执行全仓枚举搜索与 bootstrap dry-run/manifest 校验，确认源资产、安装副本、文档和测试没有遗漏。

## 验证方案

- 自动验证：
  - `npm test -w issue-flow`：验证 `type::docs` label catalog、同 prefix 互斥、`issue create/apply --type`、prompt/template 路由、bootstrap 文件清单和 provider 参数构造。
  - `npm run test:integration -w issue-flow`：在已配置 provider 凭证的环境中验证 GitHub/GitLab label sync/check、create/apply 与 plan/build 生命周期继续接受 docs；无凭证时由 CI 对应 job 执行。
  - `npm test -w issue-flow-console`：验证 webhook/snapshot 投影保存 `docs`，类型分布 SQL和 drill-down 返回独立 `type::docs` bucket。
  - `npm test -w issue-flow-web`、`npm run typecheck -w issue-flow-web`：验证 stack order、series color、tooltip/selection 参数与 drill drawer 色标。
  - `npm run build -w issue-flow-console`、`npm run build -w issue-flow-web` 与根级 `npm test`：验证 Prisma client、TypeScript、Vite 和全仓回归。
- 手动验证：
  - 在临时仓库分别执行 `labels sync` / `labels check`，确认 GitHub/GitLab 上存在且仅存在预期 metadata 的 `type::docs`。
  - 使用 `issue create --type type::docs` 创建 issue，再用 `issue apply` 在 docs 与其他 type 之间切换，确认只替换 `type::` 标签并保留其他 managed/unmanaged labels。
  - 对 docs issue 触发 triage、Markdown Plan、Visual Plan 和 Build dry-run，检查其复用实现类生命周期，同时 prompts 包含事实来源、链接、示例和命令验证要求。
  - 执行 bootstrap 到干净临时目录，确认 `type-docs.md` 同时出现在项目模板和已安装 skill 中，manifest 无遗漏或 stale 项。
  - 在 Console 注入带 `type::docs` 的 issue 事件，确认看板显示 `type::docs`，类型分布按指定顺序和颜色展示，点击 docs series 后 drill drawer 只列出 docs issues。
- 回归范围：
  - 现有 `type::feature|bug|debt|ops` 的 label metadata、CLI 校验、互斥替换与 provider 同步行为。
  - bug 专用 plan/visual plan 路由、feature/debt/ops 实现类路由、CI failure 的 ops 分类和通用 build 生命周期。
  - bootstrap 对 managed/customizable 文件的升级、冲突和 stale 清理策略，以及 install manifest hash 稳定性。
  - Console 未分类 bucket、既有四类 stack 顺序/颜色、类型 drill-down、size 加权与其他 dashboard panels。
