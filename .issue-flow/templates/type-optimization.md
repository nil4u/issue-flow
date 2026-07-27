<!-- issue-flow:automation-optimization source-issue={{sourceIssueNumber}} -->

## 优化目标

让同类任务在目标阶段尽量一次完成，减少可避免的人工介入。

## 来源任务

- 来源 Issue：#{{sourceIssueNumber}} {{sourceIssueTitle}}
- 优化阶段与 Turns：

{{phaseTurns}}

## 分析范围

基于来源 Issue 在以上阶段的完整 Task 和 TaskEvent，分别找出后续人工输入纠正或补充了什么，以及 Agent 首次未完成的根因。

## 期望产出

- 有 TaskEvent 证据支撑的根因；
- 可复用的项目说明、检查规则、工作流或工具改进；
- 能验证同类任务可减少人工介入的复现场景。

## 验收标准

1. 每项结论都能定位到具体 Task 和事件序号。
2. 优化改动有明确落点，不只给出抽象建议。
3. 区分可避免的介入和必须保留的人工业务决策。
