#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaudeManifest } from "./certify-claude.mjs";

const CLAUDE_BASE = "https://downloads.claude.ai/claude-code-releases";
const PROXY_API = "https://api.github.com/repos/router-for-me/CLIProxyAPI";
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

function fail(message) {
  throw new Error(message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is malformed.`);
  }
  return value;
}

function exactAsset(assets, name, label) {
  if (!Array.isArray(assets)) fail("CLIProxyAPI release assets are malformed.");
  const matches = assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1) fail(`CLIProxyAPI release must contain exactly one ${label}.`);
  const asset = plainObject(matches[0], label);
  if (!Number.isSafeInteger(asset.size) || asset.size < 1) fail(`${label} size is invalid.`);
  const digest = typeof asset.digest === "string" ? asset.digest : "";
  if (!digest.startsWith("sha256:") || !SHA256.test(digest.slice(7))) {
    fail(`${label} GitHub digest is invalid or unavailable.`);
  }
  const expectedPrefix = `${PROXY_API}/releases/assets/`;
  if (typeof asset.url !== "string" || !asset.url.startsWith(expectedPrefix)) {
    fail(`${label} API URL is outside the CLIProxyAPI repository.`);
  }
  return {
    name,
    size: asset.size,
    sha256: digest.slice(7),
    apiUrl: asset.url
  };
}

export function parseVersionMarker(contents, label) {
  const version = typeof contents === "string" ? contents.trim() : "";
  if (!SEMVER.test(version)) fail(`Claude ${label} marker is not one semantic version.`);
  return version;
}

export function validateProxyRelease(value, commit) {
  const release = plainObject(value, "CLIProxyAPI release");
  if (release.draft !== false || release.prerelease !== false) {
    fail("CLIProxyAPI candidate must be a stable release.");
  }
  if (typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    fail("CLIProxyAPI release tag is invalid.");
  }
  if (!COMMIT.test(commit)) fail("CLIProxyAPI tag commit is invalid.");
  if (typeof release.published_at !== "string" || Number.isNaN(Date.parse(release.published_at))) {
    fail("CLIProxyAPI publication time is invalid.");
  }
  const version = release.tag_name.slice(1);
  return {
    version,
    tag: release.tag_name,
    commit,
    publishedAt: release.published_at,
    asset: exactAsset(
      release.assets,
      `CLIProxyAPI_${version}_darwin_aarch64.tar.gz`,
      "macOS ARM64 asset"
    ),
    checksums: exactAsset(release.assets, "checksums.txt", "checksums asset")
  };
}

export function parseChecksums(contents, assetName) {
  if (typeof contents !== "string" || typeof assetName !== "string") {
    fail("CLIProxyAPI checksums metadata is malformed.");
  }
  const matches = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^([0-9a-f]{64})\s+\*?([^/\\\s]+)$/))
    .filter((match) => match?.[2] === assetName);
  if (matches.length !== 1 || !matches[0]) {
    fail(`CLIProxyAPI checksums must contain exactly one ${assetName} entry.`);
  }
  return matches[0][1];
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

function change(component, current, candidate, channel) {
  return {
    component,
    ...(channel ? { channel } : {}),
    current,
    candidate,
    status: current === candidate ? "current" : "candidate-available"
  };
}

function identityChange(component, pinned, candidate, channel) {
  const versionChange = change(component, pinned.version, candidate.version, channel);
  if (versionChange.status !== "current") return versionChange;
  const matches = component === "claude"
    ? pinned.sha256 === candidate.sha256 && pinned.size === candidate.size
    : (pinned.tagCommit
        ? candidate.commit === pinned.tagCommit
        : candidate.commit.startsWith(pinned.commit)) &&
      pinned.sha256 === candidate.asset.sha256 &&
      pinned.size === candidate.asset.size;
  return matches ? versionChange : { ...versionChange, status: "identity-drift" };
}

export function buildUpdateReport({ checkedAt, pinned, claude, proxy }) {
  const changes = [
    identityChange("claude", pinned.claude, claude.stable, "stable"),
    identityChange("claude", pinned.claude, claude.latest, "latest"),
    identityChange("proxy", pinned.proxy, proxy)
  ].filter((entry) => entry.status !== "current");
  const hasClaude = changes.some((entry) => entry.component === "claude");
  const hasProxy = changes.some((entry) => entry.component === "proxy");
  const recommendation = hasClaude && hasProxy
    ? "review-claude-and-proxy-protocol-migration"
    : hasProxy
      ? "review-proxy-protocol-migration"
      : hasClaude
        ? "review-claude"
        : "none";
  const observed = { pinned, upstream: { claude, proxy }, changes, recommendation };
  return {
    schemaVersion: 1,
    checkedAt,
    fingerprint: createHash("sha256").update(canonicalize(observed)).digest("hex"),
    ...observed
  };
}

async function fetchResponse(fetchImpl, url, headers = {}) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers,
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) fail(`Unable to read ${url}: HTTP ${response.status}.`);
  if (response.url && response.url !== url) fail(`Metadata request redirected away from ${url}.`);
  return response;
}

async function fetchText(fetchImpl, url, headers) {
  return (await fetchResponse(fetchImpl, url, headers)).text();
}

async function fetchJson(fetchImpl, url, headers) {
  try {
    return await (await fetchResponse(fetchImpl, url, headers)).json();
  } catch {
    fail(`Metadata response from ${url} is not JSON.`);
  }
}

async function fetchGitHubAssetText(fetchImpl, url, headers) {
  if (!url.startsWith(`${PROXY_API}/releases/assets/`)) {
    fail("CLIProxyAPI checksums asset URL is outside the upstream repository.");
  }
  let next = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchImpl(next, {
      method: "GET",
      redirect: "manual",
      headers: next.hostname === "api.github.com"
        ? { ...headers, accept: "application/octet-stream" }
        : { accept: "text/plain", "user-agent": "claudex-upstream-watcher" },
      signal: AbortSignal.timeout(30_000)
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) fail("CLIProxyAPI checksums redirect had no destination.");
      const redirected = new URL(location, next);
      if (
        redirected.protocol !== "https:" ||
        !new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"])
          .has(redirected.hostname) ||
        redirected.username ||
        redirected.password ||
        redirected.port ||
        redirected.hash
      ) {
        fail("CLIProxyAPI checksums redirected to an untrusted host.");
      }
      next = redirected;
      continue;
    }
    if (!response.ok) fail(`Unable to read CLIProxyAPI checksums: HTTP ${response.status}.`);
    return response.text();
  }
  fail("CLIProxyAPI checksums exceeded the redirect limit.");
}

async function resolveTagCommit(fetchImpl, tag, headers) {
  const referenceUrl = `${PROXY_API}/git/ref/tags/${encodeURIComponent(tag)}`;
  const reference = plainObject(await fetchJson(fetchImpl, referenceUrl, headers), "CLIProxyAPI tag reference");
  const target = plainObject(reference.object, "CLIProxyAPI tag target");
  if (target.type === "commit" && COMMIT.test(target.sha)) return target.sha;
  if (target.type !== "tag" || !COMMIT.test(target.sha)) fail("CLIProxyAPI tag target is invalid.");
  const tagUrl = `${PROXY_API}/git/tags/${target.sha}`;
  const annotated = plainObject(await fetchJson(fetchImpl, tagUrl, headers), "CLIProxyAPI annotated tag");
  const commit = plainObject(annotated.object, "CLIProxyAPI annotated tag target");
  if (commit.type !== "commit" || !COMMIT.test(commit.sha)) {
    fail("CLIProxyAPI annotated tag does not resolve directly to a commit.");
  }
  return commit.sha;
}

async function claudeChannel(fetchImpl, channel, headers) {
  const version = parseVersionMarker(
    await fetchText(fetchImpl, `${CLAUDE_BASE}/${channel}`, headers),
    channel
  );
  const rawManifest = await fetchJson(fetchImpl, `${CLAUDE_BASE}/${version}/manifest.json`, headers);
  const manifest = validateClaudeManifest(rawManifest, version);
  return {
    version,
    commit: manifest.commit,
    buildDate: manifest.buildDate,
    size: manifest.size,
    sha256: manifest.checksum
  };
}

/**
 * @param {{fetchImpl?: typeof fetch, pinned: any, now?: () => Date, githubToken?: string}} options
 */
export async function collectUpdateReport({ fetchImpl = fetch, pinned, now = () => new Date(), githubToken }) {
  if (!pinned) fail("Pinned Claudex metadata is required.");
  const githubHeaders = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {})
  };
  const [stable, latest, proxyRelease] = await Promise.all([
    claudeChannel(fetchImpl, "stable"),
    claudeChannel(fetchImpl, "latest"),
    fetchJson(fetchImpl, `${PROXY_API}/releases/latest`, githubHeaders)
  ]);
  const proxyTag = plainObject(proxyRelease, "CLIProxyAPI release").tag_name;
  if (typeof proxyTag !== "string") fail("CLIProxyAPI release tag is invalid.");
  const proxyCommit = await resolveTagCommit(fetchImpl, proxyTag, githubHeaders);
  const proxy = validateProxyRelease(proxyRelease, proxyCommit);
  const checksumContents = await fetchGitHubAssetText(
    fetchImpl,
    proxy.checksums.apiUrl,
    githubHeaders
  );
  const fileSha256 = parseChecksums(checksumContents, proxy.asset.name);
  if (fileSha256 !== proxy.asset.sha256) {
    fail("CLIProxyAPI checksum file disagrees with GitHub's authenticated asset digest.");
  }
  return buildUpdateReport({
    checkedAt: now().toISOString(),
    pinned,
    claude: { stable, latest },
    proxy: { ...proxy, fileSha256, digestsAgree: true }
  });
}

async function runCli() {
  if (process.argv.length !== 2) fail("Usage: check-upstreams.mjs");
  const [compatibility, runtime, settings] = await Promise.all([
    import("../dist/compatibility.js"),
    import("../dist/runtime.js"),
    import("../dist/claude-settings.js")
  ]);
  const report = await collectUpdateReport({
    pinned: {
      claudex: { version: compatibility.CLAUDEX_VERSION, sequence: compatibility.RELEASE_SEQUENCE },
      claude: {
        version: compatibility.CERTIFIED_CLAUDE.version,
        sha256: compatibility.CERTIFIED_CLAUDE.sha256,
        size: compatibility.CERTIFIED_CLAUDE.size
      },
      proxy: { ...runtime.PROXY_RUNTIME },
      model: settings.MODEL
    },
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
