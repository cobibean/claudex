# Claudex product overview

## The product in one sentence

Claudex lets a developer keep the genuine Claude Code terminal experience while
routing its model requests through a private localhost proxy to GPT-5.6 Sol via
Codex OAuth.

```text
Developer
  -> permanent Claudex launcher
  -> certified official Claude Code binary
  -> Claude-compatible localhost endpoint
  -> certified CLIProxyAPI runtime
  -> Codex OAuth
  -> GPT-5.6 Sol
```

Claudex is not a Claude Code fork, a hosted relay, or a general model switcher.
It is a narrow launcher, runtime manager, and compatibility boundary.

## What stays genuine

Claude Code still owns the terminal UI, agent loop, tools, permissions,
sessions, `CLAUDE.md`, hooks, plugins, skills, subagents, and MCP behavior.
Claudex launches the official, signed Claude Code binary and supplies a managed
routing overlay.

## What Claudex owns

- A certified Claude Code version and artifact identity.
- A pinned CLIProxyAPI version, commit, asset, and checksum.
- The GPT model route exposed to every Claude Code model role.
- A localhost-only proxy lifecycle and isolated Codex OAuth store.
- A private local API key passed through Claude Code's `apiKeyHelper`.
- Signed update discovery, artifact verification, atomic activation, recovery,
  and offline rollback.
- Guardrails that block model, settings, remote-control, and upstream updater
  escapes.

## Why certification is the product

Three independently changing systems have to keep agreeing:

1. Claude Code must still accept the managed settings and behave correctly when
   the backend is not Anthropic.
2. CLIProxyAPI must still translate Claude-compatible requests to the Codex
   route without weakening the localhost/security configuration.
3. The selected GPT model must still be available and support the capabilities
   Claudex advertises to Claude Code.

A new version existing upstream does not answer those questions. Claudex's
value is the reviewed and tested combination, not merely downloading the newest
binaries.

## Supported surface

The current v1 product is intentionally narrow:

- macOS on Apple Silicon (`darwin-arm64`)
- Node.js 22.15 or newer
- one certified Claude Code runtime per release
- one certified CLIProxyAPI runtime
- one pinned GPT route
- GitHub Releases as the update channel
- local state under `~/.claudex` by default

Linux, Windows, hosted relays, arbitrary model switching, Remote Control,
Claude Desktop inference, Slack/web Claude, voice, Tailscale exposure, npm
publication, and translation sidecars are outside the current contract.

## Human checkpoints

A human must:

- accept the unsupported-integration disclosure;
- complete Codex OAuth;
- decide whether an upstream candidate should enter certification;
- review certification evidence and compatibility changes;
- approve tagging and publishing a release;
- decide whether a published sequence must be revoked.

Everything around those decisions can be made easier and more repeatable by
automation, but the decisions should not be silently converted into cron jobs.
