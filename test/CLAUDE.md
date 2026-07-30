# test/
> L2 | 父级: /CLAUDE.md

成员清单
release-config.test.cjs: label 驱动的双包版本 bump、版本元数据同步与 image workflow 入口测试。
CLAUDE.md: 本目录的 L2 地图，记录测试文件职责。

依赖边界
release-config.test.cjs -> plugin/package.json、plugin/skills/issue-flow/SKILL.md、plugin/.claude-plugin/plugin.json、console/api/package.json、scripts/bump-release-version.cjs、.github/workflows/auto-version-bump.yml、.github/workflows/docker-image.yml。
插件行为测试位于 plugin/test/，console API 测试位于 console/api/test/。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
