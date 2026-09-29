## 目标

- 支持按 `triage`、`plan`、`build`、`review` 配置 agent、model、reasoning effort，同时覆盖当前已有的 `general`，后续 action 可以沿用同一结构扩展。
- 采用“文件配置执行策略、CI 保留全局默认”的模式：旧项目零迁移，未配置的字段继承现有行为；安装空入口不能覆盖 CI 默认值。
- Console 提供环节配置表单、继承来源和变更预览，通过配置 PR/MR 提交到仓库，审批合并后供新任务使用。
- Source issue：#129。本次 PR 只提交实现方案；以下代码、界面和测试为后续 Build 范围。

## 非目标

- 不调整标签状态机、action 业务路由或现有 provider issue/PR/MR 接口契约。
- 不迁移或重写现有 prompt；不提供另一套 CI JSON 环节配置或 Console 数据库执行配置。
- 不改变运行中任务和续跑任务的 agent/model；不实现点击保存后立即覆盖全部任务的运维开关。
- 凭证继续使用现有 secrets/CI 机制；不写入仓库配置。不涉及数据库 schema 或历史迁移修改。

## 当前上下文

- 相关模块与已确认事实：
  - `plugin/skills/issue-flow/scripts/runtimes/agentrix.cjs`：`resolveAgent()` 当前优先级为 `options.agent` > `AGENTRIX_ISSUE_FLOW_AGENT` > `AGENTRIX_AGENT` > `codex`；`buildRunArgs()` 仅显式传 agent，未传 model/reasoning；`run()` 的 dry-run 当前只打印 prompt 等信息，不显示最终执行配置。
  - 同文件 `resolveAgentrixConfig()` 兼容 `agentrix` 嵌套配置及历史平铺形状；`promptNameForAction()` 保留 bug、visual、optimization、docs 和 CI failure 的独立 prompt 路由。运行时适配器当前只有 Agentrix；agent 是其下游执行器选择，不等于新增 runtime。
  - `plugin/skills/issue-flow/scripts/bootstrap.cjs` 和 `assets/agentrix/bootstrap/config.json` 管理项目安装配置；config/prompts 为 customizable 文件，升级必须遵守现有 manifest/冲突处理机制。
  - `.github/workflows/issue-flow-auto.yml` 及对应 plugin workflow 资产显式注入 `AGENTRIX_ISSUE_FLOW_AGENT`；GitHub 和 GitLab 的变量接入方式不同，不能假设配置环境变量会自动进入所有任务。
  - `console/api/src/core/gitlab-projects.ts` 已生成和修改 `AGENTRIX_ISSUE_FLOW_AGENT` 等 CI 变量，数据库保存读取状态缓存；`console/api/src/core/gitlab-bootstrap.ts` 有安装文件提交能力，但不能直接当成配置 PR/MR 审批流程。
  - `plugin/test/agentrix-runtime.test.cjs`、`bootstrap.test.cjs`、`dispatch.test.cjs` 以及 Console 的 `service.test.cjs`、`repo-settings.test.cjs` 是相关回归入口。
- 设计选择：
  - 环节配置统一保存在 `.issue-flow/config.json` 的 `agentrix.actions`，以 action 对象提供独立入口，避免每环节目录及 `prompt.md` 与现有 label-specific prompt 出现两套配置体系。
  - 文件中的执行策略可审阅、随分支回滚并支持本地运行；CI 默认值保留现有运维修改路径。Console 是文件编辑入口，不引入第三套执行配置真源。
  - 文件优先于 CI 是显式的环节覆盖语义：修改 CI 默认值只影响仍继承它的字段。Console 必须展示这一关系。
- 外部契约边界：
  - 仓库只证实 `--agent` 已使用，未证实下游 model/reasoning 参数名、支持值和 resume 持久化语义。Build 首步检查项目实际使用版本的 `agentrix-run` help/包源码并固定契约测试；不能把猜测的 `--reasoning-effort` 当作已验证接口。
  - model 为下游支持的非空标识，不固化模型名单；agent/reasoning 的支持范围以验证过的下游契约为准。不支持的组合必须清晰失败，不能静默忽略用户设置。

## 方案

### 1. 配置结构、默认值与继承

新安装模板保留既有路径配置，并新增以下空入口：

```json
{
  "agentrix": {
    "promptsDir": ".issue-flow/prompts",
    "templatesDir": ".issue-flow/templates",
    "planRootDir": ".issue-flow/issues",
    "actions": {
      "defaults": {},
      "triage": {},
      "plan": {},
      "build": {},
      "review": {},
      "general": {}
    }
  }
}
```

- `defaults` 是保留键，表示文件级默认；其余键表示 action。每个对象仅接受 `agent`、`model`、`reasoningEffort`，字段均可缺省，合法显式值为非空字符串。缺失和 `null` 都表示继承；Console 的“恢复继承”删除字段。
- 按字段解析：显式运行 options > 当前 action 文件字段 > 文件 `actions.defaults` > 既有 CI/进程默认 > 内置/下游默认。
- agent 的环境变量继续使用 `AGENTRIX_ISSUE_FLOW_AGENT` > `AGENTRIX_AGENT`，最终回退 `codex`；model/reasoning 缺省时不新增参数，保留下游默认与既有环境继承。不凭空引入未经验证的 model/reasoning 环境变量。
- 新模板不预填 `codex`、模型或强度，因此安装或升级不会遮盖旧 CI 配置。例如 CI agent 为 A、plan 文件 agent 为 B 时，plan 使用 B，未设置 agent 的其他环节使用 A；仅设置 plan 的 model 不改变其 agent 来源。
- 发布机器可读 schema（建议 `assets/agentrix/runtime/schemas/action-execution.schema.json`）及共享解析/校验模块（建议 `scripts/action-execution.cjs`），安装时随 plugin 分发，Console 复用同一契约。schema 允许新增 action 键，未知 action 配置保留但不自动启用未支持的业务 action；未知字段、错误类型、空字符串、非法 JSON 报错并带文件路径/字段路径。
- 缺少整个 actions 或 action 条目是正常继承；错误配置不能当作缺省悄悄回退。维持旧平铺配置和嵌套配置的读取规则，不删除其他项目配置键。

### 2. runtime 加载与实际执行

- 在 Agentrix adapter 中按真正的 action 解析执行设置；build 的 docs/CI prompt 仍使用 build 配置，plan 各种 prompt 仍使用 plan 配置，review 独立读取 review。
- 每次初始 run 得到一份配置快照，返回字段值与来源；构造实际下游参数时仅传有效显式值，使用已验证的 model/reasoning 参数映射。不要把执行设置拼进 prompt 来代替参数传递。
- dry-run 与真实执行共用 resolver，在 dry-run 中展示非敏感的最终值、来源和下游参数摘要；下游默认未知时明确写“由执行器决定”，不伪造实际模型。禁止输出 API key 或全部环境变量。
- `buildResumeTaskArgs()` 保持恢复原任务语义；验证下游保存执行设置，配置 PR 合并或 CI 修改后，已有任务续跑仍沿用创建时设置。若下游不能保证，先补齐创建时快照的可恢复契约，不能临时读取最新文件冒充原设置。
- 配置文件取自 dispatcher 执行时的仓库 checkout。配置 PR 合并后，只有读取了该提交或后续提交的新任务才使用新值；旧 pipeline/旧分支任务可继续使用旧值。记录配置来源版本以便排查，不承诺合并瞬间所有任务同步切换。

### 3. 安装、兼容和迁移

- 更新 bootstrap 配置资产为空 actions；旧项目即使升级时保留原 config，也因 resolver 缺省兼容而继续工作。Console 或用户可以后续主动添加 action 字段，无强制迁移。
- schema/helper 随 runtime 安装；复用现有 customizable 文件保留、冲突决策和 manifest 机制，禁止为补 actions 整体覆盖用户 config。
- 保留 CI agent 变量及 Console 现有变量管理入口。默认不移除 workflow 中的变量，也不修改 secrets、runner、base URL 或 response mode 的归属。
- prompt 路径、模板、项目 instructions、Plan 查找规则保持兼容；新增 agent 配置不能依靠替换 prompt 实现。

### 4. Console 配置编辑与审批流程

- 在仓库设置中新增“环节执行配置”入口：选择目标分支，展示文件版本、defaults 与各 action 的 agent/model/reasoning 字段，提供“继承”选项、有效值/来源以及变更预览。
- 文件从所选仓库和分支读取；缺少 actions 展示继承态。CI 值只读取现有权限允许访问的非敏感变量；无权限或环境作用域不确定时展示“运行时确定”，不能用缓存或内置 codex 冒充实际值。
- 流程：读取配置和提交 SHA → 编辑并校验 → 展示仅相关字段的 diff → 创建配置分支和 commit → 创建/更新配置 PR/MR → 展示审批链接与待合并状态。用户看到的是“提交配置变更”，不是“立即应用”。
- API 请求包含仓库、目标分支、预期文件/提交版本及 actions 字段变更；服务端重新鉴权、重新读取并校验，保留路径配置、其他业务配置和未知 action。若期间已有并发改动，返回冲突并要求刷新，不覆盖远端新内容。
- 针对同一次保存使用幂等键/稳定变更分支识别，网络重试复用已有配置 PR/MR；提交成功但创建 PR/MR 失败时可继续重试，不重复制造分支。只提交配置文件，使用 Conventional Commit。
- 复用 Console provider 访问和已有 PR/MR 能力；如需补文件读取/分支提交封装，在 Console 层增加，不改变 plugin provider 的既有接口。配置 PR/MR 使用普通配置变更标识，不调用 `pr submit plan`，不带 `mr-by::plan`，不误触发 Issue #129 的 Plan 审批状态机。
- 两个 provider 的编辑入口按实际仓库连接权限提供：具备读取、分支提交和 PR/MR 创建权限时开放编辑；权限不足明确只读/失败，不回退直接提交基准分支。
- 合并后刷新分支配置和状态；关闭未合并 PR/MR 不生效。回滚通过新的配置 PR/MR 恢复字段或删除覆盖；只影响后续新任务，CI 默认依然可在原入口修改。

### 5. 实施顺序与文档

1. 验证下游 CLI 契约，完成共享 schema/resolver 和逐字段来源信息；确保老项目优先级不变。
2. 接入 run/dry-run，验证下游任务实际收到三个字段、action 隔离和 resume 行为。
3. 更新安装模板、schema 分发及兼容性测试。
4. 增加 Console 配置读取/提交服务和表单，实现冲突、权限、幂等、PR/MR 审批状态；新增服务/组件采用独立文件，按现有目录结构集成。
5. 更新 `plugin/docs/provider-api.md` 与 Console 使用文档，说明默认继承、文件覆盖 CI、prompt 独立性、分支生效时机、审批与回滚。同步受影响的文件头部/目录职责说明。

## 验证方案

- 自动验证：
  - 配置矩阵：无 config、旧平铺/嵌套 config、空 actions/defaults、缺失 action、部分字段、null、显式 options、两个 agent 环境变量优先级、未知 action 保留、非法字段/类型/JSON。
  - 关键迁移用例：CI agent 使用非 codex 值，安装空 actions 后所有继承环节保持该值；只覆盖 plan 时其他环节不变；删除覆盖恢复 CI。model/reasoning 缺省不产生 CLI 空参数。
  - runtime 契约：针对 triage/plan/build/review/general 断言真实传给子进程的参数，隔离环境污染；代表性 plan 下游调用验证三个字段进入任务请求。不同 agent 对强度支持差异有明确失败测试。dry-run 与真实执行使用同一解析结果，来源输出不包含凭证。
  - resume 回归：创建任务后修改文件/CI，review comment、issue comment 和 Decision 后续恢复均不误切换执行设置；保留既有 client task id/去重与 checkout 行为。
  - 安装矩阵：GitHub/GitLab 新安装、旧自定义 config 升级保留、冲突机制、schema/helper 被分发。
  - Console API/UI：读取版本与来源、CI 不可读状态、继承编辑、局部保存保留无关字段、schema 校验、权限拒绝、并发冲突、重复提交复用 PR/MR、部分失败可重试、关闭/合并状态；确认没有直接提交基准分支，也没有写入另一套 DB 执行配置。
  - 先运行 `node --test plugin/test/bootstrap.test.cjs plugin/test/agentrix-runtime.test.cjs` 及新增配置测试，再运行 `npm test -w issue-flow`、`npm test -w issue-flow-console`、`npm test -w issue-flow-web`。plugin integration 套件是独立命令 `npm run test:integration -w issue-flow`，仅在具备所需环境时执行，不将单元测试通过表述为集成验证通过。
- 手动验证：
  - 临时安装旧 CI agent 默认，逐步配置 plan model/agent、build reasoning，观察真实任务参数与 dry-run 来源；确认既有 label-specific prompt 和自定义 prompt 生效。
  - Console 选择 develop，修改 plan 字段并提交配置 PR/MR；合并前新任务仍使用旧版本，合并后读取新提交的新任务使用新值，其他 action 不受影响，原任务续跑不变。
  - 制造并发文件修改和无写权限场景，确认不覆盖配置；关闭配置 PR/MR不生效，删除覆盖后恢复 CI 默认。
  - 文档中的 JSON 示例用共享 schema 校验；链接/锚点可达，示例命令在临时仓库验证，字段与当前代码和已验证下游 CLI 契约一致。
- 回归范围：
  - CI agent 默认、安装冲突与 manifest、旧路径配置、prompt 路由、dispatch/review/resume、Console 变量管理和仓库权限、GitHub/GitLab 配置提交与审批路径。
- 验收对应：
  - Issue AC1/2：可发现的 action 入口、开放 schema、空默认与逐字段继承；AC3：真实任务参数与 action 隔离；AC4：CI/旧 config/prompt 无迁移兼容；AC5：安装、解析、实际执行和文档验证。补充验收：Console 只能经配置 PR/MR 发布策略，显示来源及生效版本，支持冲突与回滚。
