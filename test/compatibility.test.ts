import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_VERSION,
  CLAUDEX_VERSION,
  RELEASE_REPOSITORY,
  RELEASE_SEQUENCE,
  REVOKED_SEQUENCES
} from "../src/compatibility.js";

describe("certified Claudex pair", () => {
  it("keeps runtime and package versions on one certified release", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(CLAUDEX_VERSION).toBe("0.2.1");
    expect(pkg.version).toBe(CLAUDEX_VERSION);
    expect(CLAUDE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(RELEASE_REPOSITORY).toBe("cobibean/claudex");
    expect(RELEASE_SEQUENCE).toBe(2);
    expect(REVOKED_SEQUENCES).toEqual([]);
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain('claudex-${package_version}.tgz');
    expect(readme).toContain(`Claude Code ${CLAUDE_VERSION}`);
    expect(readme).not.toMatch(/private GitHub release|authenticated GitHub CLI/i);
  });
});
