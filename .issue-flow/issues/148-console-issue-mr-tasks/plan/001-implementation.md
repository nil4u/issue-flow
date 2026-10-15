## 目标

在 Console 的 Issue 与 Merge Request 详情页右侧增加统一的 `Tasks` 区块：

- Issue 页列出当前 Git server、仓库和 Issue 编号下的全部关联 Agentrix task。
- MR 页沿用 MR 已有的关联 Issue，展示该 Issue 下的全部关联 task；本期不新增独立的 MR-task 关系语义。
- 每条记录展示稳定可读的 task 标题，并沿用现有 Agentrix `/tasks/{taskId}` 链接规则。
- 无关联、标题缺失、查询失败时均有明确且不破坏详情页布局的状态。

## 当前上下文

- `console/api/src/core/issues.ts#getIssue` 已将 provider Issue 与本地 MR 摘要并行组装，是增加 Issue 关联数据的合适边界。
- `console/api/src/core/merge-requests.ts#getMergeRequest` 是 MR 详情的统一组装入口；前端分别在 `issue-page.tsx` 的右侧栏和 `merge-request-page.tsx` 的 `gh-pr-meta` 中渲染元信息。
- `Task` 当前以 `gitServerId + repositoryId + issueNumber` 保存 Issue 关联，`taskId` 唯一，但没有标题；这已经足以按 Issue 查询 tasks。
- `PullRequest` 已保存 `issueNumber`、`prNumber` 及 `openedByTaskId`；MR 详情已有 source issue 信息，可直接复用该 Issue 关系。
- Agentrix 任务链接已在 `tasks-board.tsx` 中统一拼接为 `agentrixBaseUrl/tasks/{taskId}`，repo tasks API 已返回 `agentrixBaseUrl`。

## 方案

### 1. 结论：标题落本地 Task 投影，Agentrix 事件为权威输入

扩展现有 `Task` 投影，增加带空字符串默认值的 `title` 字段；在 `create-task`/`resume-task` 的 forwarded task envelope 中读取 Agentrix 提供的任务标题并持久化。后续同一 task 的标题更新只接受 Agentrix 投影事件，不在详情页逐条调用 Agentrix task API。

标题展示优先使用投影标题；历史数据、事件缺少标题或标题加载异常时使用明确降级文本（例如 `Task <taskId>`），不因标题缺失隐藏链接或阻塞 Issue/MR 详情。这样避免 N+1 远程请求、跨服务可用性耦合和标题随实时 API 变化。

涉及边界：

- `task-projection.ts`、Task store 与 Prisma schema/migration 负责接收、保存、返回标题。
- 不把 Agentrix task API 查询作为详情页运行时依赖；旧 forwarded 事件没有标题时保持空值兼容。
- API 对外返回 `taskId`、`title`、必要的状态/时间字段和 `agentrixBaseUrl`；链接仍由统一 `/tasks/{taskId}` 规则生成，task ID 不能被标题替代。

### 2. 结论：MR 展示其关联 Issue 的全部 tasks

MR Tasks 的查询范围定义为 MR 当前已确定的关联 Issue，而不是新增“直接创建该 MR 的 task”关系。MR 详情先解析已有 source issue number，再调用与 Issue 页相同的 Issue task 查询；因此一个 Issue 下的多个 task 会在该 Issue 的 MR 详情页集中展示，用户无需在不同页面寻找 task。

本期不引入 `mergeRequestNumber`，不创建 Task-MR 关联表，也不做 MR-task 历史回填。`PullRequest.openedByTaskId` 继续作为既有 provenance 和 MR 事实字段保留，但不参与 Tasks 区块的主查询。若未来需要区分“直接创建 MR 的 task”和“Issue 下全部 task”，再单独设计关系模型与产品语义。

### 3. 数据查询与范围隔离

抽取共享的 Task summary 查询能力，按 `gitServerId + repositoryId + issueNumber` 查询全部关联 tasks，不按 action 限制，并使用稳定排序（如 queued/updated 时间后 task ID）。

新增独立的 `GET /api/issues/:gitServerId/:projectId/:issueNumber/tasks` 接口，由 `issues` route 与 core 层负责鉴权、仓库解析和查询。Issue 详情接口不携带 `tasks`，避免详情 payload 与任务列表查询耦合。

- Store 查询必须在数据库 where 条件中绑定 git server、repository 与 Issue 编号，不能先查 taskId 再由应用层过滤。
- Tasks 接口返回统一任务摘要和 `agentrixBaseUrl`；接口查询失败只影响 Tasks 区块，不影响 Issue/MR 主详情。
- MR 详情继续返回已有 source issue number，但不携带 `tasks`；MR 页面在 source issue 存在时调用同一个按 Issue number 的 Tasks 接口。
- 对于没有 source issue 的 MR，前端不调用 Tasks 接口并显示无关联状态，不根据 repo 或 `openedByTaskId` 猜测任务，避免展示无明确关系的 repo tasks。

### 4. 迁移与兼容

不修改任何既有 Prisma migration；新增 migration 只增加 `Task.title` 字段并设置空字符串默认值，保证现有 Task 行和既有 `issueNumber` 关系可继续读取。无需增加 MR 编号字段、关联表、MR 关系回填或数据迁移。

历史 Task 没有标题时由 UI 使用稳定降级文本；后续新事件带标题即可补齐投影。事件重复和乱序沿用现有 task upsert 语义，标题更新不得清空已有非空标题，除非事件明确提供新的标题。

### 5. API：新增独立的 Issue Tasks 查询接口

不扩展现有 Issue 或 MR 详情响应；新增按 Issue number 查询 tasks 的接口，保持主详情 payload 稳定：

- `GET /api/issues/:gitServerId/:projectId/:issueNumber/tasks` 返回任务摘要列表与 `agentrixBaseUrl`。
- 响应至少包含 `taskId`、`title` 和可选的状态，排序稳定，避免刷新时列表跳动。
- Issue 页从当前 Issue number 调用该接口；Issue 详情请求只返回 provider Issue、MR 摘要及现有详情字段。
- MR 页先从 MR 详情读取已有 source issue number，再调用同一个接口；MR 详情请求本身不返回 `tasks`。
- 接口无效 Issue、无关联 tasks、权限失败与查询失败使用项目既有错误格式；前端分别展示无关联或错误状态。

### 6. 前端：复用右侧栏结构，统一状态与链接行为

新增共享的 Tasks 元信息组件（或在现有元信息组件内抽取最小复用单元），分别挂载到 Issue 页右侧栏和 MR `gh-pr-meta`：

- loading：显示紧凑的加载占位，不改变右侧栏整体结构。
- 有数据：标题作为链接文本；链接使用 `agentrixBaseUrl` 和 URL 编码后的 `taskId`，新窗口打开并保留安全 `rel` 属性；标题过长截断但保留可访问的完整文本。
- 空数据：显示明确的 `No linked tasks`；MR 无 source issue 时显示等价的无关联提示。
- 标题为空：显示 `Task <short/full id>` 等稳定降级文本，并保留 task 链接。
- 请求失败：显示 `Unable to load tasks` 或本项目既有等价错误文案，保证其他 Labels、Reviewers、Development 等区块继续渲染。

样式沿用现有右侧栏和 Tasks board 的间距、颜色与链接规则，不改变 Issue/MR 其他交互。

### 7. 本期实现边界

包含 Task 标题投影、独立 Issue Tasks 查询 API、共享 Tasks 展示组件及相关测试。不包含：MR-task 独立关联表或关系回填、Agentrix task 详情页改造、repo 级 Tasks 列表重做、Issue/MR 创建或状态流转变化、无明确关联关系的仓库级 task 推断。

## 风险与边界

- **标题协议兼容**：旧 forwarded 事件可能没有标题；schema 默认值与 UI fallback 必须使历史详情可用，且需在测试中覆盖。
- **MR 关联 Issue 不完整**：没有明确 source issue 的 MR 不展示 tasks；不能根据 `openedByTaskId` 或整个 repo 推断。
- **数据隔离**：所有查询使用本地 Task 的同一 git server、repository、Issue scope；测试必须包含同编号跨仓库和跨 Git server 的隔离场景。
- **链接配置**：沿用当前 `agentrixBaseUrl` 配置和 `/tasks/{taskId}` 路径；若 base URL 缺失，展示降级文本但不生成错误的相对链接。

## 验证

### API、store 与迁移

- Task projection 测试：有标题、无标题、resume、旧事件兼容；重复事件不异常，已有标题不会被缺失标题覆盖。
- Store 测试：Issue 查询返回同 repo 同 Issue 的全部 tasks；排除其他 Issue、其他 repo、其他 Git server；稳定排序符合约定。
- MR API 测试：MR 复用 source Issue 的全部 tasks；没有 source Issue 时为空；不因 `openedByTaskId` 或 repo task 产生额外结果。
- API 集成测试：Issue/MR 详情不包含 `tasks`；独立 Issue Tasks 接口覆盖有数据、无数据、越权/无效范围、查询失败，并检查 `agentrixBaseUrl` 与 task ID 映射。
- Migration 验证：在含旧 Task 数据的数据库上执行追加 migration，确认 `title` 默认值、既有 `issueNumber` 关系和现有查询均可用；不修改既有 migration 文件。

### 前端与验收映射

- Issue 页：右侧出现 Tasks；展示同 Issue 多条标题与正确链接；无数据、loading、错误、缺标题均不破坏其他元信息。
- MR 页：右侧出现 Tasks；读取 source Issue number 后展示关联 Issue 的全部 task；无 source Issue 时为空，不串入 repo 其他 task。
- 链接测试：每条链接的 pathname 为 `/tasks/{encodeURIComponent(taskId)}`，base URL 去除尾斜杠，标题与 ID 一一对应。
- 样式/可访问性：长标题截断仍可通过 title/可访问名称读取；空状态和错误状态有文本，不依赖颜色；小屏/窄侧栏不溢出。
- 最终以 API/store/projection 自动化测试，加上前端组件或现有等价验证覆盖验收标准 1–7；不以人工浏览单一有数据样例作为唯一验证。
