import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  certifyProxyCandidate,
  inspectMachOArm64,
  parseChecksumFile,
  validateArchiveEntries,
  validateProxyCertificationOptions
} from "../scripts/certify-proxy.mjs";
import {
  computeProxyCertificationSourceDigest,
  validateProxyCertificationEvidence
} from "../scripts/verify-proxy-certification.mjs";

const ARCHIVE = Buffer.from("safe inert archive fixture");
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const CHECKSUMS = Buffer.from(`${ARCHIVE_SHA}  CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz\n`);
const CHECKSUMS_SHA = createHash("sha256").update(CHECKSUMS).digest("hex");
const BINARY_SHA = "b".repeat(64);
const RUNTIME = {
  version: "7.2.80",
  commit: "09da52ad",
  tagCommit: "09da52ad509e2c18e7b9540db3b98c2214c280aa",
  asset: "CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
  url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
  size: ARCHIVE.byteLength,
  sha256: ARCHIVE_SHA,
  binarySha256: BINARY_SHA
};
const SOURCE = {
  repository: "cobibean/claudex",
  commit: "1".repeat(40),
  digest: "2".repeat(64),
  dirty: false
};
const API = "https://api.github.com/repos/router-for-me/CLIProxyAPI";

function response(body: BodyInit, url: string, init: ResponseInit = {}) {
  const value = new Response(body, { status: 200, ...init });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

function json(value: unknown, url: string) {
  return response(JSON.stringify(value), url, { headers: { "content-type": "application/json" } });
}

function fixtureFetch(checksumContents = CHECKSUMS) {
  const releaseUrl = `${API}/releases/tags/v7.2.80`;
  const refUrl = `${API}/git/ref/tags/v7.2.80`;
  const archiveApi = `${API}/releases/assets/10`;
  const checksumsApi = `${API}/releases/assets/11`;
  const checksumsUrl = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/checksums.txt";
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === releaseUrl) return json({
      tag_name: "v7.2.80",
      draft: false,
      prerelease: false,
      assets: [
        { name: RUNTIME.asset, size: RUNTIME.size, digest: `sha256:${RUNTIME.sha256}`, url: archiveApi, browser_download_url: RUNTIME.url },
        { name: "checksums.txt", size: checksumContents.byteLength, digest: `sha256:${createHash("sha256").update(checksumContents).digest("hex")}`, url: checksumsApi, browser_download_url: checksumsUrl }
      ]
    }, releaseUrl);
    if (url === refUrl) return json({ object: { type: "commit", sha: RUNTIME.tagCommit } }, refUrl);
    if (url === RUNTIME.url) return response(ARCHIVE, RUNTIME.url);
    if (url === checksumsUrl) return response(checksumContents, checksumsUrl);
    throw new Error(`unexpected fixture URL ${url}`);
  });
  return { fetchImpl, calls, releaseUrl, refUrl, archiveApi, checksumsApi };
}

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "claudex-proxy-certification",
    certifiedAt: "2026-07-19T12:00:00.000Z",
    source: SOURCE,
    expectations: { sha256: RUNTIME.sha256, size: RUNTIME.size, matched: true },
    runtime: RUNTIME,
    upstream: {
      releaseUrl: `${API}/releases/tags/v7.2.80`,
      tag: "v7.2.80",
      tagCommit: RUNTIME.tagCommit,
      assetApiUrl: `${API}/releases/assets/10`,
      checksumsApiUrl: `${API}/releases/assets/11`,
      checksumFileSha256: CHECKSUMS_SHA,
      checksumEntrySha256: RUNTIME.sha256
    },
    candidate: {
      archiveSize: RUNTIME.size,
      archiveSha256: RUNTIME.sha256,
      binarySha256: BINARY_SHA,
      versionOutput: "CLIProxyAPI Version: 7.2.80, Commit: 09da52ad",
      machOArm64: true,
      safeArchive: true
    },
    live: {
      localhostOnly: true,
      authDirectoryReused: true,
      health: true,
      model: true,
      routedResponse: true,
      childOwned: true
    },
    proposedRuntime: RUNTIME,
    ...overrides
  };
}

describe("proxy candidate certification", () => {
  it("requires independent archive SHA and size plus an existing-auth-directory path for live mode", () => {
    expect(() => validateProxyCertificationOptions({})).toThrow(/expected-sha256.*expected-size/i);
    expect(() => validateProxyCertificationOptions({ expectedSha256: RUNTIME.sha256, expectedSize: RUNTIME.size })).toThrow(/auth-dir/i);
    expect(validateProxyCertificationOptions({
      expectedSha256: RUNTIME.sha256,
      expectedSize: RUNTIME.size,
      authDir: "/caller/auth"
    })).toMatchObject({ authDir: "/caller/auth" });
    expect(validateProxyCertificationOptions({ live: false })).toMatchObject({ live: false });
  });

  it("requires one exact checksum-file agreement and rejects unsafe archive paths", () => {
    expect(parseChecksumFile(CHECKSUMS.toString(), RUNTIME.asset)).toBe(RUNTIME.sha256);
    expect(() => parseChecksumFile(`${CHECKSUMS}${CHECKSUMS}`, RUNTIME.asset)).toThrow(/exactly one/);
    expect(validateArchiveEntries(["CLIProxyAPI", "docs/readme.md"])).toBe(true);
    for (const entries of [["../CLIProxyAPI"], ["/tmp/CLIProxyAPI"], ["safe/../../CLIProxyAPI"], ["safe\\CLIProxyAPI"]]) {
      expect(() => validateArchiveEntries(entries)).toThrow(/unsafe|invalid/);
    }
  });

  it("recognizes only a thin little-endian arm64 Mach-O header from inert fixtures", async () => {
    const root = await mkdtemp(join(tmpdir(), "proxy-macho-test-"));
    const arm = join(root, "arm64");
    const wrong = join(root, "wrong");
    await writeFile(arm, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]));
    await writeFile(wrong, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]));
    await expect(inspectMachOArm64(arm)).resolves.toBe(true);
    await expect(inspectMachOArm64(wrong)).resolves.toBe(false);
  });

  it("builds live evidence from exact GitHub metadata using injected inert inspection and routing gates", async () => {
    const authDir = await mkdtemp(join(tmpdir(), "proxy-auth-fixture-"));
    await writeFile(join(authDir, "codex.json"), "fixture credentials are never read or copied\n");
    const fixture = fixtureFetch();
    const inspectCandidateImpl = vi.fn(async (archive: string) => {
      expect(await import("node:fs/promises").then(({ readFile }) => readFile(archive))).toEqual(ARCHIVE);
      return {
        binary: "/inert/not-executed/CLIProxyAPI",
        binarySha256: BINARY_SHA,
        versionOutput: "CLIProxyAPI Version: 7.2.80, Commit: 09da52ad",
        cleanup: vi.fn()
      };
    });
    const runLiveImpl = vi.fn(async (binary: string, options: { authDir: string }) => {
      expect(binary).toBe("/inert/not-executed/CLIProxyAPI");
      expect(options.authDir).toBe(authDir);
      return { localhostOnly: true, authDirectoryReused: true, health: true, model: true, routedResponse: true, childOwned: true };
    });
    const report = await certifyProxyCandidate(RUNTIME, {
      platform: "darwin",
      arch: "arm64",
      expectedSha256: RUNTIME.sha256,
      expectedSize: RUNTIME.size,
      authDir,
      sourceState: SOURCE,
      fetchImpl: fixture.fetchImpl,
      inspectCandidateImpl,
      runLiveImpl,
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });

    expect(fixture.calls).toEqual([fixture.releaseUrl, fixture.refUrl, RUNTIME.url, expect.stringMatching(/checksums\.txt$/)]);
    expect(report).toEqual(validEvidence());
    expect(inspectCandidateImpl).toHaveBeenCalledOnce();
    expect(runLiveImpl).toHaveBeenCalledOnce();
  });

  it("rejects checksum-file disagreement before inspecting or running a candidate", async () => {
    const fixture = fixtureFetch(Buffer.from(`${"f".repeat(64)}  ${RUNTIME.asset}\n`));
    const inspectCandidateImpl = vi.fn();
    await expect(certifyProxyCandidate(RUNTIME, {
      live: false,
      platform: "darwin",
      arch: "arm64",
      sourceState: SOURCE,
      fetchImpl: fixture.fetchImpl,
      inspectCandidateImpl
    })).rejects.toThrow(/checksum-file entry/);
    expect(inspectCandidateImpl).not.toHaveBeenCalled();
  });
});

describe("proxy certification release evidence", () => {
  const verification = {
    certifiedProxy: RUNTIME,
    sourceDigest: SOURCE.digest,
    now: new Date("2026-07-20T12:00:00.000Z"),
    maxAgeDays: 30
  };

  it("accepts only complete live evidence bound to current source and runtime", () => {
    expect(validateProxyCertificationEvidence(validEvidence(), verification)).toMatchObject({
      kind: "claudex-proxy-certification",
      runtime: { version: "7.2.80" }
    });
  });

  it("ensures offline reports can never pass the release verifier", () => {
    expect(() => validateProxyCertificationEvidence(validEvidence({ live: null }), verification)).toThrow(/live/);
  });

  it("rejects dirty, source-mismatched, tag-mismatched, expectation-free, and stale evidence", () => {
    expect(() => validateProxyCertificationEvidence(validEvidence({ source: { ...SOURCE, dirty: true } }), verification)).toThrow(/clean source/);
    expect(() => validateProxyCertificationEvidence(validEvidence({ source: { ...SOURCE, digest: "3".repeat(64) } }), verification)).toThrow(/source digest/);
    expect(() => validateProxyCertificationEvidence(validEvidence({ upstream: { ...validEvidence().upstream, tagCommit: "4".repeat(40) } }), verification)).toThrow(/tag/);
    expect(() => validateProxyCertificationEvidence(validEvidence({ expectations: { ...validEvidence().expectations, matched: false } }), verification)).toThrow(/expectation/);
    expect(() => validateProxyCertificationEvidence(validEvidence({ candidate: { ...validEvidence().candidate, binarySha256: "c".repeat(64) } }), verification)).toThrow(/candidate identity/);
    expect(() => validateProxyCertificationEvidence(validEvidence(), { ...verification, now: new Date("2026-09-01T12:00:00.000Z") })).toThrow(/older than/);
  });

  it("computes a stable digest over an explicit focused source fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "proxy-source-test-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "proxy.ts"), "proxy\n");
    await writeFile(join(root, "src", "runtime.ts"), "runtime\n");
    const first = await computeProxyCertificationSourceDigest(root, ["src/runtime.ts", "src/proxy.ts"]);
    const second = await computeProxyCertificationSourceDigest(root, ["src/proxy.ts", "src/runtime.ts"]);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await expect(computeProxyCertificationSourceDigest(root, ["src/missing.ts"])).rejects.toThrow(/missing/);
  });
});
