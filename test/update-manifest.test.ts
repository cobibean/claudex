import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize as canonicalizeLegacyRelease } from "../scripts/release-manifest.mjs";
import {
  bindUpdateRecord,
  canonicalizeUpdateRecord,
  signUpdateRecord,
  validateUpdateRecord,
  verifyUpdateRecordBinding,
  verifyUpdateRecordSignature
} from "../scripts/update-manifest.mjs";

const COMMIT = "09da52ad7c67cd89d24c1b4c87a5141cbd184d7f";
const LEGACY_RELEASE = {
  schemaVersion: 1,
  sequence: 9,
  repository: "cobibean/claudex",
  tag: "v0.2.9",
  platform: "darwin-arm64",
  claudex: {
    version: "0.2.9",
    asset: "claudex-0.2.9.tgz",
    size: 7,
    sha256: "1".repeat(64)
  },
  claude: {
    version: "2.1.211",
    url: "https://downloads.claude.ai/claude-code-releases/2.1.211/darwin-arm64/claude",
    size: 32,
    sha256: "2".repeat(64),
    identifier: "com.anthropic.claude-code",
    teamIdentifier: "Q6L2SF6YDW"
  },
  proxy: { version: "7.2.80", commit: COMMIT },
  minimumBootstrapSchema: 1,
  minimumStateSchema: 1,
  revokedSequences: []
};
const LEGACY_CANONICAL = canonicalizeLegacyRelease(LEGACY_RELEASE);
const PROXY_ARTIFACT = {
  platform: "darwin-arm64",
  version: "7.2.80",
  commit: COMMIT,
  asset: "CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
  size: 123,
  sha256: "3".repeat(64),
  binary: "cli-proxy-api",
  binarySha256: "4".repeat(64)
};
const UPDATE = {
  schemaVersion: 1,
  repository: "cobibean/claudex",
  tag: "v0.2.9",
  sequence: 9,
  channel: "stable",
  legacyReleaseSha256: createHash("sha256").update(LEGACY_CANONICAL).digest("hex"),
  proxyArtifact: PROXY_ARTIFACT
};

describe("detached update manifest", () => {
  it("canonicalizes the exact schema with recursively sorted keys", () => {
    expect(canonicalizeUpdateRecord(structuredClone(UPDATE))).toBe(
      `{"channel":"stable","legacyReleaseSha256":"${UPDATE.legacyReleaseSha256}","proxyArtifact":{"asset":"CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz","binary":"cli-proxy-api","binarySha256":"${"4".repeat(64)}","commit":"${COMMIT}","platform":"darwin-arm64","sha256":"${"3".repeat(64)}","size":123,"version":"7.2.80"},"repository":"cobibean/claudex","schemaVersion":1,"sequence":9,"tag":"v0.2.9"}`
    );
  });

  it("rejects unknown keys and every locked proxy artifact identity violation", () => {
    expect(validateUpdateRecord(structuredClone(UPDATE))).toEqual(UPDATE);
    expect(() => validateUpdateRecord({ ...structuredClone(UPDATE), extra: true })).toThrow(/exactly/);
    expect(() => validateUpdateRecord({ ...structuredClone(UPDATE), channel: "latest" })).toThrow(/stable/);
    expect(() =>
      validateUpdateRecord({ ...structuredClone(UPDATE), proxyArtifact: { ...PROXY_ARTIFACT, platform: "linux-arm64" } })
    ).toThrow(/darwin-arm64/);
    expect(() =>
      validateUpdateRecord({ ...structuredClone(UPDATE), proxyArtifact: { ...PROXY_ARTIFACT, commit: "09da52ad" } })
    ).toThrow(/40-character/);
    expect(() =>
      validateUpdateRecord({ ...structuredClone(UPDATE), proxyArtifact: { ...PROXY_ARTIFACT, asset: "proxy.tar.gz" } })
    ).toThrow(/CLIProxyAPI_7\.2\.80_darwin_aarch64\.tar\.gz/);
    expect(() =>
      validateUpdateRecord({ ...structuredClone(UPDATE), proxyArtifact: { ...PROXY_ARTIFACT, binary: "proxy" } })
    ).toThrow(/cli-proxy-api/);
  });

  it("binds repository, tag, sequence, proxy identity, and exact legacy canonical bytes", () => {
    expect(
      bindUpdateRecord({
        legacyRelease: LEGACY_RELEASE,
        legacyCanonicalBytes: LEGACY_CANONICAL,
        proxyArtifact: PROXY_ARTIFACT
      })
    ).toEqual(UPDATE);
    expect(
      verifyUpdateRecordBinding(structuredClone(UPDATE), {
        legacyRelease: LEGACY_RELEASE,
        legacyCanonicalBytes: LEGACY_CANONICAL
      })
    ).toEqual(UPDATE);
  });

  it("rejects detached metadata or legacy-byte substitution that breaks the binding", () => {
    expect(() =>
      verifyUpdateRecordBinding({ ...structuredClone(UPDATE), sequence: 10 }, {
        legacyRelease: LEGACY_RELEASE,
        legacyCanonicalBytes: LEGACY_CANONICAL
      })
    ).toThrow(/sequence/);
    expect(() =>
      verifyUpdateRecordBinding(structuredClone(UPDATE), {
        legacyRelease: LEGACY_RELEASE,
        legacyCanonicalBytes: `${LEGACY_CANONICAL}\n`
      })
    ).toThrow(/canonical byte form/);
    expect(() =>
      verifyUpdateRecordBinding(structuredClone(UPDATE), {
        legacyRelease: { ...LEGACY_RELEASE, proxy: { ...LEGACY_RELEASE.proxy, version: "7.2.81" } },
        legacyCanonicalBytes: LEGACY_CANONICAL
      })
    ).toThrow(/parsed legacy release/);
  });

  it("signs canonical update bytes with Ed25519 and detects tampering", () => {
    const keys = generateKeyPairSync("ed25519");
    const signature = signUpdateRecord(UPDATE, keys.privateKey);
    expect(verifyUpdateRecordSignature(UPDATE, signature, keys.publicKey)).toEqual(UPDATE);
    expect(() =>
      verifyUpdateRecordSignature({ ...structuredClone(UPDATE), sequence: 10 }, signature, keys.publicKey)
    ).toThrow(/verification failed/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => signUpdateRecord(UPDATE, rsa.privateKey)).toThrow(/Ed25519/);
  });
});
