<div align="center">

<h1>Claudex</h1>

<p><strong>Run the genuine Claude Code CLI with GPT models through a secure, localhost-only Codex OAuth proxy.</strong></p>

<p>
  <a href="https://github.com/cobibean/claudex/actions/workflows/ci.yml"><img src="https://github.com/cobibean/claudex/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/cobibean/claudex/releases/latest"><img src="https://img.shields.io/github/v/release/cobibean/claudex?display_name=tag&amp;sort=semver" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="#support-and-disclosure"><img src="https://img.shields.io/badge/platform-macOS%20ARM64-black.svg" alt="Platform: macOS ARM64"></a>
  <a href="#agent-ready-installation"><img src="https://img.shields.io/badge/node-%3E%3D22.15-339933.svg?logo=node.js&amp;logoColor=white" alt="Node.js 22.15 or newer"></a>
</p>

<p>
  <a href="#what-claudex-is">What it is</a> ·
  <a href="#why-it-exists">Why it exists</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#agent-ready-installation">Install</a> ·
  <a href="#commands">Commands</a> ·
  <a href="docs/README.md">Knowledge base</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="https://github.com/cobibean/claudex/releases/latest">Latest release</a>
</p>

<p>Created by <a href="https://github.com/cobibean">Cobi Bean</a> · <a href="https://x.com/cobi_bean">@cobi_bean on Twitter</a></p>

</div>

<p align="center">
  <img src="assets/claudex-demo.gif" width="800" alt="Claudex launching Claude Code with GPT-5.6 Sol">
</p>

## What Claudex is

Claudex is a local bridge between Claude Code and Codex. It lets you use the genuine Claude Code terminal experience with GPT-5.6 Sol as the model behind it. You still work inside Claude Code—with its agent loop, tools, permissions, sessions, `CLAUDE.md`, skills, hooks, plugins, agents, and MCP servers—while Claudex handles the local routing and Codex authentication.

It is a launcher and proxy manager, not a fork or replacement for Claude Code. There is no Claudex-hosted relay: the proxy runs only on your Mac, and model requests are sent from it to the authenticated Codex endpoint.

## Why it exists

Some developers like Claude Code as the place they work but want to use GPT-5.6 Sol for the model reasoning. Connecting the two normally means finding a compatible proxy, configuring both sides correctly, protecting existing credentials and settings, and keeping several independently updated pieces from drifting apart.

Claudex packages that work into one command. It installs a certified Claude Code and [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) pair, creates an isolated local configuration, guides you through Codex OAuth, verifies the route, and provides signed updates with rollback. The goal is simple: run `claudex` and get Claude Code powered by GPT-5.6 Sol without hand-building the bridge every time.

## How it works

```text
You → Claudex → official Claude Code → localhost-only CLIProxyAPI → Codex OAuth → GPT-5.6 Sol
```

| Claude Code still owns | Claudex handles |
| --- | --- |
| Terminal UI and interaction model | Certified Claude Code runtime |
| Agent loop, tools, and permissions | Local proxy lifecycle and configuration |
| Sessions and project instructions | Codex OAuth handoff |
| Hooks, plugins, skills, agents, and MCP | Model routing, integrity checks, updates, and rollback |

Claudex keeps its own state under `~/.claudex`. It does not replace or repurpose your existing `~/.claude`, `~/.codex`, standalone Claude installation, or OAuth credentials.

## Who it is for

Claudex is for developers on Apple Silicon Macs who want to experiment with the Claude Code workflow backed by GPT-5.6 Sol and are comfortable using an unsupported integration. It is intentionally narrow: one platform, one certified runtime pair, one model route, and strong guardrails around local state.

It is not the right fit if you need official support from Anthropic or OpenAI, Windows or Linux support, a hosted service, arbitrary model switching, or a drop-in replacement for every Claude product.

## Give it to your coding agent

The easiest setup path is to hand this repository to a coding agent. Paste this instruction into the agent:

```text
Clone https://github.com/cobibean/claudex and follow AGENTS.md exactly. Complete every mechanical setup and verification step yourself. Pause only when I must accept the disclosure and complete Codex OAuth, then resume and finish the smoke test.
```

The agent should make every setup decision from the repository. You only need to review the unsupported-integration disclosure and authorize your Codex account.

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

npm install --global corepack@0.34.0
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

Release certification and recovery details are in [Update operations](docs/update-operations.md). Maintainers and maintenance agents should start with the [product knowledge base](docs/README.md), especially the [maintainer update process](docs/maintainer-update-process.md) and [update automation boundaries](docs/update-automation.md).

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
