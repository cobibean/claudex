import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimSessionStart } from "../src/proxy.js";
import { resolvePaths } from "../src/state.js";
import {
  canonicalizeReleaseRecord,
  createGitHubReleaseAdapter,
  inspectManagedUpdateState,
  inspectLinkedPair,
  manageUpdate,
  recoverInterruptedUpdate,
  resolveUpdatePaths,
  UpdateInterruption,
  type ReleaseDescriptor,
  type ReleaseRecord,
  type ReleaseSource,
  type UpdateDependencies
} from "../src/update.js";

const RELEASE: ReleaseRecord = {
  schemaVersion: 1,
  sequence: 1,
  repository: "cobibean/claudex",
  tag: "v0.2.0",
  platform: "darwin-arm64",
  claudex: {
    version: "0.2.0",
    asset: "claudex-0.2.0.tgz",
    size: 16,
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
  proxy: { version: "7.2.80", commit: "09da52ad" },
  minimumBootstrapSchema: 1,
  minimumStateSchema: 1,
  revokedSequences: []
};

function signedSource(record: ReleaseRecord = RELEASE): {
  publicKey: string;
  source: ReleaseSource;
  descriptor: ReleaseDescriptor;
};
function signedSource(
  record: ReleaseRecord,
  artifacts: { claudex: Buffer; claude: Buffer }
): { publicKey: string; source: ReleaseSource; descriptor: ReleaseDescriptor };
function signedSource(
  record: ReleaseRecord = RELEASE,
  artifacts?: { claudex: Buffer; claude: Buffer }
): { publicKey: string; source: ReleaseSource; descriptor: ReleaseDescriptor } {
  const keys = generateKeyPairSync("ed25519");
  const releaseJson = Buffer.from(`${canonicalizeReleaseRecord(record)}\n`);
  const releaseSignature = Buffer.from(
    sign(null, Buffer.from(canonicalizeReleaseRecord(record)), keys.privateKey).toString("base64")
  );
  const assetUrl = (id: number) =>
    `https://api.github.com/repos/cobibean/claudex/releases/assets/${id}`;
  const descriptor: ReleaseDescriptor = {
    repository: record.repository,
    tag: record.tag,
    draft: false,
    prerelease: false,
    assets: [
      { name: "release.json", size: releaseJson.byteLength, url: assetUrl(1) },
      { name: "release.sig", size: releaseSignature.byteLength, url: assetUrl(2) },
      {
        name: record.claudex.asset,
        size: record.claudex.size,
        url: assetUrl(3)
      }
    ]
  };
  const contents = new Map([
    [assetUrl(1), releaseJson],
    [assetUrl(2), releaseSignature],
    ...(artifacts
      ? [
          [assetUrl(3), artifacts.claudex] as const,
          [record.claude.url, artifacts.claude] as const
        ]
      : [])
  ]);
  return {
    publicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    descriptor,
    source: {
      async latest() {
        return descriptor;
      },
      async download(url, destination) {
        const content = contents.get(url);
        if (!content) throw new Error(`No test artifact for ${url}`);
        await writeFile(destination, content);
      }
    }
  };
}

function releaseAt(sequence: number): ReleaseRecord {
  const patch = sequence - 1;
  return {
    ...RELEASE,
    sequence,
    tag: `v0.2.${patch}`,
    claudex: {
      ...RELEASE.claudex,
      version: `0.2.${patch}`,
      asset: `claudex-0.2.${patch}.tgz`
    },
    claude: {
      ...RELEASE.claude,
      version: `2.1.${210 + sequence}`,
      url: `https://downloads.claude.ai/claude-code-releases/2.1.${210 + sequence}/darwin-arm64/claude`
    }
  };
}

async function applyTestRelease(
  home: string,
  input: ReleaseRecord,
  overrides: Partial<UpdateDependencies> = {},
  useDefaultActivatedVerification = false
): Promise<ReleaseRecord> {
  const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
  const claudex = Buffer.from(`claudex-${input.claudex.version}-${input.sequence}`);
  const claude = Buffer.from(`claude-${input.claude.version}-${input.sequence}`);
  const record: ReleaseRecord = {
    ...input,
    claudex: { ...input.claudex, size: claudex.byteLength, sha256: digest(claudex) },
    claude: { ...input.claude, size: claude.byteLength, sha256: digest(claude) }
  };
  const signed = signedSource(record, { claudex, claude });
  await manageUpdate("apply", resolveUpdatePaths(home), {
    releaseSource: signed.source,
    publicKeyPem: signed.publicKey,
    platform: "darwin",
    arch: "arm64",
    env: {},
    activeSessionCount: async () => 0,
    hasCodexAuth: async () => true,
    extractClaudexArchive: async (_archive, destination) => {
      await mkdir(join(destination, "dist"), { recursive: true });
      await mkdir(join(destination, "bin"), { recursive: true });
      await writeFile(
        join(destination, "package.json"),
        JSON.stringify({ name: "claudex", version: record.claudex.version })
      );
      await writeFile(join(destination, "dist", "cli.js"), "// candidate");
      await writeFile(join(destination, "bin", "claudex"), "#!/bin/sh\n");
    },
    verifyClaudeBinary: async () => [],
    prepareProxy: async () => false,
    restoreProxy: async () => undefined,
    verifyCandidate: async () => undefined,
    ...(useDefaultActivatedVerification
      ? {}
      : { verifyActivated: async () => undefined }),
    ...overrides
  });
  return record;
}

describe("managed Claudex updates", () => {
  it("recovers interrupted activation locally before bootstrap delegation", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-recovery-"));
    const paths = resolveUpdatePaths(home);
    await mkdir(paths.releasesRoot, { recursive: true });
    await mkdir(paths.runDir, { recursive: true });
    await symlink("2", paths.currentLink);
    await symlink("1", paths.previousLink);
    await writeFile(paths.lockFile, `${JSON.stringify({ pid: 999_999 })}\n`);
    await writeFile(
      paths.journalFile,
      `${JSON.stringify({
        schemaVersion: 1,
        action: "apply",
        phase: "activated",
        targetSequence: 2,
        targetClaudexVersion: "0.2.1",
        targetClaudeVersion: "2.1.212",
        stagingName: ".update-staging-999999-deadbeef",
        oldCurrent: "1",
        oldPrevious: null,
        proxyWasRunning: null
      })}\n`
    );
    await writeFile(
      paths.snapshotFile,
      `${JSON.stringify({
        schemaVersion: 1,
        entries: {
          settings: { kind: "missing" },
          proxyConfig: { kind: "missing" },
          proxyKey: { kind: "missing" },
          apiKeyHelper: { kind: "missing" },
          resolvedClaude: { kind: "missing" },
          packagedFallback: { kind: "missing" }
        }
      })}\n`
    );

    expect(
      await recoverInterruptedUpdate(paths, { isProcessAlive: () => false })
    ).toBe("recovered");
    expect(await readlink(paths.currentLink)).toBe("1");
    await expect(readlink(paths.previousLink)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(paths.runDir)).toEqual([]);
  });

  it("treats a recent malformed lock as busy instead of deleting a live updater claim", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-lock-race-"));
    const paths = resolveUpdatePaths(home);
    await mkdir(paths.runDir, { recursive: true });
    await writeFile(paths.lockFile, "");

    expect(await recoverInterruptedUpdate(paths, { isProcessAlive: () => false })).toBe("busy");
    expect(await readFile(paths.lockFile, "utf8")).toBe("");
  });

  it("records a running proxy before interruption, then quiesces and restores it during recovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-proxy-journal-"));
    const paths = resolveUpdatePaths(home);

    await expect(
      applyTestRelease(home, releaseAt(1), {
        prepareProxy: async (_paths, recordPriorState) => {
          await recordPriorState(true);
          throw new UpdateInterruption("interrupt after proxy state is durable");
        }
      })
    ).rejects.toBeInstanceOf(UpdateInterruption);
    expect(JSON.parse(await readFile(paths.journalFile, "utf8"))).toMatchObject({
      phase: "prepared",
      proxyWasRunning: true
    });

    const transitions: boolean[] = [];
    expect(
      await recoverInterruptedUpdate(paths, {
        restoreProxy: async (_updatePaths, wasRunning) => {
          transitions.push(wasRunning);
        }
      })
    ).toBe("recovered");
    expect(transitions).toEqual([false, true]);
    await expect(readFile(paths.journalFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.snapshotFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the recovery journal and snapshot when proxy restoration fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-restore-failure-"));
    const paths = resolveUpdatePaths(home);
    await expect(
      applyTestRelease(home, releaseAt(1), {
        prepareProxy: async (_paths, recordPriorState) => {
          await recordPriorState(true);
          throw new UpdateInterruption("leave a recoverable transaction");
        }
      })
    ).rejects.toBeInstanceOf(UpdateInterruption);

    const transitions: boolean[] = [];
    await expect(
      recoverInterruptedUpdate(paths, {
        restoreProxy: async (_updatePaths, wasRunning) => {
          transitions.push(wasRunning);
          if (wasRunning) throw new Error("proxy restart failed");
        }
      })
    ).rejects.toThrow(/proxy restart failed/i);
    expect(transitions).toEqual([false, true]);
    expect((await stat(paths.journalFile)).isFile()).toBe(true);
    expect((await stat(paths.snapshotFile)).isFile()).toBe(true);
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds the replacement update lock while recovering so concurrent recovery and session start stay blocked", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-recovery-lock-"));
    const paths = resolveUpdatePaths(home);
    await expect(
      applyTestRelease(home, releaseAt(1), {
        prepareProxy: async (_paths, recordPriorState) => {
          await recordPriorState(false);
          throw new UpdateInterruption("leave a recoverable transaction");
        }
      })
    ).rejects.toBeInstanceOf(UpdateInterruption);

    let enteredRecovery!: () => void;
    let releaseRecovery!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredRecovery = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const firstRecovery = recoverInterruptedUpdate(paths, {
      pid: 71_111,
      isProcessAlive: (pid) => pid === 71_111,
      restoreProxy: async (_updatePaths, wasRunning) => {
        if (!wasRunning) {
          enteredRecovery();
          await hold;
        }
      }
    });
    await entered;
    expect(JSON.parse(await readFile(paths.lockFile, "utf8"))).toEqual({ pid: 71_111 });

    expect(
      await recoverInterruptedUpdate(paths, {
        pid: 72_222,
        isProcessAlive: (pid) => pid === 71_111,
        restoreProxy: async () => undefined
      })
    ).toBe("busy");
    await expect(
      claimSessionStart(resolvePaths(home), 73_333, "/private/test/claude")
    ).rejects.toThrow(/update is in progress/i);
    expect(JSON.parse(await readFile(paths.lockFile, "utf8"))).toEqual({ pid: 71_111 });

    releaseRecovery();
    expect(await firstRecovery).toBe("recovered");
    await expect(readFile(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses authenticated private GitHub releases without forwarding credentials to Anthropic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-update-github-"));
    const requests: Array<{ url: string; authorization: string | null; accept: string | null }> = [];
    const assetUrl = "https://api.github.com/repos/cobibean/claudex/releases/assets/42";
    const claudeUrl = RELEASE.claude.url;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        authorization: headers.get("authorization"),
        accept: headers.get("accept")
      });
      if (url.endsWith("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: RELEASE.tag,
            draft: false,
            prerelease: false,
            assets: [{ name: "release.json", size: 8, url: assetUrl }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(url === assetUrl ? "github" : "anthropic", { status: 200 });
    }) as typeof fetch;
    const source = createGitHubReleaseAdapter({
      fetchImpl,
      tokenProvider: async () => "private-token"
    });

    expect(await source.latest()).toEqual({
      repository: "cobibean/claudex",
      tag: "v0.2.0",
      draft: false,
      prerelease: false,
      assets: [{ name: "release.json", size: 8, url: assetUrl }]
    });
    await source.download(assetUrl, join(directory, "github-asset"));
    await source.download(claudeUrl, join(directory, "claude-asset"));

    expect(await readFile(join(directory, "github-asset"), "utf8")).toBe("github");
    expect(await readFile(join(directory, "claude-asset"), "utf8")).toBe("anthropic");
    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/cobibean/claudex/releases/latest",
        authorization: "Bearer private-token",
        accept: "application/vnd.github+json"
      },
      {
        url: assetUrl,
        authorization: "Bearer private-token",
        accept: "application/octet-stream"
      },
      { url: claudeUrl, authorization: null, accept: "application/octet-stream" }
    ]);
  });

  it("bounds release discovery and removes a truncated artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-update-network-failure-"));
    const timeoutSource = createGitHubReleaseAdapter({
      latestTimeoutMs: 5,
      tokenProvider: async () => "private-token",
      fetchImpl: ((_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })) as typeof fetch
    });
    await expect(timeoutSource.latest()).rejects.toThrow(/timed out/i);

    const destination = join(directory, "partial-claude");
    const truncatedSource = createGitHubReleaseAdapter({
      tokenProvider: async () => "unused",
      fetchImpl: (async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("partial"));
            controller.error(new Error("truncated response"));
          }
        });
        return new Response(body, { status: 200 });
      }) as typeof fetch
    });
    await expect(truncatedSource.download(RELEASE.claude.url, destination)).rejects.toThrow(
      /truncated response/i
    );
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a valid signed release without changing local state", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-check-"));
    const signed = signedSource();

    const result = await manageUpdate("check", resolveUpdatePaths(home), {
      releaseSource: signed.source,
      publicKeyPem: signed.publicKey,
      platform: "darwin",
      arch: "arm64"
    });

    expect(result).toEqual({
      ok: true,
      action: "check",
      status: "update-available",
      current: null,
      target: { sequence: 1, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      previous: null,
      code: "UPDATE_AVAILABLE",
      message: "Claudex 0.2.0 with Claude Code 2.1.211 is available."
    });
    expect(await readdir(home)).toEqual([]);
  });

  it("fails closed when the signed release record is not authentic", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-signature-"));
    const authentic = signedSource();
    const unrelatedKey = signedSource().publicKey;

    await expect(
      manageUpdate("check", resolveUpdatePaths(home), {
        releaseSource: authentic.source,
        publicKeyPem: unrelatedKey,
        platform: "darwin",
        arch: "arm64"
      })
    ).rejects.toThrow(/signature verification failed/);
    expect(await readdir(home)).toEqual([]);
  });

  it("rejects a signed record whose security-critical fields are malformed", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-schema-"));
    const malformed = {
      ...RELEASE,
      sequence: 0,
      claudex: { ...RELEASE.claudex, sha256: "not-a-sha256" }
    };
    const signed = signedSource(malformed);

    await expect(
      manageUpdate("check", resolveUpdatePaths(home), {
        releaseSource: signed.source,
        publicKeyPem: signed.publicKey,
        platform: "darwin",
        arch: "arm64"
      })
    ).rejects.toThrow(/malformed/);
    expect(await readdir(home)).toEqual([]);
  });

  it("rejects a same-sequence target whose signed record differs from the installed release", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-sequence-collision-"));
    const installed = await applyTestRelease(home, RELEASE);
    const mutated = { ...installed, revokedSequences: [99] };
    const signed = signedSource(mutated);

    await expect(
      manageUpdate("check", resolveUpdatePaths(home), {
        releaseSource: signed.source,
        publicKeyPem: signed.publicKey,
        platform: "darwin",
        arch: "arm64"
      })
    ).rejects.toThrow(/same release sequence.*different/i);
  });

  it.each([
    [
      "proxy identity",
      { ...RELEASE, proxy: { ...RELEASE.proxy, commit: "deadbee" } },
      /proxy/i
    ],
    [
      "Claude identifier",
      { ...RELEASE, claude: { ...RELEASE.claude, identifier: "com.example.claude" } },
      /identifier/i
    ],
    [
      "Claude team",
      { ...RELEASE, claude: { ...RELEASE.claude, teamIdentifier: "ABCDEFGHIJ" } },
      /team/i
    ]
  ] as const)("rejects a signed release with the wrong %s", async (_label, record, message) => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-identity-"));
    const signed = signedSource(record);

    await expect(
      manageUpdate("check", resolveUpdatePaths(home), {
        releaseSource: signed.source,
        publicKeyPem: signed.publicKey,
        platform: "darwin",
        arch: "arm64"
      })
    ).rejects.toThrow(message);
  });

  it.each([
    {
      label: "repository",
      record: { ...RELEASE, repository: "attacker/claudex" },
      mutate: (descriptor: ReleaseDescriptor) => descriptor,
      message: /repository/i
    },
    {
      label: "asset host",
      record: RELEASE,
      mutate: (descriptor: ReleaseDescriptor) => ({
        ...descriptor,
        assets: descriptor.assets.map((asset, index) =>
          index === 0 ? { ...asset, url: "https://attacker.example/release.json" } : asset
        )
      }),
      message: /repository|asset URL/i
    },
    {
      label: "tag",
      record: { ...RELEASE, tag: "v9.9.9" },
      mutate: (descriptor: ReleaseDescriptor) => descriptor,
      message: /tag/i
    },
    {
      label: "platform",
      record: { ...RELEASE, platform: "linux-x64" } as unknown as ReleaseRecord,
      mutate: (descriptor: ReleaseDescriptor) => descriptor,
      message: /malformed|compatible/i
    },
    {
      label: "draft status",
      record: RELEASE,
      mutate: (descriptor: ReleaseDescriptor) => ({ ...descriptor, draft: true }),
      message: /stable/i
    }
  ])("rejects a release with the wrong $label", async ({ record, mutate, message }) => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-trust-"));
    const signed = signedSource(record);
    const source: ReleaseSource = {
      async latest() {
        return mutate(await signed.source.latest());
      },
      download: (url, destination) => signed.source.download(url, destination)
    };

    await expect(
      manageUpdate("check", resolveUpdatePaths(home), {
        releaseSource: source,
        publicKeyPem: signed.publicKey,
        platform: "darwin",
        arch: "arm64"
      })
    ).rejects.toThrow(message);
  });

  it("fails the free-space preflight before downloading runtime artifacts", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-space-"));
    const claudex = Buffer.from("claudex archive");
    const claude = Buffer.from("Claude binary");
    const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
    const record: ReleaseRecord = {
      ...RELEASE,
      claudex: { ...RELEASE.claudex, size: claudex.byteLength, sha256: digest(claudex) },
      claude: { ...RELEASE.claude, size: claude.byteLength, sha256: digest(claude) }
    };
    const signed = signedSource(record, { claudex, claude });
    const downloaded: string[] = [];
    const source: ReleaseSource = {
      latest: () => signed.source.latest(),
      async download(url, destination) {
        downloaded.push(url);
        await signed.source.download(url, destination);
      }
    };

    await expect(
      manageUpdate("apply", resolveUpdatePaths(home), {
        releaseSource: source,
        publicKeyPem: signed.publicKey,
        platform: "darwin",
        arch: "arm64",
        env: {},
        activeSessionCount: async () => 0,
        hasCodexAuth: async () => true,
        availableBytes: async () => 0,
        extractClaudexArchive: async () => {
          throw new Error("runtime download reached extraction");
        }
      })
    ).rejects.toThrow(/free space/i);
    expect(downloaded).toEqual([
      signed.descriptor.assets[0]?.url,
      signed.descriptor.assets[1]?.url
    ]);
  });

  it("rejects apply before release discovery when Claudex Codex OAuth is unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-auth-"));
    let networkCalls = 0;
    const source: ReleaseSource = {
      async latest() {
        networkCalls += 1;
        throw new Error("release discovery should not run");
      },
      async download() {
        networkCalls += 1;
        throw new Error("artifact download should not run");
      }
    };

    await expect(
      manageUpdate("apply", resolveUpdatePaths(home), {
        releaseSource: source,
        publicKeyPem: "unused",
        platform: "darwin",
        arch: "arm64",
        env: {},
        activeSessionCount: async () => 0,
        hasCodexAuth: async () => false
      })
    ).rejects.toThrow(/Codex OAuth/i);
    expect(networkCalls).toBe(0);
    const paths = resolveUpdatePaths(home);
    const failure = JSON.parse(await readFile(paths.failureFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(failure).sort()).toEqual([
      "action",
      "code",
      "phase",
      "schemaVersion",
      "timestamp"
    ]);
    expect(failure).toMatchObject({
      schemaVersion: 1,
      action: "apply",
      phase: "preflight",
      code: "UPDATE_FAILED"
    });
    expect(failure.timestamp).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect((await stat(paths.failureFile)).mode & 0o777).toBe(0o600);
  });

  it("installs and atomically activates one verified immutable pair", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-apply-"));
    const claudex = Buffer.from("a test claudex package");
    const claude = Buffer.from("a test official Claude binary");
    const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
    const record: ReleaseRecord = {
      ...RELEASE,
      claudex: { ...RELEASE.claudex, size: claudex.byteLength, sha256: digest(claudex) },
      claude: { ...RELEASE.claude, size: claude.byteLength, sha256: digest(claude) }
    };
    const signed = signedSource(record, { claudex, claude });
    const paths = resolveUpdatePaths(home);
    const verified: string[] = [];

    const result = await manageUpdate("apply", paths, {
      releaseSource: signed.source,
      publicKeyPem: signed.publicKey,
      platform: "darwin",
      arch: "arm64",
      env: {},
      activeSessionCount: async () => 0,
      hasCodexAuth: async () => true,
      extractClaudexArchive: async (_archive, destination) => {
        await mkdir(join(destination, "dist"), { recursive: true });
        await mkdir(join(destination, "bin"), { recursive: true });
        await writeFile(
          join(destination, "package.json"),
          JSON.stringify({ name: "claudex", version: record.claudex.version })
        );
        await writeFile(join(destination, "dist", "cli.js"), "// candidate");
        await writeFile(join(destination, "bin", "claudex"), "#!/bin/sh\n");
        await chmod(join(destination, "bin", "claudex"), 0o700);
      },
      verifyClaudeBinary: async (binary, expected) => {
        expect(await readFile(binary)).toEqual(claude);
        expect(expected).toEqual(record.claude);
        verified.push("claude");
        return [];
      },
      prepareProxy: async () => {
        verified.push("proxy-ready");
        return false;
      },
      restoreProxy: async (_paths, wasRunning) => {
        expect(wasRunning).toBe(false);
        verified.push("proxy-restored");
      },
      verifyCandidate: async (candidate) => {
        expect(candidate.record).toEqual(record);
        verified.push("candidate");
      },
      verifyActivated: async (candidate) => {
        expect(candidate.record.sequence).toBe(1);
        verified.push("active");
      }
    });

    expect(result).toEqual({
      ok: true,
      action: "apply",
      status: "updated",
      current: { sequence: 1, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      target: { sequence: 1, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      previous: null,
      code: "UPDATED",
      message: "Updated to Claudex 0.2.0 with Claude Code 2.1.211."
    });
    expect(await readlink(paths.currentLink)).toBe("1");
    expect(await readFile(join(paths.releasesRoot, "1", "release.json"), "utf8")).toBe(
      `${canonicalizeReleaseRecord(record)}\n`
    );
    expect(await readFile(join(paths.claudeRuntimeRoot, "2.1.211", "claude"))).toEqual(claude);
    expect(JSON.parse(await readFile(join(paths.claudexRuntimeRoot, "0.2.0", "package.json"), "utf8"))).toEqual({
      name: "claudex",
      version: "0.2.0"
    });
    expect((await stat(paths.home)).mode & 0o777).toBe(0o700);
    expect(verified).toEqual(["claude", "proxy-ready", "candidate", "active", "proxy-restored"]);
    expect(await readdir(paths.runDir)).toEqual([]);
    expect(await inspectManagedUpdateState(paths)).toEqual({
      current: { sequence: 1, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      previous: null,
      managedRuntimeIntegrity: "verified",
      incompleteTransaction: false
    });
  });

  it("detects tampering inside an extracted managed Claudex runtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-tree-integrity-"));
    await applyTestRelease(home, RELEASE);
    const paths = resolveUpdatePaths(home);
    await writeFile(join(paths.claudexRuntimeRoot, "0.2.0", "dist", "cli.js"), "// tampered");

    expect((await inspectManagedUpdateState(paths)).managedRuntimeIntegrity).toBe("invalid");
    expect(await inspectLinkedPair(paths, "current")).toBeNull();
  });

  it("retains only the current and previous managed pairs after activation", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-retention-"));
    const paths = resolveUpdatePaths(home);
    await applyTestRelease(home, RELEASE);
    await applyTestRelease(home, {
      ...RELEASE,
      sequence: 2,
      tag: "v0.2.1",
      claudex: { ...RELEASE.claudex, version: "0.2.1", asset: "claudex-0.2.1.tgz" },
      claude: {
        ...RELEASE.claude,
        version: "2.1.212",
        url: "https://downloads.claude.ai/claude-code-releases/2.1.212/darwin-arm64/claude"
      }
    });
    await applyTestRelease(home, {
      ...RELEASE,
      sequence: 3,
      tag: "v0.2.2",
      claudex: { ...RELEASE.claudex, version: "0.2.2", asset: "claudex-0.2.2.tgz" },
      claude: {
        ...RELEASE.claude,
        version: "2.1.213",
        url: "https://downloads.claude.ai/claude-code-releases/2.1.213/darwin-arm64/claude"
      }
    });

    expect((await readdir(paths.releasesRoot)).sort()).toEqual([
      "2",
      "3",
      "current",
      "packaged-fallback.json",
      "previous"
    ]);
    expect((await readdir(paths.claudexRuntimeRoot)).sort()).toEqual(["0.2.1", "0.2.2"]);
    expect((await readdir(paths.claudeRuntimeRoot)).sort()).toEqual([
      "2.1.211",
      "2.1.212",
      "2.1.213"
    ]);
  });

  it("rolls the first managed installation back to the packaged private pair and can update again", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-packaged-rollback-"));
    const paths = resolveUpdatePaths(home);
    const installed = await applyTestRelease(home, releaseAt(1));

    const rollback = await manageUpdate("rollback", paths, {
      platform: "darwin",
      arch: "arm64",
      env: {},
      activeSessionCount: async () => 0,
      verifyClaudeBinary: async () => [],
      prepareProxy: async () => false,
      restoreProxy: async () => undefined,
      verifyActivated: async () => undefined
    });
    expect(rollback).toEqual({
      ok: true,
      action: "rollback",
      status: "rolled-back",
      current: { sequence: 0, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      target: { sequence: 0, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      previous: { sequence: 1, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      code: "ROLLED_BACK_TO_PACKAGED",
      message: "Rolled back to packaged Claudex 0.2.0 with private Claude Code 2.1.211."
    });
    await expect(readlink(paths.currentLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readlink(paths.previousLink)).rejects.toMatchObject({ code: "ENOENT" });

    const signed = signedSource(installed);
    const check = await manageUpdate("check", paths, {
      releaseSource: signed.source,
      publicKeyPem: signed.publicKey,
      platform: "darwin",
      arch: "arm64"
    });
    expect(check.current).toEqual({
      sequence: 0,
      claudexVersion: "0.2.0",
      claudeVersion: "2.1.211"
    });
    expect(check.status).toBe("update-available");

    await applyTestRelease(home, releaseAt(1));
    expect(await readlink(paths.currentLink)).toBe("1");
    expect(await readFile(paths.packagedFallbackFile, "utf8")).toContain('"claudeVersion":"2.1.211"');
  });

  it.each(["prepared", "activating", "activated"] as const)(
    "recovers an abruptly interrupted apply from the %s journal phase",
    async (interruptedPhase) => {
      const home = await mkdtemp(join(tmpdir(), "claudex-update-phase-apply-"));
      const paths = resolveUpdatePaths(home);
      await applyTestRelease(home, releaseAt(1));
      await applyTestRelease(home, releaseAt(2));

      await expect(
        applyTestRelease(home, releaseAt(3), {
          onPhase: async (action, phase) => {
            if (action === "apply" && phase === interruptedPhase) {
              throw new UpdateInterruption(`interrupt apply at ${phase}`);
            }
          }
        })
      ).rejects.toBeInstanceOf(UpdateInterruption);

      expect(await readlink(paths.currentLink)).toBe(interruptedPhase === "activated" ? "3" : "2");
      expect(await recoverInterruptedUpdate(paths, {
        isProcessAlive: () => false,
        restoreProxy: async () => undefined
      })).toBe("recovered");
      expect(await readlink(paths.currentLink)).toBe("2");
      expect(await readlink(paths.previousLink)).toBe("1");
      expect((await inspectManagedUpdateState(paths)).incompleteTransaction).toBe(false);
    }
  );

  it.each(["prepared", "activating", "activated"] as const)(
    "recovers an abruptly interrupted rollback from the %s journal phase",
    async (interruptedPhase) => {
      const home = await mkdtemp(join(tmpdir(), "claudex-update-phase-rollback-"));
      const paths = resolveUpdatePaths(home);
      await applyTestRelease(home, releaseAt(1));
      await applyTestRelease(home, releaseAt(2));

      await expect(
        manageUpdate("rollback", paths, {
          platform: "darwin",
          arch: "arm64",
          env: {},
          activeSessionCount: async () => 0,
          verifyClaudeBinary: async () => [],
          prepareProxy: async () => false,
          restoreProxy: async () => undefined,
          verifyActivated: async () => undefined,
          onPhase: async (action, phase) => {
            if (action === "rollback" && phase === interruptedPhase) {
              throw new UpdateInterruption(`interrupt rollback at ${phase}`);
            }
          }
        })
      ).rejects.toBeInstanceOf(UpdateInterruption);

      expect(await readlink(paths.currentLink)).toBe(interruptedPhase === "activated" ? "1" : "2");
      expect(await recoverInterruptedUpdate(paths, {
        isProcessAlive: () => false,
        restoreProxy: async () => undefined
      })).toBe("recovered");
      expect(await readlink(paths.currentLink)).toBe("2");
      expect(await readlink(paths.previousLink)).toBe("1");
      expect((await inspectManagedUpdateState(paths)).incompleteTransaction).toBe(false);
    }
  );

  it("removes journal-owned staging and unreferenced promoted target artifacts during recovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-recovery-cleanup-"));
    const paths = resolveUpdatePaths(home);
    await applyTestRelease(home, releaseAt(1));
    await applyTestRelease(home, releaseAt(2));
    await expect(
      applyTestRelease(home, releaseAt(3), {
        onPhase: async (action, phase) => {
          if (action === "apply" && phase === "activated") {
            throw new UpdateInterruption("interrupt after target promotion");
          }
        }
      })
    ).rejects.toBeInstanceOf(UpdateInterruption);

    const journal = JSON.parse(await readFile(paths.journalFile, "utf8")) as {
      stagingName: unknown;
    };
    expect(journal.stagingName).toEqual(expect.stringMatching(/^\.update-staging-/));
    const staging = join(home, journal.stagingName as string);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await writeFile(join(staging, "leftover"), "partial transaction");
    const promoted = [
      join(paths.releasesRoot, "3"),
      join(paths.claudexRuntimeRoot, "0.2.2"),
      join(paths.claudeRuntimeRoot, "2.1.213")
    ];
    for (const path of [staging, ...promoted]) expect((await stat(path)).isDirectory()).toBe(true);

    expect(
      await recoverInterruptedUpdate(paths, { restoreProxy: async () => undefined })
    ).toBe("recovered");
    expect(await readlink(paths.currentLink)).toBe("2");
    expect(await readlink(paths.previousLink)).toBe("1");
    for (const path of [staging, ...promoted]) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each([
    { identity: "previous", existingSequence: 1, targetSequence: 2, reportedSequence: 1 },
    { identity: "packaged", existingSequence: 0, targetSequence: 1, reportedSequence: null }
  ] as const)(
    "rejects an ok doctor that reports the $identity fallback instead of the activated target",
    async ({ identity, existingSequence, targetSequence, reportedSequence }) => {
      const home = await mkdtemp(join(tmpdir(), "claudex-update-activation-identity-"));
      const paths = resolveUpdatePaths(home);
      if (existingSequence > 0) await applyTestRelease(home, releaseAt(existingSequence));
      const target = releaseAt(targetSequence);
      const bootstrap = join(home, `lying-${identity}-bootstrap.mjs`);
      const report = {
        ok: true,
        claude: { ok: true, version: target.claude.version },
        managedPair: {
          active: {
            source: identity,
            sequence: reportedSequence,
            claudexVersion: target.claudex.version,
            claudeVersion: target.claude.version
          },
          runtimeIntegrity: identity === "packaged" ? "packaged" : "verified"
        }
      };
      await writeFile(
        bootstrap,
        `process.stdout.write(${JSON.stringify(JSON.stringify(report))});\n`,
        { mode: 0o600 }
      );
      const inheritedBootstrap = process.env.CLAUDEX_BOOTSTRAP_ENTRYPOINT;
      process.env.CLAUDEX_BOOTSTRAP_ENTRYPOINT = bootstrap;
      try {
        await expect(
          applyTestRelease(home, target, {}, true)
        ).rejects.toThrow(/did not verify the intended active pair/i);
      } finally {
        if (inheritedBootstrap === undefined) delete process.env.CLAUDEX_BOOTSTRAP_ENTRYPOINT;
        else process.env.CLAUDEX_BOOTSTRAP_ENTRYPOINT = inheritedBootstrap;
      }

      if (existingSequence > 0) {
        expect(await readlink(paths.currentLink)).toBe(String(existingSequence));
      } else {
        await expect(readlink(paths.currentLink)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(stat(join(paths.releasesRoot, String(targetSequence)))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );

  it("rolls back to the previous verified pair without contacting a release source", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-update-rollback-"));
    const paths = resolveUpdatePaths(home);
    const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
    const install = async (record: ReleaseRecord) => {
      const claudex = Buffer.from(`claudex-${record.claudex.version}`);
      const claude = Buffer.from(`claude-${record.claude.version}`);
      const complete: ReleaseRecord = {
        ...record,
        claudex: { ...record.claudex, size: claudex.byteLength, sha256: digest(claudex) },
        claude: { ...record.claude, size: claude.byteLength, sha256: digest(claude) }
      };
      const signed = signedSource(complete, { claudex, claude });
      return manageUpdate("apply", paths, {
        releaseSource: signed.source,
        publicKeyPem: signed.publicKey,
        platform: "darwin",
        arch: "arm64",
        env: {},
        activeSessionCount: async () => 0,
        hasCodexAuth: async () => true,
        extractClaudexArchive: async (_archive, destination) => {
          await mkdir(join(destination, "dist"), { recursive: true });
          await mkdir(join(destination, "bin"), { recursive: true });
          await writeFile(
            join(destination, "package.json"),
            JSON.stringify({ name: "claudex", version: complete.claudex.version })
          );
          await writeFile(join(destination, "dist", "cli.js"), "// candidate");
          await writeFile(join(destination, "bin", "claudex"), "#!/bin/sh\n");
        },
        verifyClaudeBinary: async () => [],
        prepareProxy: async () => false,
        restoreProxy: async () => undefined,
        verifyCandidate: async () => undefined,
        verifyActivated: async () => undefined
      });
    };
    await install(RELEASE);
    await install({
      ...RELEASE,
      sequence: 2,
      tag: "v0.2.1",
      claudex: { ...RELEASE.claudex, version: "0.2.1", asset: "claudex-0.2.1.tgz" },
      claude: {
        ...RELEASE.claude,
        version: "2.1.212",
        url: "https://downloads.claude.ai/claude-code-releases/2.1.212/darwin-arm64/claude"
      }
    });
    let networkCalls = 0;
    const activated: number[] = [];

    const result = await manageUpdate("rollback", paths, {
      releaseSource: {
        async latest() {
          networkCalls += 1;
          throw new Error("rollback attempted a network request");
        },
        async download() {
          networkCalls += 1;
          throw new Error("rollback attempted a network request");
        }
      },
      env: {},
      activeSessionCount: async () => 0,
      verifyClaudeBinary: async () => [],
      prepareProxy: async () => false,
      restoreProxy: async () => undefined,
      verifyActivated: async (candidate) => {
        activated.push(candidate.record.sequence);
      }
    });

    expect(result).toEqual({
      ok: true,
      action: "rollback",
      status: "rolled-back",
      current: { sequence: 1, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      target: { sequence: 1, claudexVersion: "0.2.0", claudeVersion: "2.1.211" },
      previous: { sequence: 2, claudexVersion: "0.2.1", claudeVersion: "2.1.212" },
      code: "ROLLED_BACK",
      message: "Rolled back to Claudex 0.2.0 with Claude Code 2.1.211."
    });
    expect(await readlink(paths.currentLink)).toBe("1");
    expect(await readlink(paths.previousLink)).toBe("2");
    expect(networkCalls).toBe(0);
    expect(activated).toEqual([1]);
    expect(await readdir(paths.runDir)).toEqual([]);
  });
});
