# Claudex Certified Updater Memory - 2026-07-16

## Session summary

- Claudex runs the genuine Claude Code harness through a managed localhost proxy, Codex OAuth, and a pinned model route. It is a launcher and proxy manager, not a replacement Claude client.
- Version `0.2.0` added `claudex update`, `claudex update --check`, and `claudex update --rollback`, including stable `--json` responses.
- A permanent global bootstrap now selects an integrity-valid managed `current` pair, then `previous`, then its packaged fallback. Managed runtimes are immutable under `~/.claudex`.
- The first signed `v0.2.0` release was published with exactly the Claudex tarball, canonical `release.json`, and Ed25519 `release.sig`.
- Source, tag, and release point to `main` commit `58524af`; no branch contains unique work.

## Durable product and trust decisions

- Updates are always user-invoked. There is no watcher, scheduled compatibility job, background download, or silent install.
- One release is an inseparable certified Claudex + Claude Code pair. A new upstream Claude version is not compatible until explicitly certified.
- Updates never call Claude Code's updater and never modify the standalone `claude`, `~/.claude`, or Claude credentials.
- Activation changes one `current` symlink. `previous`, a PID-aware lock, and an atomic journal provide offline rollback and crash recovery.
- Updates are blocked while sessions are active or `CLAUDEX_CLAUDE_BIN` is set. Forwarded `update`, `upgrade`, `install`, and `migrate-installer` commands are blocked.
- Every launched Claude process receives `DISABLE_UPDATES=1` and `DISABLE_AUTOUPDATER=1`.
- Release records are signed with Ed25519. Only the public key is committed. The matching private key is stored as a GitHub Actions secret; its temporary local copy was removed after publishing.

## Architecture and source map

- `src/compatibility.ts` is the machine-readable version, artifact identity, sequence, revocation, and public-key source of truth.
- `src/update.ts` owns discovery, verification, transactions, recovery, activation, rollback, and cleanup.
- `src/bootstrap.ts` and `bin/claudex` implement permanent current -> previous -> packaged runtime selection.
- `scripts/certify-claude.mjs` and `scripts/release-manifest.mjs` implement compatibility certification and release signing.
- `.github/workflows/ci.yml` and `.github/workflows/release.yml` implement packed-install CI and tagged release publishing.
- User and operator contracts live in `README.md` and `docs/update-operations.md`.

## Verification and build log

- `pnpm check`, `pnpm test`, and `pnpm build` pass; the suite has 101 tests across 14 files. Workflows pass `actionlint`, release scripts pass `node --check`, and staged diffs passed whitespace and secret-pattern checks.
- Claude Code `2.1.211` passed exact size/hash/version/Mach-O/Apple identity checks, strict code-signature validation, candidate doctor, a tools-disabled routed prompt, and localhost proxy observation.
- The packed bootstrap passed clean global installation, help/version, invalid JSON usage, and no-state update-check tests.
- Published assets were downloaded again and independently verified against the committed public key, manifest, signature, package hash, and tag.
- Real-profile acceptance passed human and JSON update checks, `claudex update`, and `claudex doctor --json`. The active pair is verified sequence `1`: Claudex `0.2.0` + Claude Code `2.1.211`, with no incomplete transaction.
- Remote CI passed the full product suite before the final workflow-handoff and public-key-only commits. Those final commits passed locally, but GitHub could not start another runner because the Actions budget was exhausted. The first release was therefore signed and published with the same checked-in release scripts.

## Gotchas and constraints

- Apple's app-oriented Gatekeeper reports that a valid standalone CLI is not an app. Only that exact non-applicability result is accepted; strict signature and identity checks remain mandatory, and any rejection or denial blocks activation.
- Artifact quota blocked the first release handoff, and a tag-scoped cache produced an unusable ref. The workflow now passes the small verified bundle as a bounded job output, retaining separate read-only verification and write-scoped signing jobs without remote bundle storage.
- The storage-free job-output handoff is locally linted but still needs its first remote run after Actions budget is available.
- Supported updater platform is currently macOS ARM64 with Node.js `22.15+`. Private release checks require authenticated GitHub CLI access.
- For a future public distribution, deliberately revisit repository authentication and discovery while preserving signed records, immutable pairs, rollback, and non-interference guarantees.

## Open acceptance and next work

- Human acceptance remains open: run a normal routed prompt and one controlled disposable tool call.
- Run `claudex update --rollback`, verify the packaged fallback with `doctor --json`, then update again and verify sequence `1`.
- Complete the post-update comparison for the standalone Claude binary, `~/.claude`, and credential files. Pre-update fingerprints exist, but sensitive hashes are intentionally omitted here.
- Once Actions budget is restored, prove the storage-free release handoff before relying on it for the next certified release.
- Do not claim full human acceptance until the interactive, rollback/update-again, and non-interference checks are complete.

## Update - 2026-07-16

- Clarification: `v0.2.0` and its release assets point to release source commit `58524af`, which is on `main`. This memory was added afterward on `main`, so the branch now advances beyond that release commit; no work is isolated on a side branch.
