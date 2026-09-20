# @rokku-c/pgw

Personal Gateway — a local gateway for agent CLIs. Routes model providers, gives
Claude Code / Codex / Pi a shared MCP tool surface, collects session history, and
serves a console as a native desktop window.

## Install

```sh
bun install -g @rokku-c/pgw
# or
npm install -g @rokku-c/pgw
```

Then:

```sh
pgw            # open the console (starts the gateway, installs the desktop app on first use)
pgw doctor     # check the install
pgw --help     # everything else
```

## What gets installed

A single compiled binary per platform, selected automatically by `os`/`cpu` via
`optionalDependencies`. There is no `postinstall` step and no build on install.

The desktop shell is **not** bundled — the binary fetches it from GitHub Releases
on first `pgw open` and caches it under `$PGW_HOME/app`. Until it arrives, `pgw`
falls back to a browser tab.

### Headless / server installs

```sh
PGW_NO_GUI=1 pgw open     # never fetch the desktop app; open a browser instead
```

The binary is identical either way — this skips the GUI download entirely rather
than downloading and ignoring it.

## Requirements

- macOS (arm64 / x64) or Linux (x64 / arm64, glibc)
- No Bun or Node runtime needed at runtime — the binary embeds everything
- Agent CLIs (`claude`, `codex`, `pi`) are optional; the gateway runs without them

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PGW_HOME` | `~/.personal-gateway` | Database, keys, logs, cached desktop app |
| `PGW_PORT` | `7210` | Loopback port |
| `PGW_MODEL` | – | Pin a route alias when wrapping an agent |
| `PGW_NO_GUI` | – | `1` disables the desktop app |
| `PGW_APP` | – | Point at a desktop build outside `$PGW_HOME/app` |

Data lives in `$PGW_HOME`. The gateway binds `127.0.0.1` only.

## Supported platforms

| Platform | Status |
|---|---|
| macOS arm64 / x64 | ✅ |
| Linux x64 (glibc) | ✅ |
| Linux arm64 (glibc) | ✅ |
| Windows | not yet |
| Linux musl (Alpine) | not yet |
