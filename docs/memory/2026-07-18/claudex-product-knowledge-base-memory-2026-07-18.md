# Claudex Product Knowledge Base Memory - 2026-07-18

## Session summary

- Cloned the new public `cobibean/claudex` repository into the durable local project workspace and traced the runtime, updater, certification scripts, release workflow, tests, and published `v0.2.1` assets.
- Turned the existing `docs/` folder into a product knowledge base with product, architecture, maintainer-update, and future-automation documentation.
- The initial discovery pass made no updater or release changes. The follow-up implementation pass added the reviewed watcher, certification, bridge-update, recovery, and GitHub-control changes described below. No production profile, release tag, signed release artifact, or publication was created.

## What we learned

- Claudex is a permanent bootstrap plus managed runtime system, not only a wrapper. Bootstrap selects integrity-valid `current`, then `previous`, then packaged fallback.
- The user-facing update loop and maintainer-facing compatibility loop are different. `claudex update` consumes a signed certified pair; maintainers still discover, evaluate, certify, pin, version, and publish candidates.
- Claude Code exposes separate `stable` and `latest` markers. On 2026-07-18 CDT they reported `2.1.205` and `2.1.215`, while Claudex certifies `2.1.211`. Neither marker can be treated as automatic compatibility policy.
- CLIProxyAPI remains pinned to `7.2.80`/`09da52ad`; the observed latest upstream release was `v7.2.88` at commit `93d74a890a44802f656d7f39a573916b2611896e`. This is discovery evidence only, not an upgrade recommendation.
- Frozen `v0.2.1` rejects a target release whose proxy identity differs from its compiled runtime. The new updater preserves that compatibility constraint through sequence 3, then uses separately signed detached proxy metadata for sequence 4+.
- Larger minimum bootstrap/state schema values are also hard update fences and need a staged migration/reinstall story.
- Signing-key rotation is another installed-client fence: clients cannot consume a release signed only by a replacement key without a prior dual-key/key-epoch transition or explicit reinstall path.
- Claude and CLIProxyAPI now both have source-bound certification and verification tooling. Discovery remains separate from compatibility approval.
- `status` and `doctor` are diagnostic but not filesystem-read-only because they initialize/regenerate managed state.
- GitHub now has protected `main` and release-tag rulesets, a protected release environment, pinned Actions, CODEOWNERS, and selected-Action restrictions. The repository has one administrator, so independent reviewer separation is not available and must not be implied.

## Follow-up implementation completed on 2026-07-19

- Added a deterministic, read-only upstream watcher that reports stable/latest Claude and proxy identities, including same-version hash, size, and tag-commit drift.
- Added source-bound Claude and CLIProxyAPI certification evidence with exact artifact, executable, Apple identity, and live-routing checks.
- Added a permanent same-proxy sequence-3 bridge and authenticated sequence-4+ release enumeration, detached update metadata, exact proxy archive/executable authorization, safe extraction, versioned runtimes, rollback, interrupted-update recovery, and retention cleanup.
- Replaced automatic release publication with a manual readiness workflow. It verifies candidates and can prove post-bridge assets with an ephemeral test key, but it cannot sign or publish a production release.
- Hardened GitHub workflows and repository controls without creating a tag or release.
- Independent security reviews found and drove fixes for bridge reachability, prior-runtime restoration, certification/source binding, archive-contract consistency, runtime cleanup, watcher identity drift, and Gatekeeper evidence handling.

## Final verification on 2026-07-19

- Full suite: 22 files and 141 tests passed.
- TypeScript check and production build passed.
- Focused bridge, updater, archive, certification, watcher, and workflow suites passed after their final edits.
- Real pinned CLIProxyAPI `7.2.80` archive and extracted executable passed the stricter offline certifier.
- Packed `claudex-0.2.1.tgz` installed in an isolated prefix, reported version `0.2.1`, and rendered help.
- Existing signed release history verified two records with maximum sequence 2.
- Markdown local links, workflow YAML, `actionlint`, and `git diff --check` passed.
- No release tag, GitHub release, production artifact signature, publication, or publication automation was created.

## Decisions made

- Recommend a read-only daily compatibility watcher as the first automation.
- The watcher should report both Claude channels, proxy release identity, model presence, signed Claudex release health, and CI changes; it should deduplicate and remain silent when nothing changed.
- Proxy candidates must be labeled `protocol-migration-required` until installed-client delivery across a proxy boundary is designed and proven.
- Live certification, production `~/.claudex` mutation, merging, tagging, signing, publishing, and revocation remain explicit human-gated actions.
- Release hardening should precede button-ready automation: protect branches/tags, isolate signing behind human approval, bind live certification evidence to source/artifacts, design key rollover, and verify sequence monotonicity across all signed releases.

## Files created or changed

- `docs/README.md`
- `docs/product-overview.md`
- `docs/architecture.md`
- `docs/maintainer-update-process.md`
- `docs/update-automation.md`
- `docs/update-operations.md`
- `README.md`
- `AGENTS.md`
- `docs/memory/2026-07-18/claudex-product-knowledge-base-memory-2026-07-18.md`

## Commands and verification

- Repository and GitHub release/workflow/tag state inspected with git and `gh`.
- Published `v0.2.1` assets downloaded and independently verified with `scripts/release-manifest.mjs`: signature, package artifact, and expected tag passed; exactly three release assets were present.
- `pnpm check`: passed.
- `pnpm test`: 15 files and 104 tests passed.
- `pnpm build`: passed.
- Packed artifact isolated-install smoke: passed; installed bootstrap reported Claudex `0.2.1` and rendered help.
- Relative Markdown links: passed.
- `git diff --check`: passed.
- Release scripts passed `node --check`.
- `actionlint` was not installed locally, so workflow lint was not rerun; the published `v0.2.1` release workflow and latest `main` CI were verified green on GitHub.

## Recommended next work

1. Use the watcher report as a discovery signal only; require a fresh human decision before preparing any candidate.
2. Produce fresh source-bound Claude and proxy evidence before a release candidate.
3. Ship sequence 3 as the permanent same-proxy bridge before considering a sequence-4 proxy migration.
4. Design signing-key rollover separately before any trust-root change.
