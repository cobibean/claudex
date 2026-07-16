import { UsageError } from "./errors.js";

export const MODEL = "gpt-5.6-sol";
export const PROXY_BASE_URL = "http://127.0.0.1:8317";

export interface ClaudeSettings {
  apiKeyHelper: string;
  model: string;
  availableModels: string[];
  env: Record<string, string>;
}

const FORBIDDEN_FLAGS = [
  "--model",
  "--fallback-model",
  "--settings",
  "--setting-sources",
  "--remote-control"
] as const;

const MANAGED_MUTATION_COMMANDS = new Set(["update", "upgrade", "install", "migrate-installer"]);

function managedMutationCommand(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const candidate = args[index] ?? "";
    if (candidate === "--") break;
    if (!MANAGED_MUTATION_COMMANDS.has(candidate)) continue;
    const previous = args[index - 1];
    if (previous === "-p" || previous === "--print") continue;
    return candidate;
  }
  return null;
}

export function buildClaudeSettings(apiKeyHelper: string): ClaudeSettings {
  return {
    apiKeyHelper,
    model: MODEL,
    availableModels: [MODEL],
    env: {
      ANTHROPIC_BASE_URL: PROXY_BASE_URL,
      ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_DEFAULT_FABLE_MODEL: MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
      ANTHROPIC_CUSTOM_MODEL_OPTION: MODEL,
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "GPT-5.6 Sol",
      ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "GPT-5.6 Sol via Codex OAuth",
      ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
        "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1"
    }
  };
}

export function validateForwardedArgs(args: readonly string[]): string[] {
  const mutationCommand = managedMutationCommand(args);
  if (mutationCommand) {
    throw new UsageError(`${mutationCommand} is managed by Claudex and cannot be forwarded to Claude Code.`);
  }
  for (const arg of args) {
    const forbidden = FORBIDDEN_FLAGS.find(
      (flag) => arg === flag || arg.startsWith(`${flag}=`)
    );
    if (forbidden) {
      throw new UsageError(`${forbidden} is not allowed through Claudex because it can escape GPT routing.`);
    }
  }
  return [...args];
}
