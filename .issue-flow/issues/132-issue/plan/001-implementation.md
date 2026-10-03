## 目标

在 Console 仓库 Settings 中增加独立的 Issue Flow 执行配置区域，读取目标 GitLab 仓库默认分支 `.issue-flow/config.json` 的 `agentrix.actions`，让维护者分别编辑 `defaults`、`triage`、`plan`、`build`、`review`、`general` 的 `agent`、`model`、`reasoningEffort`，并通过配置专用 Merge Request 审阅后生效。

配置必须继续遵守 plugin 已实现的逐字段继承和运行时优先级；Console 只管理仓库文件中的显式覆盖，不把继承值写回文件，不直接修改默认分支，也不改变安装/升级 plugin、运行中任务或续跑任务。

## 当前上下文

- plugin 已在 `action-execution.cjs` 和 JSON Schema 中定义三个字段、合法 reasoning effort、`null`/缺失继承语义及运行时解析顺序，但该契约尚未作为 Console 可复用的公共 domain API 导出。
- Console 的 GitLab 设置流程已有登录上下文、项目管理权限校验、默认分支文件读取、repository commit、MR 创建、MR 状态查询和 repository settings 缓存能力；安装器 MR 会执行 plugin 安装脚本，不能承担本配置保存。
- Settings 当前把安装检查和 Features 放在同一页面，且仅在整个 settings 缓存为空时自动检查。执行配置必须独立加载，否则已有任一缓存项的仓库会跳过读取。
- plugin 待合并 MR 已有缓存、进入 Settings 时刷新以及 GitLab webhook 清理逻辑；执行配置需要同类状态，但不能混入 plugin 安装状态或版本判断。

## 方案

### 决策一：把 action execution 契约提升为 plugin 公共 domain 能力

**结论：** 将 action 名称、字段、reasoning effort 枚举、规范化和校验放到 `issue-flow/domain` 可导出的共享模块；plugin runtime 与 Console API 都调用同一实现。保留 runtime 的解析职责，Console 不复制一份枚举或宽松校验。

共享契约包含：

- Console 可编辑 action 固定为 `defaults`、`triage`、`plan`、`build`、`review`、`general`；runtime 继续允许配置中出现未来 action 名称，Console 读取和写回时保留它们。
- `agent`、`model` 接受 trim 后的非空字符串；`reasoningEffort` 仅接受 `low`、`medium`、`high`、`xhigh`、`max`。
- 缺失字段和 `null` 都表示继承。Console 空输入转换为删除显式字段，不把空字符串写入配置。
- API 同时返回显式值和按 `当前 action > defaults` 计算的仓库内继承预览；界面将二者分开显示。运行时完整优先级仍由 plugin 保持为 `显式运行参数 > 当前 action > defaults > 既有运行时兜底`，Console 不声称知道下游最终默认模型。

这样可以让 Build 只维护一套字段语义，并通过 plugin domain 单元测试锁定 Console 与 runtime 的一致性。

### 决策二：新增配置专用读写 API，不复用 configure-agentrix 或 plugin installer

**结论：** 在 GitLab routes/project service 增加 action execution 配置的读取与提交接口，复用现有 session、project context 和 `resolveGitlabProjectAccess`。读取允许有仓库访问权限的用户查看；提交必须由服务端再次确认 `canManage`。

读取响应包含：

- 默认分支名称、配置路径和默认分支文件 revision（优先使用 GitLab 返回的 `last_commit_id`/`blob_id`）。
- 六个受支持 action 的显式字段、继承预览和原文件是否存在。
- 独立的 `pendingMergeRequest`、最近检查时间，以及缺失或 JSON/契约无效的结构化状态。

提交请求携带读取时的 base revision 和六个 action 的目标显式值。服务端重新读取默认分支后执行以下处理：

1. 若文件不存在、JSON 无效或 `agentrix`/`actions` 结构不合法，返回明确错误，不创建文件或覆盖内容。
2. 若 base revision 与当前默认分支不一致，返回 `409` 要求刷新，避免在设置页打开期间覆盖他人提交。
3. trim 输入并通过共享契约校验；空值转换为字段删除。只合并六个受管 action 的三个字段，保留其他顶层字段、其他 `agentrix` 字段、未来 action 及未编辑内容。
4. 使用稳定 JSON 格式和文件末尾换行生成候选内容；与原内容语义及序列化结果均无差异时返回 `skipped`，不创建分支或 MR。

`configureRepositoryAgentrix` 继续只负责 Console 数据库中的 automation/Agentrix 连接设置，不扩展为仓库文件写入入口，避免把两类生效语义混在同一个 API。

### 决策三：使用 GitLab repository commit API 创建单文件配置 MR

**结论：** 扩展现有 `createGitlabRepositoryCommit` 对 `start_branch` 和 action `last_commit_id` 的支持，从默认分支创建唯一的 `issue-flow/action-execution-*` 分支，并在一次 commit 中仅更新 `.issue-flow/config.json`；随后调用现有 `createGitlabMergeRequest`。不运行安装器、不 checkout 临时仓库，也不修改 manifest、CI 或 plugin 文件。

选择 repository commit API 的理由：本变更是已知路径的单文件 JSON patch，现有 API 已具备 commit 与 MR 原语；抽取 bootstrap 的 clone/install 流程会保留大量本需求不需要的安装器、冲突决策和文件 staging 行为，扩大耦合和回归面。

并发保护分两层：提交前比较 base revision，commit action 再携带原文件 `last_commit_id`。若默认分支在两次检查之间变化，将 GitLab 冲突转换为可识别的 `409`，不自动基于陈旧草稿重试。

commit 和 MR 使用配置专用标题、描述和 Conventional Commit message。MR 响应记录 iid、URL、source/target branch；创建 MR 失败时返回已创建分支信息和可重试错误，不把变更标记为待合并或已生效。

### 决策四：生效配置与 MR 草稿分离，并阻止重复待审提交

**结论：** 在 repository settings 中增加独立的 `actionExecution` 缓存，仅缓存默认分支读到的生效值、revision、检查状态和该功能的 pending MR。MR 中的草稿值不覆盖生效值；Settings 始终将“当前生效配置”和“待合并 MR”分别展示。

状态规则如下：

| 场景 | 行为 |
| --- | --- |
| 没有 pending MR | 可编辑并提交；成功后缓存 pending MR，保留原生效值 |
| pending MR 仍 opened | 禁用再次提交，返回同一 MR 链接；不静默创建第二个 MR |
| pending MR merged | 清除 pending，失效旧配置缓存并重新读取默认分支 |
| pending MR closed | 清除 pending，重新读取默认分支；原草稿不作为当前值 |
| MR 查询暂时失败 | 保留 pending 状态并显示刷新失败，不猜测已合并或关闭 |

进入 Settings 时始终单独触发 action execution 读取，不依赖 `hasRepoSettingsData` 的全局空缓存判断。存在 pending MR 时查询 GitLab MR 状态；同时扩展 GitLab merge request webhook，按缓存的 iid/source branch 精确匹配配置 MR，在 merged/closed 后清理或失效对应缓存。轮询/页面刷新保证 webhook 缺失时仍能恢复正确状态。

### 决策五：设置区按“显式覆盖/继承值”编辑，不提供虚假的目录选择器

**结论：** 在 `SettingsTab` 增加独立的“Issue Flow 执行配置”卡片/表格。行表示 `defaults` 和五个 action，列表示 agent、model、reasoning effort；agent/model 使用字符串输入，reasoning effort 使用枚举选择，并为每个字段提供“继承/清除覆盖”操作。

- 输入框显示显式值；未设置时显示继承来源及预览，例如“继承 defaults: codex”或“由运行时决定”。
- `defaults` 未设置时只显示“由运行时决定”，不反向写入内置 `codex` 或模型默认。
- 无管理权限时可读但所有编辑和提交控件禁用，并显示现有角色提示。
- 保存按钮仅在本地值合法、与读取快照有实际差异、没有待合并 MR 时启用；成功后展示 MR 链接和“合并后生效”。
- 缺文件、非法 JSON、权限拒绝、revision 冲突、GitLab/API 失败使用不同错误文案；非法状态下不提供会覆盖文件的保存动作。

前端类型在 `issue-flow-model.ts` 中增加配置快照、字段来源、pending MR 和保存结果；controller 提供独立 load/save/refresh action，不把该状态塞入 plugin 安装进度或 Features toggle。

## 风险与边界

- **配置格式化：** JSON 写回可能带来缩进差异。实现使用现有文件可解析对象做最小对象合并，再统一为仓库当前约定的两空格缩进；无语义变化时跳过，测试确保只变化目标字段且其他值完整保留。
- **默认分支竞态：** 读取 revision、提交前复查和 GitLab `last_commit_id` 共同防止覆盖；冲突要求用户刷新，不做隐式三方合并。
- **缓存不是事实来源：** repository settings 只用于页面响应和 pending 提示；默认分支文件与 GitLab MR 状态分别是生效配置和待审状态的 source of truth。
- **范围限制：** 本次仅支持 Console 已有的 GitLab managed repository，不增加 GitHub 写入；不新增 Agent/模型目录服务，不更新运行中或续跑任务，不把配置 MR 自动合并。

## 验证

### 共享契约与 API 单元测试

- 扩展 plugin action execution/domain 测试，覆盖合法字段、非法空字符串/未知字段/非法强度、`null`/缺失继承、当前 action 对 defaults 的逐字段覆盖，以及 runtime 与公共 domain 使用同一契约。
- 为 GitLab project service 增加读取测试：完整配置、缺失文件、非法 JSON、非法 action 配置、无权限读取/提交、GitLab 网络错误和 pending MR 状态刷新。
- 增加提交测试：字段设置与清除、只修改目标字段、保留其他顶层/agentrix/未来 action、无差异跳过、base revision 冲突、commit 竞态冲突、pending MR 拒绝重复提交，以及 repository commit 只包含 `.issue-flow/config.json`。
- 扩展 route/service HTTP 测试，验证登录上下文、`canManage` 服务端校验、结构化错误和 MR 响应/缓存。
- 扩展 webhook 测试，验证配置 MR merged 后失效并刷新生效值、closed 后清除 pending，以及 plugin 安装 MR 与配置 MR 不互相误匹配。

### Web 测试

- 为 settings 状态 helper/controller 增加测试，确认 action 配置会独立加载，不会因已有 permissions/plugins 等缓存而跳过；pending MR 会触发刷新。
- 为显式值与继承显示、空输入清除、reasoning effort 枚举、无权限只读、无差异禁用、pending MR 禁止重复提交、错误提示和 MR 链接状态增加组件或可提取纯函数测试。
- 保留现有 plugin 安装/升级和 Features 设置测试，确认新增区域不改变原流程。

### 执行检查

- 运行 plugin、Console API、Console Web 的相关定向测试后执行 workspace 测试。
- 运行 Console API build、Web typecheck/build 和 lint，确认共享 domain 导出、前后端类型及 UI 均通过。
- 在 GitLab 测试项目手工验证：读取默认分支配置、提交 MR、合并前仍显示旧生效值、合并/关闭后刷新、并发修改返回冲突、MR diff 仅包含预期配置字段。
