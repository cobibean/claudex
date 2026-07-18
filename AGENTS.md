# Claudex agent setup contract

## Goal

Take a fresh clone to a verified global Claudex installation on macOS ARM64. Perform every mechanical step autonomously and pause only for the human to accept the disclosure and complete Codex OAuth.

## Safety boundaries

- Never delete, copy, rewrite, or repurpose `~/.claudex`, `~/.codex`, `~/.claude`, the standalone `claude` command, or existing OAuth credentials.
- Never bypass the OAuth disclosure, synthesize consent, expose device codes outside the current user interaction, or print stored tokens.
- Never kill an unknown process on port 8317. Use `claudex doctor --json` to diagnose ownership.
- Do not upgrade Claude Code or CLIProxyAPI independently. Claudex releases certify one inseparable pair.

## Execution

1. Verify `uname -s` is `Darwin`, `uname -m` is `arm64`, and Node.js is at least 22.15.
2. Enable Corepack, activate pnpm 10.33.1, and run `pnpm install --frozen-lockfile`.
3. Run `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm pack`.
4. Read the current package version from `package.json` and globally install the resulting tarball with npm.
5. Confirm `claudex --version` matches `package.json`.
6. Run `claudex login --device` in a real terminal. Show the disclosure and device instructions verbatim, then wait for the human.
7. After OAuth succeeds, run `claudex update`, `claudex doctor --json`, and `claudex -p "Reply with exactly CLAUDEX_OK. Do not use tools."`.

Setup is complete only when doctor reports `ok: true` and the routed prompt returns `CLAUDEX_OK`. Report any incomplete gate plainly; do not claim success from build output alone.
