import { describe, expect, it } from "vitest";
import {
  buildClaudeSettings,
  validateForwardedArgs
} from "../src/claude-settings.js";

describe("Claude Code routing overlay", () => {
  it("pins every harness model role to GPT-5.6 Sol without replacing Claude config", () => {
    const settings = buildClaudeSettings("/private/claudex/api-key-helper");

    expect(settings.model).toBe("gpt-5.6-sol");
    expect(settings.availableModels).toEqual(["gpt-5.6-sol"]);
    expect(settings.apiKeyHelper).toBe("/private/claudex/api-key-helper");
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("gpt-5.6-sol");
    expect(settings.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("gpt-5.6-sol");
    expect(settings.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(JSON.stringify(settings)).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it.each([
    ["--model", "opus"],
    ["--model=opus"],
    ["--fallback-model", "sonnet"],
    ["--settings", "/tmp/other.json"],
    ["--setting-sources=user"],
    ["--remote-control"]
  ])("rejects routing escape arguments: %s", (...args) => {
    expect(() => validateForwardedArgs(args)).toThrow(/not allowed through Claudex/);
  });

  it("preserves ordinary Claude arguments", () => {
    const args = ["-p", "hello world", "--output-format", "json"];
    expect(validateForwardedArgs(args)).toEqual(args);
  });
});
