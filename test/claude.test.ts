import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectClaudeBinary, selectedClaudeOverride } from "../src/claude.js";

describe("official Claude Code resolution", () => {
  it("prefers an explicit developer binary over the bootstrap-managed pair", () => {
    expect(
      selectedClaudeOverride({
        CLAUDEX_CLAUDE_BIN: "/developer/claude",
        CLAUDEX_MANAGED_CLAUDE_BIN: "/managed/claude"
      })
    ).toBe("/developer/claude");
    expect(selectedClaudeOverride({ CLAUDEX_MANAGED_CLAUDE_BIN: "/managed/claude" })).toBe("/managed/claude");
  });

  it("accepts only the pinned genuine Claude Code version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-claude-"));
    const binary = join(directory, "claude");
    await writeFile(
      binary,
      "#!/bin/sh\n" +
        "test \"$DISABLE_UPDATES\" = 1 || exit 41\n" +
        "test \"$DISABLE_AUTOUPDATER\" = 1 || exit 42\n" +
        "echo '2.1.211 (Claude Code)'\n",
      { mode: 0o700 }
    );
    await chmod(binary, 0o700);

    await expect(inspectClaudeBinary({ override: binary })).resolves.toMatchObject({
      path: await realpath(binary),
      version: "2.1.211"
    });
  });

  it("fails closed on an untested Claude Code version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-claude-old-"));
    const binary = join(directory, "claude");
    await writeFile(binary, "#!/bin/sh\necho '2.1.158 (Claude Code)'\n", { mode: 0o700 });
    await chmod(binary, 0o700);

    await expect(inspectClaudeBinary({ override: binary })).rejects.toThrow(
      /requires Claude Code 2\.1\.211/
    );

    await expect(
      inspectClaudeBinary({ override: binary, expectedVersion: "2.1.158" })
    ).resolves.toMatchObject({ version: "2.1.158" });
  });

  it("rejects a binary that does not identify as Claude Code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-not-claude-"));
    const binary = join(directory, "claude");
    await writeFile(binary, "#!/bin/sh\necho '2.1.211 custom wrapper'\n", { mode: 0o700 });
    await chmod(binary, 0o700);

    await expect(inspectClaudeBinary({ override: binary })).rejects.toThrow(/not the official Claude Code CLI/);
  });
});
