#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DEFAULT_SOURCE_PATHS = [
  "bin/claudex",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "src",
  "scripts/certify-claude.mjs",
  "scripts/verify-claude-certification.mjs"
];

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

export function canonicalizeCertification(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeCertification).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeCertification(value[key])}`)
    .join(",")}}`;
}

async function sourceFiles(root, entries) {
  const files = [];
  const visit = async (candidate) => {
    let details;
    try {
      details = await lstat(candidate);
    } catch {
      fail(`Certification source is missing: ${relative(root, candidate) || basename(candidate)}.`);
    }
    if (details.isSymbolicLink()) fail(`Certification source may not be a symlink: ${relative(root, candidate)}.`);
    if (details.isFile()) {
      files.push(candidate);
      return;
    }
    if (!details.isDirectory()) fail(`Certification source has unsupported type: ${relative(root, candidate)}.`);
    const children = await readdir(candidate);
    children.sort();
    for (const child of children) await visit(join(candidate, child));
  };
  for (const entry of [...entries].sort()) {
    const candidate = resolve(root, entry);
    if (candidate !== root && !candidate.startsWith(`${root}/`)) fail("Certification source path escapes the project.");
    await visit(candidate);
  }
  return [...new Set(files)].sort();
}

export async function computeCertificationSourceDigest(projectRoot, entries = DEFAULT_SOURCE_PATHS) {
  const root = resolve(projectRoot);
  const hash = createHash("sha256");
  for (const path of await sourceFiles(root, entries)) {
    const name = relative(root, path).split("\\").join("/");
    const contents = await readFile(path);
    hash.update(`${name}\0${contents.byteLength}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function readCertificationSourceState(projectRoot) {
  const root = resolve(projectRoot);
  const [commitResult, treeResult, statusResult, digest, packageContents, compatibilityContents] = await Promise.all([
    execFile("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 10_000 }),
    execFile("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, timeout: 10_000 }),
    execFile("git", ["status", "--porcelain", "--untracked-files=all", "--", ...DEFAULT_SOURCE_PATHS], {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    }),
    computeCertificationSourceDigest(root),
    readFile(join(root, "package.json"), "utf8"),
    readFile(join(root, "src", "compatibility.ts"), "utf8")
  ]);
  const commit = commitResult.stdout.trim();
  const tree = treeResult.stdout.trim();
  if (!COMMIT.test(commit)) fail("Certification source commit is invalid.");
  if (!COMMIT.test(tree)) fail("Certification source tree is invalid.");
  const packageJson = JSON.parse(packageContents);
  const releaseSequence = Number(
    compatibilityContents.match(/export const RELEASE_SEQUENCE = (\d+);/)?.[1]
  );
  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
    fail("Certification source Claudex version is invalid.");
  }
  if (!Number.isSafeInteger(releaseSequence) || releaseSequence < 1) {
    fail("Certification source release sequence is invalid.");
  }
  return {
    repository: "cobibean/claudex",
    commit,
    tree,
    digest,
    dirty: statusResult.stdout.trim().length > 0,
    claudexVersion: packageJson.version,
    releaseSequence
  };
}

function sameCompatibility(report, certified) {
  const proposed = report.proposedCompatibility;
  const candidate = report.candidate;
  for (const key of ["version", "platform", "url", "sha256", "size", "identifier", "teamIdentifier"]) {
    if (proposed[key] !== certified[key]) fail(`Certification evidence ${key} does not match current compatibility.`);
  }
  for (const key of ["url", "sha256", "size", "identifier", "teamIdentifier"]) {
    if (candidate[key] !== certified[key]) fail(`Certification candidate ${key} does not match current compatibility.`);
  }
}

export function validateClaudeCertificationEvidence(
  report,
  {
    certifiedClaude,
    sourceDigest,
    claudexVersion,
    releaseSequence,
    now = new Date(),
    maxAgeDays = 7
  }
) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "kind",
      "certifiedAt",
      "source",
      "expectations",
      "version",
      "platform",
      "manifest",
      "candidate",
      "live",
      "warnings",
      "proposedCompatibility"
    ],
    "Claude certification evidence"
  );
  exactKeys(
    report.source,
    ["repository", "commit", "tree", "digest", "dirty", "claudexVersion", "releaseSequence"],
    "certification source"
  );
  exactKeys(report.expectations, ["sha256", "size", "matched"], "certification expectations");
  exactKeys(
    report.candidate,
    [
      "url",
      "size",
      "sha256",
      "identifier",
      "teamIdentifier",
      "versionOutput",
      "machOArm64",
      "strictSignatureValid",
      "gatekeeperAccepted"
    ],
    "certification candidate"
  );
  exactKeys(
    report.live,
    ["doctor", "routedPrompt", "toolsDisabled", "proxyObserved", "priorProxyStateRestored"],
    "live evidence"
  );
  if (report.schemaVersion !== 2 || report.kind !== "claudex-claude-certification") {
    fail("Claude certification evidence schema is unsupported.");
  }
  const reportedVersion =
    typeof report.candidate.versionOutput === "string"
      ? report.candidate.versionOutput.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1]
      : undefined;
  if (
    report.version !== certifiedClaude.version ||
    report.platform !== certifiedClaude.platform ||
    reportedVersion !== certifiedClaude.version ||
    !report.candidate.versionOutput.includes("Claude Code")
  ) {
    fail("Certification candidate version evidence does not match current compatibility.");
  }
  if (
    report.candidate.machOArm64 !== true ||
    report.candidate.strictSignatureValid !== true
  ) {
    fail("Certification candidate platform and signature gates must pass.");
  }
  const gatekeeperNotApplicable =
    report.candidate.gatekeeperAccepted === false &&
    Array.isArray(report.warnings) &&
    report.warnings.includes(
      "Gatekeeper reported that the valid standalone executable is not an app and could not be assessed as one"
    );
  if (report.candidate.gatekeeperAccepted !== true && !gatekeeperNotApplicable) {
    fail("Certification candidate Gatekeeper evidence is not accepted or explicitly not applicable.");
  }
  if (report.source.repository !== "cobibean/claudex" || !COMMIT.test(report.source.commit)) {
    fail("Certification source repository or commit is invalid.");
  }
  if (
    !COMMIT.test(report.source.tree) ||
    typeof report.source.claudexVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(report.source.claudexVersion) ||
    !Number.isSafeInteger(report.source.releaseSequence) ||
    report.source.releaseSequence < 1
  ) {
    fail("Certification source tree or Claudex identity is invalid.");
  }
  if (report.source.dirty !== false) fail("Certification evidence must come from clean source.");
  if (
    (claudexVersion !== undefined && report.source.claudexVersion !== claudexVersion) ||
    (releaseSequence !== undefined && report.source.releaseSequence !== releaseSequence)
  ) {
    fail("Certification source Claudex identity does not match the release source.");
  }
  if (!SHA256.test(report.source.digest) || report.source.digest !== sourceDigest) {
    fail("Certification source digest does not match current release-critical source.");
  }
  if (
    report.expectations.matched !== true ||
    report.expectations.sha256 !== certifiedClaude.sha256 ||
    report.expectations.size !== certifiedClaude.size
  ) {
    fail("Certification expectation evidence is missing or mismatched.");
  }
  if (!isPlainObject(report.live) || Object.values(report.live).some((value) => value !== true)) {
    fail("Certification evidence must contain a complete live compatibility gate.");
  }
  const certifiedAt = Date.parse(report.certifiedAt);
  if (!Number.isFinite(certifiedAt) || certifiedAt > now.getTime() + 5 * 60_000) {
    fail("Certification timestamp is invalid.");
  }
  const age = now.getTime() - certifiedAt;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1 || age > maxAgeDays * 24 * 60 * 60_000) {
    fail(`Certification evidence is older than ${maxAgeDays} days.`);
  }
  if (!Array.isArray(report.warnings) || report.warnings.some((warning) => typeof warning !== "string")) {
    fail("Certification warnings are malformed.");
  }
  sameCompatibility(report, certifiedClaude);
  return report;
}

async function importModule(path) {
  return import(`${pathToFileURL(resolve(path)).href}?certification=${Date.now()}`);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      fail("Usage: verify-claude-certification.mjs --report PATH [--source-root PATH] [--compatibility PATH] [--max-age-days N].");
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
    if (!["report", "source-root", "compatibility", "max-age-days"].includes(key)) {
      fail(`Unexpected option --${key}.`);
    }
  }
  if (!options.report) fail("--report is required.");
  const sourceRoot = resolve(options["source-root"] ?? ".");
  const compatibility = await importModule(options.compatibility ?? "dist/compatibility.js");
  const reportContents = await readFile(resolve(options.report), "utf8");
  const report = JSON.parse(reportContents);
  if (reportContents.trim() !== canonicalizeCertification(report)) {
    fail("Certification evidence is not canonical JSON.");
  }
  const source = await readCertificationSourceState(sourceRoot);
  if (source.dirty) fail("Release source is dirty; certification verification requires a clean checkout.");
  try {
    await execFile("git", ["merge-base", "--is-ancestor", report.source.commit, source.commit], {
      cwd: sourceRoot,
      timeout: 10_000
    });
  } catch {
    fail("Certification source commit is not an ancestor of the release source.");
  }
  const certifiedTree = (
    await execFile("git", ["rev-parse", `${report.source.commit}^{tree}`], {
      cwd: sourceRoot,
      timeout: 10_000
    })
  ).stdout.trim();
  if (report.source.tree !== certifiedTree) {
    fail("Certification source tree does not match its recorded source commit.");
  }
  validateClaudeCertificationEvidence(report, {
    certifiedClaude: compatibility.CERTIFIED_CLAUDE,
    sourceDigest: source.digest,
    claudexVersion: source.claudexVersion,
    releaseSequence: source.releaseSequence,
    maxAgeDays: options["max-age-days"] === undefined ? 7 : Number(options["max-age-days"])
  });
  process.stdout.write(
    `Verified live Claude Code ${report.version} certification evidence from ${report.certifiedAt}.\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
