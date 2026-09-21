# Personal Gateway

```sh
bun install
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

数据：`~/.personal-gateway`。环境变量：`PGW_HOME`、`PGW_PORT`、`PGW_MODEL`。

### 会话存储与缩容

会话正文从原始 JSONL 按需读取；SQLite 保存会话信息、事件偏移和分支关系，不再新增正文副本或 FTS 内容。全文搜索由后台任务扫描授权原文件，任务页显示进度并支持取消。

```sh
bun src/cli.ts storage status
bun src/cli.ts storage compact
```

停止网关后执行压缩，完成后重新 `bun run dev`。压缩先取得网关运行归属锁，移除旧全文索引，核对源文件前缀后清理重复正文并回收空闲页。源文件不可用或已改写时保留历史正文。维护输出阶段与进度，不删除原始会话、配置、凭据、偏好或调用记录；运行中的数据库拒绝压缩。
