import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBootstrapExec,
  ownsUpdateVerificationLock,
  recoverForBootstrap,
  selectBootstrapRuntime,
  shouldRecoverBeforeDelegation
} from "../src/bootstrap.js";
import { resolveUpdatePaths } from "../src/update.js";

async function installPair(home: string, sequence: number, claudexVersion: string, claudeVersion: string): Promise<void> {
  const releaseDir = join(home, "releases", String(sequence));
  const runtime = join(home, "runtime", "claudex", claudexVersion);
  const app = join(runtime, "dist");
  const bin = join(runtime, "bin");
  const claudeDir = join(home, "runtime", "claude", claudeVersion);
  const claudeBinary = join(claudeDir, "claude");
  await mkdir(releaseDir, { recursive: true, mode: 0o700 });
  await mkdir(app, { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(claudeDir, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "claudex", version: claudexVersion }), {
    mode: 0o600
  });
  await writeFile(join(app, "cli.js"), "// verified managed claudex", { mode: 0o600 });
  await writeFile(join(bin, "claudex"), "#!/bin/sh\n", { mode: 0o700 });
  await chmod(runtime, 0o700);
  await chmod(app, 0o700);
  await chmod(bin, 0o700);
  await chmod(join(runtime, "package.json"), 0o600);
  await chmod(join(app, "cli.js"), 0o600);
  await chmod(join(bin, "claudex"), 0o700);

  const treeHash = createHash("sha256");
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === ".artifact.json") continue;
      const path = join(directory, entry.name);
      const details = await lstat(path);
      const mode = (details.mode & 0o777).toString(8);
      if (entry.isDirectory()) {
        treeHash.update(`directory\0${relative}\0${mode}\0`);
        await walk(path, relative);
      } else {
        treeHash.update(`file\0${relative}\0${mode}\0${details.size}\0`);
        treeHash.update(await readFile(path));
        treeHash.update("\0");
      }
    }
  };
  await walk(runtime, "");
  await writeFile(
    join(runtime, ".artifact.json"),
    JSON.stringify({ size: 1, sha256: "1".repeat(64), treeSha256: treeHash.digest("hex") }),
    { mode: 0o600 }
  );

  await writeFile(claudeBinary, "#!/bin/sh\necho verified claude\n", { mode: 0o700 });
  await chmod(claudeBinary, 0o700);
  const claudeContents = await readFile(claudeBinary);
  await writeFile(
    join(releaseDir, "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      sequence,
      repository: "cobibean/claudex",
      tag: `v${claudexVersion}`,
      platform: "darwin-arm64",
      claudex: {
        version: claudexVersion,
        asset: `claudex-${claudexVersion}.tgz`,
        size: 1,
        sha256: "1".repeat(64)
      },
      claude: {
        version: claudeVersion,
        url: `https://downloads.claude.ai/claude-code-releases/${claudeVersion}/darwin-arm64/claude`,
        size: claudeContents.byteLength,
        sha256: createHash("sha256").update(claudeContents).digest("hex"),
        identifier: "com.anthropic.claude-code",
        teamIdentifier: "Q6L2SF6YDW"
      },
      proxy: { version: "7.2.80", commit: "09da52ad" },
      minimumBootstrapSchema: 1,
      minimumStateSchema: 1,
      revokedSequences: []
    }),
    { mode: 0o600 }
  );
}

async function installPackagedFallback(home: string, claudexVersion: string, claudeVersion: string): Promise<string> {
  const binary = join(home, "runtime", "claude", claudeVersion, "claude");
  const contents = await readFile(binary);
  await writeFile(
    join(home, "releases", "packaged-fallback.json"),
    JSON.stringify({
      schemaVersion: 1,
      claudexVersion,
      claudeVersion,
      claude: {
        size: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex")
      },
      createdAt: "2026-07-16T00:00:00.000Z"
    }),
    { mode: 0o600 }
  );
  return binary;
}

describe("Claudex bootstrap", () => {
  it("leaves update recovery to the updater so JSON failures keep their contract", () => {
    expect(shouldRecoverBeforeDelegation(["update", "--check", "--json"])).toBe(false);
    expect(shouldRecoverBeforeDelegation(["update"])).toBe(false);
    expect(shouldRecoverBeforeDelegation(["update", "--rollback", "--json"])).toBe(false);
    expect(shouldRecoverBeforeDelegation(["doctor", "--json"])).toBe(true);
  });

  it("keeps a malformed recovery journal from bricking known-good fallback launch", async () => {
    await expect(
      recoverForBootstrap(resolveUpdatePaths("/unused"), async () => {
        throw new Error("malformed journal");
      })
    ).resolves.toBe("unsafe");
  });

  it("bypasses bootstrap recovery only for the updater PID that owns the live lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-bootstrap-owner-"));
    const paths = resolveUpdatePaths(home);
    await mkdir(paths.runDir, { recursive: true });
    await writeFile(paths.lockFile, JSON.stringify({ pid: 4242 }));

    await expect(
      ownsUpdateVerificationLock(paths, {
        CLAUDEX_UPDATE_VERIFICATION: "1",
        CLAUDEX_UPDATE_OWNER_PID: "4242"
      })
    ).resolves.toBe(true);
    await expect(
      ownsUpdateVerificationLock(paths, {
        CLAUDEX_UPDATE_VERIFICATION: "1",
        CLAUDEX_UPDATE_OWNER_PID: "4243"
      })
    ).resolves.toBe(false);
  });

  it("selects the current managed pair and derives both executable paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-bootstrap-current-"));
    await installPair(home, 2, "0.3.0", "2.1.212");
    await symlink("2", join(home, "releases", "current"));

    await expect(selectBootstrapRuntime(home, "/packaged/cli.js")).resolves.toEqual({
      source: "current",
      sequence: 2,
      entrypoint: join(home, "runtime", "claudex", "0.3.0", "dist", "cli.js"),
      claudeBinary: join(home, "runtime", "claude", "2.1.212", "claude")
    });
  });

  it("falls back through previous and then the packaged recovery runtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-bootstrap-fallback-"));
    await mkdir(join(home, "releases"), { recursive: true });
    await symlink("99", join(home, "releases", "current"));
    await installPair(home, 1, "0.2.0", "2.1.211");
    await symlink("1", join(home, "releases", "previous"));

    expect(await selectBootstrapRuntime(home, "/packaged/cli.js")).toMatchObject({ source: "previous", sequence: 1 });
    await chmod(join(home, "runtime", "claude", "2.1.211", "claude"), 0o600);
    await expect(selectBootstrapRuntime(home, "/packaged/cli.js")).resolves.toEqual({
      source: "packaged",
      sequence: null,
      entrypoint: "/packaged/cli.js",
      claudeBinary: null
    });
  });

  it("never executes a tampered current runtime and falls through to a verified previous pair", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-bootstrap-tamper-"));
    await installPair(home, 2, "0.3.0", "2.1.212");
    await installPair(home, 1, "0.2.0", "2.1.211");
    await symlink("2", join(home, "releases", "current"));
    await symlink("1", join(home, "releases", "previous"));
    await writeFile(join(home, "runtime", "claudex", "0.3.0", "dist", "cli.js"), "// tampered");

    await expect(selectBootstrapRuntime(home, "/packaged/cli.js")).resolves.toMatchObject({
      source: "previous",
      sequence: 1
    });
  });

  it("rejects corrupt release identity before managed code can run", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-bootstrap-record-"));
    await installPair(home, 1, "0.2.0", "2.1.211");
    await symlink("1", join(home, "releases", "current"));
    await writeFile(join(home, "releases", "1", "release.json"), "{}", { mode: 0o600 });

    await expect(selectBootstrapRuntime(home, "/packaged/cli.js")).resolves.toMatchObject({
      source: "packaged",
      sequence: null
    });
  });

  it("uses only a hash-verified private Claude binary with the packaged rollback fallback", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-bootstrap-packaged-"));
    await installPair(home, 1, "0.2.0", "2.1.211");
    const binary = await installPackagedFallback(home, "0.2.0", "2.1.211");

    await expect(selectBootstrapRuntime(home, "/packaged/cli.js")).resolves.toEqual({
      source: "packaged",
      sequence: null,
      entrypoint: "/packaged/cli.js",
      claudeBinary: binary
    });
    await writeFile(binary, "tampered", { mode: 0o700 });
    await expect(selectBootstrapRuntime(home, "/packaged/cli.js")).resolves.toMatchObject({
      source: "packaged",
      claudeBinary: null
    });
  });

  it("delegates with the managed Claude path and disables upstream updates", () => {
    const spec = buildBootstrapExec(
      { source: "current", sequence: 1, entrypoint: "/managed/cli.js", claudeBinary: "/managed/claude" },
      ["doctor", "--json"],
      { PATH: "/bin" },
      "/node",
      "/packaged/bootstrap.js",
      "/packaged/cli.js"
    );

    expect(spec).toEqual({
      file: "/node",
      args: ["/node", "/managed/cli.js", "doctor", "--json"],
      env: {
        PATH: "/bin",
        CLAUDEX_BOOTSTRAP_VERSION: "0.2.0",
        CLAUDEX_BOOTSTRAPPED: "1",
        CLAUDEX_ACTIVE_PAIR_SOURCE: "current",
        CLAUDEX_ACTIVE_PAIR_SEQUENCE: "1",
        CLAUDEX_BOOTSTRAP_ENTRYPOINT: "/packaged/bootstrap.js",
        CLAUDEX_PACKAGED_ENTRYPOINT: "/packaged/cli.js",
        CLAUDEX_MANAGED_CLAUDE_BIN: "/managed/claude",
        DISABLE_UPDATES: "1",
        DISABLE_AUTOUPDATER: "1",
        NODE_NO_WARNINGS: "1"
      }
    });
  });
});
