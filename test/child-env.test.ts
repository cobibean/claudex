import { describe, expect, it } from "vitest";
import { buildProxyEnvironment } from "../src/child-env.js";

describe("CLIProxyAPI child environment", () => {
  it("preserves required system values while excluding unrelated credentials", () => {
    expect(
      buildProxyEnvironment({
        PATH: "/usr/bin:/bin",
        HOME: "/Users/example",
        LANG: "en_US.UTF-8",
        LC_CTYPE: "UTF-8",
        BROWSER: "open",
        HTTPS_PROXY: "http://127.0.0.1:9999",
        NO_PROXY: "127.0.0.1,localhost",
        SSL_CERT_FILE: "/private/cert.pem",
        OPENAI_API_KEY: "openai-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        GH_TOKEN: "github-secret",
        DATABASE_URL: "postgres://secret",
        CUSTOM_SECRET: "custom-secret"
      })
    ).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      BROWSER: "open",
      HTTPS_PROXY: "http://127.0.0.1:9999",
      NO_PROXY: "127.0.0.1,localhost",
      SSL_CERT_FILE: "/private/cert.pem"
    });
  });
});
