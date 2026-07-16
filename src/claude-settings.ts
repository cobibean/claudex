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
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1"
    }
  };
}

export function validateForwardedArgs(args: readonly string[]): string[] {
  for (const arg of args) {
    const forbidden = FORBIDDEN_FLAGS.find(
      (flag) => arg === flag || arg.startsWith(`${flag}=`)
    );
    if (forbidden) {
      throw new Error(`${forbidden} is not allowed through Claudex because it can escape GPT routing.`);
    }
  }
  return [...args];
}
