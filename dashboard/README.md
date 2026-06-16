# Issue Flow Dashboard

Issue Flow Dashboard 是 issue-flow 的本地观测看板，用 GitLab Issue 作为统计主视角，把 Agentrix `data.bin` 中的 task、人工输入、人工回复和 token 用量关联回 Issue。

## 数据来源

- GitLab Issue：Issue 基础信息、创建/关闭时间、标签流转、状态事件。
- Agentrix `data.bin`：task 事件、用户消息、问题回答、模型 token 用量。
- 本地 SQLite：默认写入 `data/dashboard.db`。

统计以 Issue 为主。Agentrix task 只有能识别到项目和 Issue 编号时，才会汇总到对应 Issue；未关联 task 只作为数据质量提示。

## 快速启动

```bash
cd issue-flow/dashboard
npm install
npm run migrate
npm run dev -- --hostname 127.0.0.1 --port 3001
```

打开：

```text
http://127.0.0.1:3001
```

如果还没有配置 GitLab 项目，首页会自动跳转到 `/settings` 并提示先配置项目。

## 配置 GitLab 项目

进入 `Settings`，在后台采集区域添加项目：

- Project ID：建议填一个稳定的本地 ID，例如 `gitlab-git-lianjia-com:huilian/wandou-kanban`。如果填 GitLab 数字 ID，也可以直接用于 GitLab API。
- Project path：GitLab path with namespace，例如 `huilian/wandou-kanban`。
- Token：GitLab PAT，至少需要读取 Issue、label event、state event 的权限，通常使用 `read_api` 或 `api`。

保存后点击 `手动采集`，或者运行命令：

```bash
npm run collect
```

也可以通过环境变量一次性配置项目，适合部署时使用：

```bash
export DASHBOARD_PROJECTS_JSON='[
  {
    "id": "gitlab-git-lianjia-com:huilian/wandou-kanban",
    "name": "wandou-kanban",
    "provider": "gitlab",
    "baseUrl": "https://git.lianjia.com",
    "pathWithNamespace": "huilian/wandou-kanban",
    "token": "your-gitlab-token"
  }
]'
npm run collect
```

不要把真实 token 提交到仓库。

## 配置文件

默认配置在 `config/app.yml`：

```yaml
database:
  path: data/dashboard.db

gitlab:
  base_url: https://git.lianjia.com

collection:
  lookback_days: 120
  keep_raw_runs: 3

agentrix:
  workspacesDir: ~/.agentrix/workspaces
```

常用环境变量：

- `DASHBOARD_DB_PATH`：覆盖 SQLite 数据库路径。
- `DASHBOARD_PROJECTS_JSON`：用 JSON 配置 GitLab 项目。
- `AGENTRIX_WORKSPACES_DIR`：覆盖 Agentrix workspace 根目录，默认 `~/.agentrix/workspaces`。
- `AGENTRIX_RUNNER_ID`：当前 runner 标识，默认 `local-runner`。
- `DASHBOARD_INGEST_URL`：把 Agentrix 事件 POST 到远端看板，而不是写本地库。
- `DASHBOARD_INGEST_TOKEN`：远端 ingest 接口的 Bearer token。

## 采集 GitLab

```bash
npm run collect
```

当前会拉取每个已配置项目的：

- `/projects/:project/issues?per_page=100&state=all`
- `/projects/:project/issues/:iid/resource_label_events?per_page=100`
- `/projects/:project/issues/:iid/resource_state_events?per_page=100`

注意：当前实现每类接口最多读取 100 条，没有分页。项目 Issue 或事件超过 100 条时，需要后续补分页能力。

## 同步 Agentrix data.bin

先确认 Agentrix 的 `data.bin` 是否能被发现：

```bash
npm run agentrix:sync -- --dry-run
```

默认扫描：

```text
~/.agentrix/workspaces/users/*/{task-*,chat-*}/data/data.bin
```

写入本地 dashboard：

```bash
npm run agentrix:sync
```

同步到远端 dashboard：

```bash
export DASHBOARD_INGEST_URL='https://your-dashboard.example.com/api/ingest/agentrix'
export DASHBOARD_INGEST_TOKEN='your-shared-token'
npm run agentrix:sync
```

如果 `DASHBOARD_INGEST_URL` 不存在，脚本会直接写入本地 `dashboard.db`。

## Agentrix task 如何关联 Issue

同步脚本会尝试从 Agentrix 初始 prompt 或 batch 字段中识别：

- `Project: huilian/wandou-kanban`
- `Number: #3`
- `Issue #3`
- `huilian/wandou-kanban#3`

识别成功后，task 会写入 `agentrix_tasks.project_id` 和 `agentrix_tasks.issue_iid`，并把 human events、token 用量汇总到 `issues`。

如果 task 第一次同步时还没识别到 Issue，后续再次同步识别成功后，会自动回填已有 human events 并重算 Issue 汇总。

## 指标口径

### 主指标

- Issue 创建：统计窗口内创建的 Issue 数。
- Issue 完成：已关闭或存在首次关闭事件的 Issue 数。
- 平均完成：首次关闭时间减创建时间。
- Human 介入：流程 gate + Agentrix 用户消息 + Agentrix 问题回答。
- 自动化动作：issue-flow 自动阶段动作，当前主要统计 plan / build。
- Token 用量：Agentrix task 中模型 `inputTokens + outputTokens`，超过百万显示为 `M`。
- Bug 占比：Bug Issue 数 / 创建 Issue 数。
- Reopen 率：已完成 Bug 中发生 reopen 的比例。

### Human 介入与阶段耗时

- 流程 gate：`Clarify / Approve` 标签次数。
- Agentrix 用户消息：人工输入次数。
- Agentrix 问题回答：Agent 提问后的人工回复次数。
- Intake：`Triage + Clarify` 阶段耗时。
- Plan：`Plan + Approve` 阶段耗时。
- Delivery：`Build` 阶段耗时。

### Issue 明细

Issue 表格按 Issue 维度展示：

- 当前阶段、创建时间、首次关闭、完成时长。
- 关联 task 数。
- Human 次数。
- Token 用量。

`flow::review` 当前不纳入统计。

## 常见排查

### 首页跳转到 Settings

说明当前没有可用 GitLab 项目。需要至少配置一个 active 项目，并且包含 `pathWithNamespace` 和 token。

### GitLab 采集 404

常见原因：

- Project ID 填了本地 ID，但 Project path 错了。
- PAT 无权访问该项目。
- `gitlab.base_url` 不是当前 GitLab 地址。

优先确认 `Project path` 是否是 GitLab 页面中的完整 namespace，例如 `huilian/wandou-kanban`。

### Agentrix 用户消息 / 问题回答一直是 0

先看 dry-run 是否能找到 `data.bin`：

```bash
npm run agentrix:sync -- --dry-run
```

再同步：

```bash
npm run agentrix:sync
```

如果 task 没有关联 Issue，检查 Agentrix 初始 prompt 里是否包含项目 path 和 Issue 编号。看板会把未关联 task 作为数据质量提示展示。

### Token 有值但 Human 为 0

说明 task 已被采到，但没有识别出人工消息或问题回答。可能是 Agentrix 事件结构变化，需要检查 `agentrix_raw_events.payload_json` 中的实际字段。

### 修改配置后没有变化

重启 dev server：

```bash
lsof -ti tcp:3001 | xargs -r kill
npm run dev -- --hostname 127.0.0.1 --port 3001
```

## 验证命令

```bash
npm test
npm run typecheck
npm run build
```

本地开发时，建议每次改采集、汇总或指标口径后至少跑 `npm test`。
