# workflows/
> L2 | 父级: /.github/CLAUDE.md

成员清单
auto-version-bump.yml: develop -> main PR label 入口，把 plugin/console 版本变更提交回当前 PR 的 develop head。
docker-image.yml: main push/workflow_dispatch 入口，创建版本 tag 并只构建一次 console 镜像推送到 GitHub Container Registry。
issue-flow-auto.yml: GitHub issue opened/labeled 入口，执行 intake 与自动路由。
issue-flow-comment.yml: GitHub issue comment 入口，响应人工 `@agentrix` 触发。
issue-flow-labels.yml: GitHub push/workflow_dispatch 入口，同步 managed labels。
issue-flow-pr-merged.yml: GitHub PR closed 入口，处理 plan/build PR merge 后的 source issue 流转。
issue-flow-pr-review-comment.yml: GitHub PR review comment 入口，恢复已有 Agentrix review task。
issue-flow-pr-review.yml: GitHub PR review 入口，按开关触发 Agentrix review。
sync-version-labels.yml: main/develop push/workflow_dispatch 入口，同步 plugin/console 版本 label。
test.yml: PR 与 main/develop push 入口，plugin 与 console 各自独立 job 运行测试与构建门禁。
CLAUDE.md: 本目录的 L2 地图，记录 workflow 职责与边界。

依赖边界
auto-version-bump.yml -> scripts/bump-release-version.cjs、plugin/package.json、plugin/skills/issue-flow/SKILL.md、plugin/.claude-plugin/plugin.json、console/api/package.json。
sync-version-labels.yml -> GitHub labels。
docker-image.yml -> plugin/package.json、console/api/package.json、console/Dockerfile、package-lock.json、console/api、console/web、plugin。
test.yml -> npm workspaces(plugin、console/api、console/web)、Postgres service 容器、根 test/。
issue-flow-*.yml -> .agentrix/plugins/issue-flow、.issue-flow、GitHub event payload。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
