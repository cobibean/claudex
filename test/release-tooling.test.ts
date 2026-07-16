import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyGatekeeperAssessment,
  inspectMachOArm64,
  validateClaudeManifest
} from "../scripts/certify-claude.mjs";
import {
  canonicalize,
  generateReleaseRecord,
  readCanonicalReleaseRecord,
  signReleaseRecord,
  validateReleaseRecord,
  verifyReleaseArtifacts,
  writeReleaseRecord
} from "../scripts/release-manifest.mjs";

const RECORD = {
  schemaVersion: 1,
  sequence: 1,
  repository: "cobibean/claudex",
  tag: "v0.2.0",
  platform: "darwin-arm64",
  claudex: {
    version: "0.2.0",
    asset: "claudex-0.2.0.tgz",
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

describe("release tooling", () => {
  it("canonicalizes recursively with sorted keys and no whitespace", () => {
    expect(canonicalize({ z: [{ y: 2, x: 1 }], a: true })).toBe('{"a":true,"z":[{"x":1,"y":2}]}');
  });

  it("validates the exact signed schema and trust-bound URLs", () => {
    expect(validateReleaseRecord(structuredClone(RECORD))).toEqual(RECORD);
    expect(() => validateReleaseRecord({ ...structuredClone(RECORD), extra: true })).toThrow(/exactly/);
    expect(() =>
      validateReleaseRecord({
        ...structuredClone(RECORD),
        claude: { ...RECORD.claude, url: "https://example.com/claude" }
      })
    ).toThrow(/downloads\.claude\.ai/);
    expect(() => validateReleaseRecord({ ...structuredClone(RECORD), revokedSequences: [1] })).toThrow(
      /own sequence/
    );
    expect(() =>
      validateReleaseRecord({
        ...structuredClone(RECORD),
        claude: { ...RECORD.claude, teamIdentifier: "ABCDEFGHIJ" }
      })
    ).toThrow(/Q6L2SF6YDW/);
    expect(() =>
      validateReleaseRecord({
        ...structuredClone(RECORD),
        claudex: { ...RECORD.claudex, version: "0.2.0-rc.1" },
        tag: "v0.2.0-rc.1"
      })
    ).toThrow(/semantic version/);
  });

  it("signs canonical bytes and detects manifest or artifact tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudex-release-tooling-"));
    const manifest = join(root, "release.json");
    const signature = join(root, "release.sig");
    const asset = join(root, "claudex-0.2.0.tgz");
    const contents = Buffer.from("release");
    await writeFile(asset, contents);
    const record = structuredClone(RECORD);
    record.claudex.size = contents.byteLength;
    record.claudex.sha256 = "a4d451ec23463726f72c43d64c710968f6b602cd653b4de8adee1b556240a829";
    await writeReleaseRecord(manifest, record);

    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    await signReleaseRecord({ manifestPath: manifest, signaturePath: signature, privateKeyPem: privateKey });
    await expect(
      verifyReleaseArtifacts({
        manifestPath: manifest,
        signaturePath: signature,
        publicKeyPem: publicKey,
        assetPath: asset,
        expectedTag: "v0.2.0"
      })
    ).resolves.toEqual(record);

    await writeFile(asset, "changed");
    await expect(
      verifyReleaseArtifacts({ manifestPath: manifest, signaturePath: signature, publicKeyPem: publicKey, assetPath: asset })
    ).rejects.toThrow(/SHA-256/);
    await writeFile(manifest, `${await readFile(manifest, "utf8")}\n`);
    await expect(readCanonicalReleaseRecord(manifest)).rejects.toThrow(/canonical byte form/);
  });

  it("generates the locked schema from built compatibility sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudex-generate-release-"));
    const asset = join(root, "claudex-0.2.0.tgz");
    const packagePath = join(root, "package.json");
    const compatibility = join(root, "compatibility.mjs");
    const runtime = join(root, "runtime.mjs");
    await writeFile(asset, "archive");
    await writeFile(packagePath, JSON.stringify({ name: "claudex", version: "0.2.0" }));
    await writeFile(
      compatibility,
      `export const CLAUDEX_VERSION="0.2.0";
export const RELEASE_SCHEMA_VERSION=1;
export const RELEASE_REPOSITORY="cobibean/claudex";
export const REVOKED_SEQUENCES=[];
export const BOOTSTRAP_SCHEMA_VERSION=1;
export const STATE_SCHEMA_VERSION=1;
export const CERTIFIED_CLAUDE=${JSON.stringify({ ...RECORD.claude, platform: "darwin-arm64" })};`
    );
    await writeFile(runtime, 'export const PROXY_RUNTIME={version:"7.2.80",commit:"09da52ad"};');
    const record = await generateReleaseRecord({
      assetPath: asset,
      sequence: 1,
      tag: "v0.2.0",
      packagePath,
      compatibilityModule: compatibility,
      runtimeModule: runtime
    });
    expect(record.claudex).toMatchObject({ version: "0.2.0", asset: "claudex-0.2.0.tgz", size: 7 });
    expect(record.proxy).toEqual(RECORD.proxy);
    expect(record.claude).toEqual(RECORD.claude);
  });
});

describe("Claude candidate metadata", () => {
  it("distinguishes standalone-CLI non-applicability from a security rejection", () => {
    expect(
      classifyGatekeeperAssessment(
        "rejected (the code is valid but does not seem to be an app)",
        true
      )
    ).toBe("not-applicable");
    expect(classifyGatekeeperAssessment("rejected (source=Unnotarized Developer ID)", true)).toBe(
      "rejected"
    );
    expect(
      classifyGatekeeperAssessment(
        "denied; rejected (the code is valid but does not seem to be an app)",
        true
      )
    ).toBe("rejected");
    expect(classifyGatekeeperAssessment("accepted source=Notarized Developer ID", false)).toBe(
      "accepted"
    );
  });

  it("accepts the official manifest shape and rejects the wrong version", () => {
    const manifest = {
      version: "2.1.211",
      commit: "17a4b6d7b2ee1936b95e595054c7e7d38fddafb7",
      buildDate: "2026-07-15T00:00:00Z",
      platforms: {
        "darwin-arm64": {
          binary: "claude",
          checksum: RECORD.claude.sha256,
          size: RECORD.claude.size
        }
      }
    };
    expect(validateClaudeManifest(manifest, "2.1.211")).toMatchObject({
      version: "2.1.211",
      checksum: RECORD.claude.sha256,
      size: RECORD.claude.size
    });
    expect(() => validateClaudeManifest(manifest, "2.1.212")).toThrow(/version/);
  });

  it("recognizes only a thin ARM64 Mach-O header", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudex-macho-"));
    const arm = join(root, "arm");
    const other = join(root, "other");
    await writeFile(arm, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]));
    await writeFile(other, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x00, 0x00]));
    await expect(inspectMachOArm64(arm)).resolves.toBe(true);
    await expect(inspectMachOArm64(other)).resolves.toBe(false);
  });
});
