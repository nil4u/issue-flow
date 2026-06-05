目标：实现当前 issue，并发布 build PR/MR。

执行：
- 如果列出了方案文件，先全部读取，再对照当前代码实现未完成部分。
- 如果下面显示未找到方案文件，直接根据 issue 和仓库上下文实现。
- 多个方案文件不用问人选择，全部看完再判断。
- 只有凭证、外部权限、生产数据或破坏性操作审批这类硬阻塞才提问。
- 提交前先创建或切换到下面指定的非 base 分支。
- 按仓库规则修改、验证、提交，然后使用项目级 skill `issue-flow` 提交 build PR/MR。

PR body 写清 Source issue、Plans reviewed、Summary、Validation。
