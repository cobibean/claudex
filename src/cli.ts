#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { stdout, stderr } from "node:process";
import { buildClaudeSettings } from "./claude-settings.js";
import {
  hasCodexAuth,
  inspectClaudeBinary,
  selectedClaudeOverride,
  writeResolvedClaudeLink
} from "./claude.js";
import { login, logout } from "./auth.js";
import { collectDiagnostics, formatDiagnostics } from "./diagnostics.js";
import { UsageError } from "./errors.js";
import { buildClaudeExec, parseInvocation } from "./invocation.js";
import {
  activeSessions,
  claimSessionStart,
  readProxyLog,
  startManagedProxy,
  stopManagedProxy
} from "./proxy.js";
import { redact } from "./redaction.js";
import { installProxyRuntime } from "./runtime.js";
import { ensureManagedState } from "./state.js";
import { CLAUDEX_VERSION } from "./compatibility.js";
import {
  inspectManagedUpdateState,
  manageUpdate,
  resolveUpdatePaths,
  type UpdateAction
} from "./update.js";
import {
  failedUpdateResult,
  formatUpdateResult,
  invalidUpdateUsageResult
} from "./update-output.js";

const HELP = `Claudex — genuine Claude Code powered by GPT-5.6 Sol

Usage:
  claudex [CLAUDE_ARGS...]
  claudex -- [RESERVED_CLAUDE_SUBCOMMAND...]
  claudex login [--device|--no-browser]
  claudex logout [--yes]
  claudex status [--json]
  claudex doctor [--json]
  claudex update [--check|--rollback] [--json]
  claudex proxy start|stop|restart|logs [--force]

Environment:
  CLAUDEX_HOME         State directory (default: ~/.claudex)
  CLAUDEX_CLAUDE_BIN   Explicit official Claude Code executable
`;

async function existingSecrets(home: string): Promise<string[]> {
  try {
    const value = (await readFile(join(home, "proxy", "api-key"), "utf8")).trim();
    return value ? [value] : [];
  } catch {
    return [];
  }
}

function updateProgress(action: UpdateAction): string {
  if (action === "check") return "Checking the latest certified Claudex pair...";
  if (action === "rollback") return "Restoring the previous verified Claudex pair...";
  return "Verifying and installing the latest certified Claudex pair...";
}

async function main(): Promise<void> {
  process.umask(0o077);
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.kind === "help") {
    stdout.write(HELP);
    return;
  }
  if (invocation.kind === "version") {
    stdout.write(`${CLAUDEX_VERSION}\n`);
    return;
  }

  const home = process.env.CLAUDEX_HOME ?? join(homedir(), ".claudex");
  if (invocation.kind === "update") {
    stderr.write(`${updateProgress(invocation.action)}\n`);
    const paths = resolveUpdatePaths(home);
    try {
      const result = await manageUpdate(invocation.action, paths);
      stdout.write(
        invocation.json
          ? `${JSON.stringify(result)}\n`
          : `${formatUpdateResult(result)}\n`
      );
    } catch (error) {
      const secrets = await existingSecrets(home);
      let state = { current: null, previous: null } as {
        current: Awaited<ReturnType<typeof inspectManagedUpdateState>>["current"];
        previous: Awaited<ReturnType<typeof inspectManagedUpdateState>>["previous"];
      };
      try {
        const inspected = await inspectManagedUpdateState(paths);
        state = { current: inspected.current, previous: inspected.previous };
      } catch {
        // A damaged local state must not prevent a stable update failure response.
      }
      const message = redact((error as Error).message || String(error), secrets);
      const result = failedUpdateResult(invocation.action, message, state);
      if (invocation.json) stdout.write(`${JSON.stringify(result)}\n`);
      else stderr.write(`${formatUpdateResult(result)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const managed = await ensureManagedState(home);

  if (invocation.kind === "login") {
    await login(managed, invocation);
    const state = await startManagedProxy(managed);
    stdout.write(`Codex OAuth ready. Managed proxy PID ${state.pid}.\n`);
    return;
  }
  if (invocation.kind === "logout") {
    const removed = await logout(managed, invocation.yes);
    stdout.write(`Removed ${removed} Claudex Codex credential file(s).\n`);
    return;
  }
  if (invocation.kind === "status" || invocation.kind === "doctor") {
    const certificationVersion = process.env.CLAUDEX_CERTIFICATION_EXPECTED_CLAUDE_VERSION;
    const expectedClaudeVersion =
      invocation.kind === "doctor" &&
      process.env.CLAUDEX_CERTIFICATION === "1" &&
      certificationVersion &&
      /^\d+\.\d+\.\d+$/.test(certificationVersion)
        ? certificationVersion
        : undefined;
    const report = await collectDiagnostics(
      managed,
      expectedClaudeVersion ? { expectedClaudeVersion } : {}
    );
    const output = invocation.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDiagnostics(report)}\n`;
    stdout.write(redact(output, [managed.apiKey]));
    if (invocation.kind === "doctor" && report.ok !== true) process.exitCode = 1;
    return;
  }
  if (invocation.kind === "proxy") {
    if (invocation.action === "logs") {
      stdout.write(redact(`${await readProxyLog(managed.paths)}\n`, [managed.apiKey]));
      return;
    }
    if (invocation.action === "stop" || invocation.action === "restart") {
      const stopped = await stopManagedProxy(managed.paths, invocation.force);
      if (invocation.action === "stop") {
        stdout.write(stopped ? "Managed proxy stopped.\n" : "Managed proxy was not running.\n");
        return;
      }
    }
    if (!(await hasCodexAuth(managed.paths))) throw new Error('No Claudex Codex OAuth. Run "claudex login".');
    await installProxyRuntime(managed.paths);
    const state = await startManagedProxy(managed);
    stdout.write(`Managed proxy ready on http://127.0.0.1:8317 (PID ${state.pid}).\n`);
    return;
  }

  if (!(await hasCodexAuth(managed.paths))) throw new Error('No Claudex Codex OAuth. Run "claudex login".');
  const claude = await inspectClaudeBinary({ override: selectedClaudeOverride(process.env) });
  await startManagedProxy(managed);
  await writeResolvedClaudeLink(managed.paths, claude.path);
  await claimSessionStart(managed.paths, process.pid, claude.path);
  const settings = buildClaudeSettings(managed.paths.apiKeyHelper);
  const spec = buildClaudeExec({
    claudePath: claude.path,
    settingsPath: managed.paths.settings,
    args: invocation.args,
    inheritedEnv: process.env,
    routingEnv: settings.env,
    proxyApiKey: managed.apiKey
  });
  const execve = process.execve;
  if (!execve) throw new Error("Node.js 22.15 or newer is required for exact Claude process replacement.");
  execve(spec.file, spec.args, spec.env);
}

main().catch(async (error) => {
  const home = process.env.CLAUDEX_HOME ?? join(homedir(), ".claudex");
  const secrets = await existingSecrets(home);
  const message = redact((error as Error).message || String(error), secrets);
  const args = process.argv.slice(2);
  if (error instanceof UsageError && args[0] === "update" && args.includes("--json")) {
    const action: UpdateAction = args.includes("--rollback")
      ? "rollback"
      : args.includes("--check")
        ? "check"
        : "apply";
    stdout.write(`${JSON.stringify(invalidUpdateUsageResult(action, message))}\n`);
  } else {
    stderr.write(`${message}\n`);
  }
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
