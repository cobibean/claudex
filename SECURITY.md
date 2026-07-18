# Security policy

## Supported version

Security fixes are provided for the latest stable Claudex release only.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities involving OAuth credentials, release verification, downloaded runtimes, filesystem permissions, process ownership, or command execution. Use [GitHub private vulnerability reporting](https://github.com/cobibean/claudex/security/advisories/new).

Include the affected Claudex version, macOS version, reproduction steps, impact, and redacted diagnostic output. Never include OAuth tokens, API keys, device codes, private signing material, or unredacted auth files.

## Trust boundaries

Claudex verifies pinned runtimes and signed releases, stores secrets in private local paths, listens only on localhost, and strips unrelated parent-shell credentials before launching CLIProxyAPI. The unsupported Codex OAuth integration and separately licensed third-party runtimes remain explicit trust boundaries.
