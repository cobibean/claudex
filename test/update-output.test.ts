import { describe, expect, it } from "vitest";
import { failedUpdateResult, formatUpdateResult, invalidUpdateUsageResult } from "../src/update-output.js";
import type { UpdateResult } from "../src/update.js";

describe("update output contract", () => {
  it("reports the current, target, and previous certified pairs for humans", () => {
    const result: UpdateResult = {
      ok: true,
      action: "check",
      status: "update-available",
      current: { sequence: 1, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      target: { sequence: 2, claudexVersion: "0.3.0", claudeVersion: "2.1.212" },
      previous: null,
      code: "UPDATE_AVAILABLE",
      message: "An update is available."
    };

    expect(formatUpdateResult(result)).toBe(
      "An update is available.\n" +
        "Current: sequence 1: Claudex 0.2.0 + Claude Code 2.1.211\n" +
        "Target: sequence 2: Claudex 0.3.0 + Claude Code 2.1.212\n" +
        "Previous: none"
    );
  });

  it("creates the stable eight-field JSON shape for failures", () => {
    expect(Object.keys(failedUpdateResult("apply", "Blocked."))).toEqual([
      "ok",
      "action",
      "status",
      "current",
      "target",
      "previous",
      "code",
      "message"
    ]);
  });

  it("uses the same JSON contract for invalid update usage", () => {
    expect(invalidUpdateUsageResult("rollback", "Bad flags.")).toMatchObject({
      ok: false,
      action: "rollback",
      status: "invalid-usage",
      code: "INVALID_USAGE"
    });
  });
});
