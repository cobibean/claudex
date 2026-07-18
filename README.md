# Claudex

Claudex launches the genuine Claude Code CLI while routing model requests to GPT-5.6 Sol through a localhost-only [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance and a separate Codex OAuth login.

It is a launcher and proxy manager—not a Claude Code replacement. Claude Code still owns the terminal interface, agent loop, tools, permissions, sessions, `CLAUDE.md`, skills, hooks, plugins, agents, and MCP servers.

## Support and disclosure

- macOS ARM64
- Node.js 22.15 or newer
- Official Claude Code 2.1.211, installed as a checksum-verified managed runtime
- [CLIProxyAPI 7.2.80](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.80), installed and checksum-verified by Claudex
- GPT-5.6 Sol access through the authenticated Codex account

This is an unsupported integration. Anthropic does not support non-Claude models behind Claude Code gateways, and OpenAI does not document third-party use of Codex OAuth. Claudex presents this disclosure and requires human consent before first login.

Claudex itself is MIT licensed. CLIProxyAPI and Claude Code remain governed by their own licenses and terms; see [Third-party notices](THIRD_PARTY_NOTICES.md).

## Agent-ready installation

An agent can perform every step below except accepting the disclosure and completing Codex OAuth. Existing `~/.claudex`, `~/.codex`, `~/.claude`, and standalone `claude` installations must not be deleted, overwritten, or repurposed.

```bash
git clone https://github.com/cobibean/claudex.git
cd claudex

test "$(uname -s)" = "Darwin"
test "$(uname -m)" = "arm64"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 15) ? 0 : 1)'

corepack enable
corepack prepare pnpm@10.33.1 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm pack

package_version="$(node -p 'require("./package.json").version')"
npm install --global "./claudex-${package_version}.tgz"
claudex --version
```

At the human checkpoint, run this in a real terminal:

```bash
claudex login --device
```

Read and accept the disclosure, then open the displayed URL and complete the device authorization. After authentication succeeds, the agent can resume:

```bash
claudex update
claudex doctor --json
claudex -p "Reply with exactly CLAUDEX_OK. Do not use tools."
```

Successful setup means `doctor --json` reports `"ok": true`, the certified managed pair, an authenticated localhost proxy, `gpt-5.6-sol`, valid settings, and safe permissions. The final prompt must return `CLAUDEX_OK`.

The repository includes [AGENTS.md](AGENTS.md) with the same execution contract for coding agents.

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

`claudex update --check` reads the latest stable GitHub release without requiring GitHub CLI or GitHub authentication. `GH_TOKEN` or `GITHUB_TOKEN` is used only when already present, which can help with API rate limits. GitHub credentials are never forwarded to Anthropic.

`claudex update` verifies the signed release record and both artifacts, smoke-tests the inactive pair through the localhost proxy, then activates it atomically. `claudex update --rollback` restores the previous verified pair without using the network. Claudex never silently updates.

Updates are refused while sessions are active or when `CLAUDEX_CLAUDE_BIN` is set. Claude Code's own `update`, `upgrade`, `install`, and `migrate-installer` commands are blocked through Claudex so the pair cannot drift.

Release certification and recovery details are in [Update operations](docs/update-operations.md).

## Runtime and security

Production state lives under `~/.claudex` by default. Set `CLAUDEX_HOME` to use another location or `CLAUDEX_CLAUDE_BIN` to select a specific official Claude executable.

- Proxy listener: `127.0.0.1:8317`
- Claude-compatible endpoint: `/v1/messages`
- Proxy management, control panel, plugins, pprof, request logging, and usage statistics: disabled
- Direct model catalog: pinned locally with `-local-model`
- State directories: mode `0700`
- Config, keys, auth files, and state records: mode `0600`
- Local API key: delivered to Claude Code through `apiKeyHelper`
- OAuth tokens: owned exclusively by CLIProxyAPI in `~/.claudex/auth`
- Proxy subprocess environment: restricted to required system, browser, locale, certificate, and network-proxy variables

Claudex does not read or modify `~/.codex`, `~/.claude`, Claude credentials, or a Homebrew CLIProxyAPI configuration. It refuses to reuse or kill an unknown process on port 8317 and refuses to stop its managed proxy while sessions are active unless `--force` is explicitly supplied.

## Troubleshooting

```bash
claudex doctor
claudex proxy logs
```

`doctor --json` is designed to be shareable and never emits stored token values. Request-body logging remains disabled even in diagnostic mode.

Remote Control, voice dictation, Slack/web Claude, Claude Desktop inference, Tailscale exposure, Linux/Windows, custom translation sidecars, and npm publication are outside v1.
