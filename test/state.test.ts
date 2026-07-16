import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureManagedState, resolvePaths } from "../src/state.js";

describe("Claudex state", () => {
  it("creates private state, a stable key, hardened proxy config, and Claude overlay", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-state-"));
    const first = await ensureManagedState(home);
    const second = await ensureManagedState(home);
    const paths = resolvePaths(home);

    expect(first.apiKey).toBe(second.apiKey);
    expect(first.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.proxyConfig)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.settings)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.apiKeyHelper)).mode & 0o777).toBe(0o700);

    const helper = await readFile(paths.apiKeyHelper, "utf8");
    expect(helper).toContain(paths.proxyKey);
    expect(await readFile(paths.proxyKey, "utf8")).toBe(`${first.apiKey}\n`);

    const settings = JSON.parse(await readFile(paths.settings, "utf8"));
    expect(settings.model).toBe("gpt-5.6-sol");
    expect(settings.apiKeyHelper).toBe(paths.apiKeyHelper);

    const proxyConfig = await readFile(paths.proxyConfig, "utf8");
    expect(proxyConfig).toContain(`auth-dir: ${JSON.stringify(paths.authDir)}`);
  });
});
