import { describe, expect, it } from "vitest";
import { buildClaudeExec, parseInvocation } from "../src/invocation.js";

describe("Claudex command interface", () => {
  it.each([
    [[], { kind: "launch", args: [] }],
    [["-p", "hello"], { kind: "launch", args: ["-p", "hello"] }],
    [["--", "doctor"], { kind: "launch", args: ["doctor"] }],
    [["login", "--device"], { kind: "login", device: true, noBrowser: false }],
    [["status", "--json"], { kind: "status", json: true }],
    [["--version"], { kind: "version" }],
    [["proxy", "restart", "--force"], { kind: "proxy", action: "restart", force: true }]
  ])("parses %j", (args, expected) => {
    expect(parseInvocation(args)).toEqual(expected);
  });

  it("builds an exact official-Claude exec while scrubbing conflicting credentials", () => {
    const spec = buildClaudeExec({
      claudePath: "/official/claude",
      settingsPath: "/state/settings.json",
      args: ["-p", "hello world"],
      inheritedEnv: {
        PATH: "/bin",
        CLAUDE_CONFIG_DIR: "/real/claude-config",
        ANTHROPIC_API_KEY: "must-not-leak",
        CLAUDE_CODE_USE_BEDROCK: "1"
      },
      routingEnv: { ANTHROPIC_MODEL: "gpt-5.6-sol" }
    });

    expect(spec).toEqual({
      file: "/official/claude",
      args: ["/official/claude", "--settings", "/state/settings.json", "-p", "hello world"],
      env: {
        PATH: "/bin",
        CLAUDE_CONFIG_DIR: "/real/claude-config",
        ANTHROPIC_MODEL: "gpt-5.6-sol"
      }
    });
  });

  it("omits --settings for Claude management subcommands that reject it", () => {
    const spec = buildClaudeExec({
      claudePath: "/official/claude",
      settingsPath: "/state/settings.json",
      args: ["doctor"],
      inheritedEnv: {},
      routingEnv: { ANTHROPIC_MODEL: "gpt-5.6-sol" },
      proxyApiKey: "local-only-key"
    });
    expect(spec.args).toEqual(["/official/claude", "doctor"]);
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe("local-only-key");
  });
});
