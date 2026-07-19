# Claudex update operations

Claudex updates only when a user runs `claudex update`. There is no watcher, scheduled compatibility job, background download, or silent installation.

This is the compact operator runbook. The product model and full file-by-file checklist live in [Maintainer update process](maintainer-update-process.md); future scheduled assistance must follow [Update automation](update-automation.md).

## Certified pair contract

Each stable GitHub release is one inseparable Claudex, Claude Code, and CLIProxyAPI combination. `src/compatibility.ts` is the version, revocation, and trust source consumed by runtime checks, packaging, tests, and release-record generation.

Legacy releases through the same-proxy bridge contain exactly:

- `claudex-<version>.tgz`
- `release.json`
- `release.sig`

Bridge-aware proxy-transition releases keep that schema-1 `release.json` unchanged for the permanent v0.2.1 bootstrap and add separately signed `update.json`/`update.sig` plus the exact proxy archive. The detached record binds the legacy record digest, stable channel, full proxy tag commit, archive size/hash, and executable hash. Old clients remain pinned to the bridge through GitHub `/releases/latest`; bridge-aware clients enumerate signed releases and choose the highest valid stable sequence.

The release record is canonical JSON signed with Ed25519. Only the public key is committed. The existing private key remains a repository secret, but no checked-in workflow can currently read it: publication and production signing are intentionally disabled until a separately approved release-automation phase.

Do not rotate that key as an ordinary secret change. Existing clients authenticate the next release with their compiled public key before installing new code, so a release signed only by a replacement key is unreachable. Design and test a dual-key/key-epoch transition or explicit reinstall recovery path first.

## Certifying a future Claude Code version

Run the live gate; do not use the offline option as release evidence:

```bash
pnpm certify:claude <version> \
  --expected-sha256 <official-manifest-sha256> \
  --expected-size <official-manifest-size> \
  --out /tmp/claudex-claude-certification.json
```

The command downloads the exact macOS ARM64 artifact from Anthropic, verifies its manifest, size, hash, Mach-O identity, version, Apple identifier and team, signature policy, and Gatekeeper result, then runs doctor plus a tools-disabled routed prompt through the owned localhost proxy. It restores and verifies the proxy's prior running or stopped state. Release-grade evidence is canonical JSON generated from a clean source commit/tree. That commit must remain an ancestor of the release, while the evidence-excluding critical-source digest, Claudex version, and release sequence must match exactly. The verifier rejects evidence older than seven days.

Gatekeeper's exact “the code is valid but does not seem to be an app” result is treated as an assessment that does not apply to a standalone CLI. Any other explicit rejection or denial remains a hard failure, and strict code-signature validation is always required.

Only after that gate passes should an agent update `src/compatibility.ts`, its assertions, the package version, and the release sequence. There is no automatic interpretation of Anthropic's `stable` or `latest` marker as compatible.

## Certifying a future CLIProxyAPI or model route

CLIProxyAPI and the GPT route are part of the certified combination even though they are not versioned in the Claude candidate command. `scripts/certify-proxy.mjs` and `scripts/verify-proxy-certification.mjs` provide the corresponding source-bound evidence path: exact upstream tag commit, GitHub/checksum agreement, safe archive layout, archive and executable hashes, reported version/commit, hardened localhost startup, model catalog, routed smoke, owned-child shutdown, and prior-state restoration. Offline evidence is never release evidence.

A changed proxy still requires a same-proxy bridge release before its target release. Do not mark the target GitHub-latest while v0.2.1 remains supported. The bridge must stay latest and keep the three-asset legacy contract; later targets use detached signed update metadata and remain `make_latest=false`.

A model name or advertised capability change requires the same real catalog and routed-smoke evidence plus a new Claudex version and release sequence. Do not alter a user's route independently of a signed Claudex release.

## Source update checklist

After the exact final combination passes certification:

1. Update `CLAUDEX_VERSION`, the Claude pin when applicable, and increment `RELEASE_SEQUENCE` in `src/compatibility.ts`.
2. Match `package.json` to `CLAUDEX_VERSION`.
3. For a proxy change, certify the exact runtime, preserve the prior identity in the rollback set, update `src/runtime.ts`, and verify the bridge sequence before producing detached update metadata. `src/state.ts` derives its default runtime version from `PROXY_RUNTIME`.
4. Update the model and capability overlay in `src/claude-settings.ts` when applicable.
5. Update exact-value assertions, current README support text, and third-party notices; inspect rather than blindly replacing historical test fixtures.
6. Run the full pinned-toolchain checks, pack and isolated-install the artifact, and verify a test-key release record.
7. Add dated project memory with the candidate evidence and any incomplete human acceptance.

## Release readiness—publication disabled

`.github/workflows/release.yml` is intentionally a manual, read-only readiness verifier. It accepts an existing signed candidate tag, requires that tag to resolve to the current protected `main` tip with exact green CI, verifies fresh source-bound Claude and proxy certification evidence and all signed release history, builds and isolated-installs the package, and retains an **unsigned** candidate bundle. For a post-bridge sequence it also downloads and re-verifies the exact proxy archive, builds detached metadata, and proves signing/verification with an ephemeral test key; that test signature is clearly renamed and is never publishable. The workflow has no production signing secret, `contents: write`, tag mutation, or GitHub Release command.

Remote governance now requires PR-only, squash-only changes to `main`, exact CI, signed commits on `main`, and blocks force-push/deletion. Release tags are protected from routine creation, movement, and deletion. Actions require full SHA pins and are restricted to GitHub-owned actions plus `pnpm/action-setup`. The `claude-certification` and `release-signing` environments require explicit `cobibean` approval. Publishing remains a separate future design and approval step.

## Local transaction and recovery

Managed releases live under `~/.claudex/runtime` and `~/.claudex/releases`. Activation changes one `current` symlink; `previous` is retained for offline rollback. An exclusive PID-aware lock and atomic journal make each pointer transition recoverable. The permanent bootstrap validates and tries current, then previous, then its packaged fallback.

`claudex update --check` performs no recovery or state creation. Apply and rollback own recovery so their JSON failure contract remains intact. A malformed journal is left untouched for diagnostics; normal launch still tries an integrity-valid known-good runtime, while another update remains blocked until the unsafe journal is resolved.

Never delete or edit `~/.claude`, the standalone `claude` command, or Claude credentials during certification, migration, update, rollback, or recovery.
