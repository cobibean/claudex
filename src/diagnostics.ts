import { stat, readFile } from "node:fs/promises";
import { buildClaudeSettings, MODEL, PROXY_BASE_URL } from "./claude-settings.js";
import {
  CLAUDE_VERSION,
  conflictingEnvironment,
  hasCodexAuth,
  inspectClaudeBinary
} from "./claude.js";
import { activeSessions, proxyStatus } from "./proxy.js";
import { PROXY_RUNTIME, verifyInstalledRuntime } from "./runtime.js";
import type { ManagedState } from "./state.js";

async function mode(path: string): Promise<string | null> {
  try {
    return `0${((await stat(path)).mode & 0o777).toString(8)}`;
  } catch {
    return null;
  }
}

export async function collectDiagnostics(managed: ManagedState): Promise<Record<string, unknown>> {
  let claude: Record<string, unknown>;
  try {
    const inspected = await inspectClaudeBinary({ override: process.env.CLAUDEX_CLAUDE_BIN });
    claude = { ok: true, path: inspected.path, version: inspected.version };
  } catch (error) {
    claude = { ok: false, requiredVersion: CLAUDE_VERSION, error: (error as Error).message };
  }

  let settingsOk = false;
  try {
    const actual = JSON.parse(await readFile(managed.paths.settings, "utf8"));
    const expected = buildClaudeSettings(managed.paths.apiKeyHelper);
    settingsOk =
      actual.model === expected.model &&
      actual.apiKeyHelper === expected.apiKeyHelper &&
      actual.env?.ANTHROPIC_BASE_URL === PROXY_BASE_URL;
  } catch {
    settingsOk = false;
  }

  const proxy = await proxyStatus(managed);
  const sessions = await activeSessions(managed.paths);
  const authPresent = await hasCodexAuth(managed.paths);
  const runtimeInstalled = await verifyInstalledRuntime(managed.paths);
  const permissions = {
    home: await mode(managed.paths.home),
    auth: await mode(managed.paths.authDir),
    proxyConfig: await mode(managed.paths.proxyConfig),
    proxyKey: await mode(managed.paths.proxyKey),
    settings: await mode(managed.paths.settings),
    apiKeyHelper: await mode(managed.paths.apiKeyHelper)
  };
  const permissionsOk =
    permissions.home === "0700" &&
    permissions.auth === "0700" &&
    permissions.proxyConfig === "0600" &&
    permissions.proxyKey === "0600" &&
    permissions.settings === "0600" &&
    permissions.apiKeyHelper === "0700";

  const ok =
    claude.ok === true &&
    runtimeInstalled &&
    authPresent &&
    settingsOk &&
    permissionsOk &&
    proxy.owned &&
    proxy.probe.authenticated &&
    proxy.probe.modelAvailable;

  return {
    ok,
    platform: { os: process.platform, arch: process.arch, node: process.versions.node },
    claude,
    proxyRuntime: {
      installed: runtimeInstalled,
      requiredVersion: PROXY_RUNTIME.version,
      requiredCommit: PROXY_RUNTIME.commit
    },
    proxy: {
      owned: proxy.owned,
      pid: proxy.state?.pid ?? null,
      baseUrl: PROXY_BASE_URL,
      live: proxy.probe.live,
      authenticated: proxy.probe.authenticated,
      modelAvailable: proxy.probe.modelAvailable,
      portOwners: proxy.portOwners
    },
    oauth: { present: authPresent, store: managed.paths.authDir },
    model: MODEL,
    settings: { valid: settingsOk, path: managed.paths.settings },
    permissions: { ok: permissionsOk, modes: permissions },
    environment: { conflicts: conflictingEnvironment(process.env) },
    sessions: { active: sessions.map((session) => ({ pid: session.pid, startedAt: session.startedAt })) }
  };
}

export function formatDiagnostics(report: Record<string, unknown>): string {
  const value = report as {
    ok: boolean;
    claude: { ok: boolean; path?: string; version?: string; error?: string };
    proxyRuntime: { installed: boolean; requiredVersion: string };
    proxy: { owned: boolean; pid: number | null; live: boolean; authenticated: boolean; modelAvailable: boolean };
    oauth: { present: boolean };
    settings: { valid: boolean };
    permissions: { ok: boolean };
    environment: { conflicts: string[] };
    sessions: { active: unknown[] };
  };
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  return [
    `Claudex ${value.ok ? "ready" : "not ready"}`,
    `${mark(value.claude.ok)} Claude Code ${value.claude.version ?? value.claude.error ?? "missing"}`,
    `${mark(value.proxyRuntime.installed)} CLIProxyAPI ${value.proxyRuntime.requiredVersion}`,
    `${mark(value.oauth.present)} Separate Codex OAuth`,
    `${mark(value.proxy.owned && value.proxy.live)} Managed proxy${value.proxy.pid ? ` (PID ${value.proxy.pid})` : ""}`,
    `${mark(value.proxy.authenticated)} Local proxy authentication`,
    `${mark(value.proxy.modelAvailable)} GPT-5.6 Sol available`,
    `${mark(value.settings.valid)} Claude routing overlay`,
    `${mark(value.permissions.ok)} Private filesystem permissions`,
    `${value.environment.conflicts.length === 0 ? "✓" : "!"} Conflicting environment: ${value.environment.conflicts.join(", ") || "none"}`,
    `Active Claudex sessions: ${value.sessions.active.length}`
  ].join("\n");
}
