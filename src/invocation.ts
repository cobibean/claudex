import { CONFLICTING_ENV_KEYS } from "./claude.js";
import { validateForwardedArgs } from "./claude-settings.js";

export type Invocation =
  | { kind: "launch"; args: string[] }
  | { kind: "login"; device: boolean; noBrowser: boolean }
  | { kind: "logout"; yes: boolean }
  | { kind: "status"; json: boolean }
  | { kind: "doctor"; json: boolean }
  | { kind: "proxy"; action: "start" | "stop" | "restart" | "logs"; force: boolean }
  | { kind: "help" }
  | { kind: "version" };

function unknownFlags(args: readonly string[], allowed: readonly string[]): string[] {
  return args.filter((arg) => arg.startsWith("-") && !allowed.includes(arg));
}

export function parseInvocation(args: readonly string[]): Invocation {
  if (args[0] === "--") return { kind: "launch", args: validateForwardedArgs(args.slice(1)) };
  const [command, ...rest] = args;
  if (command === "--help" || command === "help") return { kind: "help" };
  if (command === "--version" || command === "version") return { kind: "version" };
  if (!command || command.startsWith("-")) {
    return { kind: "launch", args: validateForwardedArgs(args) };
  }
  if (command === "login") {
    const unknown = unknownFlags(rest, ["--device", "--no-browser"]);
    if (unknown.length > 0) throw new Error(`Unknown login option: ${unknown.join(", ")}`);
    return { kind: "login", device: rest.includes("--device"), noBrowser: rest.includes("--no-browser") };
  }
  if (command === "logout") {
    const unknown = unknownFlags(rest, ["--yes"]);
    if (unknown.length > 0) throw new Error(`Unknown logout option: ${unknown.join(", ")}`);
    return { kind: "logout", yes: rest.includes("--yes") };
  }
  if (command === "status" || command === "doctor") {
    const unknown = unknownFlags(rest, ["--json"]);
    if (unknown.length > 0) throw new Error(`Unknown ${command} option: ${unknown.join(", ")}`);
    return { kind: command, json: rest.includes("--json") };
  }
  if (command === "proxy") {
    const action = rest[0];
    if (!action || !["start", "stop", "restart", "logs"].includes(action)) {
      throw new Error("Usage: claudex proxy start|stop|restart|logs [--force]");
    }
    const trailing = rest.slice(1);
    const unknown = unknownFlags(trailing, ["--force"]);
    if (unknown.length > 0) throw new Error(`Unknown proxy option: ${unknown.join(", ")}`);
    return {
      kind: "proxy",
      action: action as "start" | "stop" | "restart" | "logs",
      force: trailing.includes("--force")
    };
  }
  return { kind: "launch", args: validateForwardedArgs(args) };
}

const NO_SETTINGS_SUBCOMMANDS = new Set([
  "agents",
  "config",
  "doctor",
  "install",
  "mcp",
  "plugin",
  "update"
]);

export interface ClaudeExecInput {
  claudePath: string;
  settingsPath: string;
  args: readonly string[];
  inheritedEnv: NodeJS.ProcessEnv;
  routingEnv: Record<string, string>;
  proxyApiKey?: string;
}

export interface ClaudeExecSpec {
  file: string;
  args: string[];
  env: Record<string, string>;
}

export function buildClaudeExec(input: ClaudeExecInput): ClaudeExecSpec {
  const forwarded = validateForwardedArgs(input.args);
  const useSettings = !NO_SETTINGS_SUBCOMMANDS.has(forwarded[0] ?? "");
  const env = Object.fromEntries(
    Object.entries(input.inheritedEnv).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    )
  );
  for (const key of CONFLICTING_ENV_KEYS) delete env[key];
  Object.assign(env, input.routingEnv);
  if (!useSettings) {
    if (!input.proxyApiKey) throw new Error("A local proxy key is required for this Claude subcommand.");
    env.ANTHROPIC_AUTH_TOKEN = input.proxyApiKey;
  }

  const args = [input.claudePath];
  if (useSettings) args.push("--settings", input.settingsPath);
  args.push(...forwarded);
  return { file: input.claudePath, args, env };
}
