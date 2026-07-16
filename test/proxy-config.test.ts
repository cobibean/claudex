import { describe, expect, it } from "vitest";
import { renderProxyConfig } from "../src/proxy-config.js";

describe("managed proxy configuration", () => {
  it("is loopback-only, authenticated, and disables diagnostic surfaces", () => {
    const yaml = renderProxyConfig({
      authDir: "/private/state/auth",
      apiKey: "local-secret",
      port: 8317
    });

    expect(yaml).toContain('host: "127.0.0.1"');
    expect(yaml).toContain("port: 8317");
    expect(yaml).toContain('auth-dir: "/private/state/auth"');
    expect(yaml).toContain('  - "local-secret"');
    expect(yaml).toContain("disable-control-panel: true");
    expect(yaml).toContain("request-log: false");
    expect(yaml).toContain("usage-statistics-enabled: false");
    expect(yaml).toContain("plugins:\n  enabled: false");
    expect(yaml).not.toContain("0.0.0.0");
  });
});
