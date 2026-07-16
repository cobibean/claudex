import { describe, expect, it } from "vitest";
import { formatDiagnostics } from "../src/diagnostics.js";

describe("diagnostic update visibility", () => {
  it("shows active, previous, integrity, bootstrap, and transaction state", () => {
    const output = formatDiagnostics({
      ok: true,
      claude: { ok: true, version: "2.1.212" },
      proxyRuntime: { installed: true, requiredVersion: "7.2.80" },
      managedPair: {
        active: { sequence: 2, claudexVersion: "0.3.0", claudeVersion: "2.1.212", source: "current" },
        previous: { sequence: 1, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
        runtimeIntegrity: "verified",
        currentRuntimeIntegrity: "verified",
        previousRuntimeIntegrity: "verified",
        bootstrapVersion: "0.2.0",
        incompleteTransaction: false
      },
      proxy: { owned: true, pid: 42, live: true, authenticated: true, modelAvailable: true },
      oauth: { present: true },
      settings: { valid: true },
      permissions: { ok: true },
      environment: { conflicts: [] },
      sessions: { active: [] }
    });

    expect(output).toContain("Active pair: Claudex 0.3.0 + Claude Code 2.1.212 (sequence 2)");
    expect(output).toContain("Previous pair: Claudex 0.2.0 + Claude Code 2.1.211 (sequence 1)");
    expect(output).toContain("Managed runtime integrity: verified");
    expect(output).toContain("Current pointer integrity: verified");
    expect(output).toContain("Previous pointer integrity: verified");
    expect(output).toContain("Permanent bootstrap 0.2.0");
    expect(output).toContain("Incomplete update transaction: none");
  });
});
