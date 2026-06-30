# Issue Flow 管理页与独立 GitLab Webhook 承接能力

## 背景

`issue-flow` 当前是一个安装到目标代码仓里的 Agentrix runtime/plugin：通过 `install.sh github|gitlab` 写入 `.agentrix/plugins/issue-flow`、`.issue-flow/*`、GitHub workflows 或 GitLab CI include。GitLab 侧目前依赖 Agentrix daemon webhook bridge：GitLab webhook 先打到 Agentrix/daemon，再被转换成 `GITLAB_BRIDGE_*` / `AGENTRIX_*` 变量触发 GitLab pipeline，最后由 CI 里的 issue-flow jobs 调用 `dispatch.cjs`。

现在希望把 issue-flow 做成一个可在公司内部部署的服务：用户通过管理页面添加代码仓和 token，直接把 GitLab webhook 地址指向 issue-flow 服务，而不是依赖 Agentrix 的 GitLab webhook bridge。issue-flow 服务仍可依托 Agentrix 创建/恢复 agent task，但 GitLab webhook 接入、仓库 token、webhook secret、repo 安装/配置应由 issue-flow 自己管理。

## 现有实现要点

### issue-flow 当前能力

- `install.sh` / `bootstrap.cjs` 负责把 runtime 文件安装到目标仓：`.agentrix/plugins/issue-flow`、`.issue-flow/config.json`、prompts/templates/issues，以及 GitHub workflows 或 GitLab CI 文件。
- `skills/issue-flow/scripts/dispatch.cjs` 是自动化入口，支持 `auto`、`comment`、`review`、`review-comment`、`pr-merged`、`pipeline-failed`、`triage`、`plan`、`build`、`general`。
- `providers.cjs` 已支持 GitHub/GitLab provider 检测和 provider API 调用，token 当前主要来自环境变量，如 `GITLAB_TOKEN` / `GL_TOKEN` / `GITLAB_PRIVATE_TOKEN`。
- `events.cjs` 已能把 Agentrix GitLab bridge 环境变量还原成 GitLab-like payload，说明现有 runtime 已经围绕 bridge 变量做过兼容。
- GitLab CI 模板 `issue-flow.gitlab-ci.yml` 已同时识别 `GITLAB_BRIDGE_*` 和 `AGENTRIX_*` 变量，用于 auto/comment/review/review-comment/merged/failure-intake。

### Agentrix 当前 GitLab webhook 能力

- API 路由：`POST /v1/webhooks/:type/:gitServerId?`，GitLab handler 校验 `X-Gitlab-Token` 与 `GitServer.webhookSecret`。
- 入站记录：`WebhookDelivery` / `WebhookDeliveryConsumer` 做 delivery 记录和 consumer 去重。
- Repository Inbox：`repository-inbox-normalizers.ts` 将 GitLab `issue`、`note`、`merge_request` 归一成 inbox commands，包括 assigned、needs_reply、needs_review、resolve 等。
- GitLab side effects：`gitlab-webhook-effects.ts` 对 issue/MR webhook 做 cache invalidation、sync available 事件、MR task PR state 更新。
- Daemon bridge：`cli/src/daemon/gitlabWebhook.ts` 使用 `@xmz-ai/gitlab-webhook-bridge` 将 GitLab webhook 规范化并触发 GitLab pipeline。它保存 webhook secret / project trigger tokens，并提供 dedupe/runtime store。

## 目标

构建 issue-flow 内部部署服务，提供：

1. 管理页面：直接添加、查看、配置和诊断代码仓。
2. 仓库凭据：在 issue-flow 中配置 GitLab token、webhook secret、Agentrix API 配置和自动化策略。
3. 安装管理：能为目标仓安装/升级 issue-flow runtime 文件，减少手工 `curl | bash` 和 CI 变量配置。
4. 独立 webhook：GitLab webhook 直接指向 issue-flow 服务。
5. 事件承接：复用/迁移 Agentrix 中 GitLab webhook normalization、delivery dedupe、repository inbox/event side effects、pipeline failure/review/comment routing 等能力。
6. Agentrix 依托：issue-flow 仍可调用 Agentrix API 创建/恢复 agent task，但 webhook 接入不再要求 Agentrix daemon bridge。

## 建议方向

MVP 不建议继续把 GitLab webhook 转发给 Agentrix daemon。建议在 issue-flow 服务内做一个 `GitLabWebhookGateway`：

- 接收并校验 webhook；
- 记录 delivery 并按 event/action 去重；
- 归一化为 issue-flow runtime 可消费的 event context；
- 由 server 直接执行 `dispatch.cjs` 对应动作，或者在兼容模式下触发 GitLab pipeline；
- provider token 从 issue-flow 的加密凭据库读取，不从 GitLab CI 变量读取；
- Agentrix task 的创建/恢复仍通过 `agentrix-run` 或等价 API adapter，但 Agentrix 不再拥有 GitLab webhook 接入链路。

## 功能范围

### 管理页面

- 仓库列表：显示 provider、项目路径、默认分支、安装状态、webhook 状态、最近 delivery、自动化开关、最后错误。
- 添加仓库向导：GitLab base URL/project path/token/webhook secret/Agentrix API 配置/默认 agent/自动化策略。
- 仓库详情：
  - 基础信息与 token 校验状态；
  - webhook URL 与 secret；
  - runtime 安装/升级状态；
  - label sync 状态；
  - automation 策略：auto default、review enabled、agent；
  - delivery 日志与事件处理结果；
  - 手动重放 webhook / 手动运行 dispatch。

### 后端能力

- Config DB：Git provider、repository、credential、webhook secret、automation config、install manifest、delivery log、dispatch run log。
- GitLab API client：用仓库 token 获取项目、写文件/创建 MR 或 direct commit、创建/更新 labels、读 issue/MR/comment/pipeline/job log。
- Webhook receiver：`POST /webhooks/gitlab/{repositoryId}` 或 tokenized URL，校验 `X-Gitlab-Token`，解析 `X-Gitlab-Event(-UUID)`。
- Normalizer：复用 Agentrix / `@xmz-ai/gitlab-webhook-bridge` 的 GitHub-style event 映射，不在 UI/route 层硬编码工作流语义。
- Dispatcher：将 normalized event 路由到 issue-flow action：auto/comment/review/review-comment/pr-merged/pipeline-failed。
- Credential boundary：token 加密存储；不写入日志、artifact、URL、Agentrix task env；运行时只注入给 provider API layer。

## 关键设计决策

1. **执行位置**：优先 server-side dispatch，CI/pipeline trigger 作为兼容模式。这样才能真正做到 token 配在 issue-flow 服务里，而不是继续要求每个仓配置 `GITLAB_TOKEN` CI variable。
2. **安装内容拆分**：安装 runtime plugin/prompts/templates 与安装 CI workflows 分开。server-side 模式不应强制写 GitLab CI include；兼容模式才写 `.gitlab/issue-flow.gitlab-ci.yml`。
3. **Webhook URL 归属**：GitLab project webhook 指向 issue-flow 服务，例如 `/webhooks/gitlab/{repositoryId}`；Agentrix 不再作为 GitLab webhook bridge 入口。
4. **复用边界**：
   - 可直接复用：`@xmz-ai/gitlab-webhook-bridge` normalization、issue-flow `dispatch.cjs`、`providers.cjs`、`sync-labels.cjs`、Agentrix 的 delivery/consumer 去重思想。
   - 不应照搬：Agentrix API 的 `GitServer`/`RepositoryAccess`/`UserInboxItem` 模型整体；issue-flow 服务需要自己的更轻数据模型。
5. **兼容现有仓**：已安装旧 GitLab CI workflow 的仓库应能继续工作；新服务上线后可逐仓迁移 webhook URL 和 token 配置。

## 验收标准

- 用户可以在管理页添加一个 GitLab 仓库，输入 token 后完成校验并保存。
- 管理页生成该仓库专属 webhook URL 与 secret，并显示 GitLab 侧需要配置的事件类型。
- GitLab webhook 直接发到 issue-flow 后，服务能：
  - 校验 secret；
  - 记录 delivery；
  - 对重复 delivery 做幂等处理；
  - 将 issue opened/labeled、issue comment、MR opened/synchronize/ready_for_review/merged、MR note、pipeline failed 路由到正确 issue-flow action；
  - 使用 issue-flow 中保存的仓库 token 调用 GitLab API；
  - 必要时调用 Agentrix 创建或恢复 task。
- 不需要 Agentrix daemon webhook bridge 就能跑通 GitLab issue-flow 自动化。
- token/webhook secret 不出现在日志、前端明文回显、Agentrix task env、计划 artifact 或错误报告中。
- 有单测覆盖 GitLab webhook normalization、secret 校验、delivery dedupe、action routing、credential 注入边界。

## 非目标 / 延后

- 首版不做多租户计费或公开 SaaS。
- 首版不要求完全替代 Agentrix Repository Inbox UI；可以只做 issue-flow 自动化所需的 delivery/run 诊断。
- GitHub webhook 独立接入可以用同一架构预留，但本阶段优先 GitLab。
- 不要求首版同时支持所有 GitLab system hook；以 project webhook 的 issue/note/merge_request/pipeline 为主。
