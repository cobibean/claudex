import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasCodexAuth } from "./claude.js";
import { buildProxyEnvironment } from "./child-env.js";
import { stopManagedProxy } from "./proxy.js";
import { installProxyRuntime } from "./runtime.js";
import { enforceAuthPermissions, type ManagedState } from "./state.js";

async function askConfirmation(prompt: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await reader.question(`${prompt} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    reader.close();
  }
}

async function ensureOAuthDisclosure(managed: ManagedState): Promise<void> {
  const disclosure = join(managed.paths.home, "oauth-disclosure.json");
  try {
    const current = JSON.parse(await readFile(disclosure, "utf8")) as { accepted?: boolean };
    if (current.accepted) return;
  } catch {
    // First login or malformed disclosure record.
  }
  stdout.write(
    [
      "Claudex uses CLIProxyAPI, an unofficial third-party OAuth client.",
      "OpenAI documents ChatGPT OAuth for official Codex clients, not this proxy integration.",
      "Your separate Codex OAuth refresh token will be stored under ~/.claudex/auth.",
      "No OpenAI API-key fallback is used."
    ].join("\n") + "\n\n"
  );
  if (!(await askConfirmation("Continue with Codex OAuth?"))) {
    throw new Error("Codex OAuth was not authorized by the user.");
  }
  await writeFile(disclosure, `${JSON.stringify({ accepted: true, acceptedAt: new Date().toISOString() })}\n`, {
    mode: 0o600
  });
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`CLIProxyAPI login ended from signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

export async function login(
  managed: ManagedState,
  options: { device: boolean; noBrowser: boolean }
): Promise<void> {
  await ensureOAuthDisclosure(managed);
  const binary = await installProxyRuntime(managed.paths);
  const args = ["-config", managed.paths.proxyConfig, options.device ? "-codex-device-login" : "-codex-login"];
  if (options.noBrowser && !options.device) args.push("-no-browser");
  const child = spawn(binary, args, {
    cwd: managed.paths.proxyDir,
    stdio: "inherit",
    env: buildProxyEnvironment(process.env)
  });
  const exitCode = await waitForChild(child);
  await enforceAuthPermissions(managed.paths);
  if (exitCode !== 0) throw new Error(`CLIProxyAPI login failed with exit code ${exitCode}.`);
  if (!(await hasCodexAuth(managed.paths))) {
    throw new Error("Codex OAuth completed without creating a recognizable Claudex auth record.");
  }
}

function isCodexAuth(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const auth = value as { type?: unknown; provider?: unknown; metadata?: { type?: unknown } };
  return auth.type === "codex" || auth.provider === "codex" || auth.metadata?.type === "codex";
}

export async function logout(managed: ManagedState, yes: boolean): Promise<number> {
  if (!yes && !(await askConfirmation("Remove Claudex-owned Codex OAuth credentials?"))) {
    throw new Error("Logout cancelled.");
  }
  try {
    await stopManagedProxy(managed.paths, false);
  } catch (error) {
    if (!String(error).includes("missing")) throw error;
  }
  let removed = 0;
  for (const entry of await readdir(managed.paths.authDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(managed.paths.authDir, entry.name);
    try {
      if (isCodexAuth(JSON.parse(await readFile(path, "utf8")))) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch {
      // Never delete an unrecognized file.
    }
  }
  return removed;
}
