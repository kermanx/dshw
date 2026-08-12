# 合并 PR target

唯一目标仓库是 `{{clonePath}}`，它是 PR #{{prNumber}} 的分支 `{{branch}}`。

你当前就在这个目标仓库中运行。开始修改前，先用 `gh` 和 Git 查看 PR #{{prNumber}} 的标题、描述、提交和 diff，弄清这个 PR 想实现什么；后续解决冲突时必须保留该意图和已有行为，不要为了消除冲突而丢弃 PR 的功能。

请把 target branch `origin/{{baseRefName}}` 的最新提交合并到当前分支，解决所有冲突。

你不需要做全量的测试和检查，当你认为你的修改已经完成时，就请提交并 push 当前分支。你不需要等待 CI 运行结果，也不需要再做其他修改，也无需检查 base branch 是否又发生了新的提交，无需检查 review 意见。

不要 rebase，不要 force push。只处理完成该合并所必需的修改。

如果任务能够完成，最终回复最后一行必须是：

`DSHW_RESULT: completed`

如果经过调查后确认任务无法安全完成，停止继续尝试，不要伪造成功，也不要 push 不完整的结果；最终回复最后两行必须严格是：

`DSHW_RESULT: blocked`
`DSHW_REASON: <用一行说明无法完成的具体原因>`
