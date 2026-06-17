## 目标

- 提供一个确定性的 label 同步机制，将 issue-flow 内置 managed labels 同步到 GitHub/GitLab provider。
- 同步范围覆盖 `type::`、`status::`、`flow::`、`automation::`、`priority::` 以及 PR/MR 使用的 `mr-by::plan`、`mr-by::build`。
- 为每个内置 label 定义稳定的名称、颜色和说明，并在 GitHub/GitLab 之间采用可解释的兼容策略。
- 保持 `apply.cjs` 当前的互斥 label 行为：它仍只在单个 issue 上增删指定 prefix 的 label，不负责全量创建或更新 provider labels。
- 在安装和维护路径中说明何时同步、权限不足如何失败、如何 dry-run 和重试。

## 非目标

- 不改变现有 label 名称、prefix 互斥规则或 issue-flow 状态机语义。
- 不新增新的 managed label prefix。
- 不让 `apply.cjs` 自动同步全部 provider labels，避免每次 issue label 变更都需要 repository label 管理权限。
- 不保证 GitHub/GitLab 在 UI 展示上完全一致；只保证名称、语义和近似颜色稳定。

## 当前上下文

- 相关模块：
  - `skills/issue-flow/scripts/apply.cjs` 内部定义了 issue managed label schema，并通过 `computeLabelChanges` 只处理调用方指定 prefix 的互斥替换。
  - `skills/issue-flow/scripts/submit.cjs` 定义了 `SUBMIT_KINDS`，目前只对 GitHub 的 `mr-by::plan` / `mr-by::build` 做 `gh label create` 兜底；GitLab 只在 dry-run 输出 `ensureLabel`。
  - `skills/issue-flow/scripts/providers.cjs` 已封装 GitHub/GitLab token、repo 解析、issue label 应用、PR/MR 创建更新和 API fallback。
  - `skills/issue-flow/scripts/bootstrap.cjs` / `install.sh` 负责安装 runtime、workflow、config、prompts/templates，没有 provider label 同步步骤。
  - `skills/issue-flow/references/labels.md`、`skills/issue-flow/SKILL.md`、`docs/provider-api.md` 和 `docs/state-machine.md` 记录 label 语义和 CLI 行为。
  - 当前仓库包含 `.agentrix/plugins/issue-flow/skills/issue-flow/` 的项目级插件副本，实施时需要与源码 skill 保持一致。
- 相关接口 / 数据 / 状态：
  - Issue labels：`type::feature|bug|debt|ops`、`status::active|done|drop|suspend`、`flow::triage|plan|build|review|clarify|approve`、`automation::plan|build`、`priority::p0|p1|p2|p3`。
  - PR/MR labels：`mr-by::plan`、`mr-by::build`。
  - GitHub 当前通过 `gh label create --repo <owner/repo> --color <hex-no-#> --description <text>` 只创建缺失的 `mr-by::*` label，不更新已有 label 的颜色/说明。
  - GitLab provider 当前已有 `requestGitlab` / `glab api` fallback，可以用于 label create/update，但还没有 label 管理方法。
- 既有约束：
  - `apply.cjs` 只移除指定 prefix 下的旧 label，不触碰其他 managed prefix，也不接受 `mr-by::*`。
  - `submit.cjs` 发布 PR/MR 前要求 worktree clean，并用仓库外临时 body file。
  - GitHub/GitLab label 管理通常需要高于普通 issue 编辑的权限；同步失败不能悄悄降级成部分成功。
  - 测试使用 Node 内置 test runner，`npm test` 是主要验证入口。

## 方案

1. 抽出单一 managed label catalog。
   - 新增 `skills/issue-flow/scripts/labels.cjs`，导出 `MANAGED_LABEL_GROUPS`、`MANAGED_LABELS`、`labelsForScope(scope)`、`labelDefinitionFor(name)` 等纯函数。
   - 将 `apply.cjs` 的 `MANAGED_LABELS` 改为从 catalog 读取 issue-scoped groups，保持 `collectDesiredLabels` 和 `computeLabelChanges` 的外部行为不变。
   - 将 `submit.cjs` 的 `SUBMIT_KINDS` label color/description 改为引用同一 catalog 中的 `mr-by::*` 定义，避免 PR/MR label 和全量同步定义分叉。
   - Catalog 字段建议包含：
     - `name`
     - `scope`: `issue` 或 `merge_request`
     - `group`: `type`、`status`、`flow`、`automation`、`priority`、`mr-by`
     - `color`: GitHub 兼容的 6 位 hex，不带 `#`
     - `description`

2. 定义稳定颜色和说明。
   - 使用固定 hex 值，不从 provider 读取或随机生成。
   - 建议色板按语义分组，但避免所有 label 同色：
     - `type::*`：蓝/青系，区分 feature、bug、debt、ops。
     - `status::*`：active 用蓝，done 用绿，drop 用灰，suspend 用橙。
     - `flow::*`：triage/plan/build/review/clarify/approve 用不同但稳定的工作流色。
     - `automation::*`：使用中性紫/蓝，表示自动化策略。
     - `priority::*`：p0 红、p1 橙、p2 黄/蓝、p3 灰。
     - `mr-by::*`：保留现有 `mr-by::plan` 的 `0052CC` 和 `mr-by::build` 的 `1D76DB`，避免已安装仓库出现无必要 churn。
   - Description 使用英文短句，便于 GitHub/GitLab UI 和 API 共同展示；例如 `Issue is a feature or enhancement`、`Waiting for implementation`、`PR or MR was created by the plan action`。
   - GitHub 颜色提交为 `RRGGBB`；GitLab 颜色提交为 `#RRGGBB`。Catalog 只保存无 `#` 的规范值，由 provider adapter 转换。

3. 新增 label 同步 CLI。
   - 新增 `skills/issue-flow/scripts/sync-labels.cjs`：
     ```bash
     node sync-labels.cjs [--provider github|gitlab] [--repo <owner/repo|group/project>] [--dry-run] [--check]
     ```
   - 默认同步全部 catalog labels；后续如有需要可再扩展 `--scope issue|merge_request|all`，本次不必增加配置面。
   - `--dry-run` 输出每个 label 的 planned action：`create`、`update`、`skip`。
   - `--check` 只校验 provider 当前 label 是否与 catalog 一致；发现缺失或 drift 时非零退出，供 CI 或维护检查使用。
   - 正常执行采用 upsert：不存在则 create；存在但颜色或说明不同则 update；一致则 skip。
   - 输出汇总 JSON 或稳定文本，至少包含 provider、repo、created、updated、skipped、failed 数量，便于 CI 日志排查。

4. 在 provider 层实现 GitHub/GitLab label upsert。
   - 在 `providers.cjs` 为 provider 增加统一方法：
     - `getLabel(repo, name, options)`
     - `createLabel(repo, definition, options)`
     - `updateLabel(repo, definition, options)`
     - 或更高层的 `ensureLabelDefinition(repo, definition, options)`
   - GitHub 路径优先使用现有 token/fetch 机制；无 token 时复用 `gh` fallback。API 行为应支持：
     - 获取 label。
     - 创建 label。
     - 更新已有 label 的 color 和 description。
   - GitLab 路径复用 `requestGitlab`；无 token 时走 `glab api` fallback。API 行为应支持：
     - 获取 project label。
     - 创建 project label。
     - 更新已有 project label 的 color 和 description。
   - 兼容差异：
     - GitHub label name 在 URL 中需要 encode。
     - GitLab update 需要按项目 label name 定位，并提交 `color` / `description`；颜色加 `#`。
     - 如果 provider 不支持 description 或实例版本不接受 description，错误应暴露为同步失败，不静默吞掉；plan 文档中提示可先用 `--dry-run`/`--check` 验证权限和 API 兼容性。

5. 调整 `submit.cjs` 的 PR/MR label 兜底。
   - 用 catalog definition 取代 `SUBMIT_KINDS` 中分散的 `labelColor` / `labelDescription`。
   - GitHub 的 `ensureGithubLabel` 改为调用 provider 的 label ensure 方法，并在 label 已存在但颜色/说明漂移时更新。
   - GitLab 的 `ensureMergeRequestLabel` 不再只 dry-run 记录，而是对 `mr-by::*` 执行实际 ensure。
   - 保持 `submit.cjs` 只 ensure 当前 PR/MR 需要的 `mr-by::*`，全量内置 labels 仍由 `sync-labels.cjs` 负责。

6. 安装和维护流程。
   - `bootstrap.cjs` 仍只负责写文件，不默认调用 provider API，避免 `install.sh` 在没有 label 管理权限或 token 时失败。
   - `install.sh` 和 `docs/provider-api.md` 增加安装后的推荐步骤：
     ```bash
     node .agentrix/plugins/issue-flow/skills/issue-flow/scripts/sync-labels.cjs --provider github --repo owner/repo
     node .agentrix/plugins/issue-flow/skills/issue-flow/scripts/sync-labels.cjs --provider gitlab --repo group/project
     ```
   - 在 GitHub/GitLab workflow 文档中说明：如果仓库希望 CI 定期检查 label drift，可运行 `sync-labels.cjs --check`；如果希望自动修复，需要给 workflow token 配置 label 管理权限。
   - 失败策略：
     - 安装不因 label 同步缺失而失败，因为安装期不执行远端写操作。
     - 手动同步时任一 label create/update 失败则命令非零退出，并列出失败 label 和 provider 错误。
     - `submit.cjs` 如果无法 ensure `mr-by::*`，继续保持失败；否则 PR/MR 缺少 source label 会破坏 merge 后流转。

7. 文档更新。
   - `skills/issue-flow/references/labels.md` 增加每个 label 的 color 和 description 表，注明 issue scoped 与 PR/MR scoped label 的区别。
   - `skills/issue-flow/SKILL.md` 增加 label sync CLI 简短说明，但继续强调 issue label 应用必须走 `apply.cjs`。
   - `docs/provider-api.md` 增加 `sync-labels.cjs` CLI 参考、权限说明、GitHub/GitLab 颜色格式兼容策略和 `--dry-run` / `--check` 示例。
   - `README.md` 增加安装后同步 labels 的维护步骤。
   - 同步更新 `.agentrix/plugins/issue-flow/skills/issue-flow/` 下对应脚本和文档副本。

8. 测试覆盖。
   - `test/labels.test.cjs`：
     - catalog 包含所有 issue managed labels 和 `mr-by::*`。
     - `apply.cjs` 从 catalog 派生的合法值仍拒绝非法 label，并保持 prefix 互斥计算不变。
     - 每个 catalog label 都有 6 位 hex color 和非空 description。
   - 新增或扩展 provider 测试：
     - GitHub definition 转换不带 `#`，GitLab definition 转换带 `#`。
     - missing label 走 create，drift label 走 update，一致 label skip。
     - dry-run/check 输出稳定 action。
   - `test/submit.test.cjs`：
     - `SUBMIT_KINDS` 的 `mr-by::*` 使用 catalog 中的定义。
     - GitLab submit 路径会请求 ensure MR label，而不是只在 dry-run 输出。
   - `test/bootstrap.test.cjs` / `test/install.test.cjs`：
     - 确认新脚本会被安装到 `.agentrix/plugins/issue-flow/skills/issue-flow/scripts/`。
     - 确认安装逻辑不自动执行 provider label 同步。
   - 文档/CLI smoke：
     - `node skills/issue-flow/scripts/sync-labels.cjs --dry-run --provider github --repo owner/repo` 可输出全部 planned labels。
     - `node skills/issue-flow/scripts/sync-labels.cjs --check --dry-run ...` 应失败或提示参数冲突；建议二者互斥，避免语义含糊。

## 验证方案

- 自动验证：
  - 运行 `npm test`。
  - 重点检查 `test/labels.test.cjs`、`test/providers.test.cjs`、`test/submit.test.cjs`、`test/bootstrap.test.cjs`、`test/install.test.cjs` 的新增或调整断言。
- 手动验证：
  - GitHub dry-run：`node skills/issue-flow/scripts/sync-labels.cjs --provider github --repo owner/repo --dry-run`，确认输出覆盖全部内置 labels。
  - GitLab dry-run：`node skills/issue-flow/scripts/sync-labels.cjs --provider gitlab --repo group/project --dry-run`，确认颜色输出为 `#RRGGBB`。
  - 在测试仓库执行一次真实 sync，确认缺失 label 被创建、已有 drift label 被更新。
  - 执行 `submit.cjs plan --dry-run` 和 GitLab provider dry-run，确认 `mr-by::plan` ensure 行为仍存在。
- 回归范围：
  - `apply.cjs` 的同 prefix 互斥替换和未指定 prefix 保留行为。
  - `submit.cjs` plan/build PR/MR 创建或更新、`mr-by::*` 添加、source issue 转 `flow::approve`。
  - GitHub/GitLab provider repo detection、token/CLI fallback、issue label add/remove。
  - Bootstrap/install 的文件安装和 manifest 管理。
