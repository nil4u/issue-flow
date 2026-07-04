# plugin/test/
> L2 | 父级: /CLAUDE.md

成员清单
agentrix-runtime.test.cjs: Agentrix runtime prompt、run args、resume 与 task comment 的行为测试。
bootstrap.test.cjs: install/bootstrap 生成文件、manifest、三方冲突规则、plan/decision 与 provider workflow 的行为测试。
cli.test.cjs: 统一 CLI help、dry-run envelope 与命令路由测试。
create-issue.test.cjs: issue create 参数解析、managed label 与 task marker 测试。
dispatch.test.cjs: issue/PR/MR event dispatch、自动流转与 review resume 测试。
gitlab-ci-include.test.cjs: GitLab 根 CI 顶层 include 转换器（list/scalar/map/complex）与字节保真测试。
install.test.cjs: install.sh checkout source、GitHub/GitLab 安装路径、plan-json/decision-file 协议与 dry-run 测试。
intake.test.cjs: issue intake 默认标签与 provider repo hint 测试。
labels.test.cjs: managed label catalog 与 apply 规则测试。
merged.test.cjs: merged PR/MR source issue transition 测试。
pipeline-failed.test.cjs: CI failure intake、fingerprint 与 root-cause analysis 测试。
providers.test.cjs: GitHub/GitLab provider API、CLI fallback、review comment 与 label sync 测试。
resolve.test.cjs: mention、automation decision 与 flow action 解析测试。
review.test.cjs: review CLI parser、provider review submission 与 stale-head guard 测试。
submit.test.cjs: PR/MR submit、source marker、base branch 与 push auth 测试。
sync-labels.test.cjs: label sync parser、dry-run 与 drift detection 测试。
integration/integration.test.cjs: provider lifecycle 集成场景测试，默认不在 npm test 中运行。
integration/integration-lifecycle.test.cjs: 真实远端 lifecycle 集成测试，默认不在 npm test 中运行。
CLAUDE.md: 本目录的 L2 地图，记录测试文件职责。

依赖边界
*.test.cjs -> ../skills/issue-flow/scripts/*、../skills/issue-flow/assets/*、../install.sh。
integration/*.test.cjs -> 真实 provider/远端环境，默认由 npm run test:integration 单独执行。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
