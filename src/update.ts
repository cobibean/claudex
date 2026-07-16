import { execFile as execFileCallback } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import {
  BOOTSTRAP_SCHEMA_VERSION,
  CERTIFIED_CLAUDE,
  CLAUDEX_VERSION,
  RELEASE_PUBLIC_KEY_PEM,
  RELEASE_REPOSITORY,
  RELEASE_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION
} from "./compatibility.js";
import {
  CONFLICTING_ENV_KEYS,
  hasCodexAuth as inspectCodexAuth
} from "./claude.js";
import { buildClaudeSettings } from "./claude-settings.js";
import {
  activeSessions,
  proxyStatus,
  startManagedProxy,
  stopManagedProxy,
  withSessionStartLock
} from "./proxy.js";
import { PROXY_RUNTIME } from "./runtime.js";
import { resolvePaths, type ManagedState } from "./state.js";

const execFile = promisify(execFileCallback);

export type UpdateAction = "check" | "apply" | "rollback";
export type UpdateJournalPhase = "prepared" | "activating" | "activated";

/** Test/fault-injection seam that models termination without running rollback cleanup. */
export class UpdateInterruption extends Error {
  constructor(message = "Claudex update interrupted.") {
    super(message);
    this.name = "UpdateInterruption";
  }
}

class UpdateLockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateLockBusyError";
  }
}

export interface ReleaseRecord {
  schemaVersion: number;
  sequence: number;
  repository: string;
  tag: string;
  platform: "darwin-arm64";
  claudex: {
    version: string;
    asset: string;
    size: number;
    sha256: string;
  };
  claude: {
    version: string;
    url: string;
    size: number;
    sha256: string;
    identifier: string;
    teamIdentifier: string;
  };
  proxy: {
    version: string;
    commit: string;
  };
  minimumBootstrapSchema: number;
  minimumStateSchema: number;
  revokedSequences: number[];
}

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
}

export interface ReleaseDescriptor {
  repository: string;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface ReleaseSource {
  latest(): Promise<ReleaseDescriptor>;
  download(url: string, destination: string): Promise<void>;
}

export interface GitHubReleaseAdapterOptions {
  fetchImpl?: typeof fetch;
  tokenProvider?: () => Promise<string>;
  latestTimeoutMs?: number;
  artifactTimeoutMs?: number;
}

async function withAbortTimeout<T>(
  timeoutMs: number,
  label: string,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultGitHubTokenProvider(): Promise<string> {
  const result = await execFile("gh", ["auth", "token"], {
    timeout: 10_000,
    maxBuffer: 64 * 1024
  });
  const token = result.stdout.trim();
  if (!token) throw new Error("GitHub CLI did not return an authentication token.");
  return token;
}

function githubHeaders(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "claudex-updater"
  };
}

function validateGitHubDownloadRedirect(url: URL): void {
  const allowed = new Set([
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com"
  ]);
  if (
    url.protocol !== "https:" ||
    !allowed.has(url.hostname) ||
    Boolean(url.username) ||
    Boolean(url.password) ||
    Boolean(url.port) ||
    Boolean(url.hash)
  ) {
    throw new Error("GitHub release download redirected to an untrusted host.");
  }
}

async function streamResponseToFile(response: Response, destination: string): Promise<void> {
  if (!response.body) throw new Error("Artifact response had no body.");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(destination, "wx", 0o600);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      await handle.write(Buffer.from(chunk.value));
    }
    await handle.sync();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

export function createGitHubReleaseAdapter(
  options: GitHubReleaseAdapterOptions = {}
): ReleaseSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenProvider = options.tokenProvider ?? defaultGitHubTokenProvider;
  const latestTimeoutMs = options.latestTimeoutMs ?? 30_000;
  const artifactTimeoutMs = options.artifactTimeoutMs ?? 10 * 60_000;
  const latestUrl = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
  return {
    async latest(): Promise<ReleaseDescriptor> {
      const token = await tokenProvider();
      const response = await withAbortTimeout(latestTimeoutMs, "Claudex release lookup", (signal) =>
        fetchImpl(latestUrl, {
          headers: githubHeaders(token, "application/vnd.github+json"),
          redirect: "error",
          signal
        })
      );
      if (!response.ok) throw new Error(`Unable to read the private Claudex release: HTTP ${response.status}.`);
      const value: unknown = await response.json();
      if (!isObject(value) || !Array.isArray(value.assets)) {
        throw new Error("GitHub returned a malformed Claudex release.");
      }
      const assets = value.assets.map((asset): ReleaseAsset => {
        if (
          !isObject(asset) ||
          typeof asset.name !== "string" ||
          typeof asset.size !== "number" ||
          !Number.isSafeInteger(asset.size) ||
          asset.size < 0 ||
          typeof asset.url !== "string"
        ) {
          throw new Error("GitHub returned malformed Claudex release assets.");
        }
        validateReleaseAssetUrl(asset.url);
        return { name: asset.name, size: asset.size, url: asset.url };
      });
      if (
        typeof value.tag_name !== "string" ||
        typeof value.draft !== "boolean" ||
        typeof value.prerelease !== "boolean"
      ) {
        throw new Error("GitHub returned malformed Claudex release metadata.");
      }
      return {
        repository: RELEASE_REPOSITORY,
        tag: value.tag_name,
        draft: value.draft,
        prerelease: value.prerelease,
        assets
      };
    },

    async download(url: string, destination: string): Promise<void> {
      const initial = new URL(url);
      const isGitHub = initial.hostname === "api.github.com";
      if (isGitHub) validateReleaseAssetUrl(url);
      else {
        if (
          initial.protocol !== "https:" ||
          initial.hostname !== "downloads.claude.ai" ||
          Boolean(initial.username) ||
          Boolean(initial.password) ||
          Boolean(initial.port) ||
          Boolean(initial.search) ||
          Boolean(initial.hash) ||
          !/^\/claude-code-releases\/\d+\.\d+\.\d+\/darwin-arm64\/claude$/.test(initial.pathname)
        ) {
          throw new Error("Refusing to download an artifact from an untrusted host.");
        }
      }

      const token = isGitHub ? await tokenProvider() : "";
      await withAbortTimeout(artifactTimeoutMs, "Certified artifact download", async (signal) => {
        let next = initial;
        for (let redirects = 0; redirects <= 3; redirects += 1) {
          const useGitHubAuth = next.hostname === "api.github.com";
          const response = await fetchImpl(next, {
            headers: useGitHubAuth
              ? githubHeaders(token, "application/octet-stream")
              : { Accept: "application/octet-stream", "User-Agent": "claudex-updater" },
            redirect: "manual",
            signal
          });
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) throw new Error("Artifact download redirect had no destination.");
            const redirected = new URL(location, next);
            if (isGitHub) validateGitHubDownloadRedirect(redirected);
            else if (
              redirected.hostname !== "downloads.claude.ai" ||
              redirected.protocol !== "https:" ||
              Boolean(redirected.username) ||
              Boolean(redirected.password) ||
              Boolean(redirected.port) ||
              Boolean(redirected.search) ||
              Boolean(redirected.hash)
            ) {
              throw new Error("Official Claude download redirected to an untrusted host.");
            }
            next = redirected;
            continue;
          }
          if (!response.ok) throw new Error(`Unable to download certified artifact: HTTP ${response.status}.`);
          await streamResponseToFile(response, destination);
          return;
        }
        throw new Error("Artifact download exceeded the redirect limit.");
      }).catch(async (error) => {
        await rm(destination, { force: true });
        throw error;
      });
    }
  };
}

export interface UpdatePaths {
  home: string;
  claudexRuntimeRoot: string;
  claudeRuntimeRoot: string;
  releasesRoot: string;
  packagedFallbackFile: string;
  currentLink: string;
  previousLink: string;
  runDir: string;
  lockFile: string;
  journalFile: string;
  snapshotFile: string;
  failureFile: string;
}

export interface PairSummary {
  sequence: number;
  claudexVersion: string;
  claudeVersion: string;
}

export interface UpdateResult {
  ok: boolean;
  action: UpdateAction;
  status: string;
  current: PairSummary | null;
  target: PairSummary | null;
  previous: PairSummary | null;
  code: string;
  message: string;
}

export interface UpdateDependencies {
  releaseSource: ReleaseSource;
  publicKeyPem: string;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  pid: number;
  isProcessAlive(pid: number): boolean;
  activeSessionCount(paths: UpdatePaths): Promise<number>;
  sessionStartBarrier(paths: UpdatePaths, operation: () => Promise<number>): Promise<number>;
  hasCodexAuth(paths: UpdatePaths): Promise<boolean>;
  availableBytes(paths: UpdatePaths): Promise<number>;
  prepareProxy(
    paths: UpdatePaths,
    recordPriorState: (wasRunning: boolean) => Promise<void>
  ): Promise<boolean>;
  restoreProxy(paths: UpdatePaths, wasRunning: boolean): Promise<void>;
  extractClaudexArchive(archive: string, destination: string): Promise<void>;
  verifyClaudeBinary(binary: string, expected: ReleaseRecord["claude"]): Promise<string[]>;
  verifyCandidate(candidate: CandidateContext): Promise<void>;
  verifyActivated(candidate: CandidateContext): Promise<void>;
  onPhase(action: Exclude<UpdateAction, "check">, phase: UpdateJournalPhase): Promise<void>;
}

export interface CandidateContext {
  paths: UpdatePaths;
  record: ReleaseRecord;
  claudexRuntimeDir: string;
  claudexEntrypoint: string;
  claudeRuntimeDir: string;
  claudeBinary: string;
  expectedBootstrapSource: "current" | "packaged";
  expectedBootstrapSequence: number | null;
}

interface UpdateJournal {
  schemaVersion: 1;
  action: "apply" | "rollback";
  phase: UpdateJournalPhase;
  targetSequence: number;
  targetClaudexVersion: string;
  targetClaudeVersion: string;
  stagingName: string | null;
  oldCurrent: string | null;
  oldPrevious: string | null;
  proxyWasRunning: boolean | null;
}

export function resolveUpdatePaths(home: string): UpdatePaths {
  const absoluteHome = resolve(home);
  const releasesRoot = join(absoluteHome, "releases");
  const runDir = join(absoluteHome, "run");
  return {
    home: absoluteHome,
    claudexRuntimeRoot: join(absoluteHome, "runtime", "claudex"),
    claudeRuntimeRoot: join(absoluteHome, "runtime", "claude"),
    releasesRoot,
    packagedFallbackFile: join(releasesRoot, "packaged-fallback.json"),
    currentLink: join(releasesRoot, "current"),
    previousLink: join(releasesRoot, "previous"),
    runDir,
    lockFile: join(runDir, "update.lock"),
    journalFile: join(runDir, "update-journal.json"),
    snapshotFile: join(runDir, "update-snapshot.json"),
    failureFile: join(runDir, "update-failure.json")
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

export function canonicalizeReleaseRecord(record: ReleaseRecord): string {
  return canonicalize(record);
}

function pairSummary(record: ReleaseRecord): PairSummary {
  return {
    sequence: record.sequence,
    claudexVersion: record.claudex.version,
    claudeVersion: record.claude.version
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

interface PackagedFallbackRecord {
  schemaVersion: 1;
  claudexVersion: string;
  claudeVersion: string;
  claude: { size: number; sha256: string };
  createdAt: string;
}

function parsePackagedFallback(contents: string): PackagedFallbackRecord {
  const value: unknown = JSON.parse(contents);
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "claudexVersion",
      "claudeVersion",
      "claude",
      "createdAt"
    ]) ||
    value.schemaVersion !== 1 ||
    value.claudexVersion !== CLAUDEX_VERSION ||
    typeof value.claudeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.claudeVersion) ||
    !isObject(value.claude) ||
    !exactKeys(value.claude, ["size", "sha256"]) ||
    !positiveInteger(value.claude.size) ||
    typeof value.claude.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.claude.sha256) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("The packaged fallback record is malformed.");
  }
  return value as unknown as PackagedFallbackRecord;
}

function packagedFallbackSummary(record: PackagedFallbackRecord): PairSummary {
  return {
    sequence: 0,
    claudexVersion: record.claudexVersion,
    claudeVersion: record.claudeVersion
  };
}

async function readVerifiedPackagedFallback(
  paths: UpdatePaths
): Promise<PackagedFallbackRecord | null> {
  try {
    if (!(await lstat(paths.packagedFallbackFile)).isFile()) return null;
    const record = parsePackagedFallback(await readFile(paths.packagedFallbackFile, "utf8"));
    const binary = join(paths.claudeRuntimeRoot, record.claudeVersion, "claude");
    if (!(await lstat(binary)).isFile()) return null;
    await access(binary, constants.R_OK | constants.X_OK);
    await verifyArtifact(binary, record.claude.size, record.claude.sha256, "Packaged fallback Claude runtime");
    return record;
  } catch {
    return null;
  }
}

async function seedPackagedFallback(paths: UpdatePaths, record: ReleaseRecord): Promise<boolean> {
  if (record.claudex.version !== CLAUDEX_VERSION) return false;
  const fallback: PackagedFallbackRecord = {
    schemaVersion: 1,
    claudexVersion: CLAUDEX_VERSION,
    claudeVersion: record.claude.version,
    claude: { size: record.claude.size, sha256: record.claude.sha256 },
    createdAt: new Date().toISOString()
  };
  await writePrivateFile(paths.packagedFallbackFile, `${JSON.stringify(fallback)}\n`);
  return true;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseReleaseRecord(contents: string): ReleaseRecord {
  const value: unknown = JSON.parse(contents);
  const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
  const sha256 = /^[a-f0-9]{64}$/;
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "sequence",
      "repository",
      "tag",
      "platform",
      "claudex",
      "claude",
      "proxy",
      "minimumBootstrapSchema",
      "minimumStateSchema",
      "revokedSequences"
    ]) ||
    !isObject(value.claudex) ||
    !exactKeys(value.claudex, ["version", "asset", "size", "sha256"]) ||
    !isObject(value.claude) ||
    !exactKeys(value.claude, [
      "version",
      "url",
      "size",
      "sha256",
      "identifier",
      "teamIdentifier"
    ]) ||
    !isObject(value.proxy) ||
    !exactKeys(value.proxy, ["version", "commit"]) ||
    !positiveInteger(value.schemaVersion) ||
    !positiveInteger(value.sequence) ||
    typeof value.repository !== "string" ||
    typeof value.tag !== "string" ||
    value.platform !== "darwin-arm64" ||
    typeof value.claudex.version !== "string" ||
    !semver.test(value.claudex.version) ||
    typeof value.claudex.asset !== "string" ||
    value.claudex.asset !== basename(value.claudex.asset) ||
    !positiveInteger(value.claudex.size) ||
    typeof value.claudex.sha256 !== "string" ||
    !sha256.test(value.claudex.sha256) ||
    typeof value.claude.version !== "string" ||
    !semver.test(value.claude.version) ||
    typeof value.claude.url !== "string" ||
    !positiveInteger(value.claude.size) ||
    typeof value.claude.sha256 !== "string" ||
    !sha256.test(value.claude.sha256) ||
    typeof value.claude.identifier !== "string" ||
    !/^[A-Za-z0-9.-]+$/.test(value.claude.identifier) ||
    typeof value.claude.teamIdentifier !== "string" ||
    !/^[A-Z0-9]{10}$/.test(value.claude.teamIdentifier) ||
    typeof value.proxy.version !== "string" ||
    !semver.test(value.proxy.version) ||
    typeof value.proxy.commit !== "string" ||
    !/^[a-f0-9]{7,64}$/.test(value.proxy.commit) ||
    !positiveInteger(value.minimumBootstrapSchema) ||
    !positiveInteger(value.minimumStateSchema) ||
    !Array.isArray(value.revokedSequences) ||
    value.revokedSequences.some((sequence) => !positiveInteger(sequence)) ||
    new Set(value.revokedSequences).size !== value.revokedSequences.length
  ) {
    throw new Error("The signed release record is malformed.");
  }
  return value as unknown as ReleaseRecord;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function defaultActiveSessionCount(paths: UpdatePaths): Promise<number> {
  try {
    return (await activeSessions(resolvePaths(paths.home))).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function defaultAvailableBytes(paths: UpdatePaths): Promise<number> {
  const filesystem = await statfs(paths.home);
  return Number(filesystem.bavail) * Number(filesystem.bsize);
}

async function defaultHasCodexAuth(paths: UpdatePaths): Promise<boolean> {
  try {
    return await inspectCodexAuth(resolvePaths(paths.home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readManagedProxyState(paths: UpdatePaths): Promise<ManagedState> {
  const managedPaths = resolvePaths(paths.home);
  const apiKey = (await readFile(managedPaths.proxyKey, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(apiKey)) {
    throw new Error("Managed proxy key is missing or malformed.");
  }
  return { paths: managedPaths, apiKey };
}

async function defaultPrepareProxy(
  paths: UpdatePaths,
  recordPriorState: (wasRunning: boolean) => Promise<void>
): Promise<boolean> {
  const managed = await readManagedProxyState(paths);
  const status = await proxyStatus(managed);
  if (status.state && !status.owned) {
    throw new Error("Recorded proxy process no longer matches Claudex ownership metadata.");
  }
  const wasRunning = status.owned;
  await recordPriorState(wasRunning);
  if (wasRunning) await stopManagedProxy(managed.paths, false);
  try {
    await startManagedProxy(managed);
  } catch (error) {
    if (wasRunning) {
      try {
        await startManagedProxy(managed);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Unable to prepare or restore the managed proxy for update verification."
        );
      }
    }
    throw error;
  }
  return wasRunning;
}

async function defaultRestoreProxy(paths: UpdatePaths, wasRunning: boolean): Promise<void> {
  const managed = await readManagedProxyState(paths);
  if (wasRunning) await startManagedProxy(managed);
  else await stopManagedProxy(managed.paths, false);
}

function safeArchiveEntry(entry: string): boolean {
  const withoutDot = entry.replace(/^\.\//, "");
  if (!withoutDot || withoutDot.includes("\\") || withoutDot.includes("\0")) return false;
  if (withoutDot.startsWith("/") || withoutDot === ".." || withoutDot.startsWith("../")) return false;
  if (withoutDot.split("/").some((component) => component === "..")) return false;
  const normalized = posix.normalize(withoutDot);
  return normalized !== ".." && !normalized.startsWith("../") && normalized.startsWith("package/");
}

async function defaultExtractClaudexArchive(archive: string, destination: string): Promise<void> {
  const listed = await execFile("/usr/bin/tar", ["-tzf", archive], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  const entries = listed.stdout.split("\n").filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !safeArchiveEntry(entry))) {
    throw new Error("Claudex archive contains an unsafe or unexpected path.");
  }
  const verbose = await execFile("/usr/bin/tar", ["-tvzf", archive], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (verbose.stdout.split("\n").some((line) => /^[lh]/.test(line))) {
    throw new Error("Claudex archive may not contain links.");
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await execFile("/usr/bin/tar", ["-xzf", archive, "-C", destination, "--strip-components", "1"], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
}

async function inspectCommand(
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execFile(file, args, {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      ...(env ? { env } : {})
    });
    return { ok: true, output: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    return { ok: false, output: `${failed.stdout ?? ""}\n${failed.stderr ?? ""}` };
  }
}

async function defaultVerifyClaudeBinary(
  binary: string,
  expected: ReleaseRecord["claude"]
): Promise<string[]> {
  const warnings: string[] = [];
  await chmod(binary, 0o700);
  const fileIdentity = await inspectCommand("/usr/bin/file", ["-b", binary]);
  if (!fileIdentity.output.includes("Mach-O") || !fileIdentity.output.toLowerCase().includes("arm64")) {
    throw new Error("Claude artifact is not a macOS ARM64 Mach-O executable.");
  }
  const version = await inspectCommand(binary, ["--version"], {
    ...process.env,
    DISABLE_UPDATES: "1",
    DISABLE_AUTOUPDATER: "1"
  });
  if (
    !version.ok ||
    !version.output.includes("Claude Code") ||
    !version.output.match(new RegExp(`\\b${expected.version.replaceAll(".", "\\.")}\\b`))
  ) {
    throw new Error(`Claude artifact did not report Claude Code ${expected.version}.`);
  }

  const signatureMetadata = await inspectCommand("/usr/bin/codesign", ["-dv", "--verbose=4", binary]);
  if (!signatureMetadata.output.includes(`Identifier=${expected.identifier}`)) {
    throw new Error(`Claude artifact identifier is not ${expected.identifier}.`);
  }
  if (!signatureMetadata.output.includes(`TeamIdentifier=${expected.teamIdentifier}`)) {
    throw new Error(`Claude artifact team is not ${expected.teamIdentifier}.`);
  }
  const signatureValidity = await inspectCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", binary]);
  if (!signatureValidity.ok) {
    throw new Error("Claude artifact code-signature verification failed.");
  }
  const gatekeeper = await inspectCommand("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    binary
  ]);
  const gatekeeperNonApplicable =
    !/\bdenied\b/i.test(gatekeeper.output) &&
    /rejected \(the code is valid but does not seem to be an app\)\s*$/i.test(
      gatekeeper.output.trim()
    );
  if (!gatekeeperNonApplicable && /\brejected\b|\bdenied\b/i.test(gatekeeper.output)) {
    throw new Error("Gatekeeper explicitly rejected the certified Claude artifact.");
  }
  if (gatekeeperNonApplicable) {
    warnings.push("Gatekeeper could not assess the valid standalone executable as an app.");
  } else if (!gatekeeper.ok || !/\baccepted\b/i.test(gatekeeper.output)) {
    warnings.push("Gatekeeper could not produce an acceptance result for the certified Claude artifact.");
  }
  return warnings;
}

async function defaultVerifyCandidate(candidate: CandidateContext): Promise<void> {
  const version = await execFile(process.execPath, [candidate.claudexEntrypoint, "--version"], {
    timeout: 15_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  });
  if (version.stdout.trim() !== candidate.record.claudex.version) {
    throw new Error("Candidate Claudex runtime reported the wrong version.");
  }
  const isolatedConfig = join(dirname(candidate.claudexRuntimeDir), `.candidate-config-${process.pid}`);
  await mkdir(isolatedConfig, { recursive: true, mode: 0o700 });
  const managedPaths = resolvePaths(candidate.paths.home);
  const routing = buildClaudeSettings(managedPaths.apiKeyHelper);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDEX_HOME: candidate.paths.home,
    CLAUDEX_MANAGED_CLAUDE_BIN: candidate.claudeBinary,
    CLAUDEX_UPDATE_VERIFICATION: "1",
    CLAUDEX_UPDATE_OWNER_PID: String(process.pid),
    CLAUDE_CONFIG_DIR: isolatedConfig,
    NODE_NO_WARNINGS: "1",
    DISABLE_UPDATES: "1",
    DISABLE_AUTOUPDATER: "1",
    ...routing.env
  };
  delete env.CLAUDEX_CLAUDE_BIN;
  for (const key of CONFLICTING_ENV_KEYS) delete env[key];
  try {
    const doctorOutput = await execFile(
      process.execPath,
      [candidate.claudexEntrypoint, "doctor", "--json"],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env }
    );
    const doctor = JSON.parse(doctorOutput.stdout) as { ok?: unknown };
    if (doctor.ok !== true) throw new Error("Candidate Claudex doctor did not pass before activation.");

    let logSizeBefore = 0;
    try {
      logSizeBefore = (await stat(managedPaths.proxyLog)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const smoke = await execFile(
      candidate.claudeBinary,
      [
        "--settings",
        managedPaths.settings,
        "-p",
        "Reply with exactly CLAUDEX_UPDATE_OK.",
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence"
      ],
      { cwd: isolatedConfig, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env }
    );
    const response = JSON.parse(smoke.stdout) as {
      result?: unknown;
      is_error?: unknown;
      subtype?: unknown;
    };
    if (
      typeof response.result !== "string" ||
      response.result.trim() !== "CLAUDEX_UPDATE_OK" ||
      response.is_error === true ||
      (response.subtype !== undefined && response.subtype !== "success")
    ) {
      throw new Error("Candidate Claudex routed smoke request did not complete.");
    }
    if ((await stat(managedPaths.proxyLog)).size <= logSizeBefore) {
      throw new Error("Candidate smoke request did not produce managed proxy evidence.");
    }
  } finally {
    await rm(isolatedConfig, { recursive: true, force: true });
  }
}

async function defaultVerifyActivated(candidate: CandidateContext): Promise<void> {
  let verificationEntrypoint = candidate.claudexEntrypoint;
  const bootstrapEntrypoint = process.env.CLAUDEX_BOOTSTRAP_ENTRYPOINT;
  if (bootstrapEntrypoint && resolve(bootstrapEntrypoint) === bootstrapEntrypoint) {
    try {
      if ((await lstat(bootstrapEntrypoint)).isFile()) verificationEntrypoint = bootstrapEntrypoint;
    } catch {
      // Injected/packed-install tests may not have entered through the permanent bootstrap.
    }
  }
  const verificationEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDEX_HOME: candidate.paths.home,
    CLAUDEX_MANAGED_CLAUDE_BIN: candidate.claudeBinary,
    NODE_NO_WARNINGS: "1",
    CLAUDEX_UPDATE_VERIFICATION: "1",
    CLAUDEX_UPDATE_OWNER_PID: String(process.pid),
    CLAUDEX_ACTIVE_PAIR_SOURCE: candidate.expectedBootstrapSource,
    DISABLE_UPDATES: "1",
    DISABLE_AUTOUPDATER: "1"
  };
  if (candidate.expectedBootstrapSequence === null) {
    delete verificationEnv.CLAUDEX_ACTIVE_PAIR_SEQUENCE;
  } else {
    verificationEnv.CLAUDEX_ACTIVE_PAIR_SEQUENCE = String(candidate.expectedBootstrapSequence);
  }
  delete verificationEnv.CLAUDEX_CLAUDE_BIN;
  const output = await execFile(process.execPath, [verificationEntrypoint, "doctor", "--json"], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: verificationEnv
  });
  const report = JSON.parse(output.stdout) as {
    ok?: unknown;
    claude?: { ok?: unknown; version?: unknown };
    managedPair?: {
      active?: {
        source?: unknown;
        sequence?: unknown;
        claudexVersion?: unknown;
        claudeVersion?: unknown;
      };
      runtimeIntegrity?: unknown;
    };
  };
  const expectedIntegrity =
    candidate.expectedBootstrapSource === "packaged" ? "packaged" : "verified";
  if (
    report.ok !== true ||
    report.claude?.ok !== true ||
    report.claude.version !== candidate.record.claude.version ||
    report.managedPair?.active?.source !== candidate.expectedBootstrapSource ||
    report.managedPair.active.sequence !== candidate.expectedBootstrapSequence ||
    report.managedPair.active.claudexVersion !== candidate.record.claudex.version ||
    report.managedPair.active.claudeVersion !== candidate.record.claude.version ||
    report.managedPair.runtimeIntegrity !== expectedIntegrity
  ) {
    throw new Error("Activated Claudex doctor did not verify the intended active pair.");
  }
}

function completeDependencies(
  dependencies: Partial<UpdateDependencies>
): UpdateDependencies {
  return {
    releaseSource: dependencies.releaseSource ?? createGitHubReleaseAdapter(),
    publicKeyPem: dependencies.publicKeyPem ?? RELEASE_PUBLIC_KEY_PEM,
    platform: dependencies.platform ?? process.platform,
    arch: dependencies.arch ?? process.arch,
    env: dependencies.env ?? process.env,
    pid: dependencies.pid ?? process.pid,
    isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive,
    activeSessionCount: dependencies.activeSessionCount ?? defaultActiveSessionCount,
    sessionStartBarrier:
      dependencies.sessionStartBarrier ??
      ((paths, operation) => withSessionStartLock(resolvePaths(paths.home), operation)),
    hasCodexAuth: dependencies.hasCodexAuth ?? defaultHasCodexAuth,
    availableBytes: dependencies.availableBytes ?? defaultAvailableBytes,
    prepareProxy: dependencies.prepareProxy ?? defaultPrepareProxy,
    restoreProxy: dependencies.restoreProxy ?? defaultRestoreProxy,
    extractClaudexArchive: dependencies.extractClaudexArchive ?? defaultExtractClaudexArchive,
    verifyClaudeBinary: dependencies.verifyClaudeBinary ?? defaultVerifyClaudeBinary,
    verifyCandidate: dependencies.verifyCandidate ?? defaultVerifyCandidate,
    verifyActivated: dependencies.verifyActivated ?? defaultVerifyActivated,
    onPhase: dependencies.onPhase ?? (async () => undefined)
  };
}

function findUniqueAsset(descriptor: ReleaseDescriptor, name: string): ReleaseAsset {
  const matches = descriptor.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) throw new Error(`Release must contain exactly one ${name} asset.`);
  return matches[0] as ReleaseAsset;
}

function validateReleaseAssetUrl(url: string): void {
  const parsed = new URL(url);
  const expectedPrefix = `/repos/${RELEASE_REPOSITORY}/releases/assets/`;
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "api.github.com" ||
    Boolean(parsed.username) ||
    Boolean(parsed.password) ||
    Boolean(parsed.port) ||
    Boolean(parsed.search) ||
    Boolean(parsed.hash) ||
    !parsed.pathname.startsWith(expectedPrefix) ||
    !/^\d+$/.test(parsed.pathname.slice(expectedPrefix.length))
  ) {
    throw new Error("Release asset URL is outside the authenticated Claudex repository.");
  }
}

function validateClaudeUrl(url: string, version: string): void {
  const parsed = new URL(url);
  const expected = `/claude-code-releases/${version}/darwin-arm64/claude`;
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "downloads.claude.ai" ||
    Boolean(parsed.username) ||
    Boolean(parsed.password) ||
    Boolean(parsed.port) ||
    parsed.pathname !== expected ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Claude artifact URL is not an allowlisted official versioned download.");
  }
}

async function downloadSignedRecord(
  descriptor: ReleaseDescriptor,
  source: ReleaseSource,
  publicKeyPem: string,
  stagingRoot?: string
): Promise<ReleaseRecord> {
  if (stagingRoot) await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(
    join(stagingRoot ?? tmpdir(), stagingRoot ? ".update-metadata-" : "claudex-update-check-")
  );
  try {
    const jsonAsset = findUniqueAsset(descriptor, "release.json");
    const signatureAsset = findUniqueAsset(descriptor, "release.sig");
    validateReleaseAssetUrl(jsonAsset.url);
    validateReleaseAssetUrl(signatureAsset.url);
    const jsonPath = join(temporary, "release.json");
    const signaturePath = join(temporary, "release.sig");
    await source.download(jsonAsset.url, jsonPath);
    await source.download(signatureAsset.url, signaturePath);
    if ((await stat(jsonPath)).size !== jsonAsset.size || (await stat(signaturePath)).size !== signatureAsset.size) {
      throw new Error("Signed release metadata size does not match the authenticated release.");
    }
    const releaseContents = await readFile(jsonPath, "utf8");
    const record = parseReleaseRecord(releaseContents);
    if (releaseContents.trim() !== canonicalizeReleaseRecord(record)) {
      throw new Error("The signed release record is not canonical JSON.");
    }
    const encodedSignature = (await readFile(signaturePath, "utf8")).trim();
    const signature = Buffer.from(encodedSignature, "base64");
    if (signature.byteLength !== 64 || signature.toString("base64") !== encodedSignature) {
      throw new Error("The Claudex release signature encoding is malformed.");
    }
    if (!publicKeyPem) throw new Error("Claudex release verification key is not configured.");
    const valid = verify(
      null,
      Buffer.from(canonicalizeReleaseRecord(record)),
      createPublicKey(publicKeyPem),
      signature
    );
    if (!valid) throw new Error("Claudex release signature verification failed.");
    return record;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readLinkedRecord(link: string, releasesRoot: string): Promise<ReleaseRecord | null> {
  try {
    const target = await readlink(link);
    if (target !== basename(target)) return null;
    const sequence = basename(target);
    if (!/^[1-9]\d*$/.test(sequence)) return null;
    const record = parseReleaseRecord(await readFile(join(releasesRoot, sequence, "release.json"), "utf8"));
    return String(record.sequence) === sequence ? record : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function validateRelease(
  descriptor: ReleaseDescriptor,
  record: ReleaseRecord,
  platform: NodeJS.Platform,
  arch: string
): void {
  if (descriptor.repository !== RELEASE_REPOSITORY || record.repository !== RELEASE_REPOSITORY) {
    throw new Error(`Release repository must be ${RELEASE_REPOSITORY}.`);
  }
  if (descriptor.draft || descriptor.prerelease) throw new Error("Only stable Claudex releases are accepted.");
  if (record.schemaVersion !== RELEASE_SCHEMA_VERSION) throw new Error("Unsupported release schema.");
  if (record.minimumBootstrapSchema > BOOTSTRAP_SCHEMA_VERSION) {
    throw new Error("This release requires a newer Claudex bootstrap.");
  }
  if (record.minimumStateSchema > STATE_SCHEMA_VERSION) {
    throw new Error("This release requires a newer Claudex state schema.");
  }
  if (platform !== "darwin" || arch !== "arm64" || record.platform !== "darwin-arm64") {
    throw new Error(`Release is not compatible with ${platform}/${arch}.`);
  }
  if (descriptor.tag !== record.tag || record.tag !== `v${record.claudex.version}`) {
    throw new Error("Release tag and Claudex version do not agree.");
  }
  if (record.claudex.asset !== `claudex-${record.claudex.version}.tgz`) {
    throw new Error("Release Claudex artifact name is invalid.");
  }
  if (
    record.proxy.version !== PROXY_RUNTIME.version ||
    record.proxy.commit !== PROXY_RUNTIME.commit
  ) {
    throw new Error(
      `Release proxy identity must be ${PROXY_RUNTIME.version}/${PROXY_RUNTIME.commit}.`
    );
  }
  if (record.claude.identifier !== CERTIFIED_CLAUDE.identifier) {
    throw new Error(`Release Claude identifier must be ${CERTIFIED_CLAUDE.identifier}.`);
  }
  if (record.claude.teamIdentifier !== CERTIFIED_CLAUDE.teamIdentifier) {
    throw new Error(`Release Claude team must be ${CERTIFIED_CLAUDE.teamIdentifier}.`);
  }
  const archive = findUniqueAsset(descriptor, record.claudex.asset);
  validateReleaseAssetUrl(archive.url);
  if (archive.size !== record.claudex.size) throw new Error("Release Claudex artifact size does not agree.");
  validateClaudeUrl(record.claude.url, record.claude.version);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function managedTreeSha256(root: string): Promise<string> {
  const hash = createHash("sha256");
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
        hash.update(`directory\0${relative}\0${mode}\0`);
        await walk(path, relative);
      } else if (entry.isFile()) {
        hash.update(`file\0${relative}\0${mode}\0${details.size}\0`);
        for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
        hash.update("\0");
      } else {
        throw new Error("Managed Claudex runtime tree contains an unsupported entry.");
      }
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}

async function verifyArtifact(path: string, size: number, sha256: string, label: string): Promise<void> {
  const details = await stat(path);
  if (!details.isFile() || details.size !== size) {
    throw new Error(`${label} size verification failed.`);
  }
  if ((await sha256File(path)) !== sha256) throw new Error(`${label} checksum verification failed.`);
}

async function writePrivateFile(
  path: string,
  contents: string | Uint8Array,
  mode = 0o600
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await rm(temporary, { force: true });
  }
}

type MutableStateKey =
  | "settings"
  | "proxyConfig"
  | "proxyKey"
  | "apiKeyHelper"
  | "resolvedClaude"
  | "packagedFallback";

type MutableStateEntry =
  | { kind: "missing" }
  | { kind: "file"; mode: number; contents: string }
  | { kind: "symlink"; target: string };

interface MutableStateSnapshot {
  schemaVersion: 1;
  entries: Record<MutableStateKey, MutableStateEntry>;
}

function mutableStatePaths(paths: UpdatePaths): Record<MutableStateKey, string> {
  const managed = resolvePaths(paths.home);
  return {
    settings: managed.settings,
    proxyConfig: managed.proxyConfig,
    proxyKey: managed.proxyKey,
    apiKeyHelper: managed.apiKeyHelper,
    resolvedClaude: managed.resolvedClaude,
    packagedFallback: paths.packagedFallbackFile
  };
}

async function captureMutableState(paths: UpdatePaths): Promise<void> {
  const entries = {} as Record<MutableStateKey, MutableStateEntry>;
  for (const [key, path] of Object.entries(mutableStatePaths(paths)) as Array<[
    MutableStateKey,
    string
  ]>) {
    try {
      const details = await lstat(path);
      if (details.isSymbolicLink()) entries[key] = { kind: "symlink", target: await readlink(path) };
      else if (details.isFile()) {
        entries[key] = {
          kind: "file",
          mode: details.mode & 0o777,
          contents: (await readFile(path)).toString("base64")
        };
      } else throw new Error(`Managed mutable state ${key} is not a regular file or symlink.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries[key] = { kind: "missing" };
      else throw error;
    }
  }
  const snapshot: MutableStateSnapshot = { schemaVersion: 1, entries };
  await writePrivateFile(paths.snapshotFile, `${JSON.stringify(snapshot)}\n`);
}

async function restoreMutableState(paths: UpdatePaths): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(paths.snapshotFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Claudex update mutable-state snapshot is malformed.");
  }
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.entries)) {
    throw new Error("Claudex update mutable-state snapshot is malformed.");
  }
  const expected = mutableStatePaths(paths);
  if (!exactKeys(value.entries, Object.keys(expected))) {
    throw new Error("Claudex update mutable-state snapshot is malformed.");
  }
  for (const [key, path] of Object.entries(expected) as Array<[MutableStateKey, string]>) {
    const entry = value.entries[key];
    if (!isObject(entry) || typeof entry.kind !== "string") {
      throw new Error("Claudex update mutable-state snapshot is malformed.");
    }
    if (entry.kind === "missing") await rm(path, { force: true });
    else if (entry.kind === "symlink" && typeof entry.target === "string") {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        await symlink(entry.target, temporary);
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    } else if (
      entry.kind === "file" &&
      typeof entry.mode === "number" &&
      Number.isSafeInteger(entry.mode) &&
      entry.mode >= 0 &&
      entry.mode <= 0o777 &&
      typeof entry.contents === "string"
    ) {
      const contents = Buffer.from(entry.contents, "base64");
      if (contents.toString("base64") !== entry.contents) {
        throw new Error("Claudex update mutable-state snapshot is malformed.");
      }
      await writePrivateFile(path, contents, entry.mode);
    } else throw new Error("Claudex update mutable-state snapshot is malformed.");
  }
  return true;
}

async function readLinkTarget(path: string): Promise<string | null> {
  try {
    const target = await readlink(path);
    return target === basename(target) && /^[1-9]\d*$/.test(target) ? target : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function replaceLink(path: string, target: string | null): Promise<void> {
  if (target === null) {
    await rm(path, { force: true });
    return;
  }
  if (target !== basename(target) || !/^[1-9]\d*$/.test(target)) {
    throw new Error("Refusing to write an invalid release pointer.");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await symlink(target, temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function acquireUpdateLock(
  paths: UpdatePaths,
  dependencies: Pick<UpdateDependencies, "pid" | "isProcessAlive">
): Promise<() => Promise<void>> {
  await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
  await chmod(paths.runDir, 0o700);
  const temporary = `${paths.lockFile}.${dependencies.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: dependencies.pid })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(temporary, paths.lockFile);
        return async () => rm(paths.lockFile, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner = 0;
        let malformed = false;
        try {
          const value = JSON.parse(await readFile(paths.lockFile, "utf8")) as { pid?: unknown };
          if (typeof value.pid === "number" && Number.isSafeInteger(value.pid)) owner = value.pid;
          else malformed = true;
        } catch {
          malformed = true;
        }
        if (owner > 0 && dependencies.isProcessAlive(owner)) {
          throw new UpdateLockBusyError(`Another Claudex update is active (PID ${owner}).`);
        }
        if (malformed && Date.now() - (await stat(paths.lockFile)).mtimeMs < 5_000) {
          throw new UpdateLockBusyError("Another Claudex update is initializing.");
        }
        await rm(paths.lockFile, { force: true });
      }
    }
    throw new Error("Unable to acquire the Claudex update lock.");
  } finally {
    await rm(temporary, { force: true });
  }
}

async function hardenTree(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Managed runtimes may not contain symbolic links.");
    if (entry.isDirectory()) await hardenTree(path);
    else if (entry.isFile()) await chmod(path, entry.name === "claudex" || entry.name === "claude" ? 0o700 : 0o600);
    else throw new Error("Managed runtimes may contain only files and directories.");
  }
}

async function validateClaudexRuntime(
  directory: string,
  version: string,
  artifact?: Pick<ReleaseRecord["claudex"], "size" | "sha256">
): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (packageJson.name !== "claudex" || packageJson.version !== version) {
    throw new Error("Claudex archive package identity does not match the signed release.");
  }
  for (const path of [join(directory, "dist", "cli.js"), join(directory, "bin", "claudex")]) {
    if (!(await stat(path)).isFile()) throw new Error("Claudex archive is missing required runtime files.");
  }
  if (artifact) {
    const installed = JSON.parse(await readFile(join(directory, ".artifact.json"), "utf8")) as {
      size?: unknown;
      sha256?: unknown;
      treeSha256?: unknown;
    };
    if (
      installed.size !== artifact.size ||
      installed.sha256 !== artifact.sha256 ||
      typeof installed.treeSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(installed.treeSha256)
    ) {
      throw new Error("Existing Claudex runtime provenance does not match the signed artifact.");
    }
    if ((await managedTreeSha256(directory)) !== installed.treeSha256) {
      throw new Error("Managed Claudex runtime contents do not match installed provenance.");
    }
  }
}

function candidateContext(
  paths: UpdatePaths,
  record: ReleaseRecord,
  claudexRuntimeDir: string,
  claudeRuntimeDir: string,
  expectedBootstrapSource: CandidateContext["expectedBootstrapSource"] = "current",
  expectedBootstrapSequence: number | null = record.sequence
): CandidateContext {
  return {
    paths,
    record,
    claudexRuntimeDir,
    claudexEntrypoint: join(claudexRuntimeDir, "dist", "cli.js"),
    claudeRuntimeDir,
    claudeBinary: join(claudeRuntimeDir, "claude"),
    expectedBootstrapSource,
    expectedBootstrapSequence
  };
}

async function promoteDirectory(staging: string, destination: string): Promise<boolean> {
  try {
    await lstat(destination);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rename(staging, destination);
  await chmod(destination, 0o700);
  return true;
}

async function cleanupUnreferencedOlderPairs(
  paths: UpdatePaths,
  activeSequence: number
): Promise<void> {
  const current = await readLinkTarget(paths.currentLink);
  const previous = await readLinkTarget(paths.previousLink);
  const protectedSequences = new Set([current, previous].filter((value): value is string => value !== null));
  const protectedClaudex = new Set<string>();
  const protectedClaude = new Set<string>();
  const removable: Array<{ directory: string; record: ReleaseRecord }> = [];
  const packagedFallback = await readVerifiedPackagedFallback(paths);
  if (packagedFallback) protectedClaude.add(packagedFallback.claudeVersion);

  for (const entry of await readdir(paths.releasesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    const directory = join(paths.releasesRoot, entry.name);
    let release: ReleaseRecord;
    try {
      release = parseReleaseRecord(await readFile(join(directory, "release.json"), "utf8"));
    } catch {
      continue;
    }
    if (String(release.sequence) !== entry.name) continue;
    if (protectedSequences.has(entry.name) || release.sequence >= activeSequence) {
      protectedClaudex.add(release.claudex.version);
      protectedClaude.add(release.claude.version);
    } else {
      removable.push({ directory, record: release });
    }
  }

  for (const release of removable) await rm(release.directory, { recursive: true, force: true });
  for (const release of removable) {
    if (!protectedClaudex.has(release.record.claudex.version)) {
      await rm(join(paths.claudexRuntimeRoot, release.record.claudex.version), {
        recursive: true,
        force: true
      });
    }
    if (!protectedClaude.has(release.record.claude.version)) {
      await rm(join(paths.claudeRuntimeRoot, release.record.claude.version), {
        recursive: true,
        force: true
      });
    }
  }
}

async function writeJournal(paths: UpdatePaths, journal: UpdateJournal): Promise<void> {
  await writePrivateFile(paths.journalFile, `${JSON.stringify(journal)}\n`);
}

type UpdateFailurePhase = "preflight" | UpdateJournalPhase;

async function writeFailureRecord(
  paths: UpdatePaths,
  action: Exclude<UpdateAction, "check">,
  phase: UpdateFailurePhase
): Promise<void> {
  await writePrivateFile(
    paths.failureFile,
    `${JSON.stringify({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      action,
      phase,
      code: action === "apply" ? "UPDATE_FAILED" : "ROLLBACK_FAILED"
    })}\n`
  );
}

function parseUpdateJournal(value: unknown): UpdateJournal {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "action",
      "phase",
      "targetSequence",
      "targetClaudexVersion",
      "targetClaudeVersion",
      "stagingName",
      "oldCurrent",
      "oldPrevious",
      "proxyWasRunning"
    ]) ||
    value.schemaVersion !== 1 ||
    !["apply", "rollback"].includes(String(value.action)) ||
    !["prepared", "activating", "activated"].includes(String(value.phase)) ||
    !Number.isSafeInteger(value.targetSequence) ||
    (value.targetSequence as number) < 0 ||
    typeof value.targetClaudexVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.targetClaudexVersion) ||
    typeof value.targetClaudeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.targetClaudeVersion) ||
    !(
      value.stagingName === null ||
      (typeof value.stagingName === "string" &&
        /^\.update-staging-[1-9]\d*-[a-f0-9]{8}$/.test(value.stagingName))
    ) ||
    (value.action === "apply" &&
      (!(value.targetSequence as number) || typeof value.stagingName !== "string")) ||
    (value.action === "rollback" && value.stagingName !== null) ||
    !(
      value.oldCurrent === null ||
      (typeof value.oldCurrent === "string" && /^[1-9]\d*$/.test(value.oldCurrent))
    ) ||
    !(
      value.oldPrevious === null ||
      (typeof value.oldPrevious === "string" && /^[1-9]\d*$/.test(value.oldPrevious))
    ) ||
    !(
      value.proxyWasRunning === null ||
      typeof value.proxyWasRunning === "boolean"
    )
  ) {
    throw new Error("Claudex update journal is malformed; automatic recovery is unsafe.");
  }
  return value as unknown as UpdateJournal;
}

async function restoreTransactionState(
  paths: UpdatePaths,
  journal: UpdateJournal,
  restoreProxy: (paths: UpdatePaths, wasRunning: boolean) => Promise<void>
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };

  if (typeof journal.proxyWasRunning === "boolean") {
    await attempt(() => restoreProxy(paths, false));
  }
  await attempt(async () => {
    if (!(await restoreMutableState(paths))) {
      throw new Error("Claudex update recovery snapshot is missing; automatic recovery is unsafe.");
    }
  });
  await attempt(() => replaceLink(paths.currentLink, journal.oldCurrent));
  await attempt(() => replaceLink(paths.previousLink, journal.oldPrevious));
  if (journal.proxyWasRunning === true) {
    await attempt(() => restoreProxy(paths, true));
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Claudex could not fully restore the interrupted update state.");
  }
}

async function cleanupInterruptedTransaction(
  paths: UpdatePaths,
  journal: UpdateJournal
): Promise<void> {
  if (journal.stagingName) {
    const staging = join(paths.home, journal.stagingName);
    try {
      const details = await lstat(staging);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error("Interrupted Claudex staging path is not a private directory.");
      }
      await rm(staging, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (journal.action !== "apply") return;

  const current = await readLinkTarget(paths.currentLink);
  const previous = await readLinkTarget(paths.previousLink);
  if (current === String(journal.targetSequence) || previous === String(journal.targetSequence)) {
    return;
  }

  const targetRelease = join(paths.releasesRoot, String(journal.targetSequence));
  try {
    const record = parseReleaseRecord(await readFile(join(targetRelease, "release.json"), "utf8"));
    if (
      record.sequence !== journal.targetSequence ||
      record.claudex.version !== journal.targetClaudexVersion ||
      record.claude.version !== journal.targetClaudeVersion
    ) {
      throw new Error("Interrupted release metadata does not match the recovery journal.");
    }
    await rm(targetRelease, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const protectedClaudex = new Set<string>();
  const protectedClaude = new Set<string>();
  try {
    for (const entry of await readdir(paths.releasesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
      try {
        const record = parseReleaseRecord(
          await readFile(join(paths.releasesRoot, entry.name, "release.json"), "utf8")
        );
        if (String(record.sequence) !== entry.name) continue;
        protectedClaudex.add(record.claudex.version);
        protectedClaude.add(record.claude.version);
      } catch {
        // Unknown local records are never used to authorize deletion.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const fallback = parsePackagedFallback(await readFile(paths.packagedFallbackFile, "utf8"));
    protectedClaude.add(fallback.claudeVersion);
  } catch {
    // A missing or invalid fallback cannot safely reference a runtime.
  }

  if (!protectedClaudex.has(journal.targetClaudexVersion)) {
    await rm(join(paths.claudexRuntimeRoot, journal.targetClaudexVersion), {
      recursive: true,
      force: true
    });
  }
  if (!protectedClaude.has(journal.targetClaudeVersion)) {
    await rm(join(paths.claudeRuntimeRoot, journal.targetClaudeVersion), {
      recursive: true,
      force: true
    });
  }
}

async function recoverJournal(
  paths: UpdatePaths,
  restoreProxy: (paths: UpdatePaths, wasRunning: boolean) => Promise<void> = defaultRestoreProxy
): Promise<boolean> {
  let journal: UpdateJournal;
  try {
    journal = parseUpdateJournal(JSON.parse(await readFile(paths.journalFile, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if ((error as Error).message.includes("automatic recovery is unsafe")) throw error;
    throw new Error("Claudex update journal is malformed; automatic recovery is unsafe.");
  }
  await restoreTransactionState(paths, journal, restoreProxy);
  await cleanupInterruptedTransaction(paths, journal);
  await rm(paths.journalFile, { force: true });
  await rm(paths.snapshotFile, { force: true });
  return true;
}

export type InterruptedUpdateRecovery = "clean" | "recovered" | "busy";

export async function recoverInterruptedUpdate(
  paths: UpdatePaths,
  options: {
    isProcessAlive?: (pid: number) => boolean;
    restoreProxy?: (paths: UpdatePaths, wasRunning: boolean) => Promise<void>;
    pid?: number;
  } = {}
): Promise<InterruptedUpdateRecovery> {
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const hadLock = await pathExists(paths.lockFile);
  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireUpdateLock(paths, {
      pid: options.pid ?? process.pid,
      isProcessAlive
    });
  } catch (error) {
    if (error instanceof UpdateLockBusyError) return "busy";
    throw error;
  }
  try {
    const recovered = await recoverJournal(paths, options.restoreProxy ?? defaultRestoreProxy);
    return recovered || hadLock ? "recovered" : "clean";
  } finally {
    await releaseLock();
  }
}

export interface ManagedUpdateInspection {
  current: PairSummary | null;
  previous: PairSummary | null;
  managedRuntimeIntegrity: "verified" | "missing" | "invalid";
  incompleteTransaction: boolean;
}

export interface LinkedManagedPair {
  source: "current" | "previous";
  sequence: number;
  claudexVersion: string;
  claudeVersion: string;
  entrypoint: string;
  claudeBinary: string;
}

export async function inspectLinkedPair(
  paths: UpdatePaths,
  source: "current" | "previous"
): Promise<LinkedManagedPair | null> {
  try {
    const linkPath = source === "current" ? paths.currentLink : paths.previousLink;
    const target = await readLinkTarget(linkPath);
    if (!target) return null;
    const releaseFile = join(paths.releasesRoot, target, "release.json");
    if (!(await lstat(releaseFile)).isFile()) return null;
    const record = parseReleaseRecord(await readFile(releaseFile, "utf8"));
    if (String(record.sequence) !== target) return null;
    const runtimeDir = join(paths.claudexRuntimeRoot, record.claudex.version);
    const entrypoint = join(runtimeDir, "dist", "cli.js");
    const claudeBinary = join(paths.claudeRuntimeRoot, record.claude.version, "claude");
    await validateClaudexRuntime(runtimeDir, record.claudex.version, record.claudex);
    if (!(await lstat(entrypoint)).isFile() || !(await lstat(claudeBinary)).isFile()) return null;
    await verifyArtifact(
      claudeBinary,
      record.claude.size,
      record.claude.sha256,
      "Managed Claude runtime"
    );
    await access(entrypoint, constants.R_OK);
    await access(claudeBinary, constants.X_OK);
    return {
      source,
      sequence: record.sequence,
      claudexVersion: record.claudex.version,
      claudeVersion: record.claude.version,
      entrypoint,
      claudeBinary
    };
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function inspectManagedUpdateState(
  paths: UpdatePaths
): Promise<ManagedUpdateInspection> {
  const currentRecord = await readLinkedRecord(paths.currentLink, paths.releasesRoot);
  const previousRecord = await readLinkedRecord(paths.previousLink, paths.releasesRoot);
  let managedRuntimeIntegrity: ManagedUpdateInspection["managedRuntimeIntegrity"] = currentRecord
    ? "verified"
    : "missing";
  if (currentRecord) {
    try {
      await validateClaudexRuntime(
        join(paths.claudexRuntimeRoot, currentRecord.claudex.version),
        currentRecord.claudex.version,
        currentRecord.claudex
      );
      await verifyArtifact(
        join(paths.claudeRuntimeRoot, currentRecord.claude.version, "claude"),
        currentRecord.claude.size,
        currentRecord.claude.sha256,
        "Managed Claude runtime"
      );
    } catch {
      managedRuntimeIntegrity = "invalid";
    }
  }
  return {
    current: currentRecord ? pairSummary(currentRecord) : null,
    previous: previousRecord ? pairSummary(previousRecord) : null,
    managedRuntimeIntegrity,
    incompleteTransaction:
      (await pathExists(paths.journalFile)) || (await pathExists(paths.lockFile))
  };
}

async function installRelease(
  paths: UpdatePaths,
  dependencies: UpdateDependencies,
  descriptor: ReleaseDescriptor,
  record: ReleaseRecord,
  currentRecord: ReleaseRecord | null,
  previousRecord: ReleaseRecord | null
): Promise<UpdateResult> {
  if (dependencies.env.CLAUDEX_CLAUDE_BIN) {
    throw new Error("Unset CLAUDEX_CLAUDE_BIN before updating managed runtimes.");
  }
  if ((await dependencies.activeSessionCount(paths)) > 0) {
    throw new Error("Claudex cannot update while Claude sessions are active.");
  }
  if (currentRecord && record.sequence < currentRecord.sequence) {
    throw new Error("Refusing to downgrade or replay an older Claudex release.");
  }
  if (record.revokedSequences.includes(record.sequence)) {
    throw new Error("The target Claudex release sequence is revoked.");
  }
  if (currentRecord && record.sequence === currentRecord.sequence) {
    const pair = pairSummary(currentRecord);
    return {
      ok: true,
      action: "apply",
      status: "up-to-date",
      current: pair,
      target: pairSummary(record),
      previous: previousRecord ? pairSummary(previousRecord) : null,
      code: "UP_TO_DATE",
      message: `Claudex ${pair.claudexVersion} with Claude Code ${pair.claudeVersion} is up to date.`
    };
  }

  const requiredBytes = record.claude.size + record.claudex.size * 3 + 64 * 1024 * 1024;
  const availableBytes = await dependencies.availableBytes(paths);
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new Error(
      `Insufficient free space for the certified update: ${requiredBytes} bytes required, ${Math.max(0, Math.floor(availableBytes))} available.`
    );
  }

  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  const staging = join(paths.home, `.update-staging-${dependencies.pid}-${randomBytes(4).toString("hex")}`);
  const stagedClaudex = join(staging, "claudex");
  const stagedClaude = join(staging, "claude");
  const claudexArchive = join(staging, record.claudex.asset);
  const claudeBinary = join(stagedClaude, "claude");
  const targetClaudex = join(paths.claudexRuntimeRoot, record.claudex.version);
  const targetClaude = join(paths.claudeRuntimeRoot, record.claude.version);
  const targetRelease = join(paths.releasesRoot, String(record.sequence));
  let proxyWasRunning: boolean | null = null;
  const oldCurrent = await readLinkTarget(paths.currentLink);
  const oldPrevious = await readLinkTarget(paths.previousLink);
  const journal: UpdateJournal = {
    schemaVersion: 1,
    action: "apply",
    phase: "prepared",
    targetSequence: record.sequence,
    targetClaudexVersion: record.claudex.version,
    targetClaudeVersion: record.claude.version,
    stagingName: basename(staging),
    oldCurrent,
    oldPrevious,
    proxyWasRunning: null
  };
  try {
    await mkdir(stagedClaude, { recursive: true, mode: 0o700 });
    const claudexAsset = findUniqueAsset(descriptor, record.claudex.asset);
    await dependencies.releaseSource.download(claudexAsset.url, claudexArchive);
    await dependencies.releaseSource.download(record.claude.url, claudeBinary);
    await chmod(claudexArchive, 0o600);
    await chmod(claudeBinary, 0o700);
    await verifyArtifact(claudexArchive, record.claudex.size, record.claudex.sha256, "Claudex artifact");
    await verifyArtifact(claudeBinary, record.claude.size, record.claude.sha256, "Claude artifact");
    await dependencies.extractClaudexArchive(claudexArchive, stagedClaudex);
    await validateClaudexRuntime(stagedClaudex, record.claudex.version);
    await hardenTree(stagedClaudex);
    const treeSha256 = await managedTreeSha256(stagedClaudex);
    await writeFile(
      join(stagedClaudex, ".artifact.json"),
      `${JSON.stringify({
        size: record.claudex.size,
        sha256: record.claudex.sha256,
        treeSha256
      })}\n`,
      { mode: 0o600, flag: "wx" }
    );
    await dependencies.verifyClaudeBinary(claudeBinary, record.claude);
    await captureMutableState(paths);
    await writeJournal(paths, journal);
    await dependencies.onPhase("apply", "prepared");
    proxyWasRunning = await dependencies.prepareProxy(paths, async (wasRunning) => {
      proxyWasRunning = wasRunning;
      journal.proxyWasRunning = wasRunning;
      await writeJournal(paths, journal);
    });
    if (journal.proxyWasRunning === null) {
      journal.proxyWasRunning = proxyWasRunning;
      await writeJournal(paths, journal);
    }
    await dependencies.verifyCandidate(candidateContext(paths, record, stagedClaudex, stagedClaude));

    const promotedClaudex = await promoteDirectory(stagedClaudex, targetClaudex);
    if (!promotedClaudex) {
      await validateClaudexRuntime(targetClaudex, record.claudex.version, record.claudex);
    }
    const promotedClaude = await promoteDirectory(stagedClaude, targetClaude);
    if (!promotedClaude) {
      await verifyArtifact(
        join(targetClaude, "claude"),
        record.claude.size,
        record.claude.sha256,
        "Existing Claude runtime"
      );
    }
    try {
      await lstat(targetRelease);
      const installed = parseReleaseRecord(await readFile(join(targetRelease, "release.json"), "utf8"));
      if (canonicalizeReleaseRecord(installed) !== canonicalizeReleaseRecord(record)) {
        throw new Error("Existing release sequence does not match the signed release.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const stagedRelease = join(staging, "release-record");
      await mkdir(stagedRelease, { recursive: true, mode: 0o700 });
      await writeFile(join(stagedRelease, "release.json"), `${canonicalizeReleaseRecord(record)}\n`, {
        mode: 0o600,
        flag: "wx"
      });
      const promotedRelease = await promoteDirectory(stagedRelease, targetRelease);
      if (!promotedRelease) {
        const installed = parseReleaseRecord(
          await readFile(join(targetRelease, "release.json"), "utf8")
        );
        if (canonicalizeReleaseRecord(installed) !== canonicalizeReleaseRecord(record)) {
          throw new Error("Concurrent release sequence does not match the signed release.");
        }
      }
    }

    if (!oldCurrent) await seedPackagedFallback(paths, record);

    if (oldCurrent) await replaceLink(paths.previousLink, oldCurrent);
    else await replaceLink(paths.previousLink, null);
    journal.phase = "activating";
    await writeJournal(paths, journal);
    await dependencies.onPhase("apply", "activating");
    await replaceLink(paths.currentLink, String(record.sequence));
    journal.phase = "activated";
    await writeJournal(paths, journal);
    await dependencies.onPhase("apply", "activated");
    await dependencies.verifyActivated(candidateContext(paths, record, targetClaudex, targetClaude));
    await dependencies.restoreProxy(paths, proxyWasRunning);
    await rm(paths.journalFile, { force: true });
    await rm(paths.snapshotFile, { force: true });
    await cleanupUnreferencedOlderPairs(paths, record.sequence).catch(() => undefined);

    const pair = pairSummary(record);
    return {
      ok: true,
      action: "apply",
      status: "updated",
      current: pair,
      target: pair,
      previous: currentRecord ? pairSummary(currentRecord) : null,
      code: "UPDATED",
      message: `Updated to Claudex ${pair.claudexVersion} with Claude Code ${pair.claudeVersion}.`
    };
  } catch (error) {
    await writeFailureRecord(paths, "apply", journal.phase).catch(() => undefined);
    if (error instanceof UpdateInterruption) throw error;
    let failure: unknown = error;
    let restored = !(await pathExists(paths.journalFile));
    if (!restored) {
      try {
        await restoreTransactionState(paths, journal, dependencies.restoreProxy);
        restored = true;
      } catch (restoreError) {
        failure = new AggregateError(
          [failure, restoreError],
          "Claudex update failed and its prior transaction state could not be restored."
        );
      }
    }
    if (restored) {
      try {
        await cleanupInterruptedTransaction(paths, journal);
      } catch (cleanupError) {
        restored = false;
        failure = new AggregateError(
          [failure, cleanupError],
          "Claudex update failed and its interrupted artifacts could not be cleaned."
        );
      }
    }
    if (restored) {
      await rm(paths.journalFile, { force: true });
      await rm(paths.snapshotFile, { force: true });
    }
    throw failure;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function rollbackRelease(
  paths: UpdatePaths,
  dependencies: UpdateDependencies
): Promise<UpdateResult> {
  if (dependencies.env.CLAUDEX_CLAUDE_BIN) {
    throw new Error("Unset CLAUDEX_CLAUDE_BIN before changing managed runtimes.");
  }
  if ((await dependencies.activeSessionCount(paths)) > 0) {
    throw new Error("Claudex cannot roll back while Claude sessions are active.");
  }
  const currentRecord = await readLinkedRecord(paths.currentLink, paths.releasesRoot);
  const previousRecord = await readLinkedRecord(paths.previousLink, paths.releasesRoot);
  if (!currentRecord) throw new Error("The active managed Claudex pair is missing or invalid.");
  const packagedFallback = previousRecord ? null : await readVerifiedPackagedFallback(paths);
  const rollbackToPackaged = packagedFallback !== null;
  if (!previousRecord && !packagedFallback) {
    throw new Error("No verified previous or packaged Claudex pair is available for rollback.");
  }
  if (previousRecord && currentRecord.revokedSequences.includes(previousRecord.sequence)) {
    throw new Error("The previous Claudex pair has been revoked and cannot be restored.");
  }
  if (
    packagedFallback &&
    (packagedFallback.claudexVersion !== currentRecord.claudex.version ||
      packagedFallback.claudeVersion !== currentRecord.claude.version ||
      packagedFallback.claude.size !== currentRecord.claude.size ||
      packagedFallback.claude.sha256 !== currentRecord.claude.sha256)
  ) {
    throw new Error("The packaged fallback does not match the active certified pair.");
  }

  const targetRecord = previousRecord ?? currentRecord;
  const claudexRuntimeDir = join(paths.claudexRuntimeRoot, targetRecord.claudex.version);
  const claudeRuntimeDir = join(paths.claudeRuntimeRoot, targetRecord.claude.version);
  await validateClaudexRuntime(
    claudexRuntimeDir,
    targetRecord.claudex.version,
    targetRecord.claudex
  );
  await verifyArtifact(
    join(claudeRuntimeDir, "claude"),
    targetRecord.claude.size,
    targetRecord.claude.sha256,
    rollbackToPackaged ? "Packaged fallback Claude runtime" : "Previous Claude runtime"
  );
  await dependencies.verifyClaudeBinary(join(claudeRuntimeDir, "claude"), targetRecord.claude);

  const oldCurrent = String(currentRecord.sequence);
  const oldPrevious = previousRecord ? String(previousRecord.sequence) : null;
  const journal: UpdateJournal = {
    schemaVersion: 1,
    action: "rollback",
    phase: "prepared",
    targetSequence: rollbackToPackaged ? 0 : targetRecord.sequence,
    targetClaudexVersion: targetRecord.claudex.version,
    targetClaudeVersion: targetRecord.claude.version,
    stagingName: null,
    oldCurrent,
    oldPrevious,
    proxyWasRunning: null
  };
  let proxyWasRunning: boolean | null = null;
  try {
    await captureMutableState(paths);
    await writeJournal(paths, journal);
    await dependencies.onPhase("rollback", "prepared");
    proxyWasRunning = await dependencies.prepareProxy(paths, async (wasRunning) => {
      proxyWasRunning = wasRunning;
      journal.proxyWasRunning = wasRunning;
      await writeJournal(paths, journal);
    });
    if (journal.proxyWasRunning === null) {
      journal.proxyWasRunning = proxyWasRunning;
      await writeJournal(paths, journal);
    }
    await replaceLink(paths.previousLink, rollbackToPackaged ? null : oldCurrent);
    journal.phase = "activating";
    await writeJournal(paths, journal);
    await dependencies.onPhase("rollback", "activating");
    await replaceLink(paths.currentLink, rollbackToPackaged ? null : oldPrevious);
    journal.phase = "activated";
    await writeJournal(paths, journal);
    await dependencies.onPhase("rollback", "activated");
    await dependencies.verifyActivated(
      candidateContext(
        paths,
        targetRecord,
        claudexRuntimeDir,
        claudeRuntimeDir,
        rollbackToPackaged ? "packaged" : "current",
        rollbackToPackaged ? null : targetRecord.sequence
      )
    );
    await dependencies.restoreProxy(paths, proxyWasRunning);
    await rm(paths.journalFile, { force: true });
    await rm(paths.snapshotFile, { force: true });
  } catch (error) {
    await writeFailureRecord(paths, "rollback", journal.phase).catch(() => undefined);
    if (error instanceof UpdateInterruption) throw error;
    let failure: unknown = error;
    let restored = !(await pathExists(paths.journalFile));
    if (!restored) {
      try {
        await restoreTransactionState(paths, journal, dependencies.restoreProxy);
        restored = true;
      } catch (restoreError) {
        failure = new AggregateError(
          [failure, restoreError],
          "Claudex rollback failed and its prior transaction state could not be restored."
        );
      }
    }
    if (restored) {
      await rm(paths.journalFile, { force: true });
      await rm(paths.snapshotFile, { force: true });
    }
    throw failure;
  }

  const restored = packagedFallback
    ? packagedFallbackSummary(packagedFallback)
    : pairSummary(targetRecord);
  const replaced = pairSummary(currentRecord);
  return {
    ok: true,
    action: "rollback",
    status: "rolled-back",
    current: restored,
    target: restored,
    previous: replaced,
    code: rollbackToPackaged ? "ROLLED_BACK_TO_PACKAGED" : "ROLLED_BACK",
    message: rollbackToPackaged
      ? `Rolled back to packaged Claudex ${restored.claudexVersion} with private Claude Code ${restored.claudeVersion}.`
      : `Rolled back to Claudex ${restored.claudexVersion} with Claude Code ${restored.claudeVersion}.`
  };
}

export async function manageUpdate(
  action: UpdateAction,
  paths: UpdatePaths,
  dependencies: Partial<UpdateDependencies> = {}
): Promise<UpdateResult> {
  const resolved = completeDependencies(dependencies);
  if (resolved.platform !== "darwin" || resolved.arch !== "arm64") {
    throw new Error(`Claudex updates support macOS ARM64 only; detected ${resolved.platform}/${resolved.arch}.`);
  }

  const run = async (): Promise<UpdateResult> => {
    const currentRecord = await readLinkedRecord(paths.currentLink, paths.releasesRoot);
    const previousRecord = await readLinkedRecord(paths.previousLink, paths.releasesRoot);
    const packagedFallback = currentRecord ? null : await readVerifiedPackagedFallback(paths);
    const descriptor = await resolved.releaseSource.latest();
    const targetRecord = await downloadSignedRecord(
      descriptor,
      resolved.releaseSource,
      resolved.publicKeyPem,
      action === "apply" ? paths.home : undefined
    );
    validateRelease(descriptor, targetRecord, resolved.platform, resolved.arch);
    if (currentRecord && targetRecord.sequence < currentRecord.sequence) {
      throw new Error("Refusing to downgrade or replay an older Claudex release.");
    }
    if (
      currentRecord &&
      targetRecord.sequence === currentRecord.sequence &&
      canonicalizeReleaseRecord(targetRecord) !== canonicalizeReleaseRecord(currentRecord)
    ) {
      throw new Error("The same release sequence identifies a different signed release record.");
    }
    if (targetRecord.revokedSequences.includes(targetRecord.sequence)) {
      throw new Error("The target Claudex release sequence is revoked.");
    }
    if (action === "apply") {
      return installRelease(
        paths,
        resolved,
        descriptor,
        targetRecord,
        currentRecord,
        previousRecord
      );
    }

    const target = pairSummary(targetRecord);
    const current = currentRecord
      ? pairSummary(currentRecord)
      : packagedFallback
        ? packagedFallbackSummary(packagedFallback)
        : null;
    const previous = previousRecord ? pairSummary(previousRecord) : null;
    const available = !current || target.sequence > current.sequence;
    return {
      ok: true,
      action,
      status: available ? "update-available" : "up-to-date",
      current,
      target,
      previous,
      code: available ? "UPDATE_AVAILABLE" : "UP_TO_DATE",
      message: available
        ? `Claudex ${target.claudexVersion} with Claude Code ${target.claudeVersion} is available.`
        : `Claudex ${target.claudexVersion} with Claude Code ${target.claudeVersion} is up to date.`
    };
  };

  if (action === "check") return run();
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  const releaseLock = await acquireUpdateLock(paths, resolved);
  try {
    await rm(paths.failureFile, { force: true });
    await recoverJournal(paths, resolved.restoreProxy);
    if (resolved.env.CLAUDEX_CLAUDE_BIN) {
      throw new Error("Unset CLAUDEX_CLAUDE_BIN before changing managed runtimes.");
    }
    if (
      (await resolved.sessionStartBarrier(paths, () => resolved.activeSessionCount(paths))) > 0
    ) {
      throw new Error("Claudex cannot update while Claude sessions are active.");
    }
    if (action === "rollback") return await rollbackRelease(paths, resolved);
    if (!(await resolved.hasCodexAuth(paths))) {
      throw new Error('No Claudex Codex OAuth is available. Run "claudex login" before updating.');
    }
    if (await pathExists(paths.currentLink)) {
      const current = await inspectManagedUpdateState(paths);
      if (!current.current || current.managedRuntimeIntegrity !== "verified") {
        throw new Error("The current managed Claudex runtime is invalid; refusing to apply an update.");
      }
    }
    return await run();
  } catch (error) {
    if (!(await pathExists(paths.failureFile))) {
      await writeFailureRecord(paths, action, "preflight").catch(() => undefined);
    }
    throw error;
  } finally {
    await releaseLock();
  }
}
