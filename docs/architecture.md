# Claudex architecture

## Runtime request path

1. `bin/claudex` starts the permanent packaged bootstrap.
2. `src/bootstrap.ts` recovers an interrupted transaction when safe, then
   chooses the first integrity-valid runtime in this order: `current`,
   `previous`, packaged fallback.
3. `src/cli.ts` parses the Claudex command. For a normal launch it ensures
   private managed state, confirms Codex OAuth, resolves the exact certified
   Claude binary, starts or reuses the owned proxy, records the session, and
   replaces itself with Claude Code using `process.execve`.
4. `src/claude-settings.ts` injects `http://127.0.0.1:8317`, pins every model
   role to `gpt-5.6-sol`, and disables Claude Code's own updater.
5. `src/proxy.ts` starts the checksum-verified CLIProxyAPI binary with
   `-local-model`, a restricted environment, and the generated configuration.
6. CLIProxyAPI owns the Codex OAuth token files and translates Claude-compatible
   `/v1/messages` requests to the authenticated Codex route.

`execve` matters because Claudex becomes the real Claude process rather than
leaving a wrapper parent behind. Session ownership and exit behavior therefore
match the launched CLI more closely.

## Command paths

| Command | Main path | Important behavior |
| --- | --- | --- |
| `claudex [args]` | `src/cli.ts` -> `src/invocation.ts` -> official Claude | Applies managed settings and replaces the process |
| `claudex login` | `src/auth.ts` -> CLIProxyAPI OAuth command | Requires human disclosure/authorization |
| `claudex doctor` | `src/cli.ts` -> `src/state.ts` -> `src/diagnostics.ts` | Initializes/regenerates managed state, then reports runtime, proxy, OAuth, model, settings, permissions, and update state with redaction |
| `claudex proxy ...` | `src/proxy.ts` | Starts/stops only the process whose path, command, hashes, and state prove Claudex ownership |
| `claudex update` | `src/update.ts` | Fetches a signed record, verifies both runtimes, smoke-tests, then atomically activates |
| `claudex update --rollback` | `src/update.ts` | Uses the verified previous pair or packaged fallback without network discovery |

## Managed state

Production state defaults to `~/.claudex` and can be redirected with
`CLAUDEX_HOME`.

```text
~/.claudex/
├── auth/                         # CLIProxyAPI-owned Codex OAuth JSON
├── bin/
│   └── claudex-api-key-helper    # Reads only the local proxy key
├── claude-settings.json          # Managed Claude Code routing overlay
├── proxy/
│   ├── api-key                   # Random localhost API key
│   └── config.yaml               # Localhost-only hardened proxy config
├── runtime/
│   ├── claudex/<version>/        # Immutable managed Claudex packages
│   ├── claude/<version>/claude   # Verified official Claude binaries
│   └── cliproxyapi/<version>/    # Verified proxy runtime + provenance
├── releases/
│   ├── <sequence>/release.json   # Installed, signature-verified release record
│   ├── current -> <sequence>     # Atomic active pointer
│   ├── previous -> <sequence>    # Offline rollback pointer
│   └── packaged-fallback.json    # First-install recovery record
├── run/
│   ├── proxy.json                # Owned proxy process identity
│   ├── sessions/                 # Live/starting Claude session records
│   ├── update.lock               # PID-aware exclusive update lock
│   ├── update-journal.json       # Recoverable pointer transaction
│   ├── update-snapshot.json      # Mutable-state rollback snapshot
│   └── update-failure.json       # Stable failure phase/code record
└── logs/proxy.log                # Rotated proxy process log
```

Directories are forced to mode `0700`; secrets and state records are generally
`0600`; executables and helpers are `0700`.

## Update transaction

The updater has three phases:

1. **Prepared** — signed metadata and artifacts are verified, archives are
   hardened, mutable state is snapshotted, the prior proxy state is recorded,
   and the inactive pair passes doctor plus a tools-disabled routed smoke.
2. **Activating** — immutable runtime directories and the release record are
   promoted, `previous` is set, and the `current` symlink is replaced atomically.
3. **Activated** — the permanent bootstrap verifies that it selected the exact
   intended pair; the prior proxy running/stopped state is restored; journals
   are removed; old unreferenced pairs may be cleaned up.

If a normal failure occurs, Claudex restores mutable state and pointers. If the
process is interrupted, the next safe launch or update uses the lock, journal,
and snapshot to recover. A malformed journal is preserved for diagnosis rather
than guessed through; bootstrap still attempts an integrity-valid known-good
runtime.

## Trust boundaries

### Release trust

- GitHub API metadata is discovery, not authority.
- `release.json` is canonical JSON signed with Ed25519.
- The public key is compiled into `src/compatibility.ts`; the private key is a
  GitHub Actions secret used only by the signing step.
- Release asset URLs and redirects are allowlisted to exact GitHub and official
  Claude hosts.
- Release sequence numbers prevent replay/downgrade, and newer records can list
  older revoked sequences.

### Runtime trust

- Claude is checked by exact size/hash, Mach-O ARM64 identity, reported version,
  Anthropic Apple identifier/team, strict code signature, and Gatekeeper policy.
- CLIProxyAPI is pinned by release URL, archive checksum, reported version and
  commit, then tracked by installed binary hash.
- Managed Claudex runtime trees are immutable in practice and checked against
  package identity plus stored artifact/tree provenance.

### Process and credential trust

- The proxy listens only on `127.0.0.1:8317`.
- Remote management, control panel, plugins, pprof, request logging, and usage
  statistics are disabled.
- Claudex refuses to reuse or kill an unknown process on port 8317.
- Unrelated Anthropic/Claude provider credentials are scrubbed before launch.
- GitHub tokens are used only for GitHub API rate limits when already present;
  they are not sent to Anthropic.
- Existing `~/.claude`, `~/.codex`, standalone Claude, and unrelated credentials
  are outside Claudex ownership.

## Source map

| Responsibility | Source of truth |
| --- | --- |
| Claudex version, Claude pin, release sequence, revocations, schemas, public key | `src/compatibility.ts` |
| CLIProxyAPI pin, download, checksum, installed provenance | `src/runtime.ts` |
| Proxy runtime directory version | `src/runtime.ts` (`PROXY_RUNTIME`), consumed by `src/state.ts` |
| GPT route and Claude settings overlay | `src/claude-settings.ts` |
| Permanent current/previous/fallback selection | `src/bootstrap.ts`, `bin/claudex` |
| User command orchestration | `src/cli.ts`, `src/invocation.ts` |
| Proxy ownership and session interlocks | `src/proxy.ts` |
| Signed update, activation, rollback, and recovery | `src/update.ts`, `src/update-output.ts` |
| Claude candidate certification | `scripts/certify-claude.mjs`, `scripts/verify-claude-certification.mjs` |
| Proxy candidate certification | `scripts/certify-proxy.mjs`, `scripts/verify-proxy-certification.mjs` |
| Detached proxy-transition authorization | `scripts/update-manifest.mjs`, `src/update.ts` |
| Release record generation/signing/verification | `scripts/release-manifest.mjs` |
| CI and release-readiness verification | `.github/workflows/ci.yml`, `.github/workflows/release.yml` |

## Known maintenance sharp edges

- `release.json` must remain schema 1 because the permanent packaged v0.2.1
  bootstrap parses it before delegating to managed code. Proxy-transition
  authority therefore lives in separately signed `update.json`; never add
  transition-only keys to the legacy record.
- v0.2.1 discovers only GitHub `/releases/latest` and requires the old proxy and
  exactly three assets. A same-proxy bridge must remain GitHub-latest while
  bridge-aware target releases are enumerated by signed sequence and published
  with `make_latest=false`.
- Keep every proxy runtime referenced by current, previous, bridge, or packaged
  fallback state. Cross-version owned-process replacement must still refuse an
  unrelated owner of port 8317.
- The model name is code inside the signed Claudex artifact, not a field in
  `release.json`. A model-route change still requires a new Claudex release and
  routed certification.
- Claude Code has distinct `stable` and `latest` markers. Neither is an automatic
  compatibility decision.
- Claude and proxy certification reports are source-bound and machine checked,
  but generating live evidence remains a deliberate OAuth-backed human gate;
  the read-only watcher never runs either candidate executable.
- Releases whose minimum bootstrap or state schema exceeds the installed
  updater's compiled schema are also rejected. Schema evolution needs an
  intentional staged migration/reinstall story before the schema number moves.
- Signing-key rotation has the same installed-client problem: clients verify a
  target with their compiled public key before installing its code. A release
  signed only by a replacement key is unreachable without a prior dual-key or
  key-epoch transition (or an explicit reinstall recovery path).
- `status` and `doctor` call `ensureManagedState`; they can create or rewrite the
  local key helper, proxy config, and Claude settings. Use metadata-only scripts
  for a genuinely read-only watcher.
