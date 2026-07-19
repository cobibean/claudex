#!/usr/bin/env node

import { spawn as spawnCallback, execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readProxyCertificationSourceState } from "./verify-proxy-certification.mjs";

const execFile = promisify(execFileCallback);
const PROXY_API = "https://api.github.com/repos/router-for-me/CLIProxyAPI";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is malformed.`);
  return value;
}

function validRuntime(runtime) {
  return runtime && /^\d+\.\d+\.\d+$/.test(runtime.version) && /^[0-9a-f]{8}$/.test(runtime.commit) &&
    COMMIT.test(runtime.tagCommit) && runtime.tagCommit.startsWith(runtime.commit) &&
    runtime.asset === `CLIProxyAPI_${runtime.version}_darwin_aarch64.tar.gz` &&
    runtime.url === `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${runtime.version}/${runtime.asset}` &&
    Number.isSafeInteger(runtime.size) && runtime.size > 0 && SHA256.test(runtime.sha256);
}

export function validateProxyCertificationOptions(options) {
  if (options.expectedSha256 !== undefined && !SHA256.test(options.expectedSha256)) fail("--expected-sha256 is invalid.");
  if (options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 1)) {
    fail("--expected-size is invalid.");
  }
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535)) {
    fail("--port is invalid.");
  }
  if (options.live !== false) {
    if (options.expectedSha256 === undefined || options.expectedSize === undefined) {
      fail("Live proxy certification requires both --expected-sha256 and --expected-size.");
    }
    if (typeof options.authDir !== "string" || options.authDir.length === 0) {
      fail("Live proxy certification requires a caller-provided existing --auth-dir.");
    }
  }
  return options;
}

export function parseChecksumFile(contents, asset) {
  if (typeof contents !== "string" || contents.includes("\0")) fail("CLIProxyAPI checksum file is malformed.");
  const matches = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let match = line.match(/^([0-9a-fA-F]{64})\s+[*]?(.+)$/);
    if (match && basename(match[2].trim()) === asset && match[2].trim() === asset) matches.push(match[1].toLowerCase());
    match = line.match(/^SHA256 \(([^)]+)\) = ([0-9a-fA-F]{64})$/);
    if (match && match[1] === asset) matches.push(match[2].toLowerCase());
  }
  if (matches.length !== 1) fail(`CLIProxyAPI checksum file must contain exactly one checksum for ${asset}.`);
  return matches[0];
}

export function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) fail("CLIProxyAPI archive is empty.");
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0") || entry.includes("\\")) {
      fail("CLIProxyAPI archive contains an invalid path.");
    }
    const normalized = posix.normalize(entry.replace(/^\.\//, ""));
    if (entry.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized !== entry.replace(/^\.\//, "").replace(/\/$/, "")) {
      fail(`CLIProxyAPI archive path is unsafe: ${entry}.`);
    }
  }
  return true;
}

export async function inspectMachOArm64(path) {
  const contents = await readFile(path);
  return contents.length >= 8 && contents.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) &&
    contents.readUInt32LE(4) === 0x0100000c;
}

function sha256Buffer(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function sha256File(path) {
  return sha256Buffer(await readFile(path));
}

async function inspectCandidateArchive(archive, runtime) {
  const listed = await execFile("/usr/bin/tar", ["-tzf", archive], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const entries = listed.stdout.split("\n").filter(Boolean).map((entry) => entry.replace(/\/$/, ""));
  validateArchiveEntries(entries);
  const normalized = entries.map((entry) => posix.normalize(entry.replace(/^\.\//, "")));
  if (new Set(normalized).size !== normalized.length) {
    fail("CLIProxyAPI archive contains duplicate members.");
  }
  const binaryEntries = entries.filter((_entry, index) => normalized[index] === "cli-proxy-api");
  if (binaryEntries.length !== 1) {
    fail("CLIProxyAPI archive must contain exactly one root cli-proxy-api executable.");
  }
  const verbose = await execFile("/usr/bin/tar", ["-tvzf", archive], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const types = verbose.stdout.split("\n").filter(Boolean).map((line) => line[0]);
  if (types.length !== entries.length || types.some((type) => type !== "-" && type !== "d")) {
    fail("CLIProxyAPI archive contains links or unsupported entry types.");
  }
  const extracted = await mkdtemp(join(tmpdir(), "claudex-proxy-extracted-"));
  try {
    await execFile("/usr/bin/tar", ["-xzf", archive, "-C", extracted, "--no-same-owner", "--no-same-permissions"], { timeout: 30_000 });
    const binary = join(extracted, binaryEntries[0]);
    if (!(await lstat(binary)).isFile()) {
      fail("CLIProxyAPI root cli-proxy-api executable is not a regular file.");
    }
    await chmod(binary, 0o700);
    if (!(await inspectMachOArm64(binary))) fail("CLIProxyAPI candidate is not a thin ARM64 Mach-O executable.");
    let versionOutput;
    try {
      const result = await execFile(binary, ["--version"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      versionOutput = `${result.stdout}\n${result.stderr}`.trim();
    } catch (error) {
      versionOutput = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`.trim();
    }
    if (!versionOutput.includes(`Version: ${runtime.version}`) || !versionOutput.includes(`Commit: ${runtime.commit}`)) {
      fail("CLIProxyAPI --version build identity does not match the exact release.");
    }
    return { binary, binarySha256: await sha256File(binary), versionOutput, cleanup: () => rm(extracted, { recursive: true, force: true }) };
  } catch (error) {
    await rm(extracted, { recursive: true, force: true });
    throw error;
  }
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

async function fetchMetadata(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) fail(`Unable to read ${url}: HTTP ${response.status}.`);
  if (response.url && response.url !== url) fail(`GitHub metadata request redirected away from ${url}.`);
  try {
    return await response.json();
  } catch {
    fail(`GitHub metadata response from ${url} is not JSON.`);
  }
}

function exactAsset(assets, name) {
  if (!Array.isArray(assets)) fail("CLIProxyAPI release assets are malformed.");
  const matches = assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1) fail(`CLIProxyAPI release must contain exactly one ${name}.`);
  const asset = plainObject(matches[0], `${name} asset`);
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || typeof asset.url !== "string" ||
      !asset.url.startsWith(`${PROXY_API}/releases/assets/`) || typeof asset.browser_download_url !== "string") {
    fail(`CLIProxyAPI ${name} asset metadata is invalid.`);
  }
  const digest = typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice(7) : "";
  if (!SHA256.test(digest)) fail(`CLIProxyAPI ${name} GitHub digest is unavailable or invalid.`);
  return { ...asset, sha256: digest };
}

async function resolveTagCommit(fetchImpl, tag, headers) {
  const reference = plainObject(await fetchMetadata(fetchImpl, `${PROXY_API}/git/ref/tags/${encodeURIComponent(tag)}`, headers), "tag reference");
  const target = plainObject(reference.object, "tag target");
  if (target.type === "commit" && COMMIT.test(target.sha)) return target.sha;
  if (target.type !== "tag" || !COMMIT.test(target.sha)) fail("CLIProxyAPI tag target is invalid.");
  const annotated = plainObject(await fetchMetadata(fetchImpl, `${PROXY_API}/git/tags/${target.sha}`, headers), "annotated tag");
  const commit = plainObject(annotated.object, "annotated tag target");
  if (commit.type !== "commit" || !COMMIT.test(commit.sha)) fail("CLIProxyAPI annotated tag does not resolve to a commit.");
  return commit.sha;
}

function trustedDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password &&
      ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function downloadAsset(fetchImpl, asset, headers) {
  const response = await fetchImpl(asset.browser_download_url, { method: "GET", redirect: "follow", headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) fail(`Unable to download ${asset.name}: HTTP ${response.status}.`);
  if ((response.url && !trustedDownloadUrl(response.url)) || !trustedDownloadUrl(asset.browser_download_url)) {
    fail(`CLIProxyAPI ${asset.name} download redirected to an untrusted host.`);
  }
  const contents = Buffer.from(await response.arrayBuffer());
  if (contents.byteLength !== asset.size || sha256Buffer(contents) !== asset.sha256) {
    fail(`CLIProxyAPI ${asset.name} bytes do not match GitHub asset metadata.`);
  }
  return contents;
}

async function reserveLocalPort(requestedPort) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => reject(new Error(requestedPort ? `Requested port ${requestedPort} is occupied.` : `Unable to choose a localhost port: ${error.message}`)));
    server.listen({ host: "127.0.0.1", port: requestedPort ?? 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

async function fetchJson(fetchImpl, url, init, label) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) fail(`${label} returned HTTP ${response.status}.`);
  try { return await response.json(); } catch { fail(`${label} did not return JSON.`); }
}

async function runLiveCertification(binary, options) {
  const projectRoot = resolve(options.projectRoot);
  const [{ renderProxyConfig }, { MODEL }] = await Promise.all([
    import(pathToFileURL(join(projectRoot, "dist", "proxy-config.js")).href),
    import(pathToFileURL(join(projectRoot, "dist", "claude-settings.js")).href)
  ]);
  const authInput = resolve(options.authDir);
  const authDetails = await lstat(authInput).catch(() => fail("--auth-dir does not exist."));
  if (!authDetails.isDirectory() || authDetails.isSymbolicLink()) fail("--auth-dir must be an existing real directory, not a link.");
  const authDir = await realpath(authInput);
  const port = await reserveLocalPort(options.port);
  const temporary = await mkdtemp(join(tmpdir(), "claudex-proxy-live-"));
  const config = join(temporary, "config.yaml");
  const apiKey = `claudex-cert-${randomBytes(24).toString("hex")}`;
  await writeFile(config, renderProxyConfig({ authDir, apiKey, port }), { mode: 0o600 });
  const child = (options.spawnImpl ?? spawnCallback)(binary, ["-config", config, "-local-model"], {
    cwd: temporary,
    stdio: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? temporary }
  });
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  const fetchImpl = options.liveFetchImpl ?? fetch;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20_000;
    let models;
    while (Date.now() < deadline && child.exitCode === null && !spawnError) {
      try {
        const health = await fetchImpl(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) });
        if (health.ok) {
          models = await fetchJson(fetchImpl, `${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } }, "Proxy models probe");
          break;
        }
      } catch { /* Retry only this freshly spawned child. */ }
      await new Promise((done) => setTimeout(done, 200));
    }
    if (spawnError) fail(`CLIProxyAPI child could not start: ${spawnError.message}`);
    const ids = [...(models?.data ?? []).map((item) => item?.id), ...(models?.models ?? []).map((item) => item?.id ?? item?.slug)];
    if (!ids.includes(MODEL)) fail(`CLIProxyAPI did not advertise ${MODEL}.`);
    const marker = `CLAUDEX_PROXY_CERTIFIED_${randomBytes(12).toString("hex")}`;
    const body = await fetchJson(fetchImpl, `${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: `Reply with exactly ${marker} and nothing else.` }], stream: false })
    }, "Proxy routed response");
    if (body?.choices?.[0]?.message?.content?.trim() !== marker) fail("CLIProxyAPI did not return the exact routed certification response.");
    return { localhostOnly: true, authDirectoryReused: true, health: true, model: true, routedResponse: true, childOwned: true };
  } finally {
    if (child.pid && child.exitCode === null && !child.killed) {
      try { child.kill("SIGTERM"); } catch { /* The owned child already exited. */ }
    }
    await new Promise((done) => {
      if (child.exitCode !== null || !child.pid) return done();
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          try { child.kill("SIGKILL"); } catch { /* The owned child already exited. */ }
        }
        done();
      }, 5_000);
      const finished = () => { clearTimeout(timer); done(); };
      child.once("exit", finished);
      child.once("close", finished);
    });
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function certifyProxyCandidate(runtime, options = {}) {
  if (!validRuntime(runtime)) fail("Certified proxy runtime metadata is malformed or non-canonical.");
  validateProxyCertificationOptions(options);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") fail(`Proxy certification requires darwin/arm64; found ${platform}/${arch}.`);
  const projectRoot = resolve(options.projectRoot ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const source = options.sourceState ?? await readProxyCertificationSourceState(projectRoot);
  if (options.live !== false && source.dirty) fail("Live proxy certification evidence must be generated from clean release-critical source.");
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== runtime.sha256) fail("Expected archive SHA-256 does not match the runtime pin.");
  if (options.expectedSize !== undefined && options.expectedSize !== runtime.size) fail("Expected archive size does not match the runtime pin.");

  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = githubHeaders(options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);
  const tag = `v${runtime.version}`;
  const releaseUrl = `${PROXY_API}/releases/tags/${encodeURIComponent(tag)}`;
  const release = plainObject(await fetchMetadata(fetchImpl, releaseUrl, headers), "CLIProxyAPI release");
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false) fail("CLIProxyAPI release metadata is not the exact stable tag.");
  const tagCommit = await resolveTagCommit(fetchImpl, tag, headers);
  if (tagCommit !== runtime.tagCommit) fail("CLIProxyAPI GitHub tag commit does not match the exact runtime pin.");
  const archiveAsset = exactAsset(release.assets, runtime.asset);
  const checksumsAsset = exactAsset(release.assets, "checksums.txt");
  if (archiveAsset.browser_download_url !== runtime.url || archiveAsset.size !== runtime.size || archiveAsset.sha256 !== runtime.sha256) {
    fail("CLIProxyAPI GitHub archive metadata does not match the exact runtime pin.");
  }
  const [archiveBytes, checksumsBytes] = await Promise.all([
    downloadAsset(fetchImpl, archiveAsset, headers),
    downloadAsset(fetchImpl, checksumsAsset, headers)
  ]);
  const checksum = parseChecksumFile(checksumsBytes.toString("utf8"), runtime.asset);
  if (checksum !== runtime.sha256 || checksum !== archiveAsset.sha256) {
    fail("CLIProxyAPI checksum-file entry does not agree with the expected and GitHub archive digests.");
  }

  const temporary = await mkdtemp(join(tmpdir(), "claudex-proxy-certify-"));
  const archive = join(temporary, runtime.asset);
  let inspected;
  try {
    await writeFile(archive, archiveBytes, { mode: 0o600, flag: "wx" });
    inspected = await (options.inspectCandidateImpl ?? inspectCandidateArchive)(archive, runtime);
    if (options.archiveOut) {
      await mkdir(dirname(resolve(options.archiveOut)), { recursive: true, mode: 0o700 });
      await writeFile(resolve(options.archiveOut), archiveBytes, { mode: 0o600, flag: "wx" });
    }
    if (options.binaryOut) {
      await mkdir(dirname(resolve(options.binaryOut)), { recursive: true, mode: 0o700 });
      await copyFile(inspected.binary, resolve(options.binaryOut));
      await chmod(resolve(options.binaryOut), 0o700);
    }
    const live = options.live === false
      ? null
      : await (options.runLiveImpl ?? runLiveCertification)(inspected.binary, {
          ...options,
          projectRoot
        });
    return {
      schemaVersion: 1,
      kind: "claudex-proxy-certification",
      certifiedAt: (options.now?.() ?? new Date()).toISOString(),
      source,
      expectations: { sha256: options.expectedSha256 ?? runtime.sha256, size: options.expectedSize ?? runtime.size, matched: options.expectedSha256 !== undefined && options.expectedSize !== undefined },
      runtime: { ...runtime },
      upstream: {
        releaseUrl,
        tag,
        tagCommit,
        assetApiUrl: archiveAsset.url,
        checksumsApiUrl: checksumsAsset.url,
        checksumFileSha256: checksumsAsset.sha256,
        checksumEntrySha256: checksum
      },
      candidate: {
        archiveSize: archiveBytes.byteLength,
        archiveSha256: sha256Buffer(archiveBytes),
        binarySha256: inspected.binarySha256,
        versionOutput: inspected.versionOutput,
        machOArm64: true,
        safeArchive: true
      },
      live,
      proposedRuntime: { ...runtime }
    };
  } finally {
    await inspected?.cleanup?.();
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseCli(args) {
  const options = {};
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--offline") { options.live = false; continue; }
    if (!["--out", "--archive-out", "--binary-out", "--expected-sha256", "--expected-size", "--auth-dir", "--port", "--runtime"].includes(flag)) fail(`Unexpected option: ${flag ?? ""}`);
    const value = args.shift();
    if (!value || value.startsWith("--")) fail(`${flag} requires a value.`);
    const key = flag.slice(2).replaceAll(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (Object.hasOwn(options, key)) fail(`${flag} may only be provided once.`);
    options[key] = ["--expected-size", "--port"].includes(flag) ? Number(value) : value;
  }
  validateProxyCertificationOptions(options);
  return options;
}

async function runCli() {
  const options = parseCli(process.argv.slice(2));
  const runtimeModule = await import(resolve(options.runtime ?? "dist/runtime.js"));
  const report = await certifyProxyCandidate(runtimeModule.PROXY_RUNTIME, options);
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    await mkdir(dirname(resolve(options.out)), { recursive: true, mode: 0o700 });
    await writeFile(resolve(options.out), contents, { mode: 0o600 });
    process.stdout.write(`Certified CLIProxyAPI ${report.runtime.version}; report written to ${resolve(options.out)}.\n`);
  } else process.stdout.write(contents);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
