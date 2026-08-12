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
git clone https://github.com/kermanx/dshw.git ~/workspace/dshw
cd ~/workspace/dshw
pnpm install
pnpm dshw start
```

首次启动会在当前 clone 内创建 `.dshw/`，克隆托管的 DeepSeek Harness 仓库，构建 UI，注册当前用户的 macOS LaunchAgent，然后在后台启动服务。命令完成后会退出，并默认打开 VS Code workspace。

以后在仓库目录中直接运行：

```sh
pnpm dshw status
pnpm dshw ui
pnpm dshw restart
pnpm dshw stop
pnpm dshw start
```

不希望 `start` 打开 VS Code 时，使用 `pnpm dshw start --no-code`。环境检查可运行 `pnpm dshw doctor`。

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
    worktrees/                 PR worktree
    clones/                    worktree 元数据
    logs/                      服务和任务日志
    workers/                   独立后台任务数据
    state.json                 持久化状态
    dshw.code-workspace        VS Code workspace
```

`.dshw/` 已被 Git 忽略。

## 后台服务安全边界

`dshw` 只注册当前用户的 LaunchAgent，不使用 `sudo`，也不会创建系统级 daemon。

每份 clone 都有独立 installation ID。启动、停止、重启或查询服务前，dshw 会校验 LaunchAgent ownership 和运行中 daemon 的身份。如果同名服务、端口或 plist 属于另一份安装，命令会明确报冲突并退出，不会覆盖、停止或接管对方。

`dshw stop` 只停止当前 clone 拥有的服务，不会删除 `.dshw/`。涉及清理托管仓库的操作也会先校验 ownership。

## 常用命令

```sh
pnpm dshw start [--no-code]  # 初始化并启动后台服务
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
