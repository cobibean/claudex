import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectClaudeBinary } from "../src/claude.js";

describe("official Claude Code resolution", () => {
  it("accepts only the pinned genuine Claude Code version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-claude-"));
    const binary = join(directory, "claude");
    await writeFile(binary, "#!/bin/sh\necho '2.1.211 (Claude Code)'\n", { mode: 0o700 });
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
  });

  it("rejects a binary that does not identify as Claude Code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-not-claude-"));
    const binary = join(directory, "claude");
    await writeFile(binary, "#!/bin/sh\necho '2.1.211 custom wrapper'\n", { mode: 0o700 });
    await chmod(binary, 0o700);

    await expect(inspectClaudeBinary({ override: binary })).rejects.toThrow(/not the official Claude Code CLI/);
  });
});
