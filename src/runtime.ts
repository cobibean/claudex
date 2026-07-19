import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join, posix } from "node:path";
import type { ManagedPaths } from "./state.js";

const execFile = promisify(execFileCallback);

export interface ProxyRuntimeIdentity {
  version: string;
  commit: string;
  tagCommit: string;
  asset: string;
  url: string;
  size: number;
  sha256: string;
  binarySha256: string;
}

export const PROXY_RUNTIME: ProxyRuntimeIdentity = {
  version: "7.2.80",
  commit: "09da52ad",
  tagCommit: "09da52ad509e2c18e7b9540db3b98c2214c280aa",
  asset: "CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
  url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
  size: 14_101_646,
  sha256: "7b13a17670a7d24318e3d6a3f24ff38696cf23ab44894fc93fbd53fbb68dfda6",
  binarySha256: "53afff247f28bee8a5a51bb376f8e03092e1eb7b15a2663ce6cbe92618afec3a"
};

// Preserve prior certified identities here when changing PROXY_RUNTIME so a newer
// runtime can verify and roll back to a schema-v1 bridge release.
export const KNOWN_PROXY_RUNTIMES: readonly ProxyRuntimeIdentity[] = [PROXY_RUNTIME];

interface RuntimeMetadata {
  version: string;
  commit: string;
  tagCommit: string;
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

export function inspectRuntimeVersionOutput(output: string, runtime: ProxyRuntimeIdentity): void {
  if (!output.includes(`Version: ${runtime.version}`) || !output.includes(`Commit: ${runtime.commit}`)) {
    throw new Error(`CLIProxyAPI runtime identity did not match ${runtime.version}/${runtime.commit}.`);
  }
}

async function inspectRuntimeVersion(
  binary: string,
  runtime: ProxyRuntimeIdentity = PROXY_RUNTIME
): Promise<void> {
  let output = "";
  try {
    const result = await execFile(binary, ["--version"], { timeout: 5_000 });
    output = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    output = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
  }
  inspectRuntimeVersionOutput(output, runtime);
}

export async function verifyInstalledRuntime(
  paths: ManagedPaths,
  runtime: ProxyRuntimeIdentity = PROXY_RUNTIME
): Promise<boolean> {
  const metadataPath = join(paths.runtimeDir, "installed.json");
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as RuntimeMetadata;
    await access(paths.runtimeBinary);
    if (
      metadata.version !== runtime.version ||
      metadata.commit !== runtime.commit ||
      metadata.tagCommit !== runtime.tagCommit ||
      metadata.asset !== runtime.asset ||
      metadata.archiveSha256 !== runtime.sha256
    ) {
      return false;
    }
    return (
      metadata.binarySha256 === runtime.binarySha256 &&
      (await sha256File(paths.runtimeBinary)) === runtime.binarySha256
    );
  } catch {
    return false;
  }
}

export interface InstallRuntimeOptions {
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  runtime?: ProxyRuntimeIdentity;
  archivePath?: string;
}

function safeArchiveEntry(entry: string): string | null {
  const normalizedInput = entry.replace(/^\.\//, "");
  if (
    !normalizedInput ||
    normalizedInput.includes("\\") ||
    normalizedInput.includes("\0") ||
    normalizedInput.startsWith("/") ||
    normalizedInput.split("/").some((part) => part === "..")
  ) {
    return null;
  }
  const normalized = posix.normalize(normalizedInput);
  return normalized === "." || normalized.startsWith("../") ? null : normalized;
}

export async function inspectProxyArchive(archive: string): Promise<string> {
  const listed = await execFile("/usr/bin/tar", ["-tzf", archive], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  const entries = listed.stdout.split("\n").filter(Boolean);
  const normalized = entries.map(safeArchiveEntry);
  if (
    entries.length === 0 ||
    normalized.some((entry) => entry === null) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error("CLIProxyAPI archive contains unsafe or duplicate members.");
  }
  const binaryEntries = entries.filter(
    (_entry, index) => normalized[index] === "cli-proxy-api"
  );
  if (binaryEntries.length !== 1) {
    throw new Error("CLIProxyAPI archive must contain exactly one root cli-proxy-api executable.");
  }
  const verbose = await execFile("/usr/bin/tar", ["-tvzf", archive], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (verbose.stdout.split("\n").filter(Boolean).some((line) => !/^[-d]/.test(line))) {
    throw new Error("CLIProxyAPI archive may contain only regular files and directories.");
  }
  return binaryEntries[0] as string;
}

function validateRuntimeRedirect(url: URL): void {
  if (
    url.protocol !== "https:" ||
    !new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]).has(
      url.hostname
    ) ||
    Boolean(url.username) ||
    Boolean(url.password) ||
    Boolean(url.port) ||
    Boolean(url.hash)
  ) {
    throw new Error("CLIProxyAPI download redirected to an untrusted host.");
  }
}

async function downloadRuntimeArchive(
  runtime: ProxyRuntimeIdentity,
  fetchImpl: typeof fetch,
  destination: string
): Promise<void> {
  let next = new URL(runtime.url);
  if (
    next.protocol !== "https:" ||
    next.hostname !== "github.com" ||
    Boolean(next.username) ||
    Boolean(next.password) ||
    Boolean(next.port) ||
    Boolean(next.search) ||
    Boolean(next.hash)
  ) {
    throw new Error("CLIProxyAPI download URL is not an allowlisted GitHub release URL.");
  }
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchImpl(next, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("CLIProxyAPI redirect had no destination.");
      next = new URL(location, next);
      validateRuntimeRedirect(next);
      continue;
    }
    if (!response.ok) throw new Error(`Unable to download CLIProxyAPI: HTTP ${response.status}.`);
    if (!response.body) throw new Error("CLIProxyAPI download response had no body.");
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > runtime.size) {
      throw new Error("CLIProxyAPI download exceeds its signed size.");
    }
    const handle = await open(destination, "wx", 0o600);
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > runtime.size) {
          await reader.cancel();
          throw new Error("CLIProxyAPI download exceeds its signed size.");
        }
        await handle.write(Buffer.from(chunk.value));
      }
      await handle.sync();
      return;
    } finally {
      await handle.close();
    }
  }
  throw new Error("CLIProxyAPI download exceeded the redirect limit.");
}

export async function installProxyRuntime(
  paths: ManagedPaths,
  options: InstallRuntimeOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runtime = options.runtime ?? PROXY_RUNTIME;
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(`Claudex v1 supports macOS ARM64 only; detected ${platform}/${arch}.`);
  }
  if (await verifyInstalledRuntime(paths, runtime)) return paths.runtimeBinary;

  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
  const nonce = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const archive = join(paths.runtimeRoot, `.download-${nonce}.tar.gz`);
  const staging = join(paths.runtimeRoot, `.staging-${nonce}`);
  try {
    if (options.archivePath) {
      await copyFile(options.archivePath, archive);
      await chmod(archive, 0o600);
    } else {
      await downloadRuntimeArchive(runtime, fetchImpl, archive);
    }
    const archiveDetails = await stat(archive);
    if (archiveDetails.size !== runtime.size) {
      throw new Error(`CLIProxyAPI archive size mismatch: expected ${runtime.size}, got ${archiveDetails.size}.`);
    }
    await verifyArchiveChecksum(archive, runtime.sha256);

    const binaryEntry = await inspectProxyArchive(archive);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await execFile("/usr/bin/tar", ["-xzf", archive, "-C", staging, "--", binaryEntry], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024
    });
    const extracted = await findRuntimeBinary(staging);
    if (!(await lstat(extracted)).isFile()) {
      throw new Error("CLIProxyAPI extracted executable is not a regular file.");
    }
    const destination = join(staging, "cli-proxy-api");
    if (extracted !== destination) await rename(extracted, destination);
    await chmod(destination, 0o700);
    await inspectRuntimeVersion(destination, runtime);
    const binarySha256 = await sha256File(destination);
    if (binarySha256 !== runtime.binarySha256) {
      throw new Error("CLIProxyAPI executable checksum did not match the signed runtime identity.");
    }

    const metadata: RuntimeMetadata = {
      version: runtime.version,
      commit: runtime.commit,
      tagCommit: runtime.tagCommit,
      asset: runtime.asset,
      archiveSha256: runtime.sha256,
      binarySha256
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
