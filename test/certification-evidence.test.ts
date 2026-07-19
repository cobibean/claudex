import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeCertificationSourceDigest,
  validateClaudeCertificationEvidence
} from "../scripts/verify-claude-certification.mjs";
import { validateCertificationOptions } from "../scripts/certify-claude.mjs";

const CLAUDE = {
  version: "2.1.211",
  platform: "darwin-arm64",
  url: "https://downloads.claude.ai/claude-code-releases/2.1.211/darwin-arm64/claude",
  sha256: "5a728a76198b6eca7f3c7cdbff43bab44b77b48c2108f7a3107d889773382629",
  size: 242_445_680,
  identifier: "com.anthropic.claude-code",
  teamIdentifier: "Q6L2SF6YDW"
};

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    kind: "claudex-claude-certification",
    certifiedAt: "2026-07-18T12:00:00.000Z",
    source: {
      repository: "cobibean/claudex",
      commit: "1".repeat(40),
      tree: "4".repeat(40),
      digest: "2".repeat(64),
      dirty: false,
      claudexVersion: "0.2.1",
      releaseSequence: 2
    },
    expectations: {
      sha256: CLAUDE.sha256,
      size: CLAUDE.size,
      matched: true
    },
    version: CLAUDE.version,
    platform: CLAUDE.platform,
    manifest: {
      url: "https://downloads.claude.ai/claude-code-releases/2.1.211/manifest.json",
      commit: "3".repeat(40),
      buildDate: "2026-07-15T00:00:00Z"
    },
    candidate: {
      url: CLAUDE.url,
      size: CLAUDE.size,
      sha256: CLAUDE.sha256,
      identifier: CLAUDE.identifier,
      teamIdentifier: CLAUDE.teamIdentifier,
      versionOutput: "2.1.211 (Claude Code)",
      machOArm64: true,
      strictSignatureValid: true,
      gatekeeperAccepted: false
    },
    live: {
      doctor: true,
      routedPrompt: true,
      toolsDisabled: true,
      proxyObserved: true,
      priorProxyStateRestored: true
    },
    warnings: ["Gatekeeper reported that the valid standalone executable is not an app and could not be assessed as one"],
    proposedCompatibility: CLAUDE,
    ...overrides
  };
}

describe("Claude certification evidence", () => {
  it("requires independent hash and size expectations for live evidence", () => {
    expect(() => validateCertificationOptions({})).toThrow(/expected-sha256.*expected-size/i);
    expect(() => validateCertificationOptions({ expectedSha256: CLAUDE.sha256 })).toThrow(
      /expected-sha256.*expected-size/i
    );
    expect(
      validateCertificationOptions({ expectedSha256: CLAUDE.sha256, expectedSize: CLAUDE.size })
    ).toMatchObject({ expectedSha256: CLAUDE.sha256, expectedSize: CLAUDE.size });
    expect(validateCertificationOptions({ live: false })).toMatchObject({ live: false });
  });

  it("binds a live expectation-backed report to current source and compatibility", () => {
    expect(
      validateClaudeCertificationEvidence(evidence(), {
        certifiedClaude: CLAUDE,
        sourceDigest: "2".repeat(64),
        sourceCommit: "1".repeat(40),
        sourceTree: "4".repeat(40),
        claudexVersion: "0.2.1",
        releaseSequence: 2,
        now: new Date("2026-07-20T12:00:00.000Z"),
        maxAgeDays: 30
      })
    ).toMatchObject({ version: "2.1.211", schemaVersion: 2 });
  });

  it("rejects offline, dirty, stale, mismatched, or expectation-free evidence", () => {
    const options = {
      certifiedClaude: CLAUDE,
      sourceDigest: "2".repeat(64),
      now: new Date("2026-08-30T12:00:00.000Z"),
      maxAgeDays: 30
    };
    expect(() => validateClaudeCertificationEvidence(evidence({ live: null }), options)).toThrow(/live/);
    expect(() =>
      validateClaudeCertificationEvidence(
        evidence({ live: { ...evidence().live, priorProxyStateRestored: false } }),
        { ...options, now: new Date("2026-07-20T12:00:00.000Z") }
      )
    ).toThrow(/complete live/);
    expect(() =>
      validateClaudeCertificationEvidence(
        evidence({ source: { ...evidence().source, dirty: true } }),
        options
      )
    ).toThrow(/clean source/);
    expect(() => validateClaudeCertificationEvidence(evidence(), options)).toThrow(/older than 30 days/);
    expect(() =>
      validateClaudeCertificationEvidence(
        evidence({ source: { ...evidence().source, digest: "4".repeat(64) } }),
        { ...options, now: new Date("2026-07-20T12:00:00.000Z") }
      )
    ).toThrow(/source digest/);
    expect(() =>
      validateClaudeCertificationEvidence(
        evidence({ expectations: { ...evidence().expectations, matched: false } }),
        { ...options, now: new Date("2026-07-20T12:00:00.000Z") }
      )
    ).toThrow(/expectation/);
    for (const gate of ["machOArm64", "strictSignatureValid"]) {
      expect(() =>
        validateClaudeCertificationEvidence(
          evidence({ candidate: { ...evidence().candidate, [gate]: false } }),
          { ...options, now: new Date("2026-07-20T12:00:00.000Z") }
        )
      ).toThrow(/platform and signature gates/);
    }
    expect(() =>
      validateClaudeCertificationEvidence(
        evidence({ candidate: { ...evidence().candidate, gatekeeperAccepted: false }, warnings: [] }),
        { ...options, now: new Date("2026-07-20T12:00:00.000Z") }
      )
    ).toThrow(/Gatekeeper evidence/);
    expect(() =>
      validateClaudeCertificationEvidence(
        evidence({ candidate: { ...evidence().candidate, versionOutput: "2.1.210 (Claude Code)" } }),
        { ...options, now: new Date("2026-07-20T12:00:00.000Z") }
      )
    ).toThrow(/version evidence/);
  });

  it("computes a stable digest over release-critical source and rejects missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudex-cert-source-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "a\n");
    await writeFile(join(root, "package.json"), "{}\n");
    const first = await computeCertificationSourceDigest(root, ["package.json", "src/a.ts"]);
    const second = await computeCertificationSourceDigest(root, ["src/a.ts", "package.json"]);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await expect(computeCertificationSourceDigest(root, ["src/missing.ts"])).rejects.toThrow(/missing/);
  });
});
