#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sha256File } from "./release-manifest.mjs";
import {
  canonicalizeCertification,
  readCertificationSourceState
} from "./verify-claude-certification.mjs";

const execFile = promisify(execFileCallback);
const RELEASE_BASE = "https://downloads.claude.ai/claude-code-releases";
const PLATFORM = "darwin-arm64";
const EXPECTED_IDENTIFIER = "com.anthropic.claude-code";
const EXPECTED_TEAM_IDENTIFIER = "Q6L2SF6YDW";
const CONFLICTING_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE"
];
function fail(message) {
  throw new Error(message);
}

function semver(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

function sha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function validateCertificationOptions(options) {
  if (options.expectedSha256 !== undefined && !sha256(options.expectedSha256)) {
    fail("--expected-sha256 is invalid.");
  }
  if (
    options.expectedSize !== undefined &&
    (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 1)
  ) {
    fail("--expected-size is invalid.");
  }
  if (
    options.live !== false &&
    (options.expectedSha256 === undefined || options.expectedSize === undefined)
  ) {
    fail("Live certification requires both --expected-sha256 and --expected-size.");
  }
  return options;
}

export function validateClaudeManifest(value, requestedVersion) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Claude manifest is malformed.");
  if (value.version !== requestedVersion) fail("Claude manifest version does not match the requested version.");
  if (typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit)) {
    fail("Claude manifest commit is invalid.");
  }
  const platform = value.platforms?.[PLATFORM];
  if (platform === null || typeof platform !== "object" || Array.isArray(platform)) {
    fail(`Claude manifest does not contain ${PLATFORM}.`);
  }
  if (platform.binary !== "claude") fail("Claude manifest binary name is invalid.");
  if (!sha256(platform.checksum)) fail("Claude manifest checksum is invalid.");
  if (!Number.isSafeInteger(platform.size) || platform.size < 1) fail("Claude manifest size is invalid.");
  return {
    version: value.version,
    commit: value.commit,
    buildDate: typeof value.buildDate === "string" ? value.buildDate : null,
    checksum: platform.checksum,
    size: platform.size
  };
}

async function fetchExact(fetchImpl, url, label) {
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) fail(`Unable to download ${label}: HTTP ${response.status}.`);
  if (response.url && response.url !== url) fail(`${label} download redirected away from the certified URL.`);
  return response;
}

async function downloadBinary(fetchImpl, url, destination, expectedSize) {
  const response = await fetchExact(fetchImpl, url, "Claude Code candidate");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== expectedSize) {
    fail("Claude Code Content-Length does not match its official manifest.");
  }
  if (!response.body) fail("Claude Code candidate response did not contain a body.");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  await chmod(destination, 0o700);
}

export async function inspectMachOArm64(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) return false;
    return header.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) && header.readUInt32LE(4) === 0x0100000c;
  } finally {
    await handle.close();
  }
}

async function runIdentityCommand(file, args, timeout = 15_000) {
  try {
    return await execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const failure = error;
    return {
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      failed: true
    };
  }
}

export function classifyGatekeeperAssessment(output, failed) {
  const normalized = output.toLowerCase();
  if (/\bdenied\b/.test(normalized)) return "rejected";
  if (
    /rejected \(the code is valid but does not seem to be an app\)\s*$/.test(normalized.trim())
  ) {
    return "not-applicable";
  }
  if (/\brejected\b/.test(normalized)) return "rejected";
  if (!failed && /\baccepted\b/.test(normalized)) return "accepted";
  return "unavailable";
}

async function inspectAppleIdentity(binary, warnings) {
  const displayed = await runIdentityCommand("/usr/bin/codesign", ["--display", "--verbose=4", binary]);
  if (displayed.failed) fail("Unable to read the Claude Code signing identity.");
  const identityOutput = `${displayed.stdout}\n${displayed.stderr}`;
  const identifier = identityOutput.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  const teamIdentifier = identityOutput.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (identifier !== EXPECTED_IDENTIFIER) fail("Claude Code signing identifier is not Anthropic's identifier.");
  if (teamIdentifier !== EXPECTED_TEAM_IDENTIFIER) fail("Claude Code Apple team identifier is not Anthropic's team.");

  const verified = await runIdentityCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", binary]);
  if (verified.failed) fail("Claude Code strict code-signature verification failed.");

  const gatekeeper = await runIdentityCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", binary]);
  const gatekeeperOutput = `${gatekeeper.stdout}\n${gatekeeper.stderr}`.toLowerCase();
  const gatekeeperAssessment = classifyGatekeeperAssessment(gatekeeperOutput, gatekeeper.failed === true);
  if (gatekeeperAssessment === "rejected") {
    fail("Gatekeeper explicitly rejected the Claude Code candidate.");
  }
  if (gatekeeperAssessment === "not-applicable") {
    warnings.push("Gatekeeper reported that the valid standalone executable is not an app and could not be assessed as one");
  } else if (gatekeeperAssessment === "unavailable") {
    warnings.push("Gatekeeper assessment was unavailable or returned an internal assessment error");
  }
  return {
    identifier,
    teamIdentifier,
    strictSignatureValid: !verified.failed,
    gatekeeperAccepted: gatekeeperAssessment === "accepted"
  };
}

async function inspectVersion(binary, requestedVersion) {
  let result;
  try {
    result = await execFile(binary, ["--version"], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1" }
    });
  } catch {
    fail("Claude Code candidate did not execute its version command.");
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  const found = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
  if (!output.includes("Claude Code") || found !== requestedVersion) {
    fail("Claude Code candidate version output does not match the requested version.");
  }
  return output;
}

async function recordedProxyRunning(claudexHome) {
  try {
    const state = JSON.parse(await readFile(join(claudexHome, "run", "proxy.json"), "utf8"));
    if (!Number.isSafeInteger(state.pid) || state.pid <= 1) return false;
    process.kill(state.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function runLiveCompatibility(binary, version, options) {
  const projectRoot = resolve(options.projectRoot ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const cli = join(projectRoot, "dist", "cli.js");
  await stat(cli).catch(() => fail('Build Claudex before live certification with "pnpm build".'));
  const claudexHome = resolve(options.claudexHome ?? process.env.CLAUDEX_HOME ?? join(homedir(), ".claudex"));
  const environment = {
    ...process.env,
    CLAUDEX_HOME: claudexHome,
    CLAUDEX_CLAUDE_BIN: binary,
    CLAUDEX_CERTIFICATION: "1",
    CLAUDEX_CERTIFICATION_EXPECTED_CLAUDE_VERSION: version,
    DISABLE_UPDATES: "1",
    DISABLE_AUTOUPDATER: "1"
  };
  for (const key of CONFLICTING_ENV_KEYS) delete environment[key];
  const proxyWasRunning = await recordedProxyRunning(claudexHome);
  let proxyReady = false;
  try {
  try {
    await execFile(process.execPath, [cli, "proxy", "start"], {
      cwd: projectRoot,
      env: environment,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    });
    proxyReady = true;
  } catch {
    fail("Claudex could not start its owned proxy for live candidate certification.");
  }
  let doctor;
  try {
    const result = await execFile(process.execPath, [cli, "doctor", "--json"], {
      cwd: projectRoot,
      env: environment,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    });
    doctor = JSON.parse(result.stdout);
  } catch {
    fail("Candidate doctor gate failed.");
  }
  if (doctor.ok !== true || doctor.claude?.version !== version || doctor.proxy?.modelAvailable !== true) {
    fail("Candidate doctor did not confirm the certified Claude version and routed model.");
  }

  const isolatedConfig = await mkdtemp(join(tmpdir(), "claudex-certify-config-"));
  const marker = `CLAUDEX_CERTIFIED_${version.replaceAll(".", "_")}`;
  const settings = join(claudexHome, "claude-settings.json");
  const logPath = join(claudexHome, "logs", "proxy.log");
  const beforeLogSize = await stat(logPath).then((value) => value.size).catch(() => 0);
  try {
    const prompt = `Reply with exactly ${marker} and nothing else.`;
    const result = await execFile(
      binary,
      [
        "--settings",
        settings,
        "--print",
        prompt,
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence"
      ],
      {
        cwd: isolatedConfig,
        env: {
          ...environment,
          CLAUDE_CONFIG_DIR: isolatedConfig,
          DISABLE_UPDATES: "1",
          DISABLE_AUTOUPDATER: "1"
        },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024
      }
    );
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      fail("Candidate live prompt did not return JSON.");
    }
    if (typeof response.result !== "string" || response.result.trim() !== marker) {
      fail("Candidate live prompt did not return the expected routed response.");
    }
    let afterLogSize = beforeLogSize;
    const logDeadline = Date.now() + 5_000;
    while (afterLogSize <= beforeLogSize && Date.now() < logDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      afterLogSize = await stat(logPath).then((value) => value.size).catch(() => 0);
    }
    if (afterLogSize <= beforeLogSize) fail("Owned proxy log did not record the candidate smoke request.");
    return {
      doctor: true,
      routedPrompt: true,
      toolsDisabled: true,
      proxyObserved: true,
      priorProxyStateRestored: true
    };
  } finally {
    await rm(isolatedConfig, { recursive: true, force: true });
  }
  } finally {
    if (proxyReady && !proxyWasRunning) {
      await execFile(process.execPath, [cli, "proxy", "stop"], {
        cwd: projectRoot,
        env: environment,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024
      });
    }
    if ((await recordedProxyRunning(claudexHome)) !== proxyWasRunning) {
      fail("Live certification did not restore the prior managed proxy state.");
    }
  }
}

export async function certifyClaudeCandidate(version, options = {}) {
  if (!semver(version)) fail("Claude Code version must be a semantic version.");
  validateCertificationOptions(options);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") fail(`Certification requires darwin/arm64; found ${platform}/${arch}.`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectRoot = resolve(options.projectRoot ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const source = options.sourceState ?? (await readCertificationSourceState(projectRoot));
  if (options.live !== false && source.dirty) {
    fail("Live certification evidence must be generated from clean release-critical source.");
  }
  const manifestUrl = `${RELEASE_BASE}/${version}/manifest.json`;
  const binaryUrl = `${RELEASE_BASE}/${version}/${PLATFORM}/claude`;
  const manifestResponse = await fetchExact(fetchImpl, manifestUrl, "Claude Code manifest");
  let rawManifest;
  try {
    rawManifest = await manifestResponse.json();
  } catch {
    fail("Claude Code manifest is not JSON.");
  }
  const manifest = validateClaudeManifest(rawManifest, version);
  if (options.expectedSha256 !== undefined && manifest.checksum !== options.expectedSha256) {
    fail("Official manifest SHA-256 does not match the expected candidate digest.");
  }
  if (options.expectedSize !== undefined && manifest.size !== options.expectedSize) {
    fail("Official manifest size does not match the expected candidate size.");
  }

  const temporary = await mkdtemp(join(tmpdir(), `claudex-certify-${version}-`));
  const binary = join(temporary, "claude");
  const warnings = [];
  try {
    await downloadBinary(fetchImpl, binaryUrl, binary, manifest.size);
    const binaryStats = await stat(binary);
    if (binaryStats.size !== manifest.size) fail("Claude Code binary size does not match its official manifest.");
    const digest = await sha256File(binary);
    if (digest !== manifest.checksum) fail("Claude Code binary SHA-256 does not match its official manifest.");
    if (!(await inspectMachOArm64(binary))) fail("Claude Code candidate is not a thin ARM64 Mach-O executable.");
    const versionOutput = await inspectVersion(binary, version);
    const apple = await inspectAppleIdentity(binary, warnings);
    const live = options.live === false ? null : await runLiveCompatibility(binary, version, options);
    return {
      schemaVersion: 2,
      kind: "claudex-claude-certification",
      certifiedAt: (options.now?.() ?? new Date()).toISOString(),
      source,
      expectations: {
        sha256: options.expectedSha256 ?? manifest.checksum,
        size: options.expectedSize ?? manifest.size,
        matched: options.expectedSha256 !== undefined && options.expectedSize !== undefined
      },
      version,
      platform: PLATFORM,
      manifest: { url: manifestUrl, commit: manifest.commit, buildDate: manifest.buildDate },
      candidate: {
        url: binaryUrl,
        size: manifest.size,
        sha256: digest,
        identifier: apple.identifier,
        teamIdentifier: apple.teamIdentifier,
        versionOutput,
        machOArm64: true,
        strictSignatureValid: apple.strictSignatureValid,
        gatekeeperAccepted: apple.gatekeeperAccepted
      },
      live,
      warnings,
      proposedCompatibility: {
        version,
        platform: PLATFORM,
        url: binaryUrl,
        sha256: digest,
        size: manifest.size,
        identifier: apple.identifier,
        teamIdentifier: apple.teamIdentifier
      }
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseCli(args) {
  const version = args.shift();
  if (!version) fail("Usage: certify-claude.mjs <version> [--out PATH] [--offline].");
  const options = {};
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--offline") {
      options.live = false;
      continue;
    }
    if (!["--out", "--expected-sha256", "--expected-size", "--claudex-home"].includes(flag)) {
      fail(`Unexpected option: ${flag ?? ""}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) fail(`${flag} requires a value.`);
    const key = flag.slice(2).replaceAll(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (Object.hasOwn(options, key)) fail(`${flag} may only be provided once.`);
    options[key] = flag === "--expected-size" ? Number(value) : value;
  }
  validateCertificationOptions(options);
  return { version, options };
}

async function runCli() {
  const { version, options } = parseCli(process.argv.slice(2));
  const report = await certifyClaudeCandidate(version, options);
  const contents = `${canonicalizeCertification(report)}\n`;
  if (options.out) {
    await mkdir(dirname(resolve(options.out)), { recursive: true, mode: 0o700 });
    await writeFile(resolve(options.out), contents, { mode: 0o600 });
    process.stdout.write(`Certified Claude Code ${version}; report written to ${resolve(options.out)}.\n`);
  } else {
    process.stdout.write(contents);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
