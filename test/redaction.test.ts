import { describe, expect, it } from "vitest";
import { redact } from "../src/redaction.js";

describe("diagnostic redaction", () => {
  it("removes OAuth, authorization, and managed proxy secrets", () => {
    const localKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const input = [
      "Authorization: Bearer access-value",
      '"refresh_token":"refresh-value"',
      '"id_token": "id-value"',
      "https://example.test/callback?code=oauth-code&state=oauth-state",
      `proxy=${localKey}`
    ].join("\n");

    const output = redact(input, [localKey]);
    expect(output).not.toContain("access-value");
    expect(output).not.toContain("refresh-value");
    expect(output).not.toContain("id-value");
    expect(output).not.toContain("oauth-code");
    expect(output).not.toContain("oauth-state");
    expect(output).not.toContain(localKey);
    expect(output).toContain("[REDACTED]");
  });
});
