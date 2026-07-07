# Issue Flow Monorepo

npm-workspaces monorepo,两个独立版本管理的产品加根级 dogfooding 状态:

- `plugin/` — issue-flow 插件/CLI 产品(标签驱动的 issue 状态机与确定性 provider 操作)
- `console/` — 管理控制台产品(`console/api` Fastify + Prisma API 服务,`console/web` Vite/React 前端)
- 根级 `.agentrix/`、`.issue-flow/`、`.github/workflows/issue-flow-*.yml` — 本仓库给自己安装的插件运行时(dogfooding),由安装器生成,不手工编辑

## Structure

- `plugin/package.json` — npm 包 `issue-flow`(bin 入口,零外部依赖,仅 Node.js 内置模块)
- `plugin/.claude-plugin/plugin.json` — 插件 manifest
- `plugin/install.sh` — 安装器入口(README 的 curl URL 指向它;clone 模式下探测 monorepo 的 `plugin/` 子目录,并对旧 tag 布局回退)
- `plugin/skills/issue-flow/SKILL.md` — 单一 skill 入口(agent-facing)
- `plugin/skills/issue-flow/scripts/` — 确定性 CJS 脚本(路径全部相对自身,可整体平移)
- `plugin/docs/` — 插件人类文档(状态机、provider API)
- `plugin/test/` — 插件单元测试;`plugin/test/integration/` 为真实远端集成测试(默认不跑)
- `console/api/` — API 服务源码、`prisma/` migrations、独立 package.json(`issue-flow-console`)
- `console/web/` — web 控制台(workspace `issue-flow-web`,不独立发版)
- `console/scripts/` — dev/web 编排脚本;`console/docker-compose.yml` — 本地 Postgres
- `scripts/` — 根级仓库自动化辅助脚本,目前用于 release-please 前置提交信号校验
- `test/` — 根级测试,仅发布配置契约(release-config)
- `.github/workflows/` — 仓库自动化:issue-flow 运行时 job、release-please、test.yml 测试门禁

## Development

```bash
npm run db:up          # Docker Compose 启动 Postgres
npm run db:migrate:dev # Prisma migrations(cwd 委托到 console/api)
npm run dev            # API + web 一起起
npm test               # 根 release-config + plugin 单测 + console 测试(console 测试需要 DATABASE_URL)
```

脚本约定:根 package.json 只做 workspace 委托与编排;`.env`/`.env.dev` 留在仓库根,workspace 内脚本用 `../../.env*` 相对引用。

数据库迁移纪律:`console/api/prisma/migrations/` 下已经存在的 Prisma migration 是追加式历史,开发中禁止修改旧迁移文件;任何 schema 变化必须新增一个后续 migration 文件承接。

插件脚本是 CommonJS(.cjs),除 Node.js 内置模块外无外部依赖。Provider 操作走 `gh`/`glab` CLI 或 Node 内置 fetch 直连 HTTP。

## Key Conventions

- 统一 `issue-flow` CLI 是 agent-facing 的 provider 操作入口;直接 `gh`/`glab` 或手写 provider API 调用仅是内部 fallback 细节
- 插件脚本是确定性行为的 source of truth,全部支持 `--dry-run`
- SKILL.md 是 agent-facing 使用指南(保持精炼);`plugin/docs/` 与 `console/docs/` 是人类文档
- Release Please 双包独立发版:`plugin/` → `issue-flow`(tag `vX.Y.Z`,兼容 `ISSUE_FLOW_REF` pin 安装);`console/api/` → `issue-flow-console`(tag `console-vX.Y.Z`)。发布 PR 保持 `plugin/package.json`、`plugin/skills/issue-flow/SKILL.md`、`plugin/.claude-plugin/plugin.json`、`.release-please-manifest.json` 与对应 CHANGELOG 同步
- `console/api` 读取插件最新版本号时以 `plugin/package.json` 为准(升级提示语义)
- 纯结构调整、不改行为的提交用 `chore:`/`refactor:` 前缀,避免触发发版
