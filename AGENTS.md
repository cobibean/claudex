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
2. Install Corepack 0.34.0 globally, enable it, activate pnpm 10.33.1, and run `pnpm install --frozen-lockfile`.
3. Run `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm pack`.
4. Read the current package version from `package.json` and globally install the resulting tarball with npm.
5. Confirm `claudex --version` matches `package.json`.
6. Run `claudex login --device` in a real terminal. Show the disclosure and device instructions verbatim, then wait for the human.
7. After OAuth succeeds, run `claudex update`, `claudex doctor --json`, and `claudex -p "Reply with exactly CLAUDEX_OK. Do not use tools."`.

Setup is complete only when doctor reports `ok: true` and the routed prompt returns `CLAUDEX_OK`. Report any incomplete gate plainly; do not claim success from build output alone.

## Maintainer and automation contract

- Read `docs/README.md` and `docs/maintainer-update-process.md` before changing any production pin, release sequence, update logic, or release workflow.
- Treat upstream availability as a candidate signal, never as compatibility approval. Claude Code `stable` and `latest` are separate channels and neither may silently choose a release.
- A scheduled job may discover metadata, compare pins, verify existing signed Claudex releases, and prepare a report. It must not mutate the production `~/.claudex` profile, certify compatibility from version numbers, merge, tag, sign, publish, revoke, or delete without explicit human approval.
- Keep `src/runtime.ts` and the duplicated proxy directory version in `src/state.ts` synchronized when CLIProxyAPI changes, but do not treat a proxy bump as a routine release: the current updater rejects a target proxy identity different from its own and the signed record does not authorize a proxy artifact. Design and certify the update-protocol migration first. A model-route change also requires a new certified Claudex release.
- Do not rotate the release signing key as a routine secret replacement. Installed clients trust their compiled public key and cannot consume a release signed only by a replacement key; design a dual-key/key-epoch rollover or explicit reinstall recovery path first.
- Treat `status` and `doctor` as diagnostic commands, not filesystem-read-only probes: both initialize/regenerate managed state before inspection.
- Preserve candidate reports and verification evidence without committing credentials, auth state, private signing material, or sensitive local paths.
