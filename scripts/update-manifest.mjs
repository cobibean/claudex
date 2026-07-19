#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UPDATE_SCHEMA_VERSION = 1;
const EXPECTED_REPOSITORY = "cobibean/claudex";
const EXPECTED_PLATFORM = "darwin-arm64";
const EXPECTED_CHANNEL = "stable";
const EXPECTED_BINARY = "cli-proxy-api";
const DEFAULT_PRIVATE_KEY_ENV = "CLAUDEX_UPDATE_PRIVATE_KEY_PEM";
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "repository",
  "tag",
  "sequence",
  "channel",
  "legacyReleaseSha256",
  "proxyArtifact"
];
const PROXY_ARTIFACT_KEYS = [
  "platform",
  "version",
  "commit",
  "asset",
  "size",
  "sha256",
  "binary",
  "binarySha256"
];
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Canonical JSON does not support non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (!isPlainObject(value)) fail("Canonical JSON supports only plain JSON objects.");
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      if (value[key] === undefined) fail(`Canonical JSON property ${key} is undefined.`);
      return `${JSON.stringify(key)}:${canonicalize(value[key])}`;
    })
    .join(",")}}`;
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

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be a lowercase 64-character SHA-256 digest.`);
  }
}

function asBytes(value, label) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  fail(`${label} must be a string or byte array.`);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateUpdateRecord(record) {
  assertExactKeys(record, TOP_LEVEL_KEYS, "update record");
  assertExactKeys(record.proxyArtifact, PROXY_ARTIFACT_KEYS, "proxyArtifact");

  if (record.schemaVersion !== UPDATE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${UPDATE_SCHEMA_VERSION}.`);
  }
  if (record.repository !== EXPECTED_REPOSITORY) fail(`repository must be ${EXPECTED_REPOSITORY}.`);
  if (typeof record.tag !== "string" || record.tag.length === 0) fail("tag must be a non-empty string.");
  assertPositiveInteger(record.sequence, "sequence");
  if (record.channel !== EXPECTED_CHANNEL) fail(`channel must be ${EXPECTED_CHANNEL}.`);
  assertSha256(record.legacyReleaseSha256, "legacyReleaseSha256");

  const artifact = record.proxyArtifact;
  if (artifact.platform !== EXPECTED_PLATFORM) fail(`proxyArtifact.platform must be ${EXPECTED_PLATFORM}.`);
  if (typeof artifact.version !== "string" || !SEMVER.test(artifact.version)) {
    fail("proxyArtifact.version must be a semantic version.");
  }
  if (typeof artifact.commit !== "string" || !/^[0-9a-f]{40}$/.test(artifact.commit)) {
    fail("proxyArtifact.commit must be a lowercase 40-character commit hash.");
  }
  const expectedAsset = `CLIProxyAPI_${artifact.version}_darwin_aarch64.tar.gz`;
  if (artifact.asset !== expectedAsset) fail(`proxyArtifact.asset must be ${expectedAsset}.`);
  assertPositiveInteger(artifact.size, "proxyArtifact.size");
  assertSha256(artifact.sha256, "proxyArtifact.sha256");
  if (artifact.binary !== EXPECTED_BINARY) fail(`proxyArtifact.binary must be ${EXPECTED_BINARY}.`);
  assertSha256(artifact.binarySha256, "proxyArtifact.binarySha256");
  return record;
}

export function canonicalizeUpdateRecord(record) {
  return canonicalize(validateUpdateRecord(record));
}

function verifyLegacyCanonicalBytes(legacyRelease, legacyCanonicalBytes) {
  if (!isPlainObject(legacyRelease)) fail("legacyRelease must be a parsed JSON object.");
  const bytes = asBytes(legacyCanonicalBytes, "legacyCanonicalBytes");
  const expected = Buffer.from(canonicalize(legacyRelease), "utf8");
  if (!bytes.equals(expected)) {
    fail("legacy release bytes do not match the parsed legacy release in canonical byte form.");
  }
  return bytes;
}

function assertLegacyBinding(record, legacyRelease) {
  for (const field of ["repository", "tag", "sequence"]) {
    if (record[field] !== legacyRelease[field]) {
      fail(`update record ${field} does not match the parsed legacy release.`);
    }
  }
  if (!isPlainObject(legacyRelease.proxy)) fail("parsed legacy release proxy must be an object.");
  if (record.proxyArtifact.version !== legacyRelease.proxy.version) {
    fail("proxyArtifact.version does not match the parsed legacy release proxy version.");
  }
  if (record.proxyArtifact.commit !== legacyRelease.proxy.commit) {
    fail("proxyArtifact.commit does not match the parsed legacy release proxy commit.");
  }
}

export function verifyUpdateRecordBinding(record, { legacyRelease, legacyCanonicalBytes }) {
  validateUpdateRecord(record);
  const legacyBytes = verifyLegacyCanonicalBytes(legacyRelease, legacyCanonicalBytes);
  assertLegacyBinding(record, legacyRelease);
  if (record.legacyReleaseSha256 !== sha256Bytes(legacyBytes)) {
    fail("legacyReleaseSha256 does not match the canonical legacy release bytes.");
  }
  return record;
}

export function bindUpdateRecord({ legacyRelease, legacyCanonicalBytes, proxyArtifact }) {
  const legacyBytes = verifyLegacyCanonicalBytes(legacyRelease, legacyCanonicalBytes);
  const record = {
    schemaVersion: UPDATE_SCHEMA_VERSION,
    repository: legacyRelease.repository,
    tag: legacyRelease.tag,
    sequence: legacyRelease.sequence,
    channel: EXPECTED_CHANNEL,
    legacyReleaseSha256: sha256Bytes(legacyBytes),
    proxyArtifact: { ...proxyArtifact }
  };
  return verifyUpdateRecordBinding(record, { legacyRelease, legacyCanonicalBytes: legacyBytes });
}

export const bindUpdateRecordToLegacyRelease = bindUpdateRecord;
export const verifyUpdateRecordAgainstLegacyRelease = verifyUpdateRecordBinding;

function privateEd25519Key(key) {
  let parsed;
  try {
    parsed = key?.type === "private" && key?.asymmetricKeyType ? key : createPrivateKey(key);
  } catch {
    fail("The update signing key is not a valid private key.");
  }
  if (parsed.type !== "private" || parsed.asymmetricKeyType !== "ed25519") {
    fail("The update signing key must be Ed25519.");
  }
  return parsed;
}

function publicEd25519Key(key) {
  let parsed;
  try {
    parsed = key?.type === "public" && key?.asymmetricKeyType ? key : createPublicKey(key);
  } catch {
    fail("The update public key is invalid.");
  }
  if (parsed.type !== "public" || parsed.asymmetricKeyType !== "ed25519") {
    fail("The update public key must be Ed25519.");
  }
  return parsed;
}

function decodeSignature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) {
    fail("update signature must be canonical base64 for a 64-byte Ed25519 signature.");
  }
  const signature = Buffer.from(value, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== value) {
    fail("update signature must be canonical base64 for a 64-byte Ed25519 signature.");
  }
  return signature;
}

export function signUpdateRecord(record, privateKey) {
  const canonical = canonicalizeUpdateRecord(record);
  return cryptoSign(null, Buffer.from(canonical, "utf8"), privateEd25519Key(privateKey)).toString("base64");
}

export function verifyUpdateRecordSignature(record, signature, publicKey) {
  const canonical = canonicalizeUpdateRecord(record);
  if (!cryptoVerify(null, Buffer.from(canonical, "utf8"), publicEd25519Key(publicKey), decodeSignature(signature))) {
    fail("Update signature verification failed.");
  }
  return record;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readCanonicalUpdateRecord(path) {
  const contents = await readFile(resolve(path));
  let record;
  try {
    record = JSON.parse(contents.toString("utf8"));
  } catch {
    fail("update.json is not valid JSON.");
  }
  const canonical = canonicalizeUpdateRecord(record);
  if (!contents.equals(Buffer.from(canonical, "utf8"))) fail("update.json is not in canonical byte form.");
  return { record, canonical };
}

export async function writeUpdateRecord(path, record) {
  const canonical = canonicalizeUpdateRecord(record);
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), canonical, { mode: 0o644 });
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

async function readLegacyRelease(path) {
  const bytes = await readFile(resolve(path));
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("legacy release.json is not valid JSON.");
  }
  verifyLegacyCanonicalBytes(record, bytes);
  return { record, bytes };
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (command === "generate") {
    assertAllowedOptions(options, [
      "legacy-release",
      "proxy-archive",
      "proxy-binary",
      "proxy-version",
      "proxy-commit",
      "out"
    ]);
    const legacy = await readLegacyRelease(requireOption(options, "legacy-release"));
    const archivePath = requireOption(options, "proxy-archive");
    const binaryPath = requireOption(options, "proxy-binary");
    const archiveStats = await stat(resolve(archivePath));
    const binaryStats = await stat(resolve(binaryPath));
    if (!archiveStats.isFile()) fail("The proxy archive must be a regular file.");
    if (!binaryStats.isFile()) fail("The proxy binary must be a regular file.");
    const record = bindUpdateRecord({
      legacyRelease: legacy.record,
      legacyCanonicalBytes: legacy.bytes,
      proxyArtifact: {
        platform: EXPECTED_PLATFORM,
        version: requireOption(options, "proxy-version"),
        commit: requireOption(options, "proxy-commit"),
        asset: basename(archivePath),
        size: archiveStats.size,
        sha256: await sha256File(resolve(archivePath)),
        binary: basename(binaryPath),
        binarySha256: await sha256File(resolve(binaryPath))
      }
    });
    await writeUpdateRecord(requireOption(options, "out"), record);
    process.stdout.write(`Generated canonical detached update record for ${record.tag}.\n`);
    return;
  }
  if (command === "sign") {
    assertAllowedOptions(options, ["manifest", "signature", "key-env"]);
    const keyEnvironment = options["key-env"] ?? DEFAULT_PRIVATE_KEY_ENV;
    const { record } = await readCanonicalUpdateRecord(requireOption(options, "manifest"));
    const privateKey = process.env[keyEnvironment];
    if (!privateKey) fail(`The ${keyEnvironment} secret is not configured.`);
    const signature = signUpdateRecord(record, privateKey);
    const signaturePath = requireOption(options, "signature");
    await mkdir(dirname(resolve(signaturePath)), { recursive: true });
    await writeFile(resolve(signaturePath), signature, { mode: 0o644 });
    process.stdout.write("Signed canonical detached update record.\n");
    return;
  }
  if (command === "verify") {
    assertAllowedOptions(options, ["manifest", "signature", "legacy-release", "public-key"]);
    const [{ record }, signature, publicKey, legacy] = await Promise.all([
      readCanonicalUpdateRecord(requireOption(options, "manifest")),
      readFile(resolve(requireOption(options, "signature")), "utf8"),
      readFile(resolve(requireOption(options, "public-key")), "utf8"),
      readLegacyRelease(requireOption(options, "legacy-release"))
    ]);
    verifyUpdateRecordBinding(record, {
      legacyRelease: legacy.record,
      legacyCanonicalBytes: legacy.bytes
    });
    verifyUpdateRecordSignature(record, signature, publicKey);
    process.stdout.write(`Verified signed detached update ${record.tag} (sequence ${record.sequence}).\n`);
    return;
  }
  fail("Usage: update-manifest.mjs generate|sign|verify (never pass signing secrets in argv).");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
