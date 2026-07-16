import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeSessions, claimSessionStart, probeProxy } from "../src/proxy.js";
import { resolvePaths } from "../src/state.js";

describe("managed proxy readiness", () => {
  it("requires authenticated model readiness, not just liveness", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization") });
      if (url.endsWith("/healthz")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }), { status: 200 });
    };

    const result = await probeProxy({
      baseUrl: "http://127.0.0.1:8317",
      apiKey: "secret",
      fetchImpl
    });

    expect(result).toEqual({ live: true, authenticated: true, modelAvailable: true });
    expect(requests).toEqual([
      { url: "http://127.0.0.1:8317/healthz", authorization: null },
      { url: "http://127.0.0.1:8317/v1/models", authorization: "Bearer secret" }
    ]);
  });

  it("reports a live proxy without claiming readiness when authentication fails", async () => {
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith("/healthz")
        ? new Response("{}", { status: 200 })
        : new Response("unauthorized", { status: 401 });

    await expect(
      probeProxy({ baseUrl: "http://127.0.0.1:8317", apiKey: "wrong", fetchImpl })
    ).resolves.toEqual({ live: true, authenticated: false, modelAvailable: false });
  });

  it("interlocks session startup with an update and exposes an exec-in-progress session", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudex-session-interlock-"));
    const paths = resolvePaths(home);
    await mkdir(paths.sessionsDir, { recursive: true });
    await writeFile(paths.updateLock, JSON.stringify({ pid: 999_999 }));

    await expect(claimSessionStart(paths, process.pid, "/private/claude")).rejects.toThrow(
      /update is in progress/
    );
    await rm(paths.updateLock);
    await claimSessionStart(paths, process.pid, "/private/claude");
    await expect(activeSessions(paths)).resolves.toMatchObject([
      { pid: process.pid, claudePath: "/private/claude", state: "starting" }
    ]);
  });
});
