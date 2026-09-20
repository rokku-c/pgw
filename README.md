# Personal Gateway

本地 LLM 网关：为 Claude Code / Codex / Pi 提供统一的模型路由、MCP 工具面、会话采集与 persona 记忆，
并附带一个桌面控制台。

## 安装

```sh
bun install -g @rokku-c/pgw
# 或
npm install -g @rokku-c/pgw

pgw            # 打开控制台（首次会拉起网关并下载桌面应用）
pgw doctor     # 自检
pgw --help     # 全部命令
```

平台按 `os`/`cpu` 自动选择，安装时无需构建，也没有 `postinstall`。
桌面外壳不打进 npm 包，而是首次 `pgw open` 时从 GitHub Releases 拉取并缓存到 `$PGW_HOME/app`；
拉取失败会回退到浏览器标签页。

无头环境：

```sh
PGW_NO_GUI=1 pgw open     # 完全不下载桌面应用，直接开浏览器
```

数据：`~/.personal-gateway`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PGW_HOME` | `~/.personal-gateway` | 数据库、密钥、日志、桌面应用缓存 |
| `PGW_PORT` | `7210` | 仅监听回环地址 |
| `PGW_MODEL` | – | 包装 agent 时锁定路由别名 |
| `PGW_NO_GUI` | – | `1` 禁用桌面应用 |
| `PGW_APP` | – | 指向 `$PGW_HOME/app` 之外的桌面构建 |

支持 macOS（arm64/x64）与 Linux（glibc，x64/arm64）。

## 从源码运行

```sh
bun install
bun run dev      # 开发模式（HMR）
bun run start    # 前台运行
```

## 构建与发布

```sh
bun run build          # 只构建当前平台的单文件二进制 → dist/bin/
bun run build:all      # 全部四个平台
bun run icons          # 从 src-tauri/icons/source.png 重新生成图标集
bun run pack           # 组装可发布的 npm 包 → dist/npm/
```

产物是一个自包含的可执行文件：它既是 CLI，也是它自己重新执行的服务器（`__serve`）
与后台作业进程（`__job`）。Web 控制台由 Bun 从 `src/server/index.ts` 的 HTML import 内嵌，
没有独立的静态资源构建步骤。

打 tag（`v*`）会触发 `.github/workflows/release.yml`：四个平台各构建二进制与 Tauri 外壳，
上传到 GitHub Release，并发布五个 npm 包。

> 桌面外壳依赖 Rust 工具链，Linux 外壳还依赖 webkit2gtk，因此**只能在 CI 构建**。
> 本地 `bun run build` 只产出 CLI 二进制，不含 GUI。

## 命令

```
pgw                        打开控制台
pgw start                  前台运行网关
pgw status | doctor        状态与诊断

pgw claude | codex | pi    通过网关启动 agent CLI
pgw run AGENT --goal TEXT  无头运行 agent
pgw pause|resume|stop|complete RUN_ID
pgw steer RUN_ID MESSAGE

pgw scan                   扫描本地 agent 注册表
pgw sources                列出采集源
pgw source add PATH --name NAME [--capture] [--learn]
pgw source pause|scan ID
pgw sessions [--query Q] [--agent A] [--offset N]
pgw persona [timeline | history ID]
pgw jobs                   列出后台作业
pgw export                 导出资产清单

pgw mcp [calls | approve ID | deny ID | cancel ID]
pgw approvals | approve ID | deny ID
```
