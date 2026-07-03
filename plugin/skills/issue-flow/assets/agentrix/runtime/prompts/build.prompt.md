目标：实现当前 issue，并发布 build PR/MR。

执行：
- 如果列出了方案文件，先全部读取，再对照当前代码实现未完成部分。
- 如果下面显示未找到方案文件，直接根据 issue 和仓库上下文实现。
- 如果方案与当前代码冲突或已过时，以当前代码为准实现，并在 PR body 的 Summary 中写明偏离点和原因。
- 如果缺少关键信息或前置条件、调查后仍无法实现，不要硬编：使用统一 CLI 的 `issue apply` 将 issue 转到 `flow::clarify`，评论说明阻塞点，不提交 PR/MR。
- 提交前先创建或切换到下面指定的非 base 分支。
- 按仓库规则修改、验证、提交，然后使用统一 CLI 提交 build PR/MR。

PR body 写清 Source issue、Summary、Validation。
