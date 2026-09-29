## 目标

- 为 Agentrix runtime 增加按工作环节独立配置 `agent`、`model` 和 `reasoning effort` 的能力，覆盖 `triage`、`plan`、`build`、`review`，并允许后续 action 通过同一配置结构扩展。
- 保持现有 `.issue-flow/config.json`、统一 prompts 目录、按 action/issue label 选择 prompt 的行为兼容；未配置新字段时与当前默认执行行为一致。
- 让安装产物、runtime 参数传递、文档和自动化测试共同形成可发现、可验证的配置契约。

## 非目标

- 不调整 Issue Flow 的 label 状态机、action 路由、plan/build/review 业务流程或 provider API。
- 不把现有 prompt 文件迁移到 action 子目录，也不为每个 action 重写 prompt 内容；prompt 仍由现有 `promptNameForAction()` 和 `.issue-flow/prompts` 覆盖机制负责。
- 不改动已存在的 Prisma 或其他数据库迁移；本需求不涉及持久化 schema。

## 当前上下文

- 相关模块：
  - `plugin/skills/issue-flow/scripts/runtimes/agentrix.cjs` 当前由 `resolveAgent()` 统一读取显式 option、环境变量或内置 `codex`，`buildRunArgs()` 只传递 `--agent`；`buildResumeTaskArgs()` 只恢复既有任务。
  - `plugin/skills/issue-flow/scripts/bootstrap.cjs` 将 runtime 资源安装到 `.agentrix/plugins/issue-flow`，并将 `config.json`、`prompts/`、`templates/` 安装为可定制项目文件。
  - `plugin/skills/issue-flow/assets/agentrix/bootstrap/config.json` 是新安装项目的配置模板；`plugin/docs/provider-api.md` 记录配置和 prompt 文件名契约。
  - `plugin/test/bootstrap.test.cjs` 覆盖安装文件和 manifest；`plugin/test/agentrix-runtime.test.cjs` 覆盖 prompt 路由、run args、resume 和默认值。
- 相关接口 / 数据 / 状态：
  - 继续使用现有 `agentrix-run` 调用；在 runtime 内新增 action 配置解析器，并把非空字段映射为对应 CLI 参数（`--agent`、`--model`、`--reasoning-effort`，具体参数名在实现时以当前 `agentrix-run` CLI 契约为准）。
  - 在 `agentrix` 配置下增加可扩展的 `actions` 对象，至少提供 `triage`、`plan`、`build`、`review`，并保留可选的 `defaults`；每个 action 的值只包含 `agent`、`model`、`reasoningEffort`。
  - 建议默认配置形状：
    ```json
    {
      "agentrix": {
        "promptsDir": ".issue-flow/prompts",
        "templatesDir": ".issue-flow/templates",
        "planRootDir": ".issue-flow/issues",
        "actions": {
          "defaults": { "agent": "codex", "model": null, "reasoningEffort": null },
          "triage": {},
          "plan": {},
          "build": {},
          "review": {}
        }
      }
    }
    ```
  - 字段按单项回退而不是整对象替换：显式 runtime option > 当前 action 配置 > `actions.defaults` > 既有环境变量 > 内置默认（`agent=codex`，model/reasoning 不传以继续使用 `agentrix-run` 默认）。未知或新增 action 读取同名配置并回退到 defaults，不影响既有 action。
- 既有约束：
  - 可定制安装文件可能已经被用户修改，bootstrap 不能覆盖现有 `.issue-flow/config.json`；新增 schema 必须对缺少 `actions` 的旧配置安全。
  - prompt 仍需先查项目 `.issue-flow/prompts`，再回退到安装 runtime 的默认 prompt；action runtime 配置不能改变 `plan-bug`、`plan-impl`、docs build、CI failure build 等既有 prompt 分支。
  - review task 的 comment resume 没有重新创建任务；初始 run 应固定任务所用配置，resume 不应从另一个 action 误加载配置或覆盖既有任务设置。

## 方案

1. **定义兼容配置 schema 与安装默认值**：扩展 `plugin/skills/issue-flow/assets/agentrix/bootstrap/config.json` 的 `agentrix` 节，加入 `actions.defaults` 以及 `triage`、`plan`、`build`、`review` 入口；schema 采用开放 action key，允许后续 action 直接添加同形状配置。实现配置值的类型/枚举校验（字符串、`null`；reasoning effort 使用 `agentrix-run` 支持的值），对旧配置、缺失 action、部分字段和未知字段采用安全回退，并在文档中给出完整示例和优先级。
2. **抽取按 action 的 runtime 配置解析**：在 `agentrix.cjs` 的现有 `resolveAgentrixConfig()` 基础上读取 `actions`，实现按字段合并的 resolver；让 `resolveAgent()` 扩展为 action-aware，新增 model/reasoning resolver，统一接受显式 options 以保持测试和调用方覆盖能力。`run()` 调用 `buildRunArgs()` 时传入 action 配置，只有非空/非 `null` 值才追加对应 agentrix-run 参数；不要把 promptName 映射替换成 action 配置映射，确保 label-specific prompt 继续独立工作。
3. **处理任务续跑和 action 隔离**：为初次 run 的参数构造增加 action 配置测试断言，确保 triage/plan/build/review 各自读取自己的值且不会相互污染；resume 路径不重新按当前事件推导另一套配置，继续使用 agentrix-run 已创建任务的执行设置，仅保留现有 resume 参数和响应模式行为。若 agentrix-run 要求在 resume 时重复传递模型/推理参数，则从 task metadata 中明确读取原 action 配置，不使用触发 resume 的事件类型猜测。
4. **更新安装、文档和兼容测试**：补充 `bootstrap` 测试确认新安装配置包含 schema、旧自定义配置仍被保留且 manifest 行为不变；在 `plugin/docs/provider-api.md` 说明 action 配置入口、字段含义、默认值、覆盖优先级、部分配置回退、prompt 与 runtime 配置的关系，以及新增 action 的扩展方式。同步更新 runtime 文件头部/相关地图文档（如实现改变职责）和使用示例。
5. **验证端到端传递与回归面**：在 `agentrix-runtime.test.cjs` 覆盖默认配置、全量 action 配置、部分字段回退、显式 option 优先级、未知 action/defaults、run args 参数隔离、旧配置兼容和 resume 不误切换；在安装测试覆盖生成配置。使用现有 plugin 测试命令验证安装、prompt 路由、dispatch 和 PR/review 任务流程，确保 provider 接口和标签状态机无变化。

## 验证方案

- 自动验证：
  - `node --test plugin/test/bootstrap.test.cjs plugin/test/agentrix-runtime.test.cjs`：验证安装产物、配置 schema、旧配置回退、action 参数合并和 run/resume args。
  - `npm test -w issue-flow`：验证 plugin 全量单元测试，重点关注 `dispatch`、`submit`、`review`、`integration` 相关回归。
  - 对代表性 action 至少断言：同一 issue 分别以 `triage`、`plan`、`build`、`review` 构造 args 时得到各自 agent/model/reasoning；未配置字段不产生空 CLI 参数；prompt 仍按 label 选择原文件。
- 手动验证：
  - 在临时仓库运行 `node .../scripts/bootstrap.cjs github --dry-run` 或测试安装，检查 `.issue-flow/config.json` 的 action 入口；复制一份旧版仅含路径配置的 config，确认 runtime 仍使用 `codex` 和 agentrix-run 默认 model/reasoning。
  - 分别修改 `triage` 与 `build` 的配置并执行 dry-run，检查输出命令只包含当前 action 的参数；修改 `.issue-flow/prompts/build.prompt.md` 后确认 prompt 自定义仍生效。
  - 对 review 初次任务和 review comment resume 做一次代表性验证，确认续跑不被 comment 事件误判为其他 action，也不改变原任务配置。
- 回归范围：
  - 安装器的 customizable 文件冲突/保留和 install manifest；Agentrix prompt 路由、plan 输入查找、build docs/CI failure 特化、review checkout/resume；现有环境变量和显式 runtime options；GitHub/GitLab provider 的 issue、PR/MR 操作接口与 label/flow 状态机。
