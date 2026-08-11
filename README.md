# dshw

`dshw` 管理 DeepSeek Harness 分支的 Git worktree、PR target 同步、CI 修复和本机状态页。自身源码由 Node.js 直接运行 `.ts`，不生成 dshw 的 JavaScript 构建产物。

## 安装

需要 macOS、Node.js 24+、pnpm 11+、Git、已登录的 GitHub CLI (`gh`) 和 VS Code CLI (`code`)。首次安装：

```sh
cd ~/workspace/dsh-workflow/dshw
pnpm install
pnpm add --global ~/workspace/dsh-workflow/dshw
dshw start
```

pnpm 11 会把这个本地目录作为 global dependency 的符号链接安装，因此修改这里的代码后不需要重新安装。后台服务是长进程：修改 `src/` 内核后需要运行 `dshw restart`；该命令会先构建 Vue UI，再安全重启 daemon。只调整 `ui/` 时日常使用 `pnpm dev` 即可获得 HMR，准备更新正式页面时运行 `pnpm build:ui`，不需要重启 daemon。

## 后台服务与安全重启

`dshw start` 先刷新并用 VS Code 打开 `../dsh-workflow.code-workspace`，再安装 `~/Library/LaunchAgents/com.deepseek-harness.dshw.plist`。`launchd` 在登录后启动服务，并在服务正常退出或崩溃后重新拉起。服务负责：

- target branch push 静默 10 分钟后更新 `../deepseek-harness`；
- 共享监听每个 GitHub 仓库的各个 PR target branch；
- 持久化并恢复 sync 订阅、debounce 截止时间、CI 监听和执行记录；
- 在 `http://127.0.0.1:7849` 提供实时 UI。
- 维护 `../dsh-workflow.code-workspace`。

`dshw restart` 不会终止正在运行的 dsh agent。每个 agent 都是一个 macOS `launchd` 一次性 LaunchAgent，请求、句柄和结果保存在 `.dshw/workers/`；daemon 重启时只等待仍在进程内的短 Git/gh 操作和 Harness 更新安全结束，然后立即退出。`launchd` 负责让 agent 独立存活，新的 daemon 从持久化 job 重新接管它，继续记录最终输出、核对 PR head 并监听后续 CI。网页“终止”按钮会通过 `launchctl` 终止该 worker，并由 worker 终止完整的 dsh 子进程组。这里直接复用系统的进程监督和信号机制，不在 dshw 里维护一套 PID 守护器。

期间到达的 target push 不会丢失：重启后 watcher 会比较持久化的 base OID；sync 订阅和截止时间也会从 `.dshw/state.json` 恢复。非 dsh 进程中的 job 若遇到意外崩溃会记录为失败并重新核对远端状态。仍建议使用 `dshw restart`，不要用 `kill -9` 或 `launchctl kickstart -k` 绕过状态持久化。

常用服务命令：

```sh
dshw status
dshw ui
dshw restart
dshw stop
dshw start
```

## Worktree 命令

```sh
dshw clone [name|repo-id]
dshw code [name|repo-id]
```

命令要求当前目录属于一个 Git 仓库，该仓库的 `origin` 规范化后是 `deepseek-harness/deepseek-harness`，仓库根目录不在本工作流的 `../clones/` 内，工作区干净，并且当前分支不是 `master`。HTTPS 和 SSH GitHub origin 都会识别为同一仓库。命令先 push 当前分支，再由托管的 `../deepseek-harness` fetch 该分支，并用 `git worktree add` 创建 `../clones/<name>/`。所有 `clones/` 直属子目录都共享托管仓库的 object database，不再各自保存完整 clone。

单个纯数字参数表示源仓库编号，不表示 clone 名，并且无视命令执行时的 cwd：`0` 使用 `~/workspace/deepseek-harness`，`3` 使用 `~/workspace/deepseek-harness-3`。该规则统一适用于 `clone`、`code`、`sync` 和 `unsync`。非数字参数仍是显式 clone 名，源仓库仍取当前 cwd。

每个 worktree 使用唯一的本地分支 `dshw/<name>`，上游设为原始 PR 分支，并通过 worktree-local `push.default=upstream` 保证普通 `git push` 推回原始分支。这样同一 PR 可以同时有多个 worktree，不会触发 Git 的“同一分支已在其他 worktree checkout”限制。元数据保存在 `../.dshw/clones/<name>.json`，不会弄脏 worktree。

未给 `name` 时，如果同一 GitHub 仓库和分支已有 worktree，则直接输出其路径；否则扫描已有编号并按 `dsh-1`、`dsh-2`……递增命名。显式名称对应的目录已经存在时会报错。`dshw code` 完成相同步骤后调用 `code <path>`。

## VS Code workspace

`../dsh-workflow.code-workspace` 列出所有关联 open PR 的 clone。folder 名固定为 `PR_<number>`，条目按 PR 编号升序排列；随后固定加入 `{ "name": "dshw", "path": "./dshw" }`，最后一项始终是 `{ "name": "clones", "path": "./clones" }`。创建或复用 clone 后会立即刷新，后台服务启动后每 5 分钟校正一次，因此 PR 关闭后对应 clone 会自动从 workspace 中移除，但 clone 目录本身不会被删除。

## PR sync

```sh
dshw sync [name|repo-id]
dshw unsync [name|repo-id]
```

`sync` 先执行 clone 逻辑，再要求当前分支存在 open PR，并把订阅注册给后台服务后立即返回。PR 的 target 始终读取 `baseRefName`，不假定为 `master`。同一 PR 已经启用 sync 时不会创建第二份订阅或第二个 target watcher，只追加一次即时 mergeability + CI 检查。

一次订阅的行为如下：

1. 调用 `sync` 时立即检查 mergeability 和当前 CI；即使 PR 不可合并也会检查 CI。
2. 同一 `repo + target branch` 的所有 PR 共享一个 ref watcher。检测到 target 新 OID 后进入 10 分钟 debounce；期间再次 push 会重新计时，但从本轮首次发现变化起最多等待 30 分钟，避免上游持续合入导致冲突同步被无限推迟。
3. debounce 到期后先更新托管的 `../deepseek-harness`。同一批受影响 PR 共享这次更新，随后每个 PR 都检查 mergeability 和 CI。若冲突，先用本地 `git merge-tree` 只读计算冲突文件；仅有 Markdown（`*.md`）和翻译配对记录（`*.i18n.yaml` / `*.i18n.yml`）时跳过自动合并，否则调用 agent 合并最新 target、解决冲突、提交并 push。
4. agent push 后等待新 head 的 CI 全部结束；仍有 pending check 时不会提前修复。全部结束且存在失败时，再调用 agent 查看 `gh` 日志、修复、提交并 push，并继续等待新 CI。
5. draft PR 保留订阅，但自动暂停冲突同步和 CI 修复；转为 ready 后自动恢复并即时检查。PR 不再 open 时订阅自动停止。
6. 如果 agent 明确报告任务无法安全完成，dshw 会把本次任务记为“无法完成”、展示原因，并暂停这个 PR 后续的自动 agent 调用；PR/CI 状态仍会继续刷新。再次执行 `dshw sync`，或在网页明确点击“合并 / 修 CI”，会恢复并重试 agent。

`gh` 可以查询 PR 并等待 checks，但没有从 GitHub 到本机的 push 事件通道。真正无轮询需要一个 GitHub 可访问的 webhook 地址和额外的隧道/鉴权配置。当前实现用每 60 秒一次的 `git ls-remote` 共享 ref watcher；开销按 target branch 计算，不按 PR 计算。watcher 将远端 branch tip 单独保存在 `observedBaseOid`，不会与 GitHub 返回的 PR-specific `baseRefOid` 混用；旧状态首次升级时静默建立监听基线，只有此后 branch tip 真正变化才启动 debounce。PR 生命周期每 60 秒核对一次，活动 CI 每 30 秒核对一次。

## 网页面板操作与 PR 状态

面板是独立的 Vue 3 + UnoCSS + Vite 项目，源码位于 `ui/`，按 PR 表、Jobs、Activity、DSH 输出和任务弹窗拆分组件；共享 API/SSE 状态位于 `ui/src/use-workflow.ts`。正式 daemon 直接托管 `ui/dist/`。面板为每个关联 open PR 的 worktree 展示 GitHub PR 链接、CI 总体状态与各个 check 链接、review decision、最近 reviewer、mergeability 和实际 target branch。后台每 15 秒通过 `gh` 自动刷新一次，结果通过 SSE 立即推给已打开的页面，不需要手动刷新。

“Code” 按钮向后台服务发送请求，由 daemon 执行 `code --reuse-window <worktree>`，不再要求浏览器直接打开 `vscode://` URL。“Merge latest <target>” 和 “Fix CI” 会把任务注册给后台后立即返回，复用正常 dsh 调用、最终输出和执行记录。虽然常见 target 是 `master`，merge 按钮始终以 PR 的真实 target 为准。draft PR 的自动 merge/fix 仍会暂停，但明确点击的手动操作会执行。

若 dsh 返回机器可识别的 `DSHW_RESULT: blocked` 和 `DSHW_REASON: ...`，PR 行会显示“自动任务已暂停”，Recent jobs 和 Final dsh outputs 会显示“无法完成”及具体原因。手动操作视为明确重试，会先解除该暂停；如果仍无法完成，agent 可以再次将它暂停。

PR 行和任务列表中的“合并中 / 修复中”可点击打开大尺寸任务面板。每次调用会通过 `dsh --profile headless --patch` 临时挂载 dshw 的 progress plugin，直接把 Harness 的 `session/event` 中的 step、assistant 文本、tool call、tool result 和 turn end 转成纯文本。worker 将文本 POST 给 daemon，daemon 只在内存保留最近 48 KB 并通过轻量 SSE 实时推送；进度不写入文件，daemon 重启或任务结束即丢弃，长期记录仍然只有最终一条输出。

Recent jobs 中运行中的任务有“终止”按钮。后台会取消同一 PR 的关联检查与 dsh 子任务，并向整个子进程组发送 `SIGTERM`；5 秒后仍未退出则发送 `SIGKILL`。任务和 dsh 输出会记录为 `cancelled`，sync 订阅本身保留并在下一轮重新核对远端状态。

## 更新托管 Harness

没有独立的固定更新定时器。任一被监听的 PR target branch 出现 push 并完成 10 分钟 debounce 后，服务在执行该批 PR 检查前更新 `../deepseek-harness`。若仓库不干净，先执行带时间戳说明的 `git stash push --include-untracked`，stash 会保留而不会自动 pop，以免无人值守时产生冲突或再次弄脏 agent 运行时。随后执行 `git pull --ff-only`。托管仓库只负责 Git object database 和 worktree 管理；agent 从目标 worktree 自己的源码与依赖启动，因此这里不安装依赖或构建 master，也不会让 master 的构建状态阻塞 PR 任务。多个同时到期的 target/PR 复用同一个正在运行的更新。结果和 stash 提示会出现在 UI。

## dsh 调用与记录

冲突处理和 CI 修复由 Node 24 直接执行目标 worktree 自己的 `apps/cli/src/bin.ts`，并把进程 cwd 设为同一个目标 worktree。CLI 源码、workspace bundle、tsx loader 和依赖因此始终来自同一提交；dshw 会自动识别该提交使用旧式 `dsh run --profile headless ...` 还是新式 `dsh --profile headless ...` 参数。tsx 不是 dshw 的依赖，也不负责运行 dshw。首次使用 clone 时，dshw 会按需安装依赖；若 workspace package 声明了 `./typert` runtime export 但对应文件尚未生成，还会调用 clone 自己的 TypeRT generator 定向生成并在启动 agent 前复核产物，不要求待修分支先通过全仓构建。worker 显式设置 `DSH_PERMISSION_MODE=danger-full-access`；Harness 会据此同时使用不受限文件/命令执行和 `approval: never`，适合无人值守任务。`dshw start` 还会把当前启动环境中的 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_SEARCH_BASE_URL` 白名单写入 daemon 配置，再传给每个 worker；Harness 不允许从 `~/.dsh/.env` 读取这两个 endpoint 变量。dshw 自身仍由 Node 24 原生直接执行 `.ts`，没有 dshw 的 tsx 运行时依赖。每次调用只持久化最终 stdout（失败且 stdout 为空时使用 stderr）、状态和时间，不保存完整模型/工具过程。UI 的 “Final dsh outputs” 可展开查看，文本副本位于 `../.dshw/logs/`。

dsh 提示词是运行时读取的 Markdown 模板：`prompts/merge-base.md` 和 `prompts/fix-ci.md`。支持 `{{clonePath}}`、`{{prNumber}}`、`{{branch}}`、`{{baseRefName}}` 占位符。两类提示词都要求 agent 先理解 PR 的标题、描述、提交和 diff，再在不破坏 PR 意图的前提下合并 target 或修复 CI；无法安全完成时使用 `DSHW_RESULT: blocked` / `DSHW_REASON: ...` 协议返回。每次 dsh 调用都会重新读取文件，所以只修改提示词不需要重启后台服务；未知占位符会在启动任务前明确报错。

状态和服务日志位于：

- `../.dshw/state.json`
- `../.dshw/logs/`
- `../.dshw/service.stdout.log`
- `../.dshw/service.stderr.log`

## 开发检查

```sh
pnpm check
dshw restart
```

日常迭代不需要直接碰生产 daemon：

- `pnpm dev`（或 `dshw dev`）在 `http://127.0.0.1:7850` 启动 Vue/UnoCSS 的 Vite dev server；它只读代理正式服务的 API 和 SSE，修改 `ui/` 后通过 HMR 即时更新。dev 页面拒绝 POST，避免调样式时误触生产操作。
- `pnpm build:ui` 输出 `ui/dist/`；正式 daemon 直接读取最新构建产物，因此只发布 UI 时刷新页面即可，不需要重启内核。`dshw start` 和 `dshw restart` 也会自动执行这一步。
- `pnpm dev:kernel` 在 `http://127.0.0.1:7851` 启动只读影子内核，状态写入独立的 `../.dshw-dev`，并由 Node watch 在 TypeScript 变化后自动重启；它能读取正式 worktree 元数据和 GitHub 状态，但禁止所有 POST 操作，不会启动 dsh 或影响生产任务。
- `pnpm dev:test` 持续运行测试。
- `pnpm check` 依次运行 Node/Vue 类型检查、Vite production build 和少量关键测试。UI 不维护大面积 DOM 快照；生产静态路径边界由单元测试覆盖，其余组件正确性由 `vue-tsc`、Vite build 和浏览器手工检查保证。
- 内核修改验证完成后再运行 `pnpm check && dshw restart`。正式服务会等待短任务安全结束后切换到新版本；已交给 `launchd` 的 dsh agent 不受影响。
