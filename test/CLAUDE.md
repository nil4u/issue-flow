# test/
> L2 | 父级: /CLAUDE.md

成员清单
release-config.test.cjs: release-please 双包 config、manifest、SKILL version marker、workspace 布局与 workflow 入口测试。
CLAUDE.md: 本目录的 L2 地图，记录测试文件职责。

依赖边界
release-config.test.cjs -> 根 package.json、release-please-config.json、.release-please-manifest.json、plugin/package.json、plugin/skills/issue-flow/SKILL.md、plugin/.claude-plugin/plugin.json、console/api/package.json、.github/workflows/release-please.yml。
插件行为测试位于 plugin/test/，console API 测试位于 console/api/test/。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
