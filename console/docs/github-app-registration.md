# GitHub App 注册准备

核对日期：2026-10-09。Console 已实现 GitHub App 登录、仓库安装与事件同步。部署本次代码并执行数据库迁移后，使用下面的回调和 webhook 地址。

## Create GitHub App 表单

以 `https://console.example.com` 代表实际 Console 域名；若 API 单独部署，使用能够路由到 API 的公网地址。

| 字段 | 建议值 |
| --- | --- |
| GitHub App name | `Issue Flow <组织名>`，GitHub 全局唯一，最长 34 字符 |
| Description | `Issue Flow Console: manage issues, pull requests, and GitHub Actions integration.` |
| Homepage URL | 实际 Console 首页；尚未部署可暂用本项目公开仓库地址 |
| Callback URL | `https://console.example.com/api/auth/github/callback` |
| Expire user authorization tokens | 保持勾选；后端自动刷新并轮换令牌 |
| Request user authorization (OAuth) during installation | 建议勾选，统一安装与用户授权流程 |
| Enable Device Flow | 不勾选，Console 使用浏览器登录 |
| Setup URL / Redirect on update | 留空；勾选安装时 OAuth 授权后不能填写 Setup URL |
| Webhook → Active | 部署代码和数据库迁移后开启 |
| Webhook URL | `https://console.example.com/webhooks/github` |
| Webhook secret | 开启时生成独立高熵随机值，并在后端配置同一值进行签名验证 |
| SSL verification | 开启 |
| Where can this GitHub App be installed? | 只在 App 所属账号内使用选 `Only on this account`；需要安装到其他个人或组织账号选 `Any account` |

字段含义、安装授权与 Setup URL 互斥关系来自 [GitHub 官方注册说明](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)。关闭 webhook 时不必提供 Webhook URL；开启后需要可接收请求的服务与 secret 校验，见 [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)。安装时仍可选择只授权指定仓库；从 GitHub 返回 Console 或重新激活原标签页后会自动同步，无需单独点刷新。

## Repository permissions

以下为计划覆盖 Console 仓库安装、Issue/PR 作业与状态展示的权限集合。

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| Metadata | Read-only | 仓库元数据与访问范围 |
| Contents | Read and write | 克隆、创建分支、提交安装文件与合并 |
| Workflows | Read and write | 创建或更新 `.github/workflows/` 内的模板文件 |
| Issues | Read and write | Issue、标签及评论作业 |
| Pull requests | Read and write | 安装 PR、工作 PR 与评审作业 |
| Secrets | Read and write | 写入仓库 Actions secrets，如 `AGENTRIX_API_KEY` |
| Variables | Read and write | 写入仓库 Actions variables，如 runner 与 base URL |
| Actions | Read-only | 查询工作流运行状态、接收 workflow run 事件 |

权限和端点映射见 [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)。Git 访问需要 Contents；修改 `.github/workflows` 另外需要 Workflows，不能只配置 Actions，见 [Choosing permissions for Git access](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access)。

当前方案不需要 Repository Administration 或 Repository Webhooks 写权限：GitHub App 在自身注册中配置统一 webhook；Actions 通过仓库事件直接触发。组织权限先保持 No access。用户权限也先保持 No access；若后续实现必须获取用户非公开邮箱，再增加 Email addresses Read-only。基础身份登录不应以非公开邮箱权限作为前提。

若以后增加 Console 主动 dispatch、取消、重试工作流操作，再按具体端点把 Actions 升到 Read and write；当前状态读取不需要这项写权限。

## 开启 webhook 后的事件

建议手动订阅：`Issues`、`Issue comment`、`Pull request`、`Pull request review`、`Pull request review comment`、`Push`、`Repository`、`Workflow run`。用途分别为 Issue/PR 与评论同步、评审同步、安装文件变化及安装状态检查、仓库生命周期和工作流状态同步。后续实现应只保留实际消费的事件。

`installation` 和 `installation_repositories` 由 GitHub App 默认接收，不能手动订阅；启用 webhook 后用于同步安装、卸载与仓库授权增减。官方依据：[Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation)。`Workflow run` 需要至少 Actions Read-only，见同一文档的 [workflow_run](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run)。

此 webhook 用于 Console 状态同步。GitHub Actions 直接响应自身配置的事件，无需通过 Console 的 webhook bridge 触发。

## 创建后需要准备的凭据

保存 App ID、Client ID，生成 Client secret 和 App private key（PEM）。后端 OAuth 登录使用 Client ID/secret；后台仓库访问用 private key 签发 JWT，再换取 installation access token。Webhook secret 是另一份独立凭据。

Private key 的用途与生成操作见 [Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)。凭据放入后端密钥配置，不写入仓库或聊天记录。

## Console 接入与部署

1. 执行 `npm install`、`npm run api:build` 和 `npm run web:build`。
2. 在目标环境配置好数据库后运行 `npm run db:migrate`，应用新增的 `20261009090000_github_app` 迁移，然后重启 Console。既有迁移没有修改。
3. 在管理员的 Git servers 页面添加 GitHub，填写 Base URL、Client ID/secret、App ID、App slug、PEM private key、Webhook secret 与提交作者。私钥加密存储，响应仅包含指纹；修改时留空保留旧值。
4. 使用“连接 GitHub”登录。首次连接且未安装 App 时会自动进入仓库授权；授权返回后自动同步并回到原页面。已有授权时直接同步。账户页显示“已连接 · N 个仓库”，主按钮用于“管理仓库授权”，“重新关联账号”位于更多菜单。GitHub Enterprise Server 使用自己的 Base URL，API 地址自动推导为 `/api/v3`。
5. 选中仓库，运行安装检查。Console 检查 App 权限、App webhook URL、Actions 访问、仓库变量/secrets、标签与插件，创建安装 PR。合并后通过 webhook 更新安装状态。
6. 在 Agentrix 中配置 GitHub 仓库凭据，并将对应 Git Server ID 填入 Console 或仓库的 `AGENTRIX_GIT_SERVER_ID` 变量；选择 Agentrix runner 并配置 API key。GitHub workflows 会把该 ID 传给 Agentrix，App 私钥不会写入 Actions secrets。

Actions 检查验证 API 可访问，实际执行仍受仓库/组织的 Actions 策略限制。变量安装管理仓库级 variables/secrets，不读取组织级 secret 值。GitHub `GITHUB_TOKEN` 产生的普通事件不会再触发其他 workflow；现有 Issue Flow 的 dispatch 脚本直接推进其负责的动作，远端 Agentrix 任务使用其 Git server 凭据。

`/webhooks/github` 使用原始请求体校验 HMAC-SHA256，按 App 密钥和目标 App ID 选择 Git server。记录 delivery ID 并复用已有投影幂等逻辑；不触发 pipeline。安装卸载/仓库移除事件撤销本地仓库授权，仓库事实和历史指标保留。

### 本地登录与公网 webhook

本机浏览器登录时，可以保持 `.env.dev` 中 `ISSUE_FLOW_BASE_URL=http://127.0.0.1:8788`，并在 GitHub App 登记对应的本机 Callback URL。
另设 `ISSUE_FLOW_WEBHOOK_BASE_URL=https://你的公网隧道域名`，GitHub App 的 Webhook URL 填写该地址加 `/webhooks/github`。该配置独立于 OAuth 回调，更新后重启 API。检查会拒绝把 loopback 地址推荐给 GitHub；地址匹配只说明配置一致，真实投递结果仍以 GitHub Recent deliveries 为准。

GitLab 也使用同一 `ISSUE_FLOW_WEBHOOK_BASE_URL`，接收路径为 `/webhooks/gitlab/<repoId>`。仓库返回的 webhook URL、安装检查和自动配置共用此规则。已有 GitLab webhook 地址变化后，检查保留已识别的 hook ID，点击“自动配置”更新原 webhook。未设置该变量时，两种平台都回退到 `ISSUE_FLOW_BASE_URL`；loopback 地址不能作为远端 Git 平台的 webhook 目标。
