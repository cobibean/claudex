import { stat, readFile } from "node:fs/promises";
import { buildClaudeSettings, MODEL, PROXY_BASE_URL } from "./claude-settings.js";
import {
  CLAUDE_VERSION,
  conflictingEnvironment,
  hasCodexAuth,
  inspectClaudeBinary,
  selectedClaudeOverride
} from "./claude.js";
import { activeSessions, proxyStatus } from "./proxy.js";
import { PROXY_RUNTIME, verifyInstalledRuntime } from "./runtime.js";
import type { ManagedState } from "./state.js";
import { CLAUDEX_VERSION } from "./compatibility.js";
import { inspectLinkedPair, inspectManagedUpdateState, resolveUpdatePaths } from "./update.js";

async function mode(path: string): Promise<string | null> {
  try {
    return `0${((await stat(path)).mode & 0o777).toString(8)}`;
  } catch {
    return null;
  }
}

export async function collectDiagnostics(
  managed: ManagedState,
  options: { expectedClaudeVersion?: string } = {}
): Promise<Record<string, unknown>> {
  const expectedClaudeVersion = options.expectedClaudeVersion ?? CLAUDE_VERSION;
  let claude: Record<string, unknown>;
  try {
    const inspected = await inspectClaudeBinary({
      override: selectedClaudeOverride(process.env),
      expectedVersion: expectedClaudeVersion
    });
    claude = { ok: true, path: inspected.path, version: inspected.version };
  } catch (error) {
    claude = { ok: false, requiredVersion: expectedClaudeVersion, error: (error as Error).message };
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
  const updatePaths = resolveUpdatePaths(managed.paths.home);
  const managedUpdate = await inspectManagedUpdateState(updatePaths);
  const selectedSource = process.env.CLAUDEX_ACTIVE_PAIR_SOURCE;
  const selectedSequence = Number(process.env.CLAUDEX_ACTIVE_PAIR_SEQUENCE);
  const selectedPrevious =
    selectedSource === "previous" &&
    managedUpdate.previous?.sequence === selectedSequence
      ? { ...managedUpdate.previous, source: "previous" }
      : null;
  const selectedCurrent =
    selectedSource !== "packaged" && managedUpdate.current
      ? { ...managedUpdate.current, source: "current" }
      : null;
  const activePair =
    selectedPrevious ??
    selectedCurrent ?? {
      sequence: null,
      claudexVersion: CLAUDEX_VERSION,
      claudeVersion: CLAUDE_VERSION,
      source: "packaged"
    };
  const previousRuntimeIntegrity = managedUpdate.previous
    ? (await inspectLinkedPair(updatePaths, "previous"))
      ? "verified"
      : "invalid"
    : "missing";
  const activeRuntimeIntegrity =
    activePair.source === "previous"
      ? previousRuntimeIntegrity
      : activePair.source === "packaged"
        ? "packaged"
        : managedUpdate.managedRuntimeIntegrity;
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
    proxy.probe.modelAvailable &&
    activeRuntimeIntegrity !== "invalid" &&
    (!managedUpdate.incompleteTransaction || process.env.CLAUDEX_UPDATE_VERIFICATION === "1");

  return {
    ok,
    platform: { os: process.platform, arch: process.arch, node: process.versions.node },
    claude,
    proxyRuntime: {
      installed: runtimeInstalled,
      requiredVersion: PROXY_RUNTIME.version,
      requiredCommit: PROXY_RUNTIME.commit
    },
    managedPair: {
      active: activePair,
      previous: managedUpdate.previous,
      runtimeIntegrity: activeRuntimeIntegrity,
      currentRuntimeIntegrity: managedUpdate.managedRuntimeIntegrity,
      previousRuntimeIntegrity,
      bootstrapVersion: process.env.CLAUDEX_BOOTSTRAP_VERSION ?? CLAUDEX_VERSION,
      incompleteTransaction: managedUpdate.incompleteTransaction
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
    managedPair: {
      active: {
        sequence: number | null;
        claudexVersion: string;
        claudeVersion: string;
        source?: string;
      };
      previous: { sequence: number; claudexVersion: string; claudeVersion: string } | null;
      runtimeIntegrity: "verified" | "missing" | "invalid" | "packaged";
      currentRuntimeIntegrity: "verified" | "missing" | "invalid";
      previousRuntimeIntegrity: "verified" | "missing" | "invalid";
      bootstrapVersion: string;
      incompleteTransaction: boolean;
    };
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
    `✓ Active pair: Claudex ${value.managedPair.active.claudexVersion} + Claude Code ${value.managedPair.active.claudeVersion}${value.managedPair.active.sequence === null ? " (packaged fallback)" : ` (sequence ${value.managedPair.active.sequence}${value.managedPair.active.source === "previous" ? ", previous fallback" : ""})`}`,
    `${value.managedPair.previous ? "✓" : "-"} Previous pair: ${value.managedPair.previous ? `Claudex ${value.managedPair.previous.claudexVersion} + Claude Code ${value.managedPair.previous.claudeVersion} (sequence ${value.managedPair.previous.sequence})` : "none"}`,
    `${value.managedPair.runtimeIntegrity === "invalid" ? "✗" : value.managedPair.runtimeIntegrity === "verified" ? "✓" : "-"} Managed runtime integrity: ${value.managedPair.runtimeIntegrity}`,
    `${value.managedPair.currentRuntimeIntegrity === "invalid" ? "✗" : value.managedPair.currentRuntimeIntegrity === "verified" ? "✓" : "-"} Current pointer integrity: ${value.managedPair.currentRuntimeIntegrity}`,
    `${value.managedPair.previousRuntimeIntegrity === "invalid" ? "✗" : value.managedPair.previousRuntimeIntegrity === "verified" ? "✓" : "-"} Previous pointer integrity: ${value.managedPair.previousRuntimeIntegrity}`,
    `✓ Permanent bootstrap ${value.managedPair.bootstrapVersion}`,
    `${mark(!value.managedPair.incompleteTransaction)} Incomplete update transaction: ${value.managedPair.incompleteTransaction ? "present" : "none"}`,
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
