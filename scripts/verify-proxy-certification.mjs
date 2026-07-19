#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DEFAULT_SOURCE_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "src/claude-settings.ts",
  "src/child-env.ts",
  "src/proxy-config.ts",
  "src/proxy.ts",
  "src/runtime.ts",
  "scripts/certify-proxy.mjs",
  "scripts/verify-proxy-certification.mjs"
];

function fail(message) {
  throw new Error(message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function exactKeys(value, keys, label) {
  const object = plainObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
  return object;
}

function sourcePath(root, entry) {
  const candidate = resolve(root, entry);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) fail("Proxy certification source path escapes the project.");
  return candidate;
}

export async function computeProxyCertificationSourceDigest(projectRoot, entries = DEFAULT_SOURCE_PATHS) {
  const root = resolve(projectRoot);
  const hash = createHash("sha256");
  for (const entry of [...new Set(entries)].sort()) {
    const path = sourcePath(root, entry);
    let details;
    try {
      details = await lstat(path);
    } catch {
      fail(`Proxy certification source is missing: ${relative(root, path) || basename(path)}.`);
    }
    if (!details.isFile() || details.isSymbolicLink()) {
      fail(`Proxy certification source must be a regular file: ${relative(root, path)}.`);
    }
    const contents = await readFile(path);
    const name = relative(root, path).split("\\").join("/");
    hash.update(`${name}\0${contents.byteLength}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function readProxyCertificationSourceState(projectRoot) {
  const root = resolve(projectRoot);
  const [commitResult, statusResult, digest] = await Promise.all([
    execFile("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 10_000 }),
    execFile("git", ["status", "--porcelain", "--untracked-files=all", "--", ...DEFAULT_SOURCE_PATHS], {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    }),
    computeProxyCertificationSourceDigest(root)
  ]);
  const commit = commitResult.stdout.trim();
  if (!COMMIT.test(commit)) fail("Proxy certification source commit is invalid.");
  return { repository: "cobibean/claudex", commit, digest, dirty: statusResult.stdout.trim().length > 0 };
}

function sameRuntime(actual, expected, label) {
  for (const key of ["version", "commit", "tagCommit", "asset", "url", "size", "sha256", "binarySha256"]) {
    if (actual[key] !== expected[key]) fail(`${label} ${key} does not match the certified proxy runtime.`);
  }
}

export function validateProxyCertificationEvidence(
  report,
  { certifiedProxy, sourceDigest, now = new Date(), maxAgeDays = 30 }
) {
  exactKeys(report, [
    "schemaVersion", "kind", "certifiedAt", "source", "expectations", "runtime", "upstream",
    "candidate", "live", "proposedRuntime"
  ], "proxy certification evidence");
  exactKeys(report.source, ["repository", "commit", "digest", "dirty"], "proxy certification source");
  exactKeys(report.expectations, ["sha256", "size", "matched"], "proxy certification expectations");
  exactKeys(report.runtime, ["version", "commit", "tagCommit", "asset", "url", "size", "sha256", "binarySha256"], "proxy runtime");
  exactKeys(report.upstream, ["releaseUrl", "tag", "tagCommit", "assetApiUrl", "checksumsApiUrl", "checksumFileSha256", "checksumEntrySha256"], "proxy upstream evidence");
  exactKeys(report.candidate, ["archiveSize", "archiveSha256", "binarySha256", "versionOutput", "machOArm64", "safeArchive"], "proxy candidate evidence");
  exactKeys(report.live, ["localhostOnly", "authDirectoryReused", "health", "model", "routedResponse", "childOwned"], "proxy live evidence");

  if (report.schemaVersion !== 1 || report.kind !== "claudex-proxy-certification") {
    fail("Proxy certification evidence schema is unsupported.");
  }
  if (report.source.repository !== "cobibean/claudex" || !COMMIT.test(report.source.commit)) {
    fail("Proxy certification source repository or commit is invalid.");
  }
  if (report.source.dirty !== false) fail("Proxy certification evidence must come from clean source.");
  if (!SHA256.test(report.source.digest) || report.source.digest !== sourceDigest) {
    fail("Proxy certification source digest does not match current release-critical source.");
  }
  if (
    !certifiedProxy ||
    !SHA256.test(certifiedProxy.sha256) ||
    !SHA256.test(certifiedProxy.binarySha256) ||
    !COMMIT.test(certifiedProxy.tagCommit)
  ) {
    fail("Current certified proxy runtime is malformed.");
  }
  sameRuntime(report.runtime, certifiedProxy, "Certification runtime");
  sameRuntime(report.proposedRuntime, certifiedProxy, "Proposed runtime");
  if (report.expectations.matched !== true || report.expectations.sha256 !== certifiedProxy.sha256 || report.expectations.size !== certifiedProxy.size) {
    fail("Proxy certification expectation evidence is missing or mismatched.");
  }
  if (report.upstream.tag !== `v${certifiedProxy.version}` || report.upstream.tagCommit !== certifiedProxy.tagCommit) {
    fail("Proxy upstream tag evidence does not match the exact certified GitHub tag commit.");
  }
  const api = "https://api.github.com/repos/router-for-me/CLIProxyAPI";
  if (
    report.upstream.releaseUrl !== `${api}/releases/tags/v${certifiedProxy.version}` ||
    typeof report.upstream.assetApiUrl !== "string" ||
    typeof report.upstream.checksumsApiUrl !== "string" ||
    !report.upstream.assetApiUrl.startsWith(`${api}/releases/assets/`) ||
    !report.upstream.checksumsApiUrl.startsWith(`${api}/releases/assets/`) ||
    report.upstream.assetApiUrl === report.upstream.checksumsApiUrl
  ) {
    fail("Proxy upstream evidence URLs are not exact CLIProxyAPI GitHub URLs.");
  }
  if (!SHA256.test(report.upstream.checksumFileSha256) || report.upstream.checksumEntrySha256 !== certifiedProxy.sha256) {
    fail("Proxy checksum-file evidence is invalid or disagrees with the certified archive.");
  }
  if (
    report.candidate.archiveSize !== certifiedProxy.size ||
    report.candidate.archiveSha256 !== certifiedProxy.sha256 ||
    report.candidate.binarySha256 !== certifiedProxy.binarySha256 ||
    report.candidate.machOArm64 !== true ||
    report.candidate.safeArchive !== true ||
    typeof report.candidate.versionOutput !== "string" ||
    !report.candidate.versionOutput.includes(`Version: ${certifiedProxy.version}`) ||
    !report.candidate.versionOutput.includes(`Commit: ${certifiedProxy.commit}`)
  ) {
    fail("Proxy candidate identity evidence is incomplete or mismatched.");
  }
  if (Object.values(plainObject(report.live, "proxy live evidence")).some((value) => value !== true)) {
    fail("Proxy certification evidence must contain a complete live gate; offline reports cannot release.");
  }
  const certifiedAt = Date.parse(report.certifiedAt);
  if (!Number.isFinite(certifiedAt) || certifiedAt > now.getTime() + 5 * 60_000) fail("Proxy certification timestamp is invalid.");
  const age = now.getTime() - certifiedAt;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1 || age > maxAgeDays * 24 * 60 * 60_000) {
    fail(`Proxy certification evidence is older than ${maxAgeDays} days.`);
  }
  return report;
}

async function importModule(path) {
  return import(`${pathToFileURL(resolve(path)).href}?proxyCertification=${Date.now()}`);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      fail("Usage: verify-proxy-certification.mjs --report PATH [--source-root PATH] [--runtime PATH] [--max-age-days N].");
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) fail(`${flag} may only be supplied once.`);
    options[key] = value;
  }
  return options;
}

async function runCli() {
  const options = parseOptions(process.argv.slice(2));
  for (const key of Object.keys(options)) {
    if (!["report", "source-root", "runtime", "max-age-days"].includes(key)) fail(`Unexpected option --${key}.`);
  }
  if (!options.report) fail("--report is required.");
  const sourceRoot = resolve(options["source-root"] ?? ".");
  const runtime = await importModule(options.runtime ?? "dist/runtime.js");
  const report = JSON.parse(await readFile(resolve(options.report), "utf8"));
  const sourceDigest = await computeProxyCertificationSourceDigest(sourceRoot);
  validateProxyCertificationEvidence(report, {
    certifiedProxy: runtime.PROXY_RUNTIME,
    sourceDigest,
    maxAgeDays: options["max-age-days"] === undefined ? 30 : Number(options["max-age-days"])
  });
  try {
    await execFile("git", ["merge-base", "--is-ancestor", report.source.commit, "HEAD"], { cwd: sourceRoot, timeout: 10_000 });
  } catch {
    fail("Proxy certification source commit is not an ancestor of the release source.");
  }
  process.stdout.write(`Verified live CLIProxyAPI ${report.runtime.version} certification evidence from ${report.certifiedAt}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
