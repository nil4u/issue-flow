## 目标

消除 Console 在 Issue / Merge Request / Plan 页面之间切换时出现的“检查控制台配置 → 正在加载登录状态”等待与登录页闪烁，同时保持服务端逐请求校验 Console session、会话过期与滑动续期、Git provider OAuth 凭据隔离不变。

## 当前上下文：用户感知的“登录校验”来自哪里

结论：不是服务端逐请求鉴权，也不是 SPA 内路由切换重复调用 `/api/user/session`，而是**部分页面链接是普通 `<a href>`，点击触发整页刷新，SPA 每次都从零启动**。

整页刷新的链接（同源、无 `preventDefault`、无 pushState）：

| 位置 | 链接 |
|------|------|
| `console/web/src/components/issues-board.tsx` | Issue 行 / 看板卡片 → Issue 详情；Plan/Decision 按钮；创建后 `window.location.assign(issueHref)` |
| `console/web/src/components/issues/issues-kanban.tsx` | Issue 卡片、review 链接 |
| `console/web/src/components/merge-requests-board.tsx` | MR 行 → MR 详情 |
| `console/web/src/components/issue-page.tsx` | 返回列表、Plan/Decision 按钮 |
| `console/web/src/components/merge-request-page.tsx` | 返回列表、关联 issue 链接 |
| `console/web/src/components/automation-insights.tsx`、`metrics-drill-drawer.tsx` | 来源 issue 链接 |
| `console/web/src/vision-plan/VisionPlanPage.tsx` | 返回 Issues、MR 链接 |

而侧栏、仓库 tab、用户设置、Insights 走 `applyRoute()` + `history.pushState`，不会重新鉴权——这解释了“只在部分切换出现”的现象。

每次整页刷新后 `use-dashboard-controller.ts` / `App.tsx` 的串行链路：

1. `GET /api/setup/status` — 期间渲染“正在检查控制台配置...”。
2. `GET /api/git-servers` + `GET /api/user/session` — `userSession` 初始为 `{ authenticated: false }`，`App.tsx` 因此渲染 **`LoginPage`（“正在加载登录状态...”）**，这就是用户看到的登录校验/登录页闪烁。`/api/user/session` 还会对每个关联账号执行 `resolveFreshSession()`，token 临近过期时会同步触发 OAuth refresh 网络请求，是链路里最可能的慢点。
3. 鉴权完成后，controller 按 URL 中的 gitServerId 再请求 `GET /api/session?gitServerId=` 与仓库列表（即使当前只渲染 Issue/MR 详情页）。
4. 最后才开始页面自身的业务请求。

服务端逐请求校验成本：`consoleSessionFromRequest()` → `getConsoleSessionByToken()` 是按 `tokenHash` 唯一索引的一次 `findUnique`，写库按 1 小时节流。它不阻塞渲染，也不是用户可感知的“校验”，本次不动。

关于指标：仓库内无线上请求耗时数据。上表链路是从代码确定的请求次数事实（每次详情页切换 = 1 次文档加载 + 至少 5 个启动请求，其中 2 个串行阶段），验收以“切换时启动请求次数为 0”这一确定性指标为准，延迟数据由 Build 阶段用浏览器 DevTools 记录前后对比写进 Build PR，不作为删除任何校验的依据。

## 方案

### 决策 1：问题定位 → 整页刷新导致的 SPA 重启

主要耗时与触发频率见上节。Git provider OAuth refresh 只在 token 临近过期（5 分钟 skew）时发生，是链路 2 的放大因素而不是根因；去掉整页刷新后它只在真正启动或业务 API 需要时发生，语义不变。

### 决策 2：选择“SPA 内导航 + 启动态不再渲染登录页”，不做任何跨请求会话缓存

不采用的选项与理由：

- **前端持久化会话状态（localStorage / sessionStorage 复用登录态）**：多标签页登出、服务端会话被删除或过期时会显示陈旧的已登录 UI，且引入失效同步问题；根因消除后收益很小。
- **服务端跨请求会话缓存（内存 LRU）**：登出或会话删除后在缓存 TTL 内仍可用，多实例部署无法同步失效；单次索引查询本身已很便宜。不做。
- **服务端请求级复用**：每个请求只解析一次会话本已接近成立，收益可忽略，不做。

采用的改动：

1. **统一的应用内导航**（`console/web/src/app-route.ts` 新增 `navigateApp(path, mode)`，以及小组件 `console/web/src/components/app-link.tsx`）：
   - `AppLink` 渲染真实 `<a href>`（保留可复制链接、中键/Ctrl/Cmd/Shift 新开、右键菜单），仅在“左键、无修饰键、无 `target`/`download`、同源”时 `preventDefault` 并调用 `navigateApp`。
   - `navigateApp` 执行 `history.pushState/replaceState` 后派发一个应用内事件（如 `issue-flow:navigate`）；controller 监听该事件与 `popstate`，用同一个处理函数更新 `route` 以及新增的 `location`（pathname + search）state。
   - 把上表中所有同源链接替换为 `AppLink`，`issues-board.tsx` 创建 issue 后的 `window.location.assign` 改为 `navigateApp`。外部链接（`target="_blank"` 的 provider 链接）不动。
2. **App 按 state 渲染详情页**：`App.tsx` 中 `parseIssueRoute()` / `parseMergeRequestRoute()` / `parseVisualArtifactRoute()` 改为基于 controller 暴露的 `location` 计算（而非渲染时读 `window.location`），保证 pushState 后重新渲染；`IssuePage` / `MergeRequestPage` / `VisionPlanPage` 以路由参数作为 `key`，切到另一个 issue/MR 时重置组件内部状态。
3. **扩展现有 `popstate` 处理**：当前只处理 `view === "repos"`；改为统一处理，保证浏览器前进/后退在列表 ↔ 详情之间也不刷新、且不重复触发 `loadGitServerState`（gitServerId 不变时 `[selectedGitServerId, userSession.authenticated]` effect 不会重跑，这是现有行为）。
4. **启动阶段不再闪登录页**（仍需要的场景：用户手动刷新、从外部打开链接）：`App.tsx` 在 `loadingLoginState === true` 时渲染与“正在检查控制台配置”一致的中性加载壳，只有在确认 `authenticated: false` 后才渲染 `LoginPage`。`LoginPage` 的 `loading` 分支保留给“重新加载”按钮。
5. **启动请求去串行**：`/api/setup/status` 与 `loadLoginState()` 并行发起；若 `needsSetup` 为真则忽略登录态结果并跳转 setup。这只改变前端发起时机，两个接口语义不变（未初始化时 `/api/user/session` 本就返回 `authenticated: false`）。
6. **会话失效兜底**：减少整页刷新后，会话过期/他处登出不会再由“刷新时重新检查”顺带发现。在 `api()`（`console/web/src/issue-flow-model.ts`）中，当响应为 401 且 `error === "login_required"` 时派发 `issue-flow:session-expired` 事件；controller 监听后清空 `userSession`/`sessions`/仓库状态（复用 `logoutAll` 的本地清理部分，不再调用 logout 接口），`App` 进而渲染 `LoginPage`。`git_login_required` / `gitlab_login_required`（Git provider 凭据失效）保持现有的按账号提示，不触发 Console 登出。

### 鉴权边界（明确不变）

- 服务端：`currentUserIdFromRequest()`、`getConsoleSessionByToken()` 的过期判断与 1 小时滑动续期、`resolveFreshSession()` 的 refresh skew 与单飞去重、各路由 `login_required` 401 语义，全部不改，`console/api` 无代码改动。
- 前端：不新增任何会话持久化；内存中的 `userSession` 只用于决定渲染哪个页面，所有数据仍由服务端逐请求授权，前端状态错误最多导致显示错页，不会越权读取数据。
- OAuth scope、账号绑定、登录流程（`loginGitLab`、GitHub authorize 跳转仍是整页跳转）不变。

### 决策 3：测试与量化

在 `console/web/test/` 增加（沿用现有 `node --test` + `tsx/cjs` 模式）：

- `app-navigation.test.cjs`：`navigateApp`/`AppLink` 点击判定的纯函数（修饰键、中键、`target`、跨域、同源路径）；上表组件源码不再包含同源裸 `<a href=` 与 `location.assign`（参照 `action-execution.test.cjs` 的源码断言方式），防回归。
- `app-route.test.cjs` 补充：基于传入 location 解析 issue/MR/plan 路由。
- `api` 401 判定：抽出 `isConsoleSessionExpired(status, body)` 纯函数测试，覆盖 `login_required`（触发）与 `git_login_required`/`gitlab_login_required`/其他 401（不触发）。

API 侧：`console/api/test/console-session.test.cjs` 已覆盖有效/过期/滑动续期/删除；Build 若发现缺少“无 cookie / 无效 token / 已删除会话 → 受保护路由 401 `login_required`”的路由级用例，在 `service.test.cjs` 中补一条，用于锁定“本次未放松服务端鉴权”。

量化：Build PR 附 DevTools 记录——在仓库 Overview → Issues → Issue 详情 → MR 详情 → 返回 → 设置 的切换路径上，`document` 加载次数与 `/api/setup/status`、`/api/user/session`、`/api/git-servers`、`/api/session` 请求次数（期望切换期间均为 0），以及首屏启动在并行化前后的耗时。

## 风险与边界

- **路由状态双源**：详情页从“读 window.location”改为“读 controller state”，若遗漏某处仍直接读 `window.location`，会出现 URL 变了页面不变。用源码断言测试与手动路径覆盖兜底。
- **组件残留状态**：详情页之间切换必须带 `key`，否则旧 issue 的评论/编辑态会残留。
- **会话过期的感知变化**：之前过期会在下一次整页刷新时暴露为登录页；现在依赖 `login_required` 事件。若某个受保护接口在未登录时返回的不是 `login_required`（如 `core/installation` 返回 `git_login_required`），则仅显示错误 toast，不会跳登录页——与当前 SPA 内行为一致，不是回退。
- 不做范围：不改 `/api/user/session` 中逐账号 `resolveFreshSession` 的串行循环（若 DevTools 数据显示它是启动慢点，另开 issue 改为并行）。

## 回滚

全部为前端改动、无 schema/API 变化。按改动可独立回退：`AppLink` 替换可逐文件还原为 `<a href>`（行为退回整页刷新）；启动加载壳与并行启动在 `App.tsx`/controller 内各为独立提交；`session-expired` 事件为增量监听，删除即恢复原状。

## 验证

1. `npm test -w issue-flow-web`（新增与更新的用例）、`npm run lint -w issue-flow-web`、`npm run typecheck -w issue-flow-web`、`npm run build -w issue-flow-web`。
2. `npm test -w issue-flow-console`（需 `DATABASE_URL`），确认 console-session / service 测试通过，证明服务端鉴权未变。
3. 手动（`npm run dev`）：
   - 已登录：Issues 列表 ↔ Issue 详情 ↔ MR 详情 ↔ Plan 页 ↔ 设置之间点击、前进/后退，无登录页或“检查控制台配置”闪现，Network 中无 document 请求与启动请求。
   - Ctrl/Cmd/中键点击 Issue 链接在新标签打开，新标签正常启动（显示中性加载壳而非登录页）。
   - 在另一标签登出后回到原标签操作：首个受保护请求返回 `login_required` 后进入登录页；未登录时直接访问 Issue 详情 URL 显示登录页。
   - 手动删除/过期数据库中的 console session 行后操作：同上进入登录页，且不读到数据。
