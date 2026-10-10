## Summary
- 推荐新增服务端“源仓库配置预览”能力：仅允许当前用户可访问、同一 Git server/provider 的源仓库，从源仓库默认分支读取 `.issue-flow/config.json`，不读取或复制 secrets、tokens、webhook secret、runner、变量值和仓库标识。
- 导入只作为目标仓库安装向导的可取消预填/差异预览，不直接写目标仓库；目标仓库特有的 `gitServerId`、`projectId`、分支、路径和权限继续由目标上下文生成，最终写入仍走现有安装分支/MR 流程。
- GitHub 与 GitLab 共用规范化的 provider reader/字段白名单；labels、webhook、runner、权限、Actions/CI、变量和 plugin 不从源仓库复制，改为对目标仓库重新检查并按现有步骤配置。
- 冲突默认保留目标已有值，用户可逐项选择“使用导入值/保留目标值”；敏感字段只显示“目标仓库需重新填写/沿用现有值”，API 返回前后均做脱敏和字段白名单校验。

## Review focus
- 默认是否接受“同一 Git server 且同一 provider”作为 v1 的兼容边界；推荐保持该边界，跨 provider 或跨 Git server 直接提示不支持，而不是尝试映射仓库/权限语义。
- 默认是否把 `agentrix.actions`、prompt/template/plan 路径和 milestone 作为可导入字段；推荐导入这些非敏感声明式字段，但过滤 `gitServerId`、`projectId`、仓库路径/URL、分支及任何凭据。
- 默认是否坚持预览后由现有安装向导提交，而非导入 API 直接写仓库；推荐坚持预览/确认/取消模型，避免半成品配置和不可逆覆盖。

## 目标

当前 Console 的 onboarding 以目标仓库为上下文执行：前端 `repo-workspace.tsx`/`use-installation.ts` 调用 `/api/installation/plan`、`check` 和 `configure`，后端 adapter 从目标 provider 上下文检查权限、webhook、变量、labels、runner/plugin 等；仓库创建和 Agentrix 设置接口也只接收目标仓库输入。因此用户没有可选择源仓库的入口，现有检查结果缓存（`RepoSettingItem`）只能描述目标仓库的现状，不能替代源仓库文件读取，导致重复填写。

本方案增加一个 onboarding 辅助路径：用户选择一个已配置的源仓库后，Console 通过当前 GitHub App 或 GitLab 会话读取源仓库默认分支的 `.issue-flow/config.json`，将经过白名单规范化的非敏感字段返回为导入预览；用户确认后把结果合并进目标仓库安装表单，再执行目标仓库现有检查。它解决重复填写，但不改变安装检查、Issue Flow 状态机或 provider 权限模型。

## 方案

### 决策 1：导入范围

**结论：只导入非敏感、与仓库身份无关的声明式配置；不导入安装资源和缓存状态。**

允许字段以版本化 allowlist 定义，v1 包括：

- `.issue-flow/config.json` 中 `baseUrl`（仅作为目标表单建议值，提交前仍按服务端环境/目标上下文校验）、`agentrix.promptsDir`、`agentrix.templatesDir`、`agentrix.planRootDir`。
- `agentrix.actions` 下的默认及 action-specific `agent`、`model`、`reasoningEffort`。
- `milestone.enabled` 与 `milestone.branchPatterns`。
- 如安装向导已有对应的 automation/visual-plan preference 字段，可在规范化 DTO 中显式映射；没有对应控件的字段只在“未应用”列表展示，不静默写入。

明确排除：`gitServerId`、`projectId`、server repo id、owner/name/fullName、repo URL、default branch、任何 token/API key/secret/password、webhook secret、变量值、runner 标识/凭据、权限、webhook endpoint、GitHub Actions/GitLab CI 状态、labels、plugin 安装状态以及 `RepoSettingItem` 中的 checked/cached 状态。排除项不从源仓库读取或只返回字段名和原因，不返回原值。

理由：配置文件中的仓库标识和服务端绑定信息对目标仓库无效；安装资源必须依据目标仓库实际状态检查，变量/secret 等属于目标环境安全边界；直接复用缓存会绕过 provider 权限和现状检查。

### 决策 2：源仓库和兼容性

**结论：v1 只允许同一 Git server、同一 provider，且当前用户对源仓库具备读取权限；GitHub/GitLab 两者都实现，共享契约。**

源仓库选择器只列出当前会话能发现或已登记且可访问的仓库，并在服务端再次校验 source/target 的 `gitServerId` 与 provider。选择源仓库不代表授予新的权限：

- GitHub 使用现有 GitHub App/repository context 读取 `contents` 下默认分支文件；无 App 读取权限时返回可操作错误（授权/切换源仓库），不泄露文件是否存在以外的内容。
- GitLab 使用现有 token/OAuth project API 读取默认分支文件；缺少 project read 权限时返回同样结构化错误。
- 跨 provider、跨 Git server、源仓库不可访问统一为 `source_repo_incompatible` 或 `source_repo_forbidden`，前端显示原因和重试/更换源仓库入口。
- `.issue-flow/config.json` 缺失返回可区分的 `source_config_not_found`，导入预览保持空状态，允许取消并继续手填；JSON 无效、超大或版本不支持返回 `source_config_invalid`，不部分应用。

读取真实配置文件而非 `RepoSettingItem`：后者是目标检查缓存，不能证明源仓库当前文件内容，也可能包含不适合复制的资源状态。reader 返回 `{source, ref, configVersion?, fields, omitted, warnings}` 的规范化结果，不返回原始 JSON。

### 决策 3：覆盖与冲突

**结论：导入先生成逐项预览，默认保留目标值；只有用户明确勾选的字段才覆盖。**

每个允许字段标记 `sourceValue`（对敏感/排除字段不返回）、`targetValuePresent`（只表明是否已填，不回显 secret）、`decision`（`keep_target`/`use_source`/`unset`）和 `reason`。默认规则：目标为空则建议 `use_source`，目标已有值则建议 `keep_target`；用户可逐项改为 `use_source`，不可通过导入清空目标值。前端显示来源、差异和“源字段未应用”的原因，绝不显示被过滤的敏感值。

确认请求只提交字段决策与目标表单值的合并结果，并携带 source fingerprint/config version，服务端重新读取并校验 fingerprint，源文件变化则要求重新预览，避免过期预览覆盖。取消只丢弃本地预填状态，不产生数据库、仓库文件或 MR 变化。确认失败时保留当前表单、显示错误并允许重试；不执行部分写入。

### 决策 4：敏感信息边界

**结论：任何凭据和 secret 不跨仓库复制；目标已有值继续沿用，目标缺失则要求按目标仓库流程重新填写。**

服务端在 parse/normalize 阶段采用正向字段 allowlist，并对字段路径、值类型、大小和嵌套深度校验；未知字段、常见敏感命名（`token`、`secret`、`password`、`apiKey` 等）一律丢弃。错误日志只记录 source/target id、字段名和错误码，不记录原始配置。API 响应和前端状态不包含敏感源值；测试使用明显的假凭据断言不会出现在响应、日志和预览中。

### 决策 5：写入时机和目标验证

**结论：导入只预填，不直接写源或目标仓库；确认后复用现有安装流程，并强制重新检查目标。**

目标仓库的 `gitServerId`、`projectId`、repo identity、default branch、paths、base URL 的最终值由目标上下文/服务端决定，不能由源值覆盖。用户确认配置后：

1. 前端把合并后的目标表单送入现有目标 `/api/installation/check`，并展示新的权限、变量、webhook、labels、runner/plugin/Actions 或 CI 检查结果。
2. 用户仍通过现有逐步 `configure`/plugin 安装及安装分支/MR 流程完成写入；配置文件生成/更新继续由现有 checkout/install script 与目标仓库分支执行。
3. 检查失败不写入；已产生的本地表单状态可重试，取消不创建 RepoSettingItem 或提交记录。
4. 目标 `projectId`、branch/path 或 source fingerprint 冲突时以目标上下文为准并要求重新预览/确认；不做跨仓库直接复制。

### 决策 6：最小交付和接口契约

**推荐方案：服务端适配器读取 + 前端预览合并（方案 A）。**

方案 A 的契约建议如下：

- `GET/POST /api/installation/import-preview`：输入 `gitServerId`、`sourceRepoId`/provider project id、`targetRepoId`/project context、可选 source ref；服务端校验会话、同 provider/server、两仓库访问权，读取源默认分支 `.issue-flow/config.json`，返回规范化字段、omitted/warnings、fingerprint 和源 branch。
- `POST /api/installation/import-apply`（或将 decisions 作为现有 check/install 输入的临时表单字段）：输入 target context、source fingerprint 和逐项 decisions；服务端重新验证 source/target 兼容性与 fingerprint，输出合并后的非敏感 install input，不持久化 source raw config。更简单的 v1 可不设 apply endpoint，由前端本地合并、现有 check 做最终服务端校验；若采用此简化，服务端仍必须对最终字段重新做 allowlist/identity 防护。
- 规范化 DTO 不携带原始配置；错误码至少覆盖 `source_repo_forbidden`、`source_repo_incompatible`、`source_config_not_found`、`source_config_invalid`、`source_config_unsupported`、`source_config_changed`。
- provider 层新增同名语义的 `readRepositoryFile`/`readConfigFile` 能力，GitHub 复用已有 Contents API 能力，GitLab 使用 Repository Files API；读取默认分支，支持显式 ref 仅用于诊断且必须是目标允许的 branch/ref，限制响应大小。
- 前端在 `repo-workspace.tsx` 的 onboarding 入口增加“从已配置仓库导入”可选入口，在 `use-installation.ts` 管理 source selection、preview、decision、cancel/error 与重新 check 状态；`issue-flow-model.ts` 增加 DTO/decision 类型。表单提交前保留当前目标选择，不让 source 选择改变路由或目标 repo。
- `console/api/src/core/installation/` 增加独立 import/normalizer 模块，并让 GitHub/GitLab adapter 只负责读取文件和访问校验；`repositories.ts` 不承担源配置解析。
- 不新增 Prisma migration：源配置不落库，`RepoSettingItem` 继续只缓存目标检查结果。若产品需要最近使用源仓库，可只增加非敏感的用户级 UI 本地最近选择，默认不持久化；不要把 raw config 或 secrets 写入缓存。

**备选方案 B：只在浏览器直接读取源仓库文件，再把字段带入现有表单。**

优点是 API 改动少、无需服务端短期 DTO；缺点是暴露 provider 读取细节和授权错误、难以统一 GitHub/GitLab 行为、容易把原始 JSON/敏感字段带进浏览器状态，也无法可靠防止跨 server/provider 或过期配置。该方案不推荐，除非后续确认 Console 无法在服务端复用现有 session；即便采用也必须复制方案 A 的 allowlist、脱敏、兼容性和重新检查约束。

### 实施拆分

1. **Provider reader 与安全规范化**：抽象 GitHub Contents/GitLab Repository Files 的默认分支读取，统一错误码、大小/JSON 校验、字段 allowlist、fingerprint；补充同 provider/server 与 repo access 校验。
2. **API 与契约**：新增 preview（必要时 apply）路由和核心服务；将源文件读取、字段映射、目标字段存在性比较、冲突决策校验与日志脱敏独立出来；不改变现有 install check/configure/plugin 路由。
3. **前端安装向导**：加入源仓库选择、加载/缺失/无权/不兼容/无效配置状态；展示逐项 diff、默认保留目标值、敏感字段提示、取消与重试；确认后把非敏感字段合并至现有表单并强制 check。
4. **目标检查与写入衔接**：确保导入字段进入既有目标 check/configure/MR 输入；目标 identity、branch/path、provider 资源和 secrets 始终来自目标；不扩展 RepoSettingItem 为源配置存储。
5. **文档与观测**：记录接口错误码、可导入字段版本和 provider 权限要求；日志/指标只记录 provider、错误码、耗时和 source/target 内部 id，不记录配置值。

## 风险与边界

- 同一 provider 不代表同一权限范围；每次 preview 都要对源仓库重新授权检查，不能仅依赖仓库列表或缓存。
- 源配置是用户可编辑文件，必须按不可信输入处理；字段类型、长度、嵌套深度、URL 协议和 action model 值需校验，未知字段忽略并在预览提示。
- base URL、prompt/template/plan 路径和 milestone pattern 可能带组织约束；预览标注“将用于目标仓库”，最终以服务端允许值和目标检查结果为准。
- 配置文件读取成功不等于目标可安装；目标权限、webhook、labels、变量、runner/plugin、Actions/CI 仍必须重新检查，导入不绕过任何 blocker。
- 不支持跨 provider/server 的语义映射，避免把 GitHub App 权限、GitLab runner 或项目变量错误互换；未来若要支持需单独设计字段映射和安全审查。

## 非目标

- 不直接修改源仓库或目标仓库的 `.issue-flow/config.json`，不改变现有安装脚本、状态机、provider 权限模型。
- 不跨仓库迁移 API key、token、secret、webhook secret、CI variable 值、runner 凭据、权限、webhook、labels、plugin 或 Actions/CI 状态。
- 不把源配置原文或导入快照持久化到 Prisma、`RepoSettingItem`、日志或 PR/MR body。

## 验证

### 单元与契约测试

- normalizer：允许字段完整映射；仓库标识/服务端绑定字段、未知字段、敏感字段均不出现在 DTO；类型、大小、无效 JSON、深层嵌套和非法 URL 被拒绝或忽略并给出 warning。
- fingerprint/冲突：相同源内容稳定生成 fingerprint；源文件变化返回 `source_config_changed`；目标为空默认 `use_source`，目标有值默认 `keep_target`，不能通过导入清空目标。
- API auth：GitHub/GitLab 同 server/provider 且有读取权限成功；无权、跨 provider、跨 server、目标无权、缺少文件、无效 JSON、过大文件分别返回稳定错误码，且响应/日志无假 token 或 secret。

### Provider 测试

- GitHub：Contents API 读取默认分支配置；App 无 contents read、仓库不存在和 API 错误映射；不得误用目标 repo 或错误 ref。
- GitLab：Repository Files API 读取默认分支配置；token/OAuth 无 project read、文件 404 和 API 错误映射；同样验证目标 repo 不被替换。
- 两 provider：相同规范化输入得到相同 DTO 语义；跨 provider/server 被拒绝。

### 前端与集成测试

- 源仓库选择、加载中、缺失配置、无权限、不兼容、无效配置、取消、重试和导入成功状态。
- 逐项预览显示 source/target/decision；默认保留目标已有值，明确覆盖后才使用源值；敏感字段只显示“需目标仓库重新填写/沿用”，不显示源值。
- 导入后调用目标 check，目标权限/变量/webhook/labels/runner/plugin/Actions/CI 的结果仍出现；check blocker 时不触发写入；configure/MR 输入只含目标 identity 与允许字段。
- 回归现有 GitHub/GitLab installation workflow、repository routes、installation config/workflow 测试，确认无导入操作时行为完全不变。

### 可验收场景

1. GitHub 同 App、源仓库有完整配置、目标空表单：预览显示可导入字段，确认后填入并重新检查；目标 `projectId`/branch/path 使用目标值。
2. GitLab 同 server、目标已有部分值：空字段建议导入，已有字段默认保留；只覆盖用户勾选项。
3. 源仓库缺文件、无读取权限、JSON 无效或跨 provider：显示可理解错误，可取消继续手填，不产生写入。
4. 源文件含 token/API key/webhook secret/runner/仓库标识：预览和响应均不含这些值，目标对应项沿用或要求重新填写。
5. 目标检查失败或用户取消：不创建/更新目标配置文件、不更新源仓库、不产生 RepoSettingItem 源缓存；重试可重新读取并在 fingerprint 变化时要求重新预览。
