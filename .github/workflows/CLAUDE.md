# workflows/
> L2 | 父级: /.github/CLAUDE.md

成员清单
docker-image.yml: console-v* tag/workflow_dispatch 入口，构建 console 单镜像并推送到 GitHub Container Registry。
issue-flow-auto.yml: GitHub issue opened/labeled 入口，执行 intake 与自动路由。
issue-flow-comment.yml: GitHub issue comment 入口，响应人工 `@agentrix` 触发。
issue-flow-failure-intake.yml: GitHub workflow_run failure 入口，创建或更新 CI failure issue。
issue-flow-labels.yml: GitHub push/workflow_dispatch 入口，同步 managed labels。
issue-flow-pr-merged.yml: GitHub PR closed 入口，处理 plan/build PR merge 后的 source issue 流转。
issue-flow-pr-review-comment.yml: GitHub PR review comment 入口，恢复已有 Agentrix review task。
issue-flow-pr-review.yml: GitHub PR review 入口，按开关触发 Agentrix review。
release-please.yml: GitHub main push/workflow_dispatch 入口，维护 plugin 与 console 两个包的 release PR、CHANGELOG、tag 与 GitHub Release。
test.yml: PR 与 main/develop push 入口，plugin 与 console 各自独立 job 运行测试与构建门禁。
CLAUDE.md: 本目录的 L2 地图，记录 workflow 职责与边界。

依赖边界
release-please.yml -> release-please-config.json、.release-please-manifest.json、plugin/package.json、plugin/skills/issue-flow/SKILL.md、plugin/.claude-plugin/plugin.json、console/api/package.json、CHANGELOG 文件。
docker-image.yml -> console/Dockerfile、package-lock.json、console/api、console/web、plugin。
test.yml -> npm workspaces(plugin、console/api、console/web)、Postgres service 容器、根 test/。
issue-flow-*.yml -> .agentrix/plugins/issue-flow、.issue-flow、GitHub event payload。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
