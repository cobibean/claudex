import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, readFile, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ManagedPaths } from "./state.js";
import { CLAUDE_VERSION } from "./compatibility.js";

const execFile = promisify(execFileCallback);
export { CLAUDE_VERSION };

export interface ClaudeBinary {
  path: string;
  version: string;
  versionOutput: string;
}

export interface InspectClaudeOptions {
  override?: string | undefined;
  pathValue?: string | undefined;
  launcherPath?: string | undefined;
  expectedVersion?: string | undefined;
}

export function selectedClaudeOverride(env: NodeJS.ProcessEnv): string | undefined {
  return env.CLAUDEX_CLAUDE_BIN ?? env.CLAUDEX_MANAGED_CLAUDE_BIN;
}

async function findOnPath(name: string, pathValue: string): Promise<string | null> {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

export async function inspectClaudeBinary(options: InspectClaudeOptions = {}): Promise<ClaudeBinary> {
  const expectedVersion = options.expectedVersion ?? CLAUDE_VERSION;
  const requested = options.override
    ? isAbsolute(options.override)
      ? options.override
      : resolve(options.override)
    : await findOnPath("claude", options.pathValue ?? process.env.PATH ?? "");
  if (!requested) {
    throw new Error(`Official Claude Code was not found. Install Claude Code ${expectedVersion} first.`);
  }
  const path = await realpath(requested);
  if (options.launcherPath) {
    try {
      if (path === (await realpath(options.launcherPath))) {
        throw new Error("Claude executable resolution pointed back to Claudex.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let versionOutput: string;
  try {
    const result = await execFile(path, ["--version"], {
      timeout: 5_000,
      env: {
        ...process.env,
        DISABLE_UPDATES: "1",
        DISABLE_AUTOUPDATER: "1"
      }
    });
    versionOutput = `${result.stdout}${result.stderr}`.trim();
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
    throw new Error(`Unable to execute the official Claude Code version check${output ? `: ${output}` : "."}`);
  }
  if (!versionOutput.includes("Claude Code")) {
    throw new Error(`${path} is not the official Claude Code CLI.`);
  }
  const match = versionOutput.match(/\b(\d+\.\d+\.\d+)\b/);
  if (!match?.[1]) throw new Error(`Unable to parse Claude Code version from: ${versionOutput}`);
  if (match[1] !== expectedVersion) {
    throw new Error(`Claudex requires Claude Code ${expectedVersion}; found ${match[1]} at ${path}.`);
  }
  return { path, version: match[1], versionOutput };
}

export async function writeResolvedClaudeLink(paths: ManagedPaths, claudePath: string): Promise<void> {
  const temporary = `${paths.resolvedClaude}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await symlink(claudePath, temporary);
  await rename(temporary, paths.resolvedClaude);
}

export async function hasCodexAuth(paths: ManagedPaths): Promise<boolean> {
  for (const entry of await readdir(paths.authDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const auth = JSON.parse(await readFile(join(paths.authDir, entry.name), "utf8")) as {
        type?: string;
        provider?: string;
        metadata?: { type?: string };
      };
      if (auth.type === "codex" || auth.provider === "codex" || auth.metadata?.type === "codex") {
        return true;
      }
    } catch {
      // Ignore malformed non-auth files; doctor reports the directory separately.
    }
  }
  return false;
}

export const CONFLICTING_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE"
] as const;

export function conflictingEnvironment(env: NodeJS.ProcessEnv): string[] {
  return CONFLICTING_ENV_KEYS.filter((key) => Boolean(env[key]));
}

export async function enforceClaudeLinkPermissions(paths: ManagedPaths): Promise<void> {
  await chmod(paths.runDir, 0o700);
}
