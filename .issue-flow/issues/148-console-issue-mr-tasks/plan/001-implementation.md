## 目标

在 Console 的 Issue 与 Merge Request 详情页右侧增加统一的 `Tasks` 区块：

- Issue 页列出当前 Git server、仓库和 Issue 编号下的全部关联 Agentrix task。
- MR 页只列出明确关联到该 MR 的 task；本期不把 MR 关联 Issue 的 task 自动扩展进来。
- 每条记录展示稳定可读的 task 标题，并沿用现有 Agentrix `/tasks/{taskId}` 链接规则。
- 无关联、标题缺失、查询失败时均有明确且不破坏详情页布局的状态。

## 当前上下文

- `console/api/src/core/issues.ts#getIssue` 已将 provider Issue 与本地 MR 摘要并行组装，是增加 Issue 关联数据的合适边界。
- `console/api/src/core/merge-requests.ts#getMergeRequest` 是 MR 详情的统一组装入口；前端分别在 `issue-page.tsx` 的右侧栏和 `merge-request-page.tsx` 的 `gh-pr-meta` 中渲染元信息。
- `Task` 当前以 `gitServerId + repositoryId + issueNumber` 保存 Issue 关联，`taskId` 唯一，但没有标题或 MR 编号；`PullRequest` 已保存 `openedByTaskId`、`issueNumber`、`prNumber`。
- Agentrix 任务链接已在 `tasks-board.tsx` 中统一拼接为 `agentrixBaseUrl/tasks/{taskId}`，repo tasks API 已返回 `agentrixBaseUrl`。
- GitHub/GitLab provenance 与 `pull-request-projection.ts` 已能识别 `openedByTaskId`，但当前只把它作为单值字段和 Issue link 的补充来源。

## 方案

### 1. 结论：标题落本地 Task 投影，Agentrix 事件为权威输入

扩展现有 `Task` 投影，增加可空或空字符串默认的 `title` 字段；在 `create-task`/`resume-task` 的 forwarded task envelope 中读取 Agentrix 提供的任务标题并持久化。后续同一 task 的标题更新只接受 Agentrix 投影事件，不在详情页逐条调用 Agentrix task API。

标题展示优先使用投影标题；历史数据、事件缺少标题或标题加载异常时使用明确降级文本（例如 `Task <taskId>`），不因标题缺失隐藏链接或阻塞 Issue/MR 详情。这样避免 N+1 远程请求、跨服务可用性耦合和标题随实时 API 变化，同时允许后续在 task 投影链路补齐标题。

涉及边界：

- `task-projection.ts`、Task store 与 Prisma schema/migration 负责接收、保存、返回标题。
- 不把 Agentrix task API 查询作为详情页运行时依赖；若上游事件当前没有标题字段，Build 阶段需在现有 forwarded envelope 的兼容字段中接入，并对旧事件保持空值兼容。
- API 对外返回 `taskId`、`title`、必要的状态/时间字段和 `agentrixBaseUrl`（或等价的可验证链接信息）；链接仍由统一 `/tasks/{taskId}` 规则生成，task ID 不能被标题替代。

### 2. 结论：MR 只展示直接关联 MR 的 task

本期 MR Tasks 的语义固定为“该 task 直接创建或被 provenance 明确关联到该 MR”，不包含 MR 关联 Issue 的全部 task。这样与 Issue 和 MR 两种关系的用户预期一致，避免同一组 Issue tasks 在每个 MR 页重复出现；若未来要显示 Issue tasks，应作为单独的产品决策和查询模式扩展。

查询必须同时限定 `gitServerId + repositoryId + prNumber`，并通过本地关联关系取 task，不能仅按 `taskId` 或仓库范围过滤。

### 3. 结论：增加独立 Task-MR 关联表，不把单值字段扩展成主关系

为支持“一个 task 多个 MR”和“一个 MR 多个 task”，新增 `TaskPullRequest`（命名可按现有 Prisma 风格调整）关联模型，至少包含：

- `taskId`（指向唯一 task ID）
- `pullRequestId`（指向本地 PullRequest 投影）
- `gitServerId`、`repositoryId`、`prNumber` 的查询索引/约束所需字段，避免跨库串联并方便按 MR 查询
- 创建时间及幂等唯一键（至少 task 与 PullRequest 组合唯一）

`PullRequest.openedByTaskId` 保留为兼容既有事实和 provenance 读取入口，但不再作为支持多关联的唯一查询来源。`pull-request-projection.ts` 在收到带 `openedByTaskId` 的快照时，先确保 Task 投影存在，再幂等写入 Task-MR 关联；同一 MR 后续同步不删除其他已存在关联。

### 4. 迁移与兼容：追加迁移，先回填再以关联表读

不修改任何既有 Prisma migration。新增 migration 按以下顺序实施：

1. 增加 `Task.title`（默认空字符串，保证旧 Task 可读）。
2. 创建 Task-MR 关联表及作用域索引/唯一约束。
3. 从现有 `PullRequest.openedByTaskId` 非空记录回填关联；仅在同一 `gitServerId + repositoryId + prNumber` 的 PullRequest 与 Task 均可唯一定位时建立关系，避免错误串联。
4. 对可能尚未落地 Task 的 provenance，复用现有 marker link/upsert 机制创建最小未知状态 Task，再由关联投影补齐关系；不能可靠定位的历史记录保留 `openedByTaskId`，不伪造 MR relation。
5. 新代码切换到关联表查询后，继续保留旧字段写入和读取兼容一段时间，便于 webhook 重放与旧数据回填；不需要一次性破坏性清理。

Task Issue 关系继续沿用现有 `issueNumber` 数据，不把它改成 MR 关系的替代字段。事件重复、乱序、重复 webhook 必须通过唯一键和 upsert 保证幂等。

### 5. API：详情接口一次返回关联任务，保持页面请求模型不变

扩展现有 Issue/MR 详情响应，而不是新增前端逐条请求：

- Issue 详情在 `getIssue` 中按当前 repo scope 查询所有关联 Task（不按 action 限制），返回 `tasks` 与 `agentrixBaseUrl`。
- MR 详情在 `getMergeRequest` 中按当前 repo scope 与 `prNumber` 查询 Task-MR 关联，返回 `tasks` 与 `agentrixBaseUrl`。
- 统一任务摘要字段，至少包含 `taskId`、`title` 和可选的状态；排序使用稳定规则（如创建/更新时间后 task ID），避免刷新时列表跳动。
- Store 查询必须在数据库 where 条件中绑定 git server、repository 与对象编号；不能先查 taskId 再由应用层过滤。
- API 查询异常应沿用现有详情接口错误处理；前端将可区分的请求失败显示为 Tasks 区块内错误，不吞掉主详情。

### 6. 前端：复用右侧栏结构，统一状态与链接行为

新增共享的 Tasks 元信息组件（或在现有元信息组件内抽取最小复用单元），分别挂载到 Issue 页右侧栏和 MR `gh-pr-meta`：

- loading：显示紧凑的加载占位，不改变右侧栏整体结构。
- 有数据：标题作为链接文本；链接使用 `agentrixBaseUrl` 和 URL 编码后的 `taskId`，新窗口打开并保留安全 `rel` 属性；标题过长截断但保留可访问的完整文本。
- 空数据：显示明确的 `No linked tasks`。
- 标题为空：显示 `Task <short/full id>` 等稳定降级文本，并保留 task 链接。
- 请求失败：显示 `Unable to load tasks` 或本项目既有等价错误文案，保证其他 Labels、Reviewers、Development 等区块继续渲染。

样式沿用现有右侧栏和 Tasks board 的间距、颜色与链接规则，不改变 Issue/MR 其他交互。

### 7. 本期实现边界

包含 Task 标题投影、Task-MR 关系投影/回填、Issue/MR 详情 API 字段、共享 Tasks 展示组件及相关测试。 不包含：Agentrix task 详情页改造、repo 级 Tasks 列表重做、Issue/MR 创建或状态流转变化、按 MR 关联 Issue 展示全部 Issue tasks、无明确 provenance 的仓库级 task 推断。

## 风险与边界

- **标题协议兼容**：旧 forwarded 事件可能没有标题；schema 默认值与 UI fallback 必须使历史详情可用，且需在测试中覆盖。
- **历史关联不完整**：只有已有 `openedByTaskId` 且可安全解析 scope 的 MR 才能自动回填；无法证明的记录不应扩大展示范围。
- **事件乱序**：MR 事件可能先于 Task runtime 事件到达；关联 upsert 必须能创建/补齐未知 Task，后续 Task 事件再完善标题与状态。
- **数据隔离**：所有查询与回填都使用本地 PullRequest/Task 的同一 git server、repository scope；测试必须包含同编号跨仓库和同 task 跨 MR 场景。
- **链接配置**：沿用当前 `agentrixBaseUrl` 配置和 `/tasks/{taskId}` 路径；若 base URL 缺失，展示降级文本但不生成错误的相对链接。

## 验证

### API、store 与迁移

- Task projection 测试：有标题、无标题、resume、旧事件兼容；标题更新/重复事件不产生异常。
- Store 测试：Issue 查询返回同 repo 同 Issue 的全部 tasks；排除其他 Issue、其他 repo、其他 git server；MR 查询支持一个 MR 多 task、一个 task 多 MR，并排除仅共享 Issue 的 task。
- Pull request projection 测试：`openedByTaskId` 首次/重复/乱序事件都能幂等建立 Task-MR relation；旧数据回填只建立可证明关系。
- API 集成测试：Issue/MR 详情有数据、无数据、查询失败时响应字段和错误边界符合约定；检查 `agentrixBaseUrl` 与 task ID 映射。
- Migration 验证：在含旧 Task/PullRequest 数据的数据库上执行追加 migration，确认标题默认值、历史关系回填、现有 issueNumber 关系和唯一约束均可用；不修改既有 migration 文件。

### 前端与验收映射

- Issue 页：右侧出现 Tasks；展示多条标题与正确链接；无数据、loading、错误、缺标题均不破坏其他元信息。
- MR 页：右侧出现 Tasks；只展示直接 MR 关联；同一 Issue 的其他 task 不泄漏。
- 链接测试：每条链接的 pathname 为 `/tasks/{encodeURIComponent(taskId)}`，base URL 去除尾斜杠，标题与 ID 一一对应。
- 样式/可访问性：长标题截断仍可通过 title/可访问名称读取；空状态和错误状态有文本，不依赖颜色；小屏/窄侧栏不溢出。
- 最终以 API/store/projection 自动化测试，加上前端组件或现有等价验证覆盖验收标准 1–7；不以人工浏览单一有数据样例作为唯一验证。
