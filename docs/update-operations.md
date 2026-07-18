# Claudex update operations

Claudex updates only when a user runs `claudex update`. There is no watcher, scheduled compatibility job, background download, or silent installation.

## Certified pair contract

Each stable GitHub release is one inseparable Claudex and Claude Code pair. `src/compatibility.ts` is the version, revocation, and trust source consumed by runtime checks, packaging, tests, and release-record generation. A release contains exactly:

- `claudex-<version>.tgz`
- `release.json`
- `release.sig`

The release record is canonical JSON signed with Ed25519. Only the public key is committed. The private key lives in the `CLAUDEX_RELEASE_PRIVATE_KEY_PEM` GitHub Actions secret and is exposed only to the signing step.

## Certifying a future Claude Code version

Run the live gate; do not use the offline option as release evidence:

```bash
pnpm certify:claude <version> \
  --expected-sha256 <official-manifest-sha256> \
  --expected-size <official-manifest-size> \
  --out /tmp/claudex-claude-certification.json
```

The command downloads the exact macOS ARM64 artifact from Anthropic, verifies its manifest, size, hash, Mach-O identity, version, Apple identifier and team, signature policy, and Gatekeeper result, then runs doctor plus a tools-disabled routed prompt through the owned localhost proxy. It restores the proxy's prior running or stopped state.

Gatekeeper's exact “the code is valid but does not seem to be an app” result is treated as an assessment that does not apply to a standalone CLI. Any other explicit rejection or denial remains a hard failure, and strict code-signature validation is always required.

Only after that gate passes should an agent update `src/compatibility.ts`, its assertions, the package version, and the release sequence. There is no automatic interpretation of Anthropic's newest release as compatible.

## Publishing

The tag must match the package and compatibility version:

```bash
git tag v<claudex-version>
git push origin v<claudex-version>
```

The tag workflow runs the full source suite, packs and installs the permanent bootstrap in isolation, enforces a monotonic sequence, generates the canonical release record in a read-only job, and passes a verified bundle to a separate write-scoped job. That job signs, verifies with the bundled public key, and publishes only the three approved assets. The workflow accepts a private repository during the public-release transition and a public repository afterward, but it always requires the exact `cobibean/claudex` destination.

## Local transaction and recovery

Managed releases live under `~/.claudex/runtime` and `~/.claudex/releases`. Activation changes one `current` symlink; `previous` is retained for offline rollback. An exclusive PID-aware lock and atomic journal make each pointer transition recoverable. The permanent bootstrap validates and tries current, then previous, then its packaged fallback.

`claudex update --check` performs no recovery or state creation. Apply and rollback own recovery so their JSON failure contract remains intact. A malformed journal is left untouched for diagnostics; normal launch still tries an integrity-valid known-good runtime, while another update remains blocked until the unsafe journal is resolved.

Never delete or edit `~/.claude`, the standalone `claude` command, or Claude credentials during certification, migration, update, rollback, or recovery.
