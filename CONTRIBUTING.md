# Contributing

Claudex currently supports macOS ARM64 only and distributes through source plus signed GitHub releases, not npm.

Before opening a pull request:

```bash
corepack enable
corepack prepare pnpm@10.33.1 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Keep changes focused, add behavior-level tests, and preserve the security boundaries documented in the README. Never commit credentials or generated auth state.

Do not change the pinned Claude Code or CLIProxyAPI version without completing the certification workflow in [docs/update-operations.md](docs/update-operations.md). Do not publish tags or release assets from a fork.
