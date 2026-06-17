## 已知症状

1. Issue #7 描述的目标是所有 Git provider 操作都应优先使用 token 直接调用 provider API；只有没有可用 token 时才 fallback 到 `gh`/`glab` CLI。
2. Issue #7 指出当前 GitHub issue apply 路径已经是 token-first，但 `submit.cjs` 的 GitHub PR/MR 发布路径仍直接依赖 `gh label list/create`、`gh pr list`、`gh api`、`gh pr edit`、`gh pr create`。
3. Issue #7 的用户可见失败是：即使环境里有 `GITHUB_TOKEN`，只要没有 `gh` 二进制，`submit.cjs` 的 GitHub PR 创建或更新仍会失败。
4. 仓库文档 `docs/provider-api.md` 已声明 GitHub token 读取顺序为 `GITHUB_TOKEN` -> `GH_TOKEN`，无 token 时才尝试 `gh` CLI fallback；但同一文档的 `submit.cjs` 行为仍写着 GitHub label 依赖 `gh label create`，与 token-first 目标不一致。
5. 仓库代码中 `skills/issue-flow/scripts/providers.cjs` 的 GitHub apply 辅助函数通过 `requestGithubForApply()` 实现 token-first、无 token 才 `requestGithubWithGh()` fallback。
6. 仓库代码中 `skills/issue-flow/scripts/providers.cjs` 的 GitLab MR 创建/更新通过 `requestGitlab()` 执行；`requestGitlab()` 在有 `GITLAB_TOKEN`/`GL_TOKEN`/`GITLAB_PRIVATE_TOKEN`/`CI_JOB_TOKEN` 时走 HTTP API，无 token 时才 fallback 到 `glab`。
7. 仓库代码中 `skills/issue-flow/scripts/submit.cjs` 的 GitHub label ensure、已有 PR 查询、PR 更新、PR 创建路径直接调用 `gh`，没有先检查或使用 `GITHUB_TOKEN`/`GH_TOKEN`。
8. 现有 `test/submit.test.cjs` 只覆盖 PR body marker、head filter、duplicate PR 错误识别、tracked body file 检查和 title normalization，没有覆盖“有 token 时不得调用 `gh`”或“无 token 时 fallback `gh`”。

## 根因分析

我认为根因是 `skills/issue-flow/scripts/submit.cjs` 中 `ensureGithubLabel()`、`findExistingPullRequest()`、`editPullRequest()` 和 `createOrUpdatePullRequest()` 的 GitHub 分支，因为这些函数绕过 `providers.cjs` 里已有的 GitHub token/API 抽象，直接执行 `gh` 命令处理 label、PR 查询、PR 编辑和 PR 创建。

完整因果链：

1. `submit.cjs` 负责 plan/build PR/MR 发布，并在发布前后执行 label ensure、已有 PR 查询、创建或更新 PR/MR、source issue flow 转移。
2. 对 GitLab，`createOrUpdatePullRequest()` 会委托给 `provider.createOrUpdateMergeRequest()`；该实现位于 `providers.cjs`，底层使用 `requestGitlab()`，因此 GitLab MR 路径已经具备 token-first 和 `glab` fallback。
3. 对 GitHub，`createOrUpdatePullRequest()` 没有委托 provider；它在 `submit.cjs` 内部直接调用 `findExistingPullRequest()`、`editPullRequest()` 和 `runChecked('gh', ['pr', 'create', ...])`。
4. `ensureMergeRequestLabel()` 在 provider 为 GitHub 时直接调用 `ensureGithubLabel()`；该函数使用 `gh label list` 和 `gh label create`，没有 token API 路径。
5. 因此，环境中即使存在 `GITHUB_TOKEN` 或 `GH_TOKEN`，这些 GitHub submit 操作仍需要本机安装并配置 `gh`。没有 `gh` 时，label ensure 或 PR 创建/更新会在调用 CLI 的位置失败。
6. 该根因解释了所有已知症状：apply 路径正常是因为它有 `requestGithubForApply()`；GitLab submit/MR 路径较一致是因为它已走 provider API；GitHub submit 路径失败是因为它保留了 CLI-only 实现；测试未阻止回归是因为缺少 token-first/no-token fallback 两类覆盖。

## 修复方案

1. 在 `skills/issue-flow/scripts/providers.cjs` 中补齐 GitHub PR/MR submit 所需的 provider API 能力：
   - 暴露可复用的 GitHub token 检测和 request helper，或新增只面向 submit 的 GitHub API 方法。
   - 新增 `ensurePullRequestLabel(repo, label, config, options)`：有 token 时使用 GitHub REST API 查询 `GET /repos/{owner}/{repo}/labels/{name}`，404 时 `POST /repos/{owner}/{repo}/labels` 创建；无 token 时 fallback 到现有 `gh label list/create` 等价行为。
   - 新增 `findExistingPullRequest(repo, headBranch, options)`：有 token 时使用 `GET /repos/{owner}/{repo}/pulls?head=<owner>:<branch>&state=open`；无 token 时 fallback 到现有 `gh pr list` + `gh api` 查询。
   - 新增 `createOrUpdatePullRequest({ repo, title, bodyFile, label, baseBranch, headBranch, draft, options })`：有 token 时用 `POST /repos/{owner}/{repo}/pulls` 创建 PR、用 `PATCH /repos/{owner}/{repo}/pulls/{number}` 更新标题/body、用 issue labels API 添加 `mr-by::*` label；无 token 时 fallback 到现有 `gh pr create/edit`。
   - 保留现有 duplicate PR 错误处理语义：创建返回“已有 PR”时重新查询并更新已有 PR。
2. 收敛 `skills/issue-flow/scripts/submit.cjs`：
   - 移除或降级 GitHub 专用 CLI helper，只保留 submit 流程编排、body marker、branch/base 校验、push 和 issue flow apply。
   - `ensureMergeRequestLabel()` 改为调用 provider 方法；GitLab 可继续 no-op 或在后续扩展为 API label ensure。
   - `createOrUpdatePullRequest()` 对 GitHub/GitLab 都委托 provider，避免 GitHub submit 再绕过 provider token 策略。
3. 更新文档：
   - 在 `docs/provider-api.md` 中明确 submit 的 GitHub label、PR 查询、PR 创建/更新均遵循 `GITHUB_TOKEN` -> `GH_TOKEN` -> CLI fallback。
   - 说明所需权限：GitHub token 需要 repository contents push 权限仍由 git remote/credentials 负责，API 侧需要 pull request 和 issue/label 写权限；GitLab token 需要 merge request 和 issue/label 写权限。
   - 明确失败行为：有 token 时 API 认证/授权失败应直接暴露 API 错误，不应静默 fallback 到 CLI；只有 token 不存在时才尝试 CLI fallback。
4. 保持边界：
   - 不改变 `apply.cjs` 的 managed label 语义。
   - 不改变 submit 的 branch、body marker、title normalization、`mr-by::*` label 和 source issue `flow::approve` 行为。
   - 不把 PR body 临时文件纳入 git。

## 验证方案

- 回归用例：
  - 新增 GitHub submit provider 单元测试：设置 `GITHUB_TOKEN`，mock/stub GitHub API 请求，断言 label ensure、已有 PR 查询、PR 更新、PR 创建路径不调用 `gh`。
  - 新增 GitHub fallback 单元测试：清空 `GITHUB_TOKEN`/`GH_TOKEN`，stub `spawnSync('gh', ...)`，断言无 token 时仍调用 `gh` fallback 并保持现有参数语义。
  - 新增 duplicate PR 场景测试：API create 返回已有 PR/validation 类错误时，重新查询并更新已有 PR。
  - 保留现有 `test/submit.test.cjs` 的 head filter、tracked body file、body marker 和 title normalization 覆盖。
- 手动验证：
  - 在没有 `gh` 的环境中设置 `GITHUB_TOKEN`，运行 `submit.cjs plan --dry-run` 确认 dry-run 无 CLI 依赖；在可用测试仓库中运行非 dry-run，确认 PR 创建/更新成功且 PR 上有 `mr-by::plan`。
  - 在清空 token 且安装/登录 `gh` 的环境中运行同一路径，确认 CLI fallback 可用。
  - 对 GitLab token 路径执行一次现有 lifecycle/integration 测试，确认委托 provider 后没有影响 MR 创建/更新。
- 需要补充的测试：
  - submit GitHub token-first 路径。
  - submit GitHub no-token CLI fallback 路径。
  - submit GitHub API 认证失败不 fallback CLI 的错误行为。
  - 文档断言可通过现有 docs review 或快照外的直接检查完成。

## 风险与边界

- GitHub REST API 创建 PR 与 `gh pr create` 在错误消息和 draft 支持上有差异；实现需要显式处理 draft 字段和已有 PR 查询，避免破坏当前 duplicate update 行为。
- GitHub label API 中 label 名称需要 URL encode；`mr-by::plan`、`mr-by::build` 含冒号，测试必须覆盖。
- API token 权限不足时应直接失败，而不是 fallback 到 CLI，否则会掩盖认证配置问题并违背 token-first 的可预测性。
- `git push` 仍由本地 git/remote credentials 执行；本次计划只覆盖 provider API 写操作，不改变 Git 推送认证策略。
