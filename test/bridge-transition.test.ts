import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROXY_RUNTIME, type ProxyRuntimeIdentity } from "../src/runtime.js";
import {
  canonicalizeReleaseRecord,
  canonicalizeUpdateRecord,
  inspectManagedUpdateState,
  manageUpdate,
  recoverInterruptedUpdate,
  resolveUpdatePaths,
  UpdateInterruption,
  type ReleaseDescriptor,
  type ReleaseRecord,
  type ReleaseSource,
  type UpdateDependencies,
  type UpdateRecord
} from "../src/update.js";

const TARGET_COMMIT = "93d74a890a44802f656d7f39a573916b2611896e";
const digest = (contents: Buffer | string) =>
  createHash("sha256").update(contents).digest("hex");
const assetUrl = (id: number) =>
  `https://api.github.com/repos/cobibean/claudex/releases/assets/${id}`;

interface FixtureRelease {
  descriptor: ReleaseDescriptor;
  record: ReleaseRecord;
  contents: Map<string, Buffer>;
}

function releaseFixture(
  sequence: number,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]
): FixtureRelease {
  if (!Number.isSafeInteger(sequence) || sequence < 3) throw new Error("fixture sequence must be at least 3");
  const changedProxy = sequence > 3;
  const claudex = Buffer.from(`claudex-sequence-${sequence}`);
  const claude = Buffer.from("claude-certified-2.1.211");
  const proxyArchive = Buffer.from("verified changed proxy archive");
  const version = `0.3.${sequence - 3}`;
  const record: ReleaseRecord = {
    schemaVersion: 1,
    sequence,
    repository: "cobibean/claudex",
    tag: `v${version}`,
    platform: "darwin-arm64",
    claudex: {
      version,
      asset: `claudex-${version}.tgz`,
      size: claudex.byteLength,
      sha256: digest(claudex)
    },
    claude: {
      version: "2.1.211",
      url: "https://downloads.claude.ai/claude-code-releases/2.1.211/darwin-arm64/claude",
      size: claude.byteLength,
      sha256: digest(claude),
      identifier: "com.anthropic.claude-code",
      teamIdentifier: "Q6L2SF6YDW"
    },
    proxy: changedProxy
      ? { version: "7.2.88", commit: TARGET_COMMIT }
      : { version: PROXY_RUNTIME.version, commit: PROXY_RUNTIME.commit },
    minimumBootstrapSchema: 1,
    minimumStateSchema: 1,
    revokedSequences: []
  };
  const canonicalRelease = canonicalizeReleaseRecord(record);
  const releaseJson = Buffer.from(canonicalRelease);
  const releaseSig = Buffer.from(
    sign(null, Buffer.from(canonicalRelease), privateKey).toString("base64")
  );
  const baseId = sequence * 10;
  const contents = new Map<string, Buffer>([
    [assetUrl(baseId + 1), releaseJson],
    [assetUrl(baseId + 2), releaseSig],
    [assetUrl(baseId + 3), claudex],
    [record.claude.url, claude]
  ]);
  const assets = [
    { name: "release.json", size: releaseJson.byteLength, url: assetUrl(baseId + 1) },
    { name: "release.sig", size: releaseSig.byteLength, url: assetUrl(baseId + 2) },
    { name: record.claudex.asset, size: claudex.byteLength, url: assetUrl(baseId + 3) }
  ];

  if (changedProxy) {
    const update: UpdateRecord = {
      schemaVersion: 1,
      repository: record.repository,
      tag: record.tag,
      sequence: record.sequence,
      channel: "stable",
      legacyReleaseSha256: digest(canonicalRelease),
      proxyArtifact: {
        platform: "darwin-arm64",
        version: "7.2.88",
        commit: TARGET_COMMIT,
        asset: "CLIProxyAPI_7.2.88_darwin_aarch64.tar.gz",
        size: proxyArchive.byteLength,
        sha256: digest(proxyArchive),
        binary: "cli-proxy-api",
        binarySha256: "d".repeat(64)
      }
    };
    const canonicalUpdate = canonicalizeUpdateRecord(update);
    const updateJson = Buffer.from(canonicalUpdate);
    const updateSig = Buffer.from(
      sign(null, Buffer.from(canonicalUpdate), privateKey).toString("base64")
    );
    contents.set(assetUrl(baseId + 4), updateJson);
    contents.set(assetUrl(baseId + 5), updateSig);
    contents.set(assetUrl(baseId + 6), proxyArchive);
    assets.push(
      { name: "update.json", size: updateJson.byteLength, url: assetUrl(baseId + 4) },
      { name: "update.sig", size: updateSig.byteLength, url: assetUrl(baseId + 5) },
      {
        name: update.proxyArtifact.asset,
        size: proxyArchive.byteLength,
        url: assetUrl(baseId + 6)
      }
    );
  }

  return {
    record,
    contents,
    descriptor: {
      repository: record.repository,
      tag: record.tag,
      draft: false,
      prerelease: false,
      assets
    }
  };
}

function sourceFor(
  bridge: FixtureRelease,
  target?: FixtureRelease
): ReleaseSource {
  const releases = target ? [bridge, target] : [bridge];
  const contents = new Map(releases.flatMap((release) => [...release.contents]));
  return {
    async latest() {
      return bridge.descriptor;
    },
    ...(target
      ? {
          async enumerate() {
            return [bridge.descriptor, target.descriptor];
          }
        }
      : {}),
    async download(url, destination) {
      const value = contents.get(url);
      if (!value) throw new Error(`Missing fixture artifact ${url}`);
      await writeFile(destination, value);
    }
  };
}

// Frozen v0.2.1 discovery contract: it calls only /releases/latest and accepts
// exactly the legacy three-asset shape before any managed target code can run.
async function frozenV021Latest(source: ReleaseSource): Promise<ReleaseDescriptor> {
  const descriptor = await source.latest();
  if (descriptor.assets.length !== 3) throw new Error("v0.2.1 requires three assets");
  return descriptor;
}

function dependencies(
  source: ReleaseSource,
  publicKeyPem: string,
  events: string[],
  overrides: Partial<UpdateDependencies> = {}
): Partial<UpdateDependencies> {
  return {
    releaseSource: source,
    publicKeyPem,
    platform: "darwin",
    arch: "arm64",
    env: {},
    activeSessionCount: async () => 0,
    hasCodexAuth: async () => true,
    extractClaudexArchive: async (_archive, destination) => {
      const version = destination.endsWith("claudex") ? "0.0.0" : "0.0.0";
      await mkdir(join(destination, "dist"), { recursive: true });
      await mkdir(join(destination, "bin"), { recursive: true });
      // The validator reads the expected version from the staged archive's release record,
      // so tests replace this placeholder in verifyCandidate-independent fixtures below.
      await writeFile(join(destination, "package.json"), JSON.stringify({ name: "claudex", version }));
      await writeFile(join(destination, "dist", "cli.js"), "// bridge candidate");
      await writeFile(join(destination, "bin", "claudex"), "#!/bin/sh\n");
    },
    verifyClaudeBinary: async () => [],
    prepareProxyRuntime: async (_paths, runtime, archivePath) => {
      events.push(`stage:${runtime.version}`);
      if (archivePath) events.push(`archive:${archivePath.split("/").at(-1)}`);
    },
    verifyProxyRuntime: async () => true,
    prepareProxy: async (_paths, runtime, recordPriorState) => {
      events.push(`start:${runtime.version}`);
      await recordPriorState(false);
      return false;
    },
    restoreProxy: async (_paths, _wasRunning, runtime) => {
      events.push(`restore:${runtime.version}`);
    },
    verifyCandidate: async () => undefined,
    verifyActivated: async () => undefined,
    ...overrides
  };
}

async function applyFixture(
  home: string,
  fixture: FixtureRelease,
  source: ReleaseSource,
  publicKeyPem: string,
  events: string[],
  overrides: Partial<UpdateDependencies> = {}
) {
  const deps = dependencies(source, publicKeyPem, events, overrides);
  deps.extractClaudexArchive = async (_archive, destination) => {
    await mkdir(join(destination, "dist"), { recursive: true });
    await mkdir(join(destination, "bin"), { recursive: true });
    await writeFile(
      join(destination, "package.json"),
      JSON.stringify({ name: "claudex", version: fixture.record.claudex.version })
    );
    await writeFile(join(destination, "dist", "cli.js"), "// bridge candidate");
    await writeFile(join(destination, "bin", "claudex"), "#!/bin/sh\n");
  };
  return manageUpdate("apply", resolveUpdatePaths(home), deps);
}

describe("same-proxy bridge transition", () => {
  it("keeps /latest on sequence 3 while enumeration moves 3 -> 4 -> 3 -> 4", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-bridge-transition-"));
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const bridge = releaseFixture(3, keys.privateKey);
    const target = releaseFixture(4, keys.privateKey);
    const events: string[] = [];

    await applyFixture(home, bridge, sourceFor(bridge), publicKey, events);
    expect(await readlink(resolveUpdatePaths(home).currentLink)).toBe("3");

    const enumerating = sourceFor(bridge, target);
    expect(await frozenV021Latest(enumerating)).toEqual(bridge.descriptor);
    await applyFixture(home, target, enumerating, publicKey, events);
    expect(await readlink(resolveUpdatePaths(home).currentLink)).toBe("4");
    expect(await readFile(join(resolveUpdatePaths(home).releasesRoot, "4", "update.json"), "utf8"))
      .toBe(`${canonicalizeUpdateRecord(JSON.parse(await readFile(join(resolveUpdatePaths(home).releasesRoot, "4", "update.json"), "utf8")) as UpdateRecord)}\n`);

    const rolledBack = await manageUpdate(
      "rollback",
      resolveUpdatePaths(home),
      dependencies(sourceFor(bridge), publicKey, events)
    );
    expect(rolledBack.code).toBe("ROLLED_BACK");
    expect(await readlink(resolveUpdatePaths(home).currentLink)).toBe("3");

    await applyFixture(home, target, enumerating, publicKey, events);
    expect(await readlink(resolveUpdatePaths(home).currentLink)).toBe("4");
    expect(events).toContain(`stage:${PROXY_RUNTIME.version}`);
    expect(events).toContain("stage:7.2.88");
    expect(events).toContain("archive:CLIProxyAPI_7.2.88_darwin_aarch64.tar.gz");
    expect(events).toContain(`start:${PROXY_RUNTIME.version}`);
    expect(events).toContain("start:7.2.88");
  });

  it("selects the permanent bridge before a newer detached release", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-bridge-required-"));
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const bridge = releaseFixture(3, keys.privateKey);
    const target = releaseFixture(4, keys.privateKey);

    const result = await applyFixture(home, bridge, sourceFor(bridge, target), publicKey, []);
    expect(result.target?.sequence).toBe(3);
    expect(await readlink(resolveUpdatePaths(home).currentLink)).toBe("3");
  });

  it("recovers an interrupted target activation back to the bridge", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-bridge-recovery-"));
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const bridge = releaseFixture(3, keys.privateKey);
    const target = releaseFixture(4, keys.privateKey);
    const events: string[] = [];
    await applyFixture(home, bridge, sourceFor(bridge), publicKey, events);

    await expect(
      applyFixture(home, target, sourceFor(bridge, target), publicKey, events, {
        onPhase: async (action, phase) => {
          if (action === "apply" && phase === "activating") throw new UpdateInterruption();
        }
      })
    ).rejects.toBeInstanceOf(UpdateInterruption);

    await recoverInterruptedUpdate(
      resolveUpdatePaths(home),
      dependencies(sourceFor(bridge), publicKey, events)
    );
    expect(await readlink(resolveUpdatePaths(home).currentLink)).toBe("3");
    expect((await inspectManagedUpdateState(resolveUpdatePaths(home))).incompleteTransaction).toBe(false);
  });

  it("recovers an interrupted post-bridge update with the authenticated prior proxy", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-target-recovery-"));
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const bridge = releaseFixture(3, keys.privateKey);
    const target = releaseFixture(4, keys.privateKey);
    const newer = releaseFixture(5, keys.privateKey);
    const events: string[] = [];

    await applyFixture(home, bridge, sourceFor(bridge), publicKey, events);
    await applyFixture(home, target, sourceFor(bridge, target), publicKey, events);
    events.length = 0;
    await expect(
      applyFixture(home, newer, sourceFor(target, newer), publicKey, events, {
        prepareProxy: async (_paths, _runtime, recordPriorState) => {
          await recordPriorState(true);
          return true;
        },
        onPhase: async (action, phase) => {
          if (action === "apply" && phase === "activating") throw new UpdateInterruption();
        }
      })
    ).rejects.toBeInstanceOf(UpdateInterruption);

    await recoverInterruptedUpdate(
      resolveUpdatePaths(home),
      dependencies(sourceFor(target), publicKey, events)
    );
    expect(await readlink(resolveUpdatePaths(home).currentLink)).toBe("4");
    expect(events.filter((event) => event.startsWith("restore:"))).toEqual([
      "restore:7.2.88",
      "restore:7.2.88"
    ]);
  });
});
