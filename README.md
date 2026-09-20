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
```

数据：`~/.personal-gateway`。环境变量：`PGW_HOME`、`PGW_PORT`、`PGW_MODEL`。
