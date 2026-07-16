import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROXY_RUNTIME,
  verifyArchiveChecksum
} from "../src/runtime.js";

describe("pinned CLIProxyAPI runtime", () => {
  it("uses the reviewed macOS ARM64 release and checksum", () => {
    expect(PROXY_RUNTIME).toEqual({
      version: "7.2.80",
      commit: "09da52ad",
      asset: "CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
      url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
      sha256: "7b13a17670a7d24318e3d6a3f24ff38696cf23ab44894fc93fbd53fbb68dfda6"
    });
  });

  it("fails closed when an archive checksum differs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-runtime-"));
    const archive = join(directory, "runtime.tar.gz");
    await writeFile(archive, "not the reviewed runtime");

    await expect(verifyArchiveChecksum(archive, PROXY_RUNTIME.sha256)).rejects.toThrow(
      /checksum mismatch/
    );
  });
});
