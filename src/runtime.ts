import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import type { ManagedPaths } from "./state.js";

const execFile = promisify(execFileCallback);

export const PROXY_RUNTIME = {
  version: "7.2.80",
  commit: "09da52ad",
  asset: "CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
  url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
  sha256: "7b13a17670a7d24318e3d6a3f24ff38696cf23ab44894fc93fbd53fbb68dfda6"
} as const;

interface RuntimeMetadata {
  version: string;
  commit: string;
  asset: string;
  archiveSha256: string;
  binarySha256: string;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function verifyArchiveChecksum(path: string, expected: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(`CLIProxyAPI archive checksum mismatch: expected ${expected}, got ${actual}.`);
  }
}

async function findRuntimeBinary(directory: string): Promise<string> {
  const candidates = new Set(["cli-proxy-api", "cliproxyapi", "CLIProxyAPI"]);
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && candidates.has(basename(path))) return path;
    }
  }
  throw new Error("The reviewed CLIProxyAPI archive did not contain an expected executable.");
}

async function inspectRuntimeVersion(binary: string): Promise<void> {
  let output = "";
  try {
    const result = await execFile(binary, ["--version"], { timeout: 5_000 });
    output = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    output = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
  }
  if (!output.includes(`Version: ${PROXY_RUNTIME.version}`) || !output.includes(`Commit: ${PROXY_RUNTIME.commit}`)) {
    throw new Error(`CLIProxyAPI runtime identity did not match ${PROXY_RUNTIME.version}/${PROXY_RUNTIME.commit}.`);
  }
}

export async function verifyInstalledRuntime(paths: ManagedPaths): Promise<boolean> {
  const metadataPath = join(paths.runtimeDir, "installed.json");
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as RuntimeMetadata;
    await access(paths.runtimeBinary);
    if (
      metadata.version !== PROXY_RUNTIME.version ||
      metadata.commit !== PROXY_RUNTIME.commit ||
      metadata.asset !== PROXY_RUNTIME.asset ||
      metadata.archiveSha256 !== PROXY_RUNTIME.sha256
    ) {
      return false;
    }
    return (await sha256File(paths.runtimeBinary)) === metadata.binarySha256;
  } catch {
    return false;
  }
}

export interface InstallRuntimeOptions {
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
}

export async function installProxyRuntime(
  paths: ManagedPaths,
  options: InstallRuntimeOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(`Claudex v1 supports macOS ARM64 only; detected ${platform}/${arch}.`);
  }
  if (await verifyInstalledRuntime(paths)) return paths.runtimeBinary;

  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
  const nonce = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const archive = join(paths.runtimeRoot, `.download-${nonce}.tar.gz`);
  const staging = join(paths.runtimeRoot, `.staging-${nonce}`);
  try {
    const response = await fetchImpl(PROXY_RUNTIME.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Unable to download CLIProxyAPI: HTTP ${response.status}.`);
    }
    await writeFile(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600, flag: "wx" });
    await verifyArchiveChecksum(archive, PROXY_RUNTIME.sha256);

    await mkdir(staging, { recursive: true, mode: 0o700 });
    await execFile("/usr/bin/tar", ["-xzf", archive, "-C", staging], { timeout: 30_000 });
    const extracted = await findRuntimeBinary(staging);
    const destination = join(staging, "cli-proxy-api");
    if (extracted !== destination) await rename(extracted, destination);
    await chmod(destination, 0o700);
    await inspectRuntimeVersion(destination);

    const metadata: RuntimeMetadata = {
      version: PROXY_RUNTIME.version,
      commit: PROXY_RUNTIME.commit,
      asset: PROXY_RUNTIME.asset,
      archiveSha256: PROXY_RUNTIME.sha256,
      binarySha256: await sha256File(destination)
    };
    await writeFile(join(staging, "installed.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600
    });
    await rm(paths.runtimeDir, { recursive: true, force: true });
    await rename(staging, paths.runtimeDir);
    await chmod(paths.runtimeDir, 0o700);
    return paths.runtimeBinary;
  } finally {
    await rm(archive, { force: true });
    try {
      if ((await stat(staging)).isDirectory()) await rm(staging, { recursive: true, force: true });
    } catch {
      // Staging was atomically promoted or never created.
    }
  }
}
