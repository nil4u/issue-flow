# 功能配置

## 评论作者黑名单

通过环境变量 `ISSUE_FLOW_COMMENT_AUTHOR_BLACKLIST` 配置需要屏蔽的账号名，以逗号分隔，例如：

```text
ci-bot,security-bot
```

未配置或留空时默认不屏蔽。

### 配置方式

- **GitLab**：在 Console 选择目标 repo，进入 **Settings → Variables**，设置该变量。保存后通过现有变量配置接口写入该 GitLab 项目的 CI/CD 变量；各 repo 分别配置。清空后保存即可取消屏蔽。
- **GitHub**：在仓库 **Settings → Secrets and variables → Actions → Variables** 新增同名 repository variable。安装器生成的 `issue-flow-comment.yml` 与 `issue-flow-pr-review-comment.yml` 会把 `vars.ISSUE_FLOW_COMMENT_AUTHOR_BLACKLIST` 传给 dispatch；旧版本生成的 workflow 需要重新安装或手工补上该 env。

### 行为

Plugin 的 `dispatch comment` 和 `dispatch review-comment` 在执行评论任务前读取该环境变量。命中黑名单就正常退出，返回 `action: skipped`、`reason: comment_author_blacklisted`，不回应评论、不创建或恢复任务。未命中时继续原有流程。Console Webhook 不参与过滤。

支持 Issue 评论、普通 PR/MR 评论及行内评论。非评论 job 和 `review::off` 等现有行为不变。

### 匹配规则

账号名按完整名称匹配，忽略大小写及首尾空白，不支持通配符、子串或评论正文匹配。GitHub 使用评论作者的 login。GitLab 使用评论作者的 username，缺失时回退到 display name；display name 不唯一且可由用户自行修改，仅作兜底，黑名单请填写 username。

GitLab 场景下 Console Webhook 将真实评论作者透传为流水线变量 `GITLAB_BRIDGE_COMMENT_AUTHOR`，plugin 直接读取，不额外查询 GitLab API。作者缺失时不匹配黑名单，不使用流水线执行者代替。

### 升级与兼容

- 已有仓库需要升级 plugin 后才会过滤。
- 新 plugin 搭配旧 Console：Webhook 不透传作者，plugin 读到的作者为空，黑名单永不命中，其余行为不变。
- 旧 plugin 搭配新 Console：多出的流水线变量被忽略，行为不变。
