import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildClaudeSettings } from "./claude-settings.js";
import { renderProxyConfig } from "./proxy-config.js";
import { PROXY_RUNTIME } from "./runtime.js";

export interface ManagedPaths {
  home: string;
  authDir: string;
  binDir: string;
  runtimeRoot: string;
  runtimeDir: string;
  runtimeBinary: string;
  claudexRuntimeRoot: string;
  claudeRuntimeRoot: string;
  releasesDir: string;
  currentRelease: string;
  previousRelease: string;
  proxyDir: string;
  proxyConfig: string;
  proxyKey: string;
  apiKeyHelper: string;
  settings: string;
  runDir: string;
  proxyState: string;
  startLock: string;
  sessionStartLock: string;
  sessionsDir: string;
  logsDir: string;
  proxyLog: string;
  resolvedClaude: string;
  updateLock: string;
  updateJournal: string;
}

export interface ManagedState {
  paths: ManagedPaths;
  apiKey: string;
}

export const PROXY_VERSION = PROXY_RUNTIME.version;
export const PROXY_PORT = 8317;

export function resolvePaths(home: string, proxyVersion = PROXY_VERSION): ManagedPaths {
  const absoluteHome = resolve(home);
  if (!/^\d+\.\d+\.\d+$/.test(proxyVersion)) throw new Error("Invalid CLIProxyAPI runtime version.");
  const runtimeDir = join(absoluteHome, "runtime", "cliproxyapi", proxyVersion);
  return {
    home: absoluteHome,
    authDir: join(absoluteHome, "auth"),
    binDir: join(absoluteHome, "bin"),
    runtimeRoot: join(absoluteHome, "runtime", "cliproxyapi"),
    runtimeDir,
    runtimeBinary: join(runtimeDir, "cli-proxy-api"),
    claudexRuntimeRoot: join(absoluteHome, "runtime", "claudex"),
    claudeRuntimeRoot: join(absoluteHome, "runtime", "claude"),
    releasesDir: join(absoluteHome, "releases"),
    currentRelease: join(absoluteHome, "releases", "current"),
    previousRelease: join(absoluteHome, "releases", "previous"),
    proxyDir: join(absoluteHome, "proxy"),
    proxyConfig: join(absoluteHome, "proxy", "config.yaml"),
    proxyKey: join(absoluteHome, "proxy", "api-key"),
    apiKeyHelper: join(absoluteHome, "bin", "claudex-api-key-helper"),
    settings: join(absoluteHome, "claude-settings.json"),
    runDir: join(absoluteHome, "run"),
    proxyState: join(absoluteHome, "run", "proxy.json"),
    startLock: join(absoluteHome, "run", "start.lock"),
    sessionStartLock: join(absoluteHome, "run", "session-start.lock"),
    sessionsDir: join(absoluteHome, "run", "sessions"),
    logsDir: join(absoluteHome, "logs"),
    proxyLog: join(absoluteHome, "logs", "proxy.log"),
    resolvedClaude: join(absoluteHome, "run", "claude"),
    updateLock: join(absoluteHome, "run", "update.lock"),
    updateJournal: join(absoluteHome, "run", "update-journal.json")
  };
}

async function writePrivateFile(path: string, contents: string, mode = 0o600): Promise<void> {
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

async function readOrCreateApiKey(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(existing)) {
      await chmod(path, 0o600);
      return existing;
    }
    throw new Error(`Managed proxy key at ${path} is malformed.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const apiKey = randomBytes(32).toString("base64url");
  await writePrivateFile(path, `${apiKey}\n`);
  return apiKey;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function ensureManagedState(home: string): Promise<ManagedState> {
  const paths = resolvePaths(home);
  const privateDirectories = [
    paths.home,
    paths.authDir,
    paths.binDir,
    paths.runtimeRoot,
    paths.claudexRuntimeRoot,
    paths.claudeRuntimeRoot,
    paths.releasesDir,
    paths.proxyDir,
    paths.runDir,
    paths.sessionsDir,
    paths.logsDir
  ];

  for (const directory of privateDirectories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  const apiKey = await readOrCreateApiKey(paths.proxyKey);
  await writePrivateFile(
    paths.apiKeyHelper,
    `#!/bin/sh\nexec /bin/cat ${shellSingleQuote(paths.proxyKey)}\n`,
    0o700
  );
  await writePrivateFile(
    paths.proxyConfig,
    renderProxyConfig({ authDir: paths.authDir, apiKey, port: PROXY_PORT })
  );
  await writePrivateFile(
    paths.settings,
    `${JSON.stringify(buildClaudeSettings(paths.apiKeyHelper), null, 2)}\n`
  );

  return { paths, apiKey };
}

export async function enforceAuthPermissions(paths: ManagedPaths): Promise<void> {
  await chmod(paths.authDir, 0o700);
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(paths.authDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      await chmod(join(paths.authDir, entry.name), 0o600);
    }
  }
}
