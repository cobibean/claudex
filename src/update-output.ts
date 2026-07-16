import type { PairSummary, UpdateAction, UpdateResult } from "./update.js";

function pair(value: PairSummary | null): string {
  return value
    ? `sequence ${value.sequence}: Claudex ${value.claudexVersion} + Claude Code ${value.claudeVersion}`
    : "none";
}

export function formatUpdateResult(result: UpdateResult): string {
  return [
    result.message,
    `Current: ${pair(result.current)}`,
    `Target: ${pair(result.target)}`,
    `Previous: ${pair(result.previous)}`
  ].join("\n");
}

export function failedUpdateResult(
  action: UpdateAction,
  message: string,
  state: { current: PairSummary | null; previous: PairSummary | null } = {
    current: null,
    previous: null
  }
): UpdateResult {
  return {
    ok: false,
    action,
    status: "failed",
    current: state.current,
    target: null,
    previous: state.previous,
    code: "UPDATE_FAILED",
    message
  };
}

export function invalidUpdateUsageResult(action: UpdateAction, message: string): UpdateResult {
  return {
    ...failedUpdateResult(action, message),
    status: "invalid-usage",
    code: "INVALID_USAGE"
  };
}
