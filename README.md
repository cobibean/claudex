# Claudex

Claudex launches the genuine Claude Code CLI while routing its model requests to GPT-5.6 Sol through a private, localhost-only CLIProxyAPI instance and a separate Codex OAuth login.

It is a launcher and proxy manager—not a Claude Code replacement. Claude Code still owns the terminal interface, agent loop, tools, permissions, sessions, `CLAUDE.md`, skills, hooks, plugins, agents, and MCP servers.

## Supported v1 environment

- macOS ARM64
- Node.js 22.15 or newer
- Official Claude Code 2.1.211, installed as a checksum-verified private Claudex runtime
- CLIProxyAPI 7.2.80, installed and checksum-verified by Claudex
- GPT-5.6 Sol access through the authenticated Codex account

This is an unsupported integration. Anthropic does not support non-Claude models behind Claude Code gateways, and OpenAI does not document third-party use of Codex OAuth. Claudex presents this disclosure before first login.

## Install locally

```bash
pnpm install
pnpm test
pnpm pack
pnpm add -g ./claudex-0.2.0.tgz
```

The first update-capable bootstrap can still use the pinned official version already on `PATH`. Migrate to the private managed pair with:

```bash
claudex login
claudex update
```

Claudex never silently updates. The normal standalone `claude` command, `~/.claude`, and Claude credentials are not modified.

## First use

```bash
claudex login
claudex doctor
claudex
```

For a headless/device flow:

```bash
claudex login --device
```

`claudex login` creates a separate OAuth store under `~/.claudex/auth`. It does not read or modify `~/.codex`, Claude credentials, or the Homebrew CLIProxyAPI configuration.

## Commands

```text
claudex [CLAUDE_ARGS...]            Launch official Claude Code with GPT-5.6 Sol
claudex -- [CLAUDE_ARGS...]         Forward a reserved Claude subcommand
claudex login [--device|--no-browser]
claudex logout [--yes]
claudex status [--json]
claudex doctor [--json]
claudex update [--check|--rollback] [--json]
claudex proxy start|stop|restart|logs [--force]
```

Claudex rejects `--model`, `--fallback-model`, `--settings`, `--setting-sources`, and `--remote-control` because those options could escape the pinned GPT route.

## Certified updates

`claudex update --check` reads the latest stable private GitHub release and reports whether a newer certified Claudex + Claude Code pair is available. `claudex update` verifies the signed release record and both artifacts, smoke-tests the inactive pair through the localhost proxy, then activates the pair atomically. `claudex update --rollback` restores the previous verified pair without using the network.

With `--json`, every update action emits one object with `ok`, `action`, `status`, `current`, `target`, `previous`, `code`, and `message`; progress remains on stderr. Successful updates, up-to-date results, and update-available checks exit `0`. Verification or policy failures exit `1`, and invalid command usage exits `2`.

Updates require the authenticated GitHub CLI because this repository and its releases are private. Claudex refuses updates while sessions are active or when `CLAUDEX_CLAUDE_BIN` is set. Claude Code's own `update`/`upgrade`, `install`, and `migrate-installer` commands are blocked through Claudex so the pair cannot drift.

Claudex requires the freshly staged official artifact to pass strict code-signature validation in addition to its manifest hash and Apple signing identity. It never adopts the mutable standalone installation. Gatekeeper's exact “valid code, not an app” response is recorded as non-applicability for this standalone CLI, while any actual rejection or denial still blocks activation.

Release certification and recovery details are in [docs/update-operations.md](docs/update-operations.md).

## Runtime and security

Production state lives under `~/.claudex` by default. Set `CLAUDEX_HOME` to use another location or `CLAUDEX_CLAUDE_BIN` to select a specific official Claude executable.

Managed app and Claude runtimes are immutable and versioned under `~/.claudex/runtime`; signed pair records and the atomic current/previous pointers live under `~/.claudex/releases`.

- Proxy listener: `127.0.0.1:8317`
- Claude-compatible endpoint: `/v1/messages`
- Proxy management, control panel, plugins, pprof, request logging, and usage statistics: disabled
- Direct model catalog: pinned locally with `-local-model`
- State directories: mode `0700`
- Config, keys, auth files, and state records: mode `0600`
- Local API key: delivered to Claude Code through `apiKeyHelper`
- OAuth tokens: owned exclusively by CLIProxyAPI in `~/.claudex/auth`

Claudex refuses to reuse or kill an unknown process on port 8317. It also refuses to stop its managed proxy while recorded Claude sessions are active unless `--force` is explicitly supplied.

## Troubleshooting

Run:

```bash
claudex doctor
claudex proxy logs
```

`doctor --json` is designed to be shareable and never emits stored token values. Request-body logging remains disabled even in diagnostic mode.

Remote Control, voice dictation, Slack/web Claude, Claude Desktop inference, Tailscale exposure, Linux/Windows, and custom translation sidecars are outside v1.
