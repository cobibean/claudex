# Claudex product knowledge base

This directory is the durable product and operations knowledge base for Claudex.
It explains the product behind the public README, maps the code, and records the
safe way to evaluate and ship upstream updates.

## Start here

| Document | Use it for |
| --- | --- |
| [Product overview](product-overview.md) | What Claudex is, who owns each part of the experience, and its product boundaries |
| [Architecture](architecture.md) | Request flow, process lifecycle, local state, trust boundaries, and source map |
| [Maintainer update process](maintainer-update-process.md) | How to evaluate Claude Code, CLIProxyAPI, model-route, and Claudex releases end to end |
| [Update automation](update-automation.md) | What a scheduled maintenance agent should watch, what it may automate, and where it must stop |
| [Update operations](update-operations.md) | Compact release-certification and recovery runbook |
| [Project memory](memory/) | Dated history, decisions, verification evidence, and gotchas from past work |

## Sources of truth

When documents disagree, use this order:

1. Runtime and release code (`src/compatibility.ts`, `src/runtime.ts`,
   `src/claude-settings.ts`, `src/update.ts`).
2. Release automation (`scripts/`, `.github/workflows/`).
3. The operator contract in [Update operations](update-operations.md).
4. The explanatory documents in this knowledge base.
5. Dated project memory.

Version numbers in prose are snapshots. The current certified values always
come from the source files above and the latest signed GitHub release.

## Product invariants

These rules are more important than any single version number:

- One stable Claudex release represents one inseparable, explicitly certified
  Claudex + Claude Code pair.
- Claude Code, CLIProxyAPI, and the GPT route are never upgraded independently
  in a user's managed installation.
- New upstream availability is evidence to investigate, not proof of
  compatibility.
- Users opt into every install with `claudex update`; there are no silent
  downloads or background installs.
- A maintainer automation may discover, compare, prepare reports, and run safe
  preflight checks. It must not certify compatibility, tag a release, sign,
  publish, or revoke a release without a reviewed human decision.
- Claudex never repurposes the user's standalone Claude, `~/.claude`,
  `~/.codex`, or unrelated credentials.
