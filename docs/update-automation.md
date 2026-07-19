# Update automation

This is the design boundary for a future Devonte/Hermes scheduled maintenance
job. No cron job is created by this document.

## Recommended first automation

Start with a **read-only daily compatibility watcher**. Its job is to notice
changes early, collect deterministic metadata, compare it with the certified
pins, and send one useful report only when something changed or a check broke.

Do not start with an auto-bump or auto-release bot. The current process has a
strong Claude candidate gate but no equivalent code-backed CLIProxyAPI
certification gate. Automating source edits before that gap is closed would make
the workflow faster without making it safer.

A proxy candidate must also be labeled `protocol-migration-required`, because
the current installed updater cannot deliver a target with a different proxy
identity.

## Watch inputs

| Input | Compare against | Report |
| --- | --- | --- |
| Claude `stable` marker | `CLAUDE_VERSION` | marker version, changed/not changed |
| Claude `latest` marker | `CLAUDE_VERSION` and prior watcher state | marker version, changed/not changed |
| Candidate Claude manifest | `CERTIFIED_CLAUDE` | commit, build date, darwin-arm64 size/hash |
| CLIProxyAPI latest stable GitHub release | `PROXY_RUNTIME` | tag, commit, notes URL, asset name/size/digest, checksums digest |
| Authenticated proxy `/v1/models` | `MODEL` | pinned model present/missing; catalog change summary without tokens |
| Claudex latest signed release | local source pins | tag, sequence, asset set, signature status |
| Repository CI | current `main` | newest CI conclusion and failing step link |

Both Claude markers matter. Do not collapse `stable` and `latest` into one
"newest" value.

## Deterministic collector

The clean architecture is a small repository script that:

1. reads production pins from built/source modules;
2. fetches allowlisted metadata with strict timeouts and redirect rules;
3. validates response schemas and semantic versions;
4. computes a normalized JSON snapshot;
5. compares it with a private prior snapshot;
6. prints nothing when there is no meaningful change;
7. prints a concise machine-readable change report when action may be needed;
8. never downloads or executes candidate binaries in the watcher path.

A script-only Hermes cron (`no_agent=True`) is ideal for fixed alerts. If the
report needs upstream release-note interpretation and a plain-English
recommendation, use a normal agent cron with the collector script feeding its
prompt. The scheduled prompt must be self-contained and should run with the
Claudex repository as its `workdir` so project guidance is loaded.

Do not use `claudex status` or `claudex doctor` as the read-only collector:
both call `ensureManagedState` and may create or rewrite managed key/config/
settings files. Read source/release metadata directly, and isolate any optional
authenticated model probe from the production profile.

## Suggested report contract

```json
{
  "checkedAt": "ISO-8601 timestamp",
  "certified": {
    "claudex": "0.2.1",
    "sequence": 2,
    "claude": "2.1.211",
    "proxy": "7.2.80",
    "model": "gpt-5.6-sol"
  },
  "observed": {
    "claudeStable": "...",
    "claudeLatest": "...",
    "proxyLatest": "...",
    "modelPresent": true
  },
  "changes": [],
  "health": [],
  "recommendation": "none|review-claude|review-proxy-protocol-migration|review-model|repair-watcher"
}
```

The actual report should also include immutable candidate commit/hash/size data
and source URLs. It must never include OAuth tokens, local API keys, device
codes, private signing material, or raw auth files.

## Noise and failure policy

- Store the last normalized observation under a private profile/cache path, not
  in the public repository.
- Alert once per new candidate identity, not once per schedule tick.
- Re-alert when the candidate changes, the pinned version catches up, a model
  disappears, CI changes from green to red, or the watcher itself fails.
- A network timeout is `unknown`, not "no update".
- A malformed manifest, changed download host, missing expected asset, or
  signature/sequence failure is a high-priority trust alert.
- Use Central time in human messages while retaining UTC/ISO timestamps in JSON.
- Keep verbose collection logs private and redact credential-shaped values.

## Safe automation stages

### Stage 1 — Watch and report

Allowed automatically:

- fetch version/release metadata;
- compare pins;
- verify existing signed Claudex release metadata;
- summarize upstream release notes;
- create a private candidate dossier or issue after deduplication;
- recommend which certification path to run.

### Stage 2 — Prepare certification

After a deterministic watcher exists:

- download candidates only into private temporary storage;
- verify manifests, hashes, sizes, archive layout, and static identities;
- generate paste-ready commands with exact expected values;
- run offline/non-mutating checks;
- prepare a candidate branch or pull request only after explicit approval.

A live Claude certification consumes the local Codex route and temporarily
manages the owned proxy. It should run as a deliberate job, not as an unattended
daily tick.

### Stage 3 — Button-ready release

After both Claude and proxy certification are code-backed:

- apply reviewed pin changes on a release branch;
- update exact assertions and current docs;
- run full checks, pack, isolated install, and test-key release verification;
- produce a signed-off evidence bundle and proposed version/sequence;
- stop before merge, tag, signing, or publication.

### Never unattended

- accepting the unsupported-integration disclosure;
- completing or refreshing human OAuth consent;
- deciding compatibility from version number alone;
- modifying the production `~/.claudex` profile during a watcher tick;
- changing the release public/private key pair;
- adding revocations;
- merging, tagging, signing, publishing, or deploying;
- deleting releases, tags, branches, runtimes, user state, or credentials.

## Release-hardening backlog

Before an automation prepares button-ready releases:

1. Protect `main` and release tags and require green CI.
2. Put signing behind a protected GitHub environment with human approval; do
   not expose the private key to mutable tagged repository code if an immutable
   externally pinned signer can be used.
3. Bind a live, expectation-backed certification report to the source commit
   and candidate artifact hashes, and require it in release CI.
4. Add dual-key/key-epoch support and a compromise runbook before rotating the
   signing key.
5. Verify the next sequence against every valid signed release, not only the
   release GitHub currently marks latest.
6. Add an independent post-publish clean ARM64 install/update/doctor/smoke/
   rollback/update-again job with retained evidence.
7. Pin third-party Actions to full commit SHAs.

## Highest-leverage prerequisite

Build `scripts/certify-proxy.mjs` before auto-preparing proxy candidates. It should
mirror the Claude certifier's evidence quality:

- exact release/tag/commit and asset/checksum validation;
- safe archive inspection before extraction;
- reported version/commit validation;
- hardened config compatibility checks;
- owned localhost process proof;
- authenticated model catalog check;
- tools-disabled routed smoke and proxy-log evidence;
- restoration of prior proxy state;
- a structured report suitable for review.

Once this exists, the cron can reliably say "candidate is ready for human
certification review" instead of merely "a larger version number exists." It
still must not call the candidate release-ready until the update protocol can
authorize the proxy artifact and prove an installed older client can update,
roll back, and recover across the proxy boundary.

## Recommended schedule

For a young public tool, once daily is enough. New upstream versions do not need
minute-level response, and certification is intentionally human-reviewed. A
second weekly job can summarize unresolved candidates, stale failures, and the
latest successful release/CI evidence.
