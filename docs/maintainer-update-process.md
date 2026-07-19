# Maintainer update process

This document explains how Claudex itself is kept current. It is deliberately
separate from the user-facing `claudex update` command.

## Two update loops

### User loop

A user runs `claudex update`. Claudex reads the latest stable GitHub Release,
verifies the signed release record and exact artifacts, tests the inactive pair,
and atomically activates it. The user never selects an arbitrary Claude version.

### Maintainer loop

A maintainer watches Claude Code, CLIProxyAPI, the Codex model catalog, and
Claudex itself. A candidate becomes a user update only after review,
certification, source changes, CI, a version/sequence bump, a tag, and signed
GitHub publication.

The maintainer loop is the right target for scheduled assistance. Discovery can
be automated; compatibility approval cannot be inferred from version recency.

## Current certified snapshot

Source-of-truth values on 2026-07-18 CDT:

| Component | Certified value | Source |
| --- | --- | --- |
| Claudex | `0.2.1`, release sequence `2` | `src/compatibility.ts` |
| Claude Code | `2.1.211` | `src/compatibility.ts` |
| CLIProxyAPI | `7.2.80`, commit `09da52ad` | `src/runtime.ts` |
| Model route | `gpt-5.6-sol` | `src/claude-settings.ts` |
| Platform | `darwin-arm64` | compatibility and release record |

Read-only upstream reconnaissance on the same date found:

- Claude Code marker `stable` -> `2.1.205`.
- Claude Code marker `latest` -> `2.1.215`.
- CLIProxyAPI latest GitHub release -> `v7.2.88`, tag commit
  `93d74a890a44802f656d7f39a573916b2611896e`, with macOS ARM64 asset digest
  `sha256:9f9c3c33612fece39e5b99ddc9b09ce3510eb9e6b5be23aab238dbd9a06b4c9d`.

This snapshot is not a recommendation to upgrade. In particular, the certified
Claude version currently sits between Anthropic's `stable` and `latest`
markers. That is direct evidence that the job must report both channels and
must not equate either marker with Claudex compatibility.

## Upstream discovery channels

### Claude Code

```text
https://downloads.claude.ai/claude-code-releases/stable
https://downloads.claude.ai/claude-code-releases/latest
https://downloads.claude.ai/claude-code-releases/<version>/manifest.json
https://downloads.claude.ai/claude-code-releases/<version>/darwin-arm64/claude
```

The marker files contain version strings. The versioned manifest supplies the
commit, build date, platform size, and checksum. The versioned binary is the
only artifact the certification script accepts.

### CLIProxyAPI

Use the latest stable GitHub Release for `router-for-me/CLIProxyAPI`. Record the
tag, tagged commit, release notes, macOS ARM64 asset name, asset size, GitHub
asset digest, and `checksums.txt` value. Review changes since the currently
pinned tag, especially Codex auth, Anthropic message translation, model catalog,
streaming, local-model behavior, management surfaces, logging, and config keys.

### GPT model route

The route is not discovered from a public static manifest in this repository.
The owned authenticated proxy's `/v1/models` response and a real tools-disabled
request are the operational evidence. A renamed, missing, or behaviorally
changed model is a separate compatibility event even when neither binary
changed.

### Claudex source

Normal Claudex fixes can also require a release without changing either upstream
runtime. They still require a new package version and monotonically increasing
release sequence because users consume signed immutable pairs.

## Decide the update type

| Change | Required work |
| --- | --- |
| Claude Code only | Live Claude candidate certification, compatibility pin update, Claudex version/sequence bump, full release |
| CLIProxyAPI only | Treat as an update-protocol migration: review/certify the candidate, then design a bridge or explicit bootstrap reinstall path before changing production pins |
| GPT route/model only | Model catalog check, capability/settings review, routed behavior smoke, model/docs/tests update, Claudex version/sequence bump, full release |
| Claudex source only | Relevant tests and product smokes, Claudex version/sequence bump, full release |
| Multiple components | Certify the exact final combination together; do not certify each independently and assume the pair composes |
| Security incident | Assess revocation and recovery first; do not publish a routine bump over a compromised trust path |

## Claude Code candidate gate

1. Choose an exact version after reviewing upstream availability and change
   context.
2. Record the official versioned manifest's macOS ARM64 checksum and size as
   explicit expected inputs.
3. Ensure the current Claudex profile has valid Codex OAuth and the owned proxy
   can start.
4. Run the live gate; `--offline` is useful for development but is not release
   evidence:

```bash
pnpm certify:claude <version> \
  --expected-sha256 <official-manifest-sha256> \
  --expected-size <official-manifest-size> \
  --out /tmp/claudex-claude-certification.json
```

5. Review the report. It must prove exact manifest/version/hash/size, thin ARM64
   Mach-O identity, Anthropic identifier `com.anthropic.claude-code`, team
   `Q6L2SF6YDW`, strict code-signature validity, acceptable Gatekeeper result,
   successful `doctor`, exact tools-disabled routed response, and proxy-log
   evidence.
6. Preserve the report as review evidence outside git if it contains environment
   details. Never commit credentials or auth state.

The script restores the proxy's prior running/stopped state. Gatekeeper's exact
"valid but does not seem to be an app" response is accepted only as
non-applicability to a standalone CLI; signature validation remains mandatory.

Live mode requires `--expected-sha256` and `--expected-size`. Its canonical
schema-v2 report records a clean source commit/tree that must remain an ancestor
of the release source, while the evidence-excluding release-critical digest and
Claudex version/sequence must match exactly. This avoids a self-referential
"report must contain its own commit" requirement without allowing source drift.
It also binds candidate identity and restored proxy state.
`scripts/verify-claude-certification.mjs` rejects offline, dirty, stale,
non-canonical, source-mismatched, expectation-free, or incomplete evidence. The
readiness workflow requires an exact report for the candidate source and a
maximum age of seven days.

## CLIProxyAPI candidate gate

`scripts/certify-proxy.mjs` and `scripts/verify-proxy-certification.mjs` provide
the code-backed proxy evidence path. Live evidence remains a deliberate,
high-attention OAuth-backed operation; the daily watcher never downloads or
executes the candidate.

Delivery uses a same-proxy bridge. The permanent v0.2.1 bootstrap must always be
able to parse schema-1 `release.json`, so proxy artifact authority lives in a
separately signed `update.json`. Sequence 3 keeps proxy 7.2.80, exactly three
legacy assets, and GitHub `/releases/latest`. Sequence 4 and later carry detached
metadata plus the exact proxy archive and remain `make_latest=false` while
v0.2.1 support is required. Bridge-aware clients enumerate and authenticate all
stable releases, then choose the highest signed sequence.

1. Read release notes and compare the candidate tag against the pinned tag.
2. Resolve the annotated/lightweight tag to its exact commit.
3. Verify the macOS ARM64 asset name, size, GitHub digest, and upstream
   `checksums.txt` digest agree.
4. Download to a temporary private directory; never overwrite the active
   runtime during review.
5. Verify archive SHA-256, safe archive contents, reported `Version:` and
   `Commit:`, and the expected executable identity.
6. Exercise the hardened generated configuration: localhost listener only,
   remote management/control panel/auto-update panel/plugins/pprof/request
   logging/usage statistics disabled, `-local-model` still supported.
7. With the exact candidate pair, run `doctor --json`, confirm
   `gpt-5.6-sol` in `/v1/models`, and run a tools-disabled exact-response smoke.
8. Review proxy logs for evidence without enabling request-body logging.

Certification does not make a proxy bump automatic. Review the upstream diff,
the report, the exact final Claudex/Claude/model combination, and the full
bridge → target → rollback → update-forward evidence before changing pins.

## Source update checklist

After the exact final combination passes its candidate gates:

1. Update `src/compatibility.ts`:
   - `CLAUDEX_VERSION`
   - `CLAUDE_VERSION` and `CERTIFIED_CLAUDE` URL/hash/size when Claude changes
   - increment `RELEASE_SEQUENCE` exactly once
   - `REVOKED_SEQUENCES` only for an explicit incident decision
   - schema versions only when the bootstrap/state contract actually changes
2. Update `package.json` to the same Claudex version.
3. If proxy changes, complete the bridge review first. Then update
   `src/runtime.ts` (version, short build commit, full tag commit, asset URL,
   archive size/hash, executable hash) and preserve prior runtime identities for
   rollback. `src/state.ts` derives its default version from `PROXY_RUNTIME`.
4. If model route changes, update `src/claude-settings.ts` and capability labels.
5. Update exact-value assertions in `test/compatibility.test.ts` and
   `test/runtime.test.ts`, plus behavior tests affected by the candidate.
   Many other tests intentionally use historical/example pairs; do not
   mechanically replace every old version string.
6. Update current support text in `README.md` and proxy licensing text in
   `THIRD_PARTY_NOTICES.md` when relevant.
7. Search the repository for every old production pin and inspect each hit.
8. Add a dated `docs/memory/YYYY-MM-DD/...` note with candidate evidence,
   decisions, gotchas, changed files, and open acceptance work.

## Local release readiness

Use the pinned toolchain and run:

```bash
npm install --global corepack@0.34.0
corepack enable
corepack prepare pnpm@10.33.1 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm pack
```

Then verify:

- `package.json`, `CLAUDEX_VERSION`, and tag candidate agree;
- release sequence is greater than the latest signed release sequence;
- any changed proxy has valid detached metadata and tested movement from the
  permanently reachable same-proxy bridge;
- packed tarball contains the launcher, bootstrap, CLI, compatibility, and
  updater runtime files;
- an isolated global install reports the expected version and renders help;
- release record generation and test-key signing/verification pass;
- no secret, auth, generated profile state, or signing key entered the diff.

## Release readiness—publication intentionally disabled

`.github/workflows/release.yml` is a manual, read-only readiness verifier. Given
an existing signed candidate tag, it requires the current protected `main` tip,
exact successful CI, fresh source-bound certification evidence, monotonic signed
release history, a clean build/test/pack, and an isolated global-install smoke.
It retains an unsigned candidate bundle for review.

The workflow has no production signing secret, `contents: write`, tag mutation,
or GitHub Release command. Do not add those until cobi explicitly starts the
separate release-automation design.

### Current GitHub hardening posture

Verified on 2026-07-19 CDT:

- `main` is PR-only, squash-only, signed, current with exact green CI, and
  protected from deletion and force-push. The solo-maintainer repository cannot
  require a second person's approval, so required review count is zero.
- `v*` release tags are protected from routine creation, movement, deletion, and
  non-fast-forward updates; the repository-admin bypass is audited.
- Actions permit GitHub-owned actions plus `pnpm/action-setup`, require full SHA
  pins, and default to a read-only workflow token.
- Secret scanning, push protection, vulnerability alerts, and Dependabot
  security updates are enabled. GitHub reports validity checks and non-provider
  patterns unavailable/disabled on the current repository tier.
- `claude-certification` and `release-signing` environments require explicit
  `cobibean` approval.
- Existing v0.2.0/v0.2.1 tags remain historical unsigned annotated tags. Future
  candidates must use verified signed tags before readiness verification.
- The existing Ed25519 private key remains a repository secret, but no current
  workflow references it. A future signer should use protected immutable code or
  an external KMS/OIDC boundary rather than mutable candidate source.

## Post-release verification

A release is not complete merely because the workflow is green:

1. Verify the release has exactly three assets and is neither draft nor
   prerelease.
2. Download all assets again and independently verify signature, tag, asset
   size/hash, repository, platform, sequence, runtime identities, and schema
   bounds.
3. Confirm the tag SHA is on `origin/main` and the GitHub release points to the
   intended tag.
4. From an installed prior release, run `claudex update --check --json`, then
   `claudex update`.
5. Run `claudex doctor --json` and a tools-disabled exact-response prompt.
6. Exercise `claudex update --rollback`, verify the previous/fallback pair, then
   update forward again.
7. Confirm the standalone Claude binary, `~/.claude`, `~/.codex`, and unrelated
   credential files were not modified.
8. Record the evidence and any incomplete human acceptance in project memory.

## Revocation and recovery

`REVOKED_SEQUENCES` is carried by a newer signed release record. Revocation is
therefore a security/reliability incident action, not cleanup. Before shipping a
revocation, verify that users have an allowed path to a safe sequence or
packaged fallback and document the recovery route.

Never delete or edit user Claude/Codex state to recover Claudex. Preserve a
malformed update journal for diagnostics; guessing through damaged transaction
metadata is less safe than launching a known-good verified fallback.

`minimumBootstrapSchema` and `minimumStateSchema` are hard compatibility fences.
The installed updater rejects larger values before installing the target. Do
not bump either schema until a staged migration or bootstrap reinstall path has
been designed and verified from an actually installed older release.

Release signing-key rotation is another hard fence. Existing clients use their
compiled public key to authenticate the next release before installing its new
code. Do not replace the signing key until a dual-key/key-epoch transition or
explicit reinstall recovery runbook has been designed and tested.

`scripts/verify-release-history.mjs` scans every stable release, verifies each
canonical record/signature and artifact identity, rejects duplicate/conflicting
sequences, and requires the candidate sequence to exceed the maximum. A missing
or malformed historical record fails closed for human review.
