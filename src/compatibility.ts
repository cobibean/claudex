export const CLAUDEX_VERSION = "0.2.1";
export const CLAUDE_VERSION = "2.1.211";
export const RELEASE_REPOSITORY = "cobibean/claudex";
export const RELEASE_SEQUENCE = 2;
export const REVOKED_SEQUENCES: readonly number[] = [];
export const RELEASE_SCHEMA_VERSION = 1;
export const STATE_SCHEMA_VERSION = 1;
export const BOOTSTRAP_SCHEMA_VERSION = 1;

export const CERTIFIED_CLAUDE = {
  version: CLAUDE_VERSION,
  platform: "darwin-arm64",
  url: `https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/darwin-arm64/claude`,
  sha256: "5a728a76198b6eca7f3c7cdbff43bab44b77b48c2108f7a3107d889773382629",
  size: 242_445_680,
  identifier: "com.anthropic.claude-code",
  teamIdentifier: "Q6L2SF6YDW"
} as const;

export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEArMEIa2SKzexx5M7lU3jqpIZ/MzaCnPALjeWP016i+Cs=
-----END PUBLIC KEY-----
`;
