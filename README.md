# dshw

`dshw` 是 DeepSeek Harness 的本机 PR 工作流工具。它会追踪你创建的 open PR，管理独立
worktree，并提供 PR、review、CI 和后台任务状态页。它以 **dsh 插件**的形式嵌入 Harness
Web（左侧栏入口，六个视图全部原生渲染，无 iframe）。

## 准备环境

- macOS
- Node.js 24+
- pnpm 11+
- Git
- GitHub CLI，并已运行 `gh auth login`
- VS Code 的 `code` 命令（看板面板的 VS Code 按钮与 `dshw code` 命令需要）

作为插件使用时，还需要本机可用的 `dsh` 命令（例如从 deepseek-harness checkout 运行
`pnpm dsh web`，或全局安装 dsh），以及一个正在运行的 dsh Web 服务。

## 开始使用

dshw 的 daemon 是看板的数据来源：看板通过 `http://127.0.0.1:7849`（默认端口，可用
`DSHW_PORT` 修改）上的 HTTP API 与 SSE 拉取快照。因此**先启动 daemon**：

```sh
git clone https://github.com/deepseek-harness/dshw.git
cd dshw
pnpm install
pnpm dshw start              # 初始化并后台启动 daemon（自动构建插件 bundle 与 VS Code workspace）
```

首次启动会在当前 clone 内创建 `.dshw/`，克隆托管的 DeepSeek Harness 仓库，准备
dshw 固定版本的 dsh runtime，构建 UI，注册当前用户的 macOS LaunchAgent，然后在后台
启动服务。固定 runtime 首次安装和构建可能需要几分钟；CLI 会逐步显示当前阶段、耗时，
并在长时间操作中持续报告等待时间。以后在仓库目录中直接用 `pnpm dshw status` /
`pnpm dshw restart` / `pnpm dshw stop` 管理服务。

### 方式一：安装到你的 dsh（推荐）

把看板装进自己的 Harness Web，左侧栏底部会出现"看板"入口（展开态图标+文字、收起态
图标，悬停/选中样式与侧栏其他条目一致）。点击后看板占据侧栏右侧全部空间（侧栏保持
可见），Pull requests（修 CI / 解决评论 / 合并 / sync 开关）、Reviews、Git（提交图 +
分支聚焦）、Jobs（任务详情 / 终止 / 暂停 / Steer）、Logs（日志详情）与 Settings
（仓库管理 / Worker 配置与排序 / Worktree 清理）六个视图全部原生渲染、经 SSE 实时
更新。

```sh
# 1. daemon 已启动后，把本仓库安装进 dsh 的 web profile
dsh plugin --profile web add "$PWD"

# 2. 重启你的 dsh web 服务（停掉后重新运行 `dsh web` / `pnpm dsh web`），
#    刷新页面即可在左侧栏底部看到看板入口
```

dshw 是一个标准 Harness 插件组合包（bundle）：`package.json` 声明了 `dsh.bundle`
（patch 层 `cordis.patch.yml`）和 `dsh.client`（浏览器端 bundle，导出 `./client`），
因此 `dsh plugin add` 直接可装。插件本体只是看板外壳，数据全部来自本机 dshw
daemon（API 已启用 CORS）；daemon 未运行时，面板会提示连接失败并允许修改服务地址
（保存在浏览器 localStorage）。

- **卸载**：`dsh plugin --profile web remove dshw`，再重启 dsh web。
- **更新**：`git pull` 后运行 `pnpm dshw restart`（重建插件 bundle），再重启 dsh web。
- **换端口**：daemon 用 `DSHW_PORT` 启动在不同端口时，在看板面板的连接失败界面修改
  服务地址即可。
- 插件只面向 Web 类 profile；`dsh plugin --profile <name>` 中的 `<name>` 要与你的
  Harness Web 使用的 profile 一致（默认 `web`）。

## 配置模型凭据

dshw 默认把 `start` 时已有的 Harness 环境变量传给后台服务和任务。例如：

```sh
export DEEPSEEK_API_KEY=...
pnpm dshw start
```

也可以使用 Harness 自己的标准用户环境文件 `~/.dsh/.env`：

```dotenv
DEEPSEEK_API_KEY=...
```

这是 Harness 原生的 dotenv 格式，dshw 不定义额外配置文件或字段；启动环境中的变量优先于文件。每个 dsh 任务仍使用独立的 `DSH_HOME`，dshw 只复用这里的环境变量，不会读写或共享用户的全局 session 和 profile。

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
    workers.json               worker 配置（不含密钥）
    worker-secrets.env         设置页保存的 worker 密钥（权限 0600）
    state.json                 持久化状态
    dshw.code-workspace        VS Code workspace
```

`.dshw/` 已被 Git 忽略。

## Worker 配置

Settings 的 **仓库管理** 页面会显示 dshw 与主仓库当前落后上游的提交数，以及 Worktree 总数和可清理数量。dshw 可以一键 fast-forward 更新、安装依赖、完成检查与构建，然后安全重启服务；存在本地修改时会拒绝自动更新。主仓库维护集中提供同步、从头配置与过期 Worktree 清理。清理只处理不再对应 active PR 且没有运行中任务占用的 Worktree；包含未提交改动或未推送提交时必须逐项确认是否丢弃。

看板的 **Settings** 页可以维护多个 worker 配置并查看运行状态。Worker 可以直接拖拽排序，排在第一项的配置就是默认 Worker；任务选择面板也使用相同顺序。初始只创建 dsh 配置；Codex 需要用户手动添加，不会自动成为默认 worker。

新建 dsh Worker 时，可以直接填写 Provider、模型、API Key、API Base URL 和 Search Base URL，不需要额外配置环境变量。API Key 也可以改为从指定环境变量读取；此时沿用启动环境或 Harness 原生的 `~/.dsh/.env`。

直接输入的 API Key 不会出现在状态 API 或 `workers.json` 中，而是单独保存在权限为 `0600` 的 `worker-secrets.env`。Base URL 留空时继续使用对应的 Harness 环境变量。

Codex Worker 直接使用本机的 Codex CLI、登录状态和配置。设置页检测不到可运行且已登录的 Codex 时，会禁用 Codex 类型并显示原因；可用时只需填写配置名称，模型留空则沿用本机默认值。每个任务使用不落盘的临时 Codex thread，不会加入用户的 Codex 任务历史。

服务内部通过统一的 Worker Driver 接口管理不同执行器。dsh 和 Codex 都提供相同的启动、等待、状态、Steer、暂停和终止能力；新增执行器不需要让任务调度层感知其协议细节。Claude Code 目前仅保留类型入口，尚未接入。

PR 操作按钮左键单击时会直接使用默认 Worker；右键单击时可以为本次任务选择其他 Worker，不会改变全局排序。自动任务始终使用触发时排在第一项的 Worker。

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
pnpm dshw start              # 初始化并启动后台服务（构建插件 bundle 与 VS Code workspace）
pnpm dshw stop               # 停止后台服务
pnpm dshw restart            # 构建插件 bundle 并安全重启
pnpm dshw status             # 查看服务摘要
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
