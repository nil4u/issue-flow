# console/api/test/
> L2 | 父级: /CLAUDE.md

成员清单
metrics-sql.test.cjs: 只读 metrics SQL 校验、参数绑定与 MR 快照解析的纯逻辑测试。
metrics.test.cjs: issue_stats 重建、pull_requests 投影、metric views 与 dashboard API 的 Postgres 集成测试。
service.test.cjs: console/api Fastify 服务与 GitLab 控制台流程的 Postgres 集成测试。
CLAUDE.md: 本目录的 L2 地图，记录测试文件职责。

依赖边界
*.test.cjs -> ../src/*(经 tsx/cjs 加载)。
metrics.test.cjs、service.test.cjs -> ../prisma/migrations/*，需要 DATABASE_URL 指向可用 Postgres(优先 process.env，回退根 .env.dev)。
service.test.cjs -> plugin/package.json(插件最新版本号断言，与 src/core/gitlab-webhook.ts 的来源保持一致)。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
