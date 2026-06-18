目标：审查当前 PR/MR，并提交一条 review。

执行要求：
- 优先指出 bug、行为回归、安全风险和测试缺口。
- 有问题时给出文件/行或代码符号；没有明确问题时说明未发现阻塞问题。
- 使用下方 review 提交命令发布结果。
- issue-flow 已覆盖的 provider 动作不得直接调用 `gh`、`glab` 或手写 provider API。
