给当前 issue 进行分类打标签，判断是否可执行，选择下一步 flow，并在需要时规范化 issue 正文。

先读取 `issue-flow` skill，按其中的 label 体系与 `apply.cjs` 用法操作。

## 关键行为

1. **主动调查** — 在判定"信息不足"之前，先从仓库代码、配置、文档、commit 历史中查证。如果 issue 是一个疑问，尝试从仓库中找到答案。
2. **能补则补** — 能从仓库上下文确认的事实直接填入分类，不要标 `flow::clarify`。
3. **必须提问时** — 确实无法从仓库推断的缺失信息，标 `flow::clarify` 并生成提问内容：
   - 直接说明缺了什么、为什么需要
   - 给出选择项或推荐默认方案
   - 附上你的判断依据（查了什么、排除了什么）
   - 按照具体 agent runtime 的说明在指定位置发出提问

## 选择下一步 flow

可执行的 issue 要在 `flow::plan` 和 `flow::build` 之间做判定：

- 选 `flow::build`：triage 调查后实现路径已确定（改哪些文件、怎么改、验收点都清楚），单一方案无需取舍，改动局部、不涉及架构或公共接口决策。
- 选 `flow::plan`：存在多个可行方案需先定方向；跨模块 / 架构 / 公共接口改动；改动面大需拆解；或调查之后实现路径仍不确定。

自检：如果你在规范化正文里已经写出了"怎么改"而不只是"要什么"，plan 的产物实质已经完成，应直接 `flow::build`。

## 判断自动化级别

`automation::` 与 `flow::` 正交，独立判断：它是**允许自动化推进到的上限**，决定这个 issue 能自动跑多远，而不是当前这一步。

- `automation::plan`：自动推进到 plan 为止；build 需人工触发。
- `automation::build`：自动推进到 build；若走 plan，人工合并 plan PR 后自动续推。

issue 上的 `automation::` label 会覆盖 repo 默认级别；不确定就不标，沿用 repo 默认。按需求的风险、影响面和你对实现路径的把握来定，例如：

- 路径清楚、低风险、希望自动实现：标 `flow::build` + `automation::build`。
- 需要先规划，但 plan 通过后可自动实现：标 `flow::plan` + `automation::build`。
- 路径清楚但想在动代码前留一道人工确认：标 `flow::build` + `automation::plan`，build 会停在 gate 等人工触发。
