# Personal Gateway

## 安装

安装包默认提供原生 CLI，浏览器 UI 不是使用 CLI 的前置条件。只需要命令行时，直接安装并使用 `pgw`：

### 本地仓库

```sh
bun link
pgw --help
pgw doctor
```

### GitHub

```sh
bun install -g github:rokku-c/pgw
pgw --version
pgw status
```

全局安装后可在任意目录使用 `pgw`。

需要浏览器 UI 时再启动 UI：

```sh
pgw ui
```

`pgw open` 保持兼容，也会启动网关并打开 UI；`bun run ui` 是源码仓库中的等价启动方式。只运行 API、诊断、查询或托管任务时，不需要打开浏览器。

CLI 使用 Commander 命令树，支持脚本友好的输出和退出码：`--help`/`-h` 查看帮助，`--version`/`-v` 查看版本，`--json` 输出纯 JSON，`--raw` 输出完整缩进 JSON，`--quiet` 抑制正常输出；未知命令退出码为 `2`，运行时错误退出码为 `1`。默认人类输出是摘要和表格，错误始终写入 stderr。

```sh
pgw --json --version
pgw --json status
pgw --json doctor
pgw --json definitely-not-a-command
```

### 命令树

```text
pgw
├─ status | doctor | dashboard/traffic [list|get|capture|delete-capture]
├─ sources | sessions | persona | preferences | skills
├─ source [add|edit|remove|restore|pause|scan]
├─ asset-roots [list|create|patch|scan|delete]
├─ assets [list|inspect|snapshot|preview|deployments|apply|restore]
├─ asset-installs | export/inventory | scan
├─ providers | routes | clients | settings
├─ observability [settings|update|captures]
├─ trajectory [sessions|calls|snapshots]
├─ jobs [list|get|attempts|attempt|cancel|retry]
├─ mcp [list|catalog|create|patch|delete|probe|history|tool|call|resource|prompt]
├─ mcp-calls [list|get|approve|deny|cancel]
├─ approvals | approve | deny
├─ routing [sessions|circuits|delete-session|reset-circuit]
├─ runs [get|events|budget] | run [codex|claude|pi]
├─ pause | resume | steer | stop | complete
├─ claude | codex | pi
└─ storage [status|usage|compact|purge]
```

列表默认使用紧凑表格，可用筛选和机器输出：

```sh
pgw sessions --query "项目决策" --limit 20
pgw jobs --limit 10 --offset 20
pgw --json providers
pgw --raw sessions
pgw settings patch --body '{"protocolConversion":true}' --confirm
pgw run codex --goal "整理项目文档" --timeout 30m
pgw source edit SOURCE_ID --body '{"name":"Sessions","agent":"auto","path":"/tmp/sessions","enabled":true,"captureBodies":false,"learn":true}' --confirm
pgw mcp probe CONNECTION_ID
pgw mcp-calls approve CALL_ID --confirm
pgw trajectory sessions nodes 'scanned:SESSION_ID'
pgw trajectory calls diff TRAFFIC_ID --against OTHER_TRAFFIC_ID
pgw jobs list --status failed --kind sessions.scan
pgw runs events RUN_ID
pgw traffic list --status failed --limit 20
pgw traffic capture TRAFFIC_ID --stage response
pgw routing circuits
```

`pgw` 本身不会启动浏览器；只有显式运行 `pgw ui`/`pgw open` 才打开 UI。安装 CLI-only 不需要浏览器依赖或手动启动 UI，UI 仍作为同一包中的可选运行入口提供。

## 本地开发

```sh
bun install
bun run cli --help
bun run start
```

打开启动输出中的本地地址。

```sh
bun src/cli.ts open
bun src/cli.ts doctor
bun src/cli.ts claude
bun src/cli.ts codex
bun src/cli.ts pi
bun src/cli.ts run codex --goal "整理项目文档" --max-turns 20 --timeout 30m
bun src/cli.ts pause RUN_ID
bun src/cli.ts resume RUN_ID --extra-turns 5 --extra-seconds 600
bun src/cli.ts sources
bun src/cli.ts sessions --query "项目决策"
bun src/cli.ts persona timeline
bun src/cli.ts --access CLIENT_ID codex
bun src/cli.ts mcp calls
bun src/cli.ts mcp approve CALL_ID
bun src/cli.ts jobs
bun src/cli.ts skills
bun src/cli.ts asset-roots
bun src/cli.ts asset-installs
```

`bun run dev` 提供前端热更新；修改后端后需重启服务。

开发模式启动后，登录密钥和直达地址写入 `.gateway/dev-access.json`（仅当前用户可读，已忽略提交）；非默认端口写入 `dev-access-端口.json`。

数据：`~/.personal-gateway`。环境变量：`PGW_HOME`、`PGW_PORT`、`PGW_MODEL`、`PGW_ALIAS`、`PGW_TRANSPARENT`。

包装 agent 时，`PGW_MODEL` 选**背后真正服务它的路由**（按路由别名），不改变该路由对 agent 的呈现方式：

- 默认把路由别名注入给 agent（`-c model=` / `ANTHROPIC_MODEL` / `models.json`），行为不变。
- `PGW_ALIAS=任意名字` 改为注入这个名字。名字不受路由别名的字符限制（可含 `[` `]` 等），
  由网关按该次启动创建的客户端的别名映射回这条路由。
- `PGW_TRANSPARENT=1` 完全不注入，agent 使用它自己配置里的模型名，网关用兜底映射接住它。
  pi 的模型名由网关生成，透明模式对它无效（会提示并沿用路由别名）。

### 会话存储与缩容

会话正文从原始 JSONL 按需读取；SQLite 保存会话信息、事件偏移和分支关系，不再新增正文副本或 FTS 内容。全文搜索由后台任务扫描授权原文件，任务页显示进度并支持取消。

```sh
bun src/cli.ts storage status
bun src/cli.ts storage compact
```

停止网关后执行压缩，完成后重新 `bun run dev`。压缩先取得网关运行归属锁，移除旧全文索引，核对源文件前缀后清理重复正文并回收空闲页。源文件不可用或已改写时保留历史正文。维护输出阶段与进度，不删除原始会话、配置、凭据、偏好或调用记录；运行中的数据库拒绝压缩。

### CLI 查询与 MCP

只读 CLI 查询命令与 MCP 共用同一份命令映射：`status`、`sources`、`sessions`、`persona`、`skills`、`asset-roots`、`asset-installs`、`jobs`、`mcp`、`export`。
MCP `/mcp` 额外提供 `gateway_cli(command, args)` 工具，以及 `pgw://gateway/...` JSON 资源；资源和查询遵循客户端的 `memoryAccess` 与项目范围。

MCP 只复用现有 `/api` 查询，不复制业务逻辑；启动、写入、运行控制和 `storage compact` 仍保留在 CLI/API，不通过这个只读工具暴露。

### 安装并使用 Personal Gateway Skill

1. 打开网关 → **设置 → 访问密钥 → 创建**，按需填写项目路径；在 **MCP 权限** 中打开记忆访问，或只勾选需要的能力。
2. 创建后只会显示一次完整密钥。复制页面里的 **Skill 说明**；不要把密钥提交到仓库或写入公开日志。
3. 安装到 Agent：
   - 临时使用：直接复制页面里的 `curl` / `fetch` 示例，设置 `PGW_MCP_KEY`。
   - Claude Code / Codex：复制页面里的 `pgw --access CLIENT_ID ...` 命令；网关会生成隔离的 MCP 配置。
   - 持久使用：把 **Skill 说明** 保存为 `SKILL.md`，放进任一授权的 Skills 目录；回到 **资产 → Skills → 来源 → 扫描**，确认网关已发现它。
4. 使用时让 Agent 先调用 `gateway_cli`，例如 `{ "command": "skills", "args": ["--query", "搜索词"] }`。也可以读取 `pgw://gateway/status`、`pgw://gateway/sessions` 等 JSON 资源。

这个 Skill 只开放只读查询：状态、会话、偏好、Skills、MCP、任务和导出；启动 Agent、审批、写入配置与 `storage compact` 仍需通过网关原有 CLI/UI/API 完成。
