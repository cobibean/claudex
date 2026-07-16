#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { stdout, stderr } from "node:process";
import { buildClaudeSettings } from "./claude-settings.js";
import {
  hasCodexAuth,
  inspectClaudeBinary,
  writeResolvedClaudeLink
} from "./claude.js";
import { login, logout } from "./auth.js";
import { collectDiagnostics, formatDiagnostics } from "./diagnostics.js";
import { buildClaudeExec, parseInvocation } from "./invocation.js";
import {
  activeSessions,
  readProxyLog,
  recordSession,
  startManagedProxy,
  stopManagedProxy
} from "./proxy.js";
import { redact } from "./redaction.js";
import { installProxyRuntime } from "./runtime.js";
import { ensureManagedState } from "./state.js";

const VERSION = "0.1.0";
const HELP = `Claudex — genuine Claude Code powered by GPT-5.6 Sol

Usage:
  claudex [CLAUDE_ARGS...]
  claudex -- [RESERVED_CLAUDE_SUBCOMMAND...]
  claudex login [--device|--no-browser]
  claudex logout [--yes]
  claudex status [--json]
  claudex doctor [--json]
  claudex proxy start|stop|restart|logs [--force]

Environment:
  CLAUDEX_HOME         State directory (default: ~/.claudex)
  CLAUDEX_CLAUDE_BIN   Explicit official Claude Code executable
`;

async function main(): Promise<void> {
  process.umask(0o077);
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.kind === "help") {
    stdout.write(HELP);
    return;
  }
  if (invocation.kind === "version") {
    stdout.write(`${VERSION}\n`);
    return;
  }

  const home = process.env.CLAUDEX_HOME ?? join(homedir(), ".claudex");
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
    const report = await collectDiagnostics(managed);
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
  const claude = await inspectClaudeBinary({ override: process.env.CLAUDEX_CLAUDE_BIN });
  await startManagedProxy(managed);
  await writeResolvedClaudeLink(managed.paths, claude.path);
  await recordSession(managed.paths, process.pid, claude.path);
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
  let secrets: string[] = [];
  try {
    const home = process.env.CLAUDEX_HOME ?? join(homedir(), ".claudex");
    secrets = [(await ensureManagedState(home)).apiKey];
  } catch {
    // Error reporting must still work before state can be created.
  }
  stderr.write(`${redact((error as Error).message || String(error), secrets)}\n`);
  process.exitCode = 1;
});
