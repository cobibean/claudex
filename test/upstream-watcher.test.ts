import { describe, expect, it } from "vitest";
import {
  buildUpdateReport,
  collectUpdateReport,
  parseChecksums,
  parseVersionMarker,
  validateProxyRelease
} from "../scripts/check-upstreams.mjs";

const PINNED = {
  claudex: { version: "0.2.1", sequence: 2 },
  claude: {
    version: "2.1.211",
    sha256: "5a728a76198b6eca7f3c7cdbff43bab44b77b48c2108f7a3107d889773382629",
    size: 242_445_680
  },
  proxy: {
    version: "7.2.80",
    commit: "09da52ad",
    tagCommit: "09da52ad509e2c18e7b9540db3b98c2214c280aa",
    asset: "CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
    size: 14_101_646,
    sha256: "7b13a17670a7d24318e3d6a3f24ff38696cf23ab44894fc93fbd53fbb68dfda6"
  },
  model: "gpt-5.6-sol"
};

const PROXY_RELEASE = {
  tag_name: "v7.2.88",
  draft: false,
  prerelease: false,
  published_at: "2026-07-18T12:00:00Z",
  assets: [
    {
      name: "CLIProxyAPI_7.2.88_darwin_aarch64.tar.gz",
      size: 12_345,
      digest: `sha256:${"a".repeat(64)}`,
      url: "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/assets/123"
    },
    {
      name: "checksums.txt",
      size: 999,
      digest: `sha256:${"b".repeat(64)}`,
      url: "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/assets/124"
    }
  ]
};

describe("read-only upstream watcher", () => {
  it("accepts only one exact semantic-version marker", () => {
    expect(parseVersionMarker("2.1.215\n", "latest")).toBe("2.1.215");
    expect(() => parseVersionMarker("v2.1.215", "latest")).toThrow(/semantic version/);
    expect(() => parseVersionMarker("2.1.215\n2.1.216", "latest")).toThrow(/semantic version/);
  });

  it("requires one exact checksum entry for the selected proxy archive", () => {
    const name = "CLIProxyAPI_7.2.88_darwin_aarch64.tar.gz";
    expect(parseChecksums(`${"a".repeat(64)}  ${name}\n`, name)).toBe("a".repeat(64));
    expect(() => parseChecksums(`${"a".repeat(64)}  other.tar.gz\n`, name)).toThrow(/exactly one/);
    expect(() => parseChecksums(`${"a".repeat(64)}  ../${name}\n`, name)).toThrow(/exactly one/);
  });

  it("locks the stable proxy release and macOS ARM64 metadata", () => {
    expect(
      validateProxyRelease(PROXY_RELEASE, "93d74a890a44802f656d7f39a573916b2611896e")
    ).toEqual({
      version: "7.2.88",
      tag: "v7.2.88",
      commit: "93d74a890a44802f656d7f39a573916b2611896e",
      publishedAt: "2026-07-18T12:00:00Z",
      asset: {
        name: "CLIProxyAPI_7.2.88_darwin_aarch64.tar.gz",
        size: 12_345,
        sha256: "a".repeat(64),
        apiUrl: "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/assets/123"
      },
      checksums: {
        name: "checksums.txt",
        size: 999,
        sha256: "b".repeat(64),
        apiUrl: "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/assets/124"
      }
    });
    expect(() => validateProxyRelease({ ...PROXY_RELEASE, prerelease: true }, "9".repeat(40))).toThrow(
      /stable/
    );
    expect(() =>
      validateProxyRelease(
        { ...PROXY_RELEASE, assets: PROXY_RELEASE.assets.filter((asset) => asset.name !== "checksums.txt") },
        "9".repeat(40)
      )
    ).toThrow(/checksums/);
  });

  it("produces a deterministic fingerprint that excludes observation time", () => {
    const input = {
      pinned: PINNED,
      claude: {
        stable: { version: "2.1.205", commit: "1".repeat(40), size: 10, sha256: "2".repeat(64) },
        latest: { version: "2.1.215", commit: "3".repeat(40), size: 11, sha256: "4".repeat(64) }
      },
      proxy: validateProxyRelease(PROXY_RELEASE, "9".repeat(40))
    };
    const first = buildUpdateReport({ ...input, checkedAt: "2026-07-18T12:00:00.000Z" });
    const second = buildUpdateReport({ ...input, checkedAt: "2026-07-19T12:00:00.000Z" });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.changes.map((change: { component: string; channel?: string }) => [change.component, change.channel]))
      .toEqual([
        ["claude", "stable"],
        ["claude", "latest"],
        ["proxy", undefined]
      ]);
    expect(first.recommendation).toBe("review-claude-and-proxy-protocol-migration");
  });

  it("reports same-version identity drift", () => {
    const currentClaude = {
      version: PINNED.claude.version,
      commit: "1".repeat(40),
      size: PINNED.claude.size,
      sha256: PINNED.claude.sha256
    };
    const proxy = {
      version: PINNED.proxy.version,
      tag: `v${PINNED.proxy.version}`,
      commit: PINNED.proxy.tagCommit,
      publishedAt: "2026-07-18T12:00:00Z",
      asset: {
        name: PINNED.proxy.asset,
        size: PINNED.proxy.size,
        sha256: PINNED.proxy.sha256,
        apiUrl: "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/assets/123"
      },
      checksums: {
        name: "checksums.txt",
        size: 999,
        sha256: "b".repeat(64),
        apiUrl: "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/assets/124"
      }
    };
    const report = buildUpdateReport({
      checkedAt: "2026-07-18T12:00:00.000Z",
      pinned: PINNED,
      claude: {
        stable: { ...currentClaude, sha256: "f".repeat(64) },
        latest: currentClaude
      },
      proxy: { ...proxy, commit: "e".repeat(40) }
    });
    expect(report.changes.map((entry: { component: string; status: string }) => [entry.component, entry.status]))
      .toEqual([
        ["claude", "identity-drift"],
        ["proxy", "identity-drift"]
      ]);
  });

  it("fetches only allowlisted read-only metadata endpoints", async () => {
    const requested: Array<{ url: string; method: string }> = [];
    const responses = new Map<string, unknown>([
      ["https://downloads.claude.ai/claude-code-releases/stable", "2.1.205\n"],
      ["https://downloads.claude.ai/claude-code-releases/latest", "2.1.215\n"],
      [
        "https://downloads.claude.ai/claude-code-releases/2.1.205/manifest.json",
        {
          version: "2.1.205",
          commit: "1".repeat(40),
          platforms: { "darwin-arm64": { binary: "claude", size: 10, checksum: "2".repeat(64) } }
        }
      ],
      [
        "https://downloads.claude.ai/claude-code-releases/2.1.215/manifest.json",
        {
          version: "2.1.215",
          commit: "3".repeat(40),
          platforms: { "darwin-arm64": { binary: "claude", size: 11, checksum: "4".repeat(64) } }
        }
      ],
      ["https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest", PROXY_RELEASE],
      [
        "https://api.github.com/repos/router-for-me/CLIProxyAPI/git/ref/tags/v7.2.88",
        { object: { type: "commit", sha: "9".repeat(40) } }
      ],
      [
        "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/assets/124",
        `${"a".repeat(64)}  CLIProxyAPI_7.2.88_darwin_aarch64.tar.gz\n`
      ]
    ]);
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push({ url, method: init?.method ?? "GET" });
      const value = responses.get(url);
      if (value === undefined) return new Response("missing", { status: 404 });
      return typeof value === "string"
        ? new Response(value, { status: 200, headers: { "content-type": "text/plain" } })
        : Response.json(value);
    };

    const report = await collectUpdateReport({
      fetchImpl: fetchImpl as typeof fetch,
      pinned: PINNED,
      now: () => new Date("2026-07-18T12:00:00.000Z")
    });

    expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(requested).toHaveLength(7);
    expect(requested.every(({ method }) => method === "GET")).toBe(true);
    expect(requested.every(({ url }) =>
      url.startsWith("https://downloads.claude.ai/claude-code-releases/") ||
      url.startsWith("https://api.github.com/repos/router-for-me/CLIProxyAPI/")
    )).toBe(true);
  });
});
