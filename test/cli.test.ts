import { describe, expect, it } from "vitest";
import { buildClaudeExec, parseInvocation } from "../src/invocation.js";
import { UsageError } from "../src/errors.js";

describe("Claudex command interface", () => {
  it.each([
    [[], { kind: "launch", args: [] }],
    [["-p", "hello"], { kind: "launch", args: ["-p", "hello"] }],
    [["--", "doctor"], { kind: "launch", args: ["doctor"] }],
    [["login", "--device"], { kind: "login", device: true, noBrowser: false }],
    [["status", "--json"], { kind: "status", json: true }],
    [["update"], { kind: "update", action: "apply", json: false }],
    [["update", "--check", "--json"], { kind: "update", action: "check", json: true }],
    [["update", "--rollback"], { kind: "update", action: "rollback", json: false }],
    [["--version"], { kind: "version" }],
    [["proxy", "restart", "--force"], { kind: "proxy", action: "restart", force: true }]
  ])("parses %j", (args, expected) => {
    expect(parseInvocation(args)).toEqual(expected);
  });

  it("rejects incompatible update modes", () => {
    expect(() => parseInvocation(["update", "--check", "--rollback"])).toThrow(UsageError);
    expect(() => parseInvocation(["update", "2.1.212"])).toThrow(UsageError);
    expect(() => parseInvocation(["update", "--json", "--json"])).toThrow(UsageError);
  });

  it.each([["--", "update"], ["--", "upgrade"], ["--", "install"], ["--", "migrate-installer"]])(
    "blocks upstream self-mutation through %j",
    (...args) => {
      expect(() => parseInvocation(args)).toThrow(/managed by Claudex/);
    }
  );

  it.each([
    ["--verbose", "update"],
    ["--debug", "install"],
    ["--verbose", "--debug", "migrate-installer"],
    ["--permission-mode", "plan", "update"],
    ["--debug-file", "/tmp/claudex-debug", "install"]
  ])("blocks upstream self-mutation after leading Claude flags: %j", (...args) => {
    expect(() => parseInvocation(args)).toThrow(/managed by Claudex/);
  });

  it.each([["-p", "update"], ["--print", "install"]])(
    "allows mutation words as print prompts: %j",
    (...args) => {
      expect(parseInvocation(args)).toEqual({ kind: "launch", args });
    }
  );

  it("does not let print mode hide a later mutation command", () => {
    expect(() => parseInvocation(["-p", "hello", "update"])).toThrow(/managed by Claudex/);
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
        ANTHROPIC_MODEL: "gpt-5.6-sol",
        DISABLE_UPDATES: "1",
        DISABLE_AUTOUPDATER: "1"
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
    expect(spec.env.DISABLE_UPDATES).toBe("1");
    expect(spec.env.DISABLE_AUTOUPDATER).toBe("1");
  });
});
