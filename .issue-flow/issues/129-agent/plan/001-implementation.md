## 目标

为 `triage`、`plan`、`build`、`review` 及现有 `general` 分别配置 agent、model、reasoning effort，使维护者可以按环节选择执行成本与质量。旧项目继续继承 CI 默认；Console 支持编辑配置并通过 PR/MR 审批生效。

本方案覆盖配置契约、安装和 runtime 加载、Console 编辑及验证；保持现有 prompt、标签状态机和 provider issue/PR/MR 接口兼容。

## 方案

### 决策一：以文件中的 action 对象提供独立入口，保留 CI 全局默认

**结论：** 在 `.issue-flow/config.json` 的 `agentrix.actions` 下组织各环节配置，不新增每环节目录与 `prompt.md`。CI 保留现有全局默认和凭证；Console 编辑同一文件，不在数据库维护另一套执行策略。

**理由：** action 对象满足独立配置与扩展需求，能随代码审阅、回滚和本地读取；拆目录没有额外收益，还会与现有按标签选择 prompt 的体系重叠。保留 CI 默认避免强制迁移，也保留当前运维修改入口。

新安装模板保留原有路径字段，并增加空入口：

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

`defaults` 是保留键，其余键为 action；每个对象允许 `agent`、`model`、`reasoningEffort`。新增 action 沿用同一结构，未知 action 配置保留，但配置本身不启用 runtime 尚不支持的业务动作。

### 决策二：逐字段继承，安装模板不固化执行值

**结论：** 每个字段独立采用以下优先级：

```text
显式运行 options > 当前 action 文件字段 > 文件 defaults
                > 既有 CI/进程默认 > 内置/下游默认
```

**理由：** 显式环节配置应覆盖全局默认；只配置模型不能顺带覆盖 agent。新文件若预填 `codex`，会遮盖现有 CI 设置，因此所有入口默认均为 `{}`。

| 情况 | 确定行为 |
| --- | --- |
| 缺少 actions、action、字段，或字段为 null | 继续逐层继承；Console“恢复继承”删除该字段 |
| 显式配置字段 | 必须是非空字符串；agent/强度须满足经验证的下游契约，model 不固化版本名单 |
| 非法 JSON、错误类型、空字符串、未知字段 | 带文件及字段路径报错，不静默回退 |
| agent 最终缺省 | 保留 `AGENTRIX_ISSUE_FLOW_AGENT` > `AGENTRIX_AGENT` > `codex` |
| model/强度最终缺省 | 不追加参数，保留下游默认和既有环境继承；不引入未经验证的新环境变量 |

例如 CI agent 为 A、plan agent 为 B，则 plan 使用 B，其他环节仍使用 A。仅设置 plan model 时，其 agent 仍继承 A；删除 plan agent 恢复继承。修改 CI 默认只影响仍继承该默认的字段。

共享 schema 和 resolver 由 plugin 提供并随安装分发，Console 复用同一契约。建议新增 `scripts/action-execution.cjs` 和 `assets/agentrix/runtime/schemas/action-execution.schema.json`；继续兼容 `resolveAgentrixConfig()` 现有嵌套/平铺格式，保留其他项目配置键。旧项目升级保留自定义 config，不要求自动补字段，遵守 bootstrap 既有 customizable/manifest 冲突机制。

### 决策三：执行配置按 action 加载，prompt 按现有标签路由

**结论：** agent/model/强度取自真实 action；prompt 继续使用 `promptNameForAction()`、项目 promptsDir 和内置 prompt 回退。

**理由：** 同一个 action 可以有多个 prompt 变体，但其执行策略仍属于该环节。docs/CI failure build 都读取 build 配置，bug/visual/optimization plan 都读取 plan 配置。模板、项目 instructions 和 Plan 输入查找保持兼容。

`agentrix.cjs` 的初始 run 每次解析一份配置快照，用于真实子进程参数与 dry-run。dry-run 新增非敏感的有效值、来源及参数摘要；下游默认不可知时标记“由执行器决定”，不能假装已知最终模型。日志不输出凭证或全部环境。

### 决策四：Agentrix adapter 映射实际任务参数，续跑沿用原任务

**结论：** 当前仓库仅有 Agentrix runtime adapter；本次为它实现 action 配置传递，不新增其他 runtime。其下游 agent 选择与 runtime 适配器是两个概念。新增配置通过已验证的 CLI 参数进入实际任务，不能只拼到 prompt。

**依据与边界：** 仓库 `buildRunArgs()` 已传 `--agent`，尚未传 model/强度；`resolveAgent()` 已有 CI 回退；`buildResumeTaskArgs()` 恢复已有任务。仓库尚未证明下游 model/强度参数名、支持值及 resume 持久化契约，不能将猜测参数作为实现依据。

Build 首先针对项目实际使用的 `agentrix-run` 版本核验 help/包源码及任务请求，固定映射与契约测试，再接入 resolver。不支持的 agent/模型/强度组合明确失败；若需要升级下游，应在 Build 中记录兼容版本及验证证据。下游不支持时必须报告依赖阻塞，不能删去字段冒充验收完成。

续跑沿用创建任务时的执行设置，文件或 CI 后续变化只影响新任务。验证下游保存原设置；若其要求重传，则先提供可恢复的创建时快照，再传原值，不能读取最新配置替代。适用 issue comment、review comment、新 review 提交及 Decision 后续恢复。

### 决策五：Console 提交配置 PR/MR，按读取的配置版本生效

**结论：** 仓库设置增加“环节执行配置”，支持选择分支、编辑 defaults/各 action、恢复继承、查看有效值与来源、预览 diff，最终操作为“提交配置变更”。配置文件是持久来源，CI 默认仍在原变量入口管理。

**理由：** 执行策略通过 PR/MR 审批和回滚；避免 Console、文件、CI 同时保存独立环节策略。现有 `gitlab-projects.ts` 已支持 CI 变量读写及缓存；`gitlab-bootstrap.ts` 的安装提交能力不能直接当作配置审批流程。

用户路径：读取目标分支的配置和版本 → 编辑/校验 → 预览变更 → 提交配置分支及 PR/MR → 查看待审批链接 → 合并后刷新配置。

- API 提交仓库、目标分支、预期文件/提交版本与 actions 字段变更。服务端鉴权并重新读取、校验，只修改相关字段，保留路径配置和其他 action；并发修改返回冲突，不能覆盖远端新内容。
- CI 值只展示现有权限下可读取的非敏感值；权限不足、环境作用域不确定或下游默认未知时显示“运行时确定”，缓存不能冒充实际值。提示文件覆盖使哪些字段不受 CI 默认修改影响。
- GitHub/GitLab 使用已有 provider 访问能力；需要的文件读取/分支提交封装放在 Console 层，不改变 plugin 既有接口契约。缺少读取、分支写入或 PR/MR 创建权限时只读或清晰失败，不直接提交基准分支。
- 保存使用幂等标识和稳定变更分支，重试复用 PR/MR；提交成功但 PR/MR 创建失败可继续完成。只提交配置文件，采用 Conventional Commit。
- 配置 PR/MR 是普通配置变更，不使用 `pr submit plan` 或 `mr-by::plan`，不触发本 Issue 的 Plan 审批流转。
- 配置取自 dispatcher 当次 checkout：合并后，读取新提交的新任务生效；旧 pipeline/旧分支和原任务续跑不保证切换。记录读取的配置版本，Console 不承诺合并瞬间所有任务同步改变。
- 关闭未合并 PR/MR 不生效；回滚通过新配置 PR/MR 恢复字段，删除覆盖后继承 CI。凭证、runner、base URL、response mode 留在现有机制，不新增数据库执行配置或迁移。

### 实施边界与交付顺序

先验证下游契约并落地共享 schema/resolver，再接入 runtime 与安装，最后完成 Console 编辑审批入口及文档。主要改动落在 plugin runtime/bootstrap/配置资产与 Console 仓库设置、配置提交服务及测试。

更新 `plugin/docs/provider-api.md` 和 Console 使用文档，解释继承、文件覆盖 CI、prompt 独立性、分支生效时机与回滚。GitHub workflow 当前显式注入 agent 变量，继续保留；GitLab 现有变量链路继续工作。本次不改标签状态机、业务流程或 prompt 内容。

## 验证

以下是 Build 的验收门槛；Plan PR 仅修改方案文件。

| 验收面 | 验证方式与通过条件 |
| --- | --- |
| AC1/2：安装入口和 schema | GitHub/GitLab 新安装包含五个 action 与空 defaults；旧自定义 config 升级保留；schema/helper 正确分发；缺失、null、非法值、未知 action/字段按契约处理 |
| AC2/4：CI 继承兼容 | CI agent 为非 codex 值时，旧 config 和新空模板都保持原值；逐字段覆盖/删除恢复、显式 options、两个 agent 环境变量优先级符合表述；不产生空 CLI 参数 |
| AC3：可靠传递与隔离 | 五种 action 的真实子进程 args 各自独立；至少一个 plan 下游任务请求收到 agent/model/强度；不支持组合清晰失败；dry-run 与真实解析一致 |
| AC4：prompt 与续跑 | label-specific prompt、自定义 promptsDir 和项目 prompt 生效；任务创建后修改 CI/文件，issue/review/Decision 续跑沿用原设置；去重及 checkout 行为不变 |
| Console 编辑与发布 | 表单展示继承来源，权限未知时不伪造有效值；局部修改保留无关键；覆盖鉴权失败、版本冲突、幂等重试、部分失败恢复与合并/关闭状态；无直接写基准分支或额外 DB 执行配置 |
| AC5：文档 | JSON 示例通过共享 schema，链接/锚点可达，命令在临时仓库有效，关键字段和下游参数与已验证实现一致 |

自动验证先运行相关 resolver、runtime、bootstrap、Console API/UI 测试，再运行 `npm test -w issue-flow`、`npm test -w issue-flow-console`、`npm test -w issue-flow-web`。`npm run test:integration -w issue-flow` 是独立集成套件，仅在所需环境具备时执行；单元测试不能代替实际任务传递证据。

手动走通代表性审批闭环：旧 CI agent 默认 → Console 只修改 plan 配置 → 提交 PR/MR → 合并前仍读取旧配置 → 合并后新 checkout 的 plan 使用新值，其他 action 不变 → 原任务续跑设置不变 → 删除覆盖的回滚 PR/MR 合并后恢复 CI 默认。同时验证无写权限、并发编辑和关闭未合并 PR/MR 的行为。
