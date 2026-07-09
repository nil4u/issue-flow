# console/api/test/
> L2 | 父级: /CLAUDE.md

成员清单
agentrix-forward.test.cjs: agentrix forward 接收端 hello/events/ack 会话协议的纯逻辑测试，用 fake store，不需要数据库（真实 ws 端到端在 metrics.test.cjs）。
console-session.test.cjs: console session token 生成/哈希与 store CRUD（过期、touch 节流、滑动续期、单端删除）的纯逻辑测试，用 fake db，不需要数据库。
gitlab-bootstrap.test.cjs: 插件安装 MR 冲突流（plan 冲突终止、decision 临时文件、exit 4 重新出计划）的 stub 测试，不需要数据库。
metrics-sql.test.cjs: 只读 metrics SQL 校验、参数绑定与 MR 快照解析的纯逻辑测试。
metrics.test.cjs: issue_stats 重建、pull_requests/tasks/task_events 投影、metric views 与 dashboard API 的 Postgres 集成测试。
plugin-paths.test.cjs: 插件目录解析与 ISSUE_FLOW_PLUGIN_DIR 覆盖的纯逻辑测试。
service.test.cjs: console/api Fastify 服务、GitLab 控制台流程、插件安装状态 webhook 投影的 Postgres 集成测试；含 console session 场景（OAuth 回调签发 sid、伪造明文 cookie 无效、旧 cookie 零读取、git 凭证过期不掉登录态、登出/断开语义、Agentrix 解耦与旧键迁移）。
task-projection.test.cjs: forward create-task/resume-task 信封的 issue↔task 链接提取与 forward 事件到 task 生命周期/task_events 映射的纯逻辑测试。
CLAUDE.md: 本目录的 L2 地图，记录测试文件职责。

依赖边界
*.test.cjs -> ../src/*(经 tsx/cjs 加载)。
metrics.test.cjs、service.test.cjs -> ../prisma/migrations/*，需要 DATABASE_URL 指向可用 Postgres(优先 process.env，回退根 .env.dev)。
service.test.cjs -> plugin/package.json(插件最新版本号断言，与 src/core/gitlab-webhook.ts 的来源保持一致)。
gitlab-bootstrap.test.cjs -> 替换 child_process.execFile 与 global.fetch，模块加载前注入占位 DATABASE_URL。
console-session.test.cjs -> 模块加载前注入占位 DATABASE_URL，store 用 options.db 注入 fake db。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
