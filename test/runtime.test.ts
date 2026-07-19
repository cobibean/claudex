import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  inspectRuntimeVersionOutput,
  inspectProxyArchive,
  PROXY_RUNTIME,
  verifyArchiveChecksum
} from "../src/runtime.js";

const execFile = promisify(execFileCallback);

describe("pinned CLIProxyAPI runtime", () => {
  it("accepts an explicitly signed target identity without changing the compiled pin", () => {
    const target = {
      ...PROXY_RUNTIME,
      version: "7.2.88",
      commit: "93d74a89",
      tagCommit: "93d74a890a44802f656d7f39a573916b2611896e",
      asset: "CLIProxyAPI_7.2.88_darwin_aarch64.tar.gz",
      url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.88/CLIProxyAPI_7.2.88_darwin_aarch64.tar.gz",
      size: 14_150_569,
      sha256: "9".repeat(64),
      binarySha256: "8".repeat(64)
    };

    expect(
      inspectRuntimeVersionOutput(
        "CLIProxyAPI Version: 7.2.88, Commit: 93d74a89, BuiltAt: 2026-07-18T15:37:36Z",
        target
      )
    ).toBeUndefined();
    expect(() => inspectRuntimeVersionOutput("Version: 7.2.80, Commit: 09da52ad", target)).toThrow(
      /7\.2\.88\/93d74a89/
    );
  });

  it("uses the reviewed macOS ARM64 release and checksum", () => {
    expect(PROXY_RUNTIME).toEqual({
      version: "7.2.80",
      commit: "09da52ad",
      tagCommit: "09da52ad509e2c18e7b9540db3b98c2214c280aa",
      asset: "CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
      url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/CLIProxyAPI_7.2.80_darwin_aarch64.tar.gz",
      size: 14_101_646,
      sha256: "7b13a17670a7d24318e3d6a3f24ff38696cf23ab44894fc93fbd53fbb68dfda6",
      binarySha256: "53afff247f28bee8a5a51bb376f8e03092e1eb7b15a2663ce6cbe92618afec3a"
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

  it("accepts only one root regular proxy executable in an archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-runtime-layout-"));
    const contents = join(directory, "contents");
    const archive = join(directory, "runtime.tar.gz");
    await mkdir(contents);
    await writeFile(join(contents, "cli-proxy-api"), "binary");
    await writeFile(join(contents, "LICENSE"), "license");
    await execFile("/usr/bin/tar", [
      "-czf",
      archive,
      "-C",
      contents,
      "cli-proxy-api",
      "LICENSE"
    ]);

    await expect(inspectProxyArchive(archive)).resolves.toBe("cli-proxy-api");
  });

  it("rejects traversal, duplicate executable, and link archive members", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claudex-runtime-attacks-"));
    const script = [
      "import io,sys,tarfile",
      "kind,path=sys.argv[1:3]",
      "with tarfile.open(path,'w:gz') as t:",
      "  names=['cli-proxy-api']",
      "  if kind=='traversal': names.append('../escape')",
      "  if kind=='duplicate': names.append('cli-proxy-api')",
      "  for name in names:",
      "    info=tarfile.TarInfo(name); data=b'bin'; info.size=len(data); t.addfile(info,io.BytesIO(data))",
      "  if kind=='link':",
      "    info=tarfile.TarInfo('linked'); info.type=tarfile.SYMTYPE; info.linkname='cli-proxy-api'; t.addfile(info)"
    ].join("\n");

    for (const kind of ["traversal", "duplicate", "link"]) {
      const archive = join(directory, `${kind}.tar.gz`);
      await execFile("python3", ["-c", script, kind, archive]);
      await expect(inspectProxyArchive(archive)).rejects.toThrow(/unsafe|duplicate|regular files/i);
    }
  });
});
