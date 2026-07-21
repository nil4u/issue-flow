# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Issue Flow Monorepo

npm-workspaces monorepo(Node 22),两个独立版本管理的产品加根级 dogfooding 状态:

- `plugin/` — issue-flow 插件/CLI 产品(标签驱动的 issue 状态机与确定性 provider 操作)
- `console/` — 管理控制台产品(`console/api` Fastify + Prisma API 服务,`console/web` Vite/React 前端)
- 根级 `.agentrix/`、`.agents/skills/`、`.claude/skills/`、`.issue-flow/`、`.github/agentrix/`、`.github/workflows/issue-flow-*.yml` — 本仓库给自己安装的插件运行时(dogfooding),由安装器生成,不手工编辑;安装的插件副本在 `.agentrix/plugins/issue-flow/`,Codex/Claude Code skill 与统一 CLI 通过相对 symlink 指向该副本,`.issue-flow/install-manifest.json` 记录文件与链接状态

## Structure

- `plugin/package.json` — npm 包 `issue-flow`(bin 入口指向 `skills/issue-flow/cli.cjs`,零外部依赖,仅 Node.js 内置模块)
- `plugin/.claude-plugin/plugin.json` — 插件 manifest
- `plugin/install.sh` — 安装器入口(README 的 curl URL 指向它;clone 模式下探测 monorepo 的 `plugin/` 子目录,并对旧 tag 布局回退)
- `plugin/skills/issue-flow/SKILL.md` — 单一 skill 入口(agent-facing);`cli.cjs` 是统一 CLI 前门
- `plugin/skills/issue-flow/scripts/` — 确定性 CJS 脚本(路径全部相对自身,可整体平移)
- `plugin/docs/` — 插件人类文档(状态机、provider API)
- `plugin/test/` — 插件单元测试;`plugin/test/integration/` 为真实远端集成测试(默认不跑)
- `console/api/` — API 服务源码、`prisma/` migrations、独立 package.json(`issue-flow-console`)
- `console/web/` — web 控制台(workspace `issue-flow-web`,不独立发版;React 19 + Vite + Tailwind 4 + shadcn/radix + echarts)
- `console/scripts/` — dev/web 编排脚本;`console/docker-compose.yml` — 本地 Postgres
- `scripts/` — 根级仓库自动化辅助脚本,目前用于 release-please 前置提交信号校验
- `test/` — 根级测试,仅发布配置契约(release-config)
- `.github/workflows/` — 仓库自动化:issue-flow 运行时 job、release-please、test.yml 测试门禁

部分目录有嵌套 CLAUDE.md(`.github/`、`test/`、`plugin/test/`、`console/api/test/`、`plugin/skills/issue-flow/scripts/runtimes/` 等),带 `[PROTOCOL]` 头与成员清单;改动对应目录时同步更新。

## Development

```bash
npm run db:up          # Docker Compose 启动 Postgres
npm run db:migrate:dev # Prisma migrations(cwd 委托到 console/api,读 .env.dev)
npm run dev            # API + web 一起起
npm test               # 根 release-config + plugin 单测 + console/api 测试(需要 DATABASE_URL;web 无 test 脚本)
```

测试全部用 Node 内置 test runner(`node --test`),测试文件为 `test/*.test.cjs`。跑单个测试文件:`node --test path/to/foo.test.cjs`;按名称过滤:`node --test --test-name-pattern "<regex>"`。跑单 workspace:`npm test -w issue-flow` / `npm test -w issue-flow-console`。

其他常用检查:

```bash
npm run build -w issue-flow-console   # console/api 的 typecheck 门禁(prisma generate + tsc),CI 同款
npm run lint -w issue-flow-web        # web eslint
npm run typecheck -w issue-flow-web   # web tsc --noEmit
npm run test:integration              # plugin 真实远端集成测试(需要 GITHUB_TOKEN/GITHUB_TEST_REPO、GITLAB_TOKEN/GITLAB_TEST_PROJECT 等)
```

脚本约定:根 package.json 只做 workspace 委托与编排;env 文件留在仓库根,workspace 内脚本用 `../../.env*` 相对引用。`.env.dev` 供 dev/测试/migrate:dev 使用(含本地 `DATABASE_URL`);`.env` 供生产部署与 `db:migrate`(deploy)使用;两者各有 `.example`。console/api 测试里 `metrics`、`service` 等需要真实 Postgres,其余为纯逻辑测试。

数据库迁移纪律:`console/api/prisma/migrations/` 下已经存在的 Prisma migration 是追加式历史,开发中禁止修改旧迁移文件;任何 schema 变化必须新增一个后续 migration 文件承接。

## Architecture

插件脚本是 CommonJS(.cjs),除 Node.js 内置模块外无外部依赖。Provider 操作走 token 直连 REST/GraphQL 或 `gh`/`glab` CLI fallback(内部自动选择)。关键脚本分工:

- `providers.cjs` — GitHub/GitLab provider 抽象(所有远端操作的唯一实现)
- `resolve.cjs` — 纯路由/决策逻辑(auto + resume),无副作用
- `dispatch.cjs` — auto/comment/review/review-comment/resume/pipeline-failed 各事件入口
- `apply.cjs`、`intake.cjs`、`create-issue.cjs`、`submit.cjs`、`review.cjs`、`pr-merged.cjs`、`pipeline-failed.cjs`、`sync-labels.cjs` — 具体状态机操作
- `runtimes/agentrix.cjs` — Agentrix 运行时适配(组装 prompt/run/resume 参数)
- `bootstrap.cjs`、`bootstrap-links.cjs` — 安装/初始化编排与 managed symlink 状态机

状态机(详见 `plugin/docs/state-machine.md`):标签前缀 `type::`、`status::`、`flow::`(triage/plan/build/clarify/approve)、`automation::`、`priority::`、`size::`,同前缀互斥;`flow::clarify` 与 `flow::approve` 是人工闸门,绝不自动执行。PR 合并转换:`mr-by::plan` → `flow::build`,`mr-by::build` → `status::done`。plan/build 前必须恰好一个 `size::` 标签。

console/api:`src/app.ts` 组装 Fastify,静态托管 `console/web/dist`(SPA fallback)并注册 `src/routes/` 下路由;业务逻辑集中在 `src/core/`(gitlab 同步、issue/PR/task projection、metrics SQL、dashboards、agentrix 转发等);`src/storage/` 是 Prisma(pg adapter)封装;另有 WebSocket 的 agentrix forward 通道。生产模式下 web 与 API 同源,前端 `API_BASE_URL` 回退到 `window.location.origin`(cookie session,`credentials: "include"`)。

## Key Conventions

- 提交信息用 Conventional Commits(`type(scope): subject`),详见根 `AGENTS.md`;纯结构调整、不改行为的提交用 `chore:`/`refactor:` 前缀,避免触发发版
- 统一 `issue-flow` CLI 是 agent-facing 的 provider 操作入口;直接 `gh`/`glab` 或手写 provider API 调用仅是内部 fallback 细节
- 插件脚本是确定性行为的 source of truth,全部支持 `--dry-run`
- SKILL.md 是 agent-facing 使用指南(保持精炼);`plugin/docs/` 与 `console/docs/` 是人类文档
- Release Please 双包独立发版:`plugin/` → `issue-flow`(tag `vX.Y.Z`,兼容 `ISSUE_FLOW_REF` pin 安装);`console/api/` → `issue-flow-console`(tag `console-vX.Y.Z`)。发布 PR 保持 `plugin/package.json`、`plugin/skills/issue-flow/SKILL.md`、`plugin/.claude-plugin/plugin.json`、`.release-please-manifest.json` 与对应 CHANGELOG 同步
- `console/api` 读取插件最新版本号时以 `plugin/package.json` 为准(升级提示语义)
