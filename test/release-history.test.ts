import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateReleaseHistory,
  verifyReleaseHistoryDirectory
} from "../scripts/verify-release-history.mjs";
import { signReleaseRecord, writeReleaseRecord } from "../scripts/release-manifest.mjs";

function record(sequence: number, version: string) {
  return {
    schemaVersion: 1,
    sequence,
    repository: "cobibean/claudex",
    tag: `v${version}`,
    platform: "darwin-arm64",
    claudex: {
      version,
      asset: `claudex-${version}.tgz`,
      size: 7,
      sha256: "1".repeat(64)
    },
    claude: {
      version: "2.1.211",
      url: "https://downloads.claude.ai/claude-code-releases/2.1.211/darwin-arm64/claude",
      size: 242_445_680,
      sha256: "5a728a76198b6eca7f3c7cdbff43bab44b77b48c2108f7a3107d889773382629",
      identifier: "com.anthropic.claude-code",
      teamIdentifier: "Q6L2SF6YDW"
    },
    proxy: { version: "7.2.80", commit: "09da52ad" },
    minimumBootstrapSchema: 1,
    minimumStateSchema: 1,
    revokedSequences: []
  };
}

describe("signed release history", () => {
  it("requires the next sequence to exceed the maximum rather than GitHub latest", () => {
    expect(validateReleaseHistory([record(3, "0.3.0"), record(1, "0.1.0"), record(2, "0.2.0")], 4)).toBe(3);
    expect(() => validateReleaseHistory([record(3, "0.3.0"), record(1, "0.1.0")], 3)).toThrow(
      /greater than maximum signed sequence 3/
    );
  });

  it("rejects duplicate sequences or tags", () => {
    expect(() => validateReleaseHistory([record(1, "0.1.0"), record(1, "0.2.0")], 3)).toThrow(
      /duplicate sequence/
    );
    expect(() => validateReleaseHistory([record(1, "0.1.0"), record(2, "0.1.0")], 3)).toThrow(
      /duplicate tag/
    );
  });

  it("verifies every signed record before calculating the maximum", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudex-history-"));
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    for (const entry of [record(1, "0.1.0"), record(2, "0.2.0")]) {
      const directory = join(root, entry.tag);
      await mkdir(directory);
      await writeReleaseRecord(join(directory, "release.json"), entry);
      await signReleaseRecord({
        manifestPath: join(directory, "release.json"),
        signaturePath: join(directory, "release.sig"),
        privateKeyPem
      });
    }
    await expect(
      verifyReleaseHistoryDirectory({ directory: root, nextSequence: 3, publicKeyPem })
    ).resolves.toEqual({ maximumSequence: 2, releases: 2 });
  });
});
