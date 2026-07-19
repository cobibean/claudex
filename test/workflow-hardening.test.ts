import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

async function workflow(name: string): Promise<string> {
  return readFile(join(ROOT, ".github", "workflows", name), "utf8");
}

describe("GitHub workflow hardening", () => {
  it("pins every action reference to an immutable commit", async () => {
    for (const name of ["ci.yml", "release.yml", "upstream-watcher.yml"]) {
      const contents = await workflow(name);
      const references = [...contents.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)].map(
        (match) => match[1]
      );
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference, `${name}: ${reference}`).toMatch(
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/
        );
      }
    }
  });

  it("keeps release publication and production signing disabled", async () => {
    const contents = await workflow("release.yml");
    expect(contents).toContain("workflow_dispatch:");
    expect(contents).not.toMatch(/^\s*push:\s*$/m);
    expect(contents).not.toContain("CLAUDEX_RELEASE_PRIVATE_KEY_PEM");
    expect(contents).not.toMatch(/contents:\s*write/);
    expect(contents).not.toMatch(/gh\s+release\s+(create|upload|edit)/);
    expect(contents).not.toMatch(/git\s+(tag|push)/);
    expect(contents).toContain("Publication intentionally disabled");
  });

  it("keeps the scheduled watcher read-only and credential-free", async () => {
    const contents = await workflow("upstream-watcher.yml");
    expect(contents).toMatch(/permissions:\n\s+contents:\s+read/);
    expect(contents).not.toMatch(/contents:\s*write/);
    expect(contents).not.toMatch(/CLAUDEX_RELEASE_PRIVATE_KEY_PEM|\.claudex|gh\s+(release|pr|issue)/);
    expect(contents).toContain("Discovery only");
  });
});
