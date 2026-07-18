# Third-party notices

Claudex is MIT licensed. The following separately obtained runtimes retain their own licenses, copyrights, and terms.

## CLIProxyAPI

Claudex downloads and executes the pinned macOS ARM64 binary from [CLIProxyAPI v7.2.80](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.80). The upstream source is [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and is distributed under the [MIT License](https://github.com/router-for-me/CLIProxyAPI/blob/main/LICENSE).

Claudex verifies the pinned archive SHA-256 and the runtime-reported version and commit before use. CLIProxyAPI is an independent project and does not endorse or support Claudex.

## Claude Code

Claudex downloads the pinned official Claude Code executable directly from Anthropic during a certified update. Claude Code is proprietary software: copyright Anthropic PBC, all rights reserved, and use is subject to [Anthropic's Commercial Terms of Service](https://github.com/anthropics/claude-code/blob/main/LICENSE.md).

Anthropic does not endorse or support Claudex or the use of non-Claude models behind Claude Code gateways.

## Codex OAuth

Claudex uses CLIProxyAPI as an unofficial third-party OAuth client. OpenAI documents ChatGPT OAuth for official Codex clients, not this proxy integration. A separate refresh token is stored under the Claudex-owned auth directory only after the user reads and accepts the in-product disclosure.
