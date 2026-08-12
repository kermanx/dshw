# dshw

`dshw` 是 DeepSeek Harness 的本机 PR 工作流工具。它会追踪你创建的 open PR，管理独立 worktree，并提供 PR、review、CI 和后台任务状态页。

## 准备环境

- macOS
- Node.js 24+
- pnpm 11+
- Git
- GitHub CLI，并已运行 `gh auth login`
- VS Code 的 `code` 命令

## 开始使用

```sh
git clone https://github.com/deepseek-harness/dshw.git
cd dshw
pnpm install
pnpm dshw start
```

首次启动会在当前 clone 内创建 `.dshw/`，克隆托管的 DeepSeek Harness 仓库，准备 dshw 固定版本的 dsh runtime，构建 UI，注册当前用户的 macOS LaunchAgent，然后在后台启动服务。固定 runtime 首次安装和构建可能需要几分钟；CLI 会逐步显示当前阶段、耗时，并在长时间操作中持续报告等待时间。命令完成后会退出，并默认打开 VS Code workspace 和浏览器看板。

以后在仓库目录中直接运行：

```sh
pnpm dshw status
pnpm dshw ui
pnpm dshw restart
pnpm dshw stop
pnpm dshw start
```

不希望 `start` 自动打开窗口时，使用 `pnpm dshw start --no-open`。只关闭 VS Code、仍打开浏览器看板时，可使用 `--no-code`。环境检查可运行 `pnpm dshw doctor`。

## 可选：安装全局命令

一般不需要全局安装；从 clone 中运行 `pnpm dshw ...` 即可。如果希望直接使用 `dshw` 命令：

```sh
cd ~/workspace/dshw
pnpm add --global "$(pwd)"
dshw status
```

全局命令仍使用这份源码 clone，运行数据也仍保存在该 clone 的 `.dshw/` 中。

## 本地目录

所有 dshw 管理的数据都位于仓库内：

```text
dshw/
  .dshw/
    managed/deepseek-harness/  托管主仓库
    runtime/deepseek-harness/  dshw 固定版本的 Harness runtime
    worktrees/                 PR worktree
    clones/                    worktree 元数据
    logs/                      服务和任务日志
    workers/                   独立后台任务数据
    state.json                 持久化状态
    dshw.code-workspace        VS Code workspace
```

`.dshw/` 已被 Git 忽略。

## dsh 任务控制

dshw 为每个后台任务直接创建并持有一个具体的 Harness Session。任务运行时可以在任务详情中：

- 发送 **Steer**，让指令在下一个 step 前进入正在运行的任务；
- **暂停**当前 turn，再输入新指令继续同一个 Session；
- **终止**整个任务。

初始任务 prompt 也通过同一条 Session steer 路径发送。daemon 重启后会使用持久化的 worker handle、SessionEvent 日志和本地控制 socket 重新接管运行中的任务，不需要等待轮询刷新。

worker 不启动 Harness Web 服务，也不占用 TCP 端口。控制只通过权限为当前用户的 Unix domain socket；每个 worker 使用 `.dshw/workers/` 下独立的 `DSH_HOME`，因此不会把 session、profile 或配置写入用户的全局 `~/.dsh`。PR worktree 只作为任务工作目录。dshw 使用源码中明确固定并验证过的 Harness commit，不依赖用户全局安装的 `dsh`，也不跟随 PR 分支里的 breaking change。

## 后台服务安全边界

`dshw` 只注册当前用户的 LaunchAgent，不使用 `sudo`，也不会创建系统级 daemon。

每份 clone 都有独立 installation ID。启动、停止、重启或查询服务前，dshw 会校验 LaunchAgent ownership 和运行中 daemon 的身份。如果同名服务、端口或 plist 属于另一份安装，命令会明确报冲突并退出，不会覆盖、停止或接管对方。

`dshw stop` 只停止当前 clone 拥有的服务，不会删除 `.dshw/`。涉及清理托管仓库的操作也会先校验 ownership。

## 常用命令

```sh
pnpm dshw start [--no-open]  # 初始化并启动；默认打开 VS Code 和浏览器看板
pnpm dshw stop               # 停止后台服务
pnpm dshw restart            # 构建 UI 并安全重启
pnpm dshw status             # 查看服务摘要
pnpm dshw ui                 # 打开状态页
pnpm dshw code [name|repo-id] # 打开当前分支对应的 worktree
pnpm dshw doctor             # 检查本机依赖和服务状态
```

纯数字 `repo-id` 对应 `~/workspace/deepseek-harness-<id>`；`0` 对应 `~/workspace/deepseek-harness`。省略参数时使用当前 Git 仓库和分支。

## 开发

```sh
pnpm dev       # UI 热更新预览：http://127.0.0.1:7850
pnpm check     # TypeScript、Vue、production build 和测试
```

修改正式服务代码后运行 `pnpm dshw restart`。正在运行的 dsh worker 由 launchd 独立管理，daemon 安全重启时不会中断这些任务。
