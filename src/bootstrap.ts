import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectLinkedPair,
  recoverInterruptedUpdate,
  resolveUpdatePaths,
  type InterruptedUpdateRecovery,
  type UpdatePaths
} from "./update.js";
import { CLAUDEX_VERSION } from "./compatibility.js";

export interface BootstrapRuntime {
  source: "current" | "previous" | "packaged";
  sequence: number | null;
  entrypoint: string;
  claudeBinary: string | null;
}

export interface BootstrapExec {
  file: string;
  args: string[];
  env: Record<string, string>;
}

export function shouldRecoverBeforeDelegation(args: readonly string[]): boolean {
  return args[0] !== "update";
}

export async function recoverForBootstrap(
  paths: UpdatePaths,
  recover: (paths: UpdatePaths) => Promise<InterruptedUpdateRecovery> = recoverInterruptedUpdate
): Promise<InterruptedUpdateRecovery | "unsafe"> {
  try {
    return await recover(paths);
  } catch {
    return "unsafe";
  }
}

async function linkedRuntime(
  home: string,
  name: "current" | "previous"
): Promise<BootstrapRuntime | null> {
  const pair = await inspectLinkedPair(resolveUpdatePaths(home), name);
  return pair
    ? {
        source: name,
        sequence: pair.sequence,
        entrypoint: pair.entrypoint,
        claudeBinary: pair.claudeBinary
      }
    : null;
}

export async function selectBootstrapRuntime(home: string, packagedEntrypoint: string): Promise<BootstrapRuntime> {
  const absoluteHome = resolve(home);
  return (
    (await linkedRuntime(absoluteHome, "current")) ??
    (await linkedRuntime(absoluteHome, "previous")) ?? {
      source: "packaged",
      sequence: null,
      entrypoint: packagedEntrypoint,
      claudeBinary: await packagedFallbackClaude(absoluteHome)
    }
  );
}

export function buildBootstrapExec(
  runtime: BootstrapRuntime,
  args: readonly string[],
  inheritedEnv: NodeJS.ProcessEnv,
  nodePath = process.execPath,
  bootstrapEntrypoint?: string,
  packagedEntrypoint?: string
): BootstrapExec {
  const env = Object.fromEntries(
    Object.entries(inheritedEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  env.CLAUDEX_BOOTSTRAPPED = "1";
  env.CLAUDEX_BOOTSTRAP_VERSION = CLAUDEX_VERSION;
  env.CLAUDEX_ACTIVE_PAIR_SOURCE = runtime.source;
  if (bootstrapEntrypoint) env.CLAUDEX_BOOTSTRAP_ENTRYPOINT = bootstrapEntrypoint;
  if (packagedEntrypoint) env.CLAUDEX_PACKAGED_ENTRYPOINT = packagedEntrypoint;
  if (runtime.sequence === null) delete env.CLAUDEX_ACTIVE_PAIR_SEQUENCE;
  else env.CLAUDEX_ACTIVE_PAIR_SEQUENCE = String(runtime.sequence);
  env.DISABLE_UPDATES = "1";
  env.DISABLE_AUTOUPDATER = "1";
  env.NODE_NO_WARNINGS = "1";
  if (runtime.claudeBinary) env.CLAUDEX_MANAGED_CLAUDE_BIN = runtime.claudeBinary;
  else delete env.CLAUDEX_MANAGED_CLAUDE_BIN;
  return {
    file: nodePath,
    args: [nodePath, runtime.entrypoint, ...args],
    env
  };
}

async function packagedFallbackClaude(home: string): Promise<string | null> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(home, "releases", "packaged-fallback.json"), "utf8")
    );
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "claude,claudeVersion,claudexVersion,createdAt,schemaVersion" ||
      record.schemaVersion !== 1 ||
      record.claudexVersion !== CLAUDEX_VERSION ||
      typeof record.claudeVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(record.claudeVersion) ||
      typeof record.createdAt !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      record.claude === null ||
      typeof record.claude !== "object" ||
      Array.isArray(record.claude)
    ) {
      return null;
    }
    const claude = record.claude as Record<string, unknown>;
    if (
      Object.keys(claude).sort().join(",") !== "sha256,size" ||
      !Number.isSafeInteger(claude.size) ||
      (claude.size as number) < 1 ||
      typeof claude.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(claude.sha256)
    ) {
      return null;
    }
    const binary = join(home, "runtime", "claude", record.claudeVersion, "claude");
    const details = await lstat(binary);
    if (!details.isFile() || details.size !== claude.size) return null;
    await access(binary, constants.X_OK);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(binary)) hash.update(chunk as Buffer);
    return hash.digest("hex") === claude.sha256 ? binary : null;
  } catch {
    return null;
  }
}

export async function ownsUpdateVerificationLock(
  paths: UpdatePaths,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  if (env.CLAUDEX_UPDATE_VERIFICATION !== "1") return false;
  const owner = Number(env.CLAUDEX_UPDATE_OWNER_PID);
  if (!Number.isSafeInteger(owner) || owner <= 1) return false;
  try {
    const lock = JSON.parse(await readFile(paths.lockFile, "utf8")) as { pid?: unknown };
    return lock.pid === owner;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const bootstrapPath = fileURLToPath(import.meta.url);
  const packagedEntrypoint = join(dirname(bootstrapPath), "cli.js");
  const home = process.env.CLAUDEX_HOME ?? join(homedir(), ".claudex");
  const forwardedArgs = process.argv.slice(2);
  const updatePaths = resolveUpdatePaths(home);
  const ownedVerification = await ownsUpdateVerificationLock(updatePaths, process.env);
  if (shouldRecoverBeforeDelegation(forwardedArgs) && !ownedVerification) {
    const recovery = await recoverForBootstrap(updatePaths);
    if (recovery === "busy") throw new Error("A Claudex update is already in progress.");
    if (recovery === "recovered") {
      process.stderr.write("Recovered an interrupted Claudex update before launch.\n");
    } else if (recovery === "unsafe") {
      process.stderr.write(
        "Warning: update recovery metadata is malformed; leaving it untouched and launching an integrity-valid runtime.\n"
      );
    }
  }
  const runtime = await selectBootstrapRuntime(home, packagedEntrypoint);
  if (runtime.source === "previous") {
    process.stderr.write("Warning: current Claudex runtime is invalid; using the previous verified pair.\n");
  }
  const spec = buildBootstrapExec(
    runtime,
    forwardedArgs,
    process.env,
    process.execPath,
    bootstrapPath,
    packagedEntrypoint
  );
  if (!process.execve) throw new Error("Node.js 22.15 or newer is required for exact process replacement.");
  process.execve(spec.file, spec.args, spec.env);
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${(error as Error).message || String(error)}\n`);
    process.exitCode = 1;
  });
}
