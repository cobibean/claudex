import { execFile as execFileCallback, spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { MODEL, PROXY_BASE_URL } from "./claude-settings.js";
import { buildProxyEnvironment } from "./child-env.js";
import {
  installProxyRuntime,
  PROXY_RUNTIME,
  sha256File,
  type ProxyRuntimeIdentity
} from "./runtime.js";
import type { ManagedPaths, ManagedState } from "./state.js";

const execFile = promisify(execFileCallback);

export interface ProxyProbe {
  live: boolean;
  authenticated: boolean;
  modelAvailable: boolean;
}

export interface ProxyState {
  pid: number;
  binaryPath: string;
  binarySha256: string;
  configSha256: string;
  port: number;
  startedAt: string;
}

export interface SessionState {
  pid: number;
  claudePath: string;
  startedAt: string;
  state?: "starting";
}

export interface ProbeOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export async function probeProxy(options: ProbeOptions): Promise<ProxyProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const health = await fetchImpl(`${options.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(1_500)
    });
    if (!health.ok) return { live: false, authenticated: false, modelAvailable: false };
  } catch {
    return { live: false, authenticated: false, modelAvailable: false };
  }

  try {
    const models = await fetchImpl(`${options.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(3_000)
    });
    if (!models.ok) return { live: true, authenticated: false, modelAvailable: false };
    const body = (await models.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string; slug?: string }> };
    const ids = [
      ...(body.data ?? []).map((entry) => entry.id),
      ...(body.models ?? []).map((entry) => entry.id ?? entry.slug)
    ];
    return { live: true, authenticated: true, modelAvailable: ids.includes(MODEL) };
  } catch {
    return { live: true, authenticated: false, modelAvailable: false };
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processCommand(pid: number): Promise<string> {
  try {
    const result = await execFile("/bin/ps", ["-p", String(pid), "-o", "command="], {
      timeout: 2_000
    });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

export async function readProxyState(paths: ManagedPaths): Promise<ProxyState | null> {
  try {
    const state = JSON.parse(await readFile(paths.proxyState, "utf8")) as ProxyState;
    if (!Number.isSafeInteger(state.pid) || typeof state.binaryPath !== "string") return null;
    return state;
  } catch {
    return null;
  }
}

async function isOwnedProxy(paths: ManagedPaths, state: ProxyState): Promise<boolean> {
  if (!isProcessAlive(state.pid)) return false;
  const runtimePrefix = `${paths.runtimeRoot}/`;
  if (
    !state.binaryPath.startsWith(runtimePrefix) ||
    !/^\d+\.\d+\.\d+\/cli-proxy-api$/.test(state.binaryPath.slice(runtimePrefix.length))
  ) {
    return false;
  }
  const command = await processCommand(state.pid);
  if (!command.includes(state.binaryPath) || !command.includes(paths.proxyConfig)) return false;
  try {
    return (
      (await sha256File(state.binaryPath)) === state.binarySha256 &&
      (await sha256File(paths.proxyConfig)) === state.configSha256
    );
  } catch {
    return false;
  }
}

async function portOwners(port: number): Promise<number[]> {
  try {
    const result = await execFile(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: 2_000 }
    );
    return result.stdout
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  } catch {
    return [];
  }
}

async function withStartLock<T>(paths: ManagedPaths, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(paths.startLock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const details = await stat(paths.startLock);
        if (Date.now() - details.mtimeMs > 10_000) {
          await rm(paths.startLock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for another Claudex startup.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(paths.startLock, { recursive: true, force: true });
  }
}

async function rotateProxyLog(paths: ManagedPaths): Promise<void> {
  try {
    if ((await stat(paths.proxyLog)).size < 1_000_000) return;
  } catch {
    return;
  }
  await rm(`${paths.proxyLog}.3`, { force: true });
  for (let index = 2; index >= 1; index -= 1) {
    try {
      await rename(`${paths.proxyLog}.${index}`, `${paths.proxyLog}.${index + 1}`);
    } catch {
      // Missing prior rotation is expected.
    }
  }
  await rename(paths.proxyLog, `${paths.proxyLog}.1`);
}

async function writeProxyState(paths: ManagedPaths, state: ProxyState): Promise<void> {
  await writeFile(paths.proxyState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(paths.proxyState, 0o600);
}

export async function startManagedProxy(
  managed: ManagedState,
  runtime: ProxyRuntimeIdentity = PROXY_RUNTIME
): Promise<ProxyState> {
  return withStartLock(managed.paths, async () => {
    const existing = await readProxyState(managed.paths);
    if (
      existing &&
      existing.binaryPath === managed.paths.runtimeBinary &&
      (await isOwnedProxy(managed.paths, existing))
    ) {
      const readinessDeadline = Date.now() + 5_000;
      while (Date.now() < readinessDeadline) {
        const ready = await probeProxy({ baseUrl: PROXY_BASE_URL, apiKey: managed.apiKey });
        if (ready.authenticated && ready.modelAvailable) return existing;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if ((await activeSessions(managed.paths)).length > 0) {
        throw new Error("The managed proxy is unhealthy while a Claudex session is active; refusing to replace it.");
      }
      process.kill(existing.pid, "SIGTERM");
      const stopDeadline = Date.now() + 5_000;
      while (isProcessAlive(existing.pid) && Date.now() < stopDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (isProcessAlive(existing.pid)) process.kill(existing.pid, "SIGKILL");
      await rm(managed.paths.proxyState, { force: true });
    } else if (existing) {
      if (await isOwnedProxy(managed.paths, existing)) {
        if ((await activeSessions(managed.paths)).length > 0) {
          throw new Error("A different certified proxy runtime is active with Claudex sessions; refusing to replace it.");
        }
        process.kill(existing.pid, "SIGTERM");
        const stopDeadline = Date.now() + 5_000;
        while (isProcessAlive(existing.pid) && Date.now() < stopDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (isProcessAlive(existing.pid)) process.kill(existing.pid, "SIGKILL");
      }
      await rm(managed.paths.proxyState, { force: true });
    }

    const owners = await portOwners(8317);
    if (owners.length > 0) {
      throw new Error(`Port 8317 is already owned by PID ${owners.join(", ")}; Claudex will not reuse or kill it.`);
    }

    await installProxyRuntime(managed.paths, { runtime });
    await rotateProxyLog(managed.paths);
    const logFd = openSync(managed.paths.proxyLog, "a", 0o600);
    let child;
    try {
      child = spawn(
        managed.paths.runtimeBinary,
        ["-config", managed.paths.proxyConfig, "-local-model"],
        {
          cwd: managed.paths.proxyDir,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: buildProxyEnvironment(process.env)
        }
      );
      child.unref();
    } finally {
      closeSync(logFd);
    }
    if (!child.pid) throw new Error("CLIProxyAPI did not return a process ID.");

    const state: ProxyState = {
      pid: child.pid,
      binaryPath: managed.paths.runtimeBinary,
      binarySha256: await sha256File(managed.paths.runtimeBinary),
      configSha256: await sha256File(managed.paths.proxyConfig),
      port: 8317,
      startedAt: new Date().toISOString()
    };
    await writeProxyState(managed.paths, state);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(state.pid)) break;
      const readiness = await probeProxy({ baseUrl: PROXY_BASE_URL, apiKey: managed.apiKey });
      if (readiness.authenticated && readiness.modelAvailable) return state;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (isProcessAlive(state.pid)) process.kill(state.pid, "SIGTERM");
    await rm(managed.paths.proxyState, { force: true });
    throw new Error(
      `CLIProxyAPI did not become ready with ${MODEL}. Run \"claudex doctor\" and \"claudex login\".`
    );
  });
}

export async function recordSession(paths: ManagedPaths, pid: number, claudePath: string): Promise<void> {
  const session: SessionState = { pid, claudePath, startedAt: new Date().toISOString(), state: "starting" };
  const path = join(paths.sessionsDir, `${pid}.json`);
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function activeSessions(paths: ManagedPaths): Promise<SessionState[]> {
  const active: SessionState[] = [];
  for (const entry of await readdir(paths.sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(paths.sessionsDir, entry.name);
    try {
      const session = JSON.parse(await readFile(path, "utf8")) as SessionState;
      const command = isProcessAlive(session.pid) ? await processCommand(session.pid) : "";
      const startedAt = Date.parse(session.startedAt);
      const recentlyStarting =
        session.state === "starting" &&
        Number.isFinite(startedAt) &&
        Date.now() - startedAt < 30_000;
      if (command.includes(session.claudePath) || (isProcessAlive(session.pid) && recentlyStarting)) {
        active.push(session);
      } else {
        await rm(path, { force: true });
      }
    } catch {
      await rm(path, { force: true });
    }
  }
  return active;
}

export async function withSessionStartLock<T>(
  paths: ManagedPaths,
  operation: () => Promise<T>
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(paths.sessionStartLock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const details = await stat(paths.sessionStartLock);
        if (Date.now() - details.mtimeMs > 30_000) {
          await rm(paths.sessionStartLock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for a Claudex session-start interlock.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(paths.sessionStartLock, { recursive: true, force: true });
  }
}

export async function claimSessionStart(
  paths: ManagedPaths,
  pid: number,
  claudePath: string
): Promise<void> {
  await withSessionStartLock(paths, async () => {
    try {
      await lstat(paths.updateLock);
      throw new Error("A Claudex update is in progress; refusing to start a new session.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await recordSession(paths, pid, claudePath);
  });
}

export async function stopManagedProxy(paths: ManagedPaths, force = false): Promise<boolean> {
  const sessions = await activeSessions(paths);
  if (sessions.length > 0 && !force) {
    throw new Error(`Refusing to stop the proxy while ${sessions.length} Claudex session(s) are active.`);
  }
  const state = await readProxyState(paths);
  if (!state) return false;
  if (!(await isOwnedProxy(paths, state))) {
    throw new Error("Recorded proxy process is missing or no longer matches Claudex ownership metadata.");
  }
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (isProcessAlive(state.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(state.pid)) process.kill(state.pid, "SIGKILL");
  await rm(paths.proxyState, { force: true });
  return true;
}

export async function proxyStatus(managed: ManagedState): Promise<{
  state: ProxyState | null;
  owned: boolean;
  probe: ProxyProbe;
  portOwners: number[];
}> {
  const state = await readProxyState(managed.paths);
  return {
    state,
    owned: state ? await isOwnedProxy(managed.paths, state) : false,
    probe: await probeProxy({ baseUrl: PROXY_BASE_URL, apiKey: managed.apiKey }),
    portOwners: await portOwners(8317)
  };
}

export async function readProxyLog(paths: ManagedPaths, lines = 200): Promise<string> {
  try {
    return (await readFile(paths.proxyLog, "utf8")).split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}
