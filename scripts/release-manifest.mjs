#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_COMPATIBILITY_MODULE = "dist/compatibility.js";
const DEFAULT_RUNTIME_MODULE = "dist/runtime.js";
const DEFAULT_PRIVATE_KEY_ENV = "CLAUDEX_RELEASE_PRIVATE_KEY_PEM";
const EXPECTED_REPOSITORY = "cobibean/claudex";
const EXPECTED_PLATFORM = "darwin-arm64";
const EXPECTED_CLAUDE_HOST = "downloads.claude.ai";

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Canonical JSON: recursively sorted object keys with no insignificant whitespace. */
export function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Canonical JSON does not support non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (!isPlainObject(value)) fail("Canonical JSON supports only plain JSON objects.");
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      if (value[key] === undefined) fail(`Canonical JSON property ${key} is undefined.`);
      return `${JSON.stringify(key)}:${canonicalize(value[key])}`;
    });
  return `{${entries.join(",")}}`;
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer.`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string.`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
}

export function validateReleaseRecord(record) {
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "sequence",
      "repository",
      "tag",
      "platform",
      "claudex",
      "claude",
      "proxy",
      "minimumBootstrapSchema",
      "minimumStateSchema",
      "revokedSequences"
    ],
    "release record"
  );
  assertExactKeys(record.claudex, ["version", "asset", "size", "sha256"], "release claudex");
  assertExactKeys(
    record.claude,
    ["version", "url", "size", "sha256", "identifier", "teamIdentifier"],
    "release claude"
  );
  assertExactKeys(record.proxy, ["version", "commit"], "release proxy");

  assertPositiveInteger(record.schemaVersion, "schemaVersion");
  assertPositiveInteger(record.sequence, "sequence");
  assertPositiveInteger(record.minimumBootstrapSchema, "minimumBootstrapSchema");
  assertPositiveInteger(record.minimumStateSchema, "minimumStateSchema");
  if (record.repository !== EXPECTED_REPOSITORY) fail(`repository must be ${EXPECTED_REPOSITORY}.`);
  if (record.platform !== EXPECTED_PLATFORM) fail(`platform must be ${EXPECTED_PLATFORM}.`);

  for (const [value, label] of [
    [record.tag, "tag"],
    [record.claudex.version, "claudex.version"],
    [record.claude.version, "claude.version"],
    [record.proxy.version, "proxy.version"],
    [record.proxy.commit, "proxy.commit"]
  ]) {
    assertString(value, label);
  }
  if (!/^\d+\.\d+\.\d+$/.test(record.claudex.version)) {
    fail("claudex.version must be a semantic version.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(record.claude.version)) {
    fail("claude.version must be a semantic version.");
  }
  if (record.tag !== `v${record.claudex.version}`) fail("tag must equal v plus claudex.version.");
  if (record.claudex.asset !== `claudex-${record.claudex.version}.tgz`) {
    fail("claudex.asset does not match claudex.version.");
  }
  if (basename(record.claudex.asset) !== record.claudex.asset) fail("claudex.asset must be a filename.");
  assertPositiveInteger(record.claudex.size, "claudex.size");
  assertPositiveInteger(record.claude.size, "claude.size");
  assertSha256(record.claudex.sha256, "claudex.sha256");
  assertSha256(record.claude.sha256, "claude.sha256");

  let claudeUrl;
  try {
    claudeUrl = new URL(record.claude.url);
  } catch {
    fail("claude.url must be a valid URL.");
  }
  const expectedPath = `/claude-code-releases/${record.claude.version}/darwin-arm64/claude`;
  if (
    claudeUrl.protocol !== "https:" ||
    claudeUrl.hostname !== EXPECTED_CLAUDE_HOST ||
    claudeUrl.port !== "" ||
    claudeUrl.username !== "" ||
    claudeUrl.password !== "" ||
    claudeUrl.pathname !== expectedPath ||
    claudeUrl.search !== "" ||
    claudeUrl.hash !== ""
  ) {
    fail(`claude.url must be https://${EXPECTED_CLAUDE_HOST}${expectedPath}.`);
  }
  if (record.claude.identifier !== "com.anthropic.claude-code") {
    fail("claude.identifier must be com.anthropic.claude-code.");
  }
  if (record.claude.teamIdentifier !== "Q6L2SF6YDW") {
    fail("claude.teamIdentifier must be Anthropic team Q6L2SF6YDW.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(record.proxy.version)) fail("proxy.version must be a semantic version.");
  if (!/^[0-9a-f]{7,64}$/.test(record.proxy.commit)) fail("proxy.commit must be a lowercase commit hash.");

  if (!Array.isArray(record.revokedSequences)) fail("revokedSequences must be an array.");
  const revoked = new Set();
  for (const sequence of record.revokedSequences) {
    assertPositiveInteger(sequence, "revoked sequence");
    if (revoked.has(sequence)) fail("revokedSequences must not contain duplicates.");
    if (sequence === record.sequence) fail("A release cannot revoke its own sequence.");
    revoked.add(sequence);
  }
  return record;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function importModule(path) {
  return import(`${pathToFileURL(resolve(path)).href}?release-tool=${Date.now()}`);
}

export async function generateReleaseRecord({
  assetPath,
  sequence,
  tag,
  packagePath = "package.json",
  compatibilityModule = DEFAULT_COMPATIBILITY_MODULE,
  runtimeModule = DEFAULT_RUNTIME_MODULE,
  revokedSequences
}) {
  const [packageJson, compatibility, runtime, assetStats] = await Promise.all([
    readFile(resolve(packagePath), "utf8").then(JSON.parse),
    importModule(compatibilityModule),
    importModule(runtimeModule),
    stat(resolve(assetPath))
  ]);
  if (!assetStats.isFile()) fail("The Claudex release asset must be a regular file.");
  if (packageJson.name !== "claudex") fail("package.json must describe the claudex package.");
  if (packageJson.version !== compatibility.CLAUDEX_VERSION) {
    fail("package.json and CLAUDEX_VERSION do not agree.");
  }
  const releaseSequence = sequence ?? compatibility.RELEASE_SEQUENCE;
  assertPositiveInteger(releaseSequence, "sequence");
  const releaseRevocations = revokedSequences ?? compatibility.REVOKED_SEQUENCES ?? [];
  if (!Array.isArray(releaseRevocations)) fail("REVOKED_SEQUENCES must be an array.");
  if (
    releaseRevocations.some(
      (revoked, index) =>
        !Number.isSafeInteger(revoked) ||
        revoked < 1 ||
        revoked >= releaseSequence ||
        (index > 0 && revoked <= releaseRevocations[index - 1])
    )
  ) {
    fail("REVOKED_SEQUENCES must be strictly sorted, unique, and older than the release sequence.");
  }
  const releaseTag = tag ?? `v${compatibility.CLAUDEX_VERSION}`;
  if (releaseTag !== `v${compatibility.CLAUDEX_VERSION}`) {
    fail("Release tag, package version, and compatibility version do not agree.");
  }
  const expectedAsset = `claudex-${compatibility.CLAUDEX_VERSION}.tgz`;
  if (basename(assetPath) !== expectedAsset) fail(`Release asset must be named ${expectedAsset}.`);

  const record = {
    schemaVersion: compatibility.RELEASE_SCHEMA_VERSION,
    sequence: releaseSequence,
    repository: compatibility.RELEASE_REPOSITORY,
    tag: releaseTag,
    platform: compatibility.CERTIFIED_CLAUDE.platform,
    claudex: {
      version: compatibility.CLAUDEX_VERSION,
      asset: expectedAsset,
      size: assetStats.size,
      sha256: await sha256File(resolve(assetPath))
    },
    claude: {
      version: compatibility.CERTIFIED_CLAUDE.version,
      url: compatibility.CERTIFIED_CLAUDE.url,
      size: compatibility.CERTIFIED_CLAUDE.size,
      sha256: compatibility.CERTIFIED_CLAUDE.sha256,
      identifier: compatibility.CERTIFIED_CLAUDE.identifier,
      teamIdentifier: compatibility.CERTIFIED_CLAUDE.teamIdentifier
    },
    proxy: {
      version: runtime.PROXY_RUNTIME.version,
      commit: runtime.PROXY_RUNTIME.commit
    },
    minimumBootstrapSchema: compatibility.BOOTSTRAP_SCHEMA_VERSION,
    minimumStateSchema: compatibility.STATE_SCHEMA_VERSION,
    revokedSequences: [...releaseRevocations]
  };
  return validateReleaseRecord(record);
}

export async function writeReleaseRecord(path, record) {
  const canonical = canonicalize(validateReleaseRecord(record));
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), canonical, { mode: 0o644 });
}

export async function readCanonicalReleaseRecord(path) {
  const contents = await readFile(resolve(path), "utf8");
  let record;
  try {
    record = JSON.parse(contents);
  } catch {
    fail("release.json is not valid JSON.");
  }
  validateReleaseRecord(record);
  const canonical = canonicalize(record);
  if (contents !== canonical) fail("release.json is not in canonical byte form.");
  return { record, canonical };
}

export async function signReleaseRecord({ manifestPath, signaturePath, privateKeyPem }) {
  const { canonical } = await readCanonicalReleaseRecord(manifestPath);
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) {
    fail(`The ${DEFAULT_PRIVATE_KEY_ENV} secret is not configured.`);
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    fail("The release signing secret is not a valid private key.");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("The release signing key must be Ed25519.");
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  await mkdir(dirname(resolve(signaturePath)), { recursive: true });
  await writeFile(resolve(signaturePath), signature, { mode: 0o644 });
  return signature;
}

function decodeSignature(value) {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) fail("release.sig is not a canonical base64 Ed25519 signature.");
  const signature = Buffer.from(value, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== value) {
    fail("release.sig is not a 64-byte canonical base64 signature.");
  }
  return signature;
}

export async function verifyReleaseArtifacts({
  manifestPath,
  signaturePath,
  publicKeyPem,
  assetPath,
  expectedTag
}) {
  const { record, canonical } = await readCanonicalReleaseRecord(manifestPath);
  if (expectedTag !== undefined && record.tag !== expectedTag) fail("release.json does not match the expected tag.");
  if (typeof publicKeyPem !== "string" || publicKeyPem.length === 0) fail("Release public key is not configured.");
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    fail("The release public key is invalid.");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("The release public key must be Ed25519.");
  const encodedSignature = await readFile(resolve(signaturePath), "utf8");
  const signature = decodeSignature(encodedSignature);
  if (!verify(null, Buffer.from(canonical, "utf8"), publicKey, signature)) {
    fail("Release signature verification failed.");
  }
  if (assetPath !== undefined) {
    if (basename(assetPath) !== record.claudex.asset) fail("Claudex asset filename does not match release.json.");
    const assetStats = await stat(resolve(assetPath));
    if (!assetStats.isFile() || assetStats.size !== record.claudex.size) {
      fail("Claudex asset size does not match release.json.");
    }
    if ((await sha256File(resolve(assetPath))) !== record.claudex.sha256) {
      fail("Claudex asset SHA-256 does not match release.json.");
    }
  }
  return record;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith("--") || key.length === 2) fail(`Unexpected argument: ${key ?? ""}`);
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) fail(`Option --${name} may only be provided once.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Option --${name} requires a value.`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required.`);
  return value;
}

function assertAllowedOptions(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) fail(`Option --${name} is not valid for this command.`);
  }
}

async function loadPublicKey(options) {
  if (options["public-key"]) return readFile(resolve(options["public-key"]), "utf8");
  const compatibility = await importModule(options.compatibility ?? DEFAULT_COMPATIBILITY_MODULE);
  return compatibility.RELEASE_PUBLIC_KEY_PEM;
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (command === "generate") {
    assertAllowedOptions(options, [
      "asset",
      "out",
      "sequence",
      "tag",
      "package",
      "compatibility",
      "runtime"
    ]);
    const output = requireOption(options, "out");
    const record = await generateReleaseRecord({
      assetPath: requireOption(options, "asset"),
      sequence: options.sequence === undefined ? undefined : Number(options.sequence),
      tag: options.tag,
      packagePath: options.package ?? "package.json",
      compatibilityModule: options.compatibility ?? DEFAULT_COMPATIBILITY_MODULE,
      runtimeModule: options.runtime ?? DEFAULT_RUNTIME_MODULE
    });
    await writeReleaseRecord(output, record);
    process.stdout.write(`Generated canonical release record for ${record.tag}.\n`);
    return;
  }
  if (command === "sign") {
    assertAllowedOptions(options, ["manifest", "signature", "key-env"]);
    const keyEnvironment = options["key-env"] ?? DEFAULT_PRIVATE_KEY_ENV;
    await signReleaseRecord({
      manifestPath: requireOption(options, "manifest"),
      signaturePath: requireOption(options, "signature"),
      privateKeyPem: process.env[keyEnvironment]
    });
    process.stdout.write("Signed canonical release record.\n");
    return;
  }
  if (command === "verify") {
    assertAllowedOptions(options, [
      "manifest",
      "signature",
      "public-key",
      "compatibility",
      "asset",
      "expected-tag"
    ]);
    const record = await verifyReleaseArtifacts({
      manifestPath: requireOption(options, "manifest"),
      signaturePath: requireOption(options, "signature"),
      publicKeyPem: await loadPublicKey(options),
      assetPath: options.asset,
      expectedTag: options["expected-tag"]
    });
    process.stdout.write(`Verified signed release ${record.tag} (sequence ${record.sequence}).\n`);
    return;
  }
  fail(
    "Usage: release-manifest.mjs generate|sign|verify (run the command without secrets in argv)."
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
