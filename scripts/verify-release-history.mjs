#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseArtifacts } from "./release-manifest.mjs";

function fail(message) {
  throw new Error(message);
}

export function validateReleaseHistory(records, nextSequence) {
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) {
    fail("The next release sequence must be a positive safe integer.");
  }
  const sequences = new Set();
  const tags = new Set();
  let maximumSequence = 0;
  for (const record of records) {
    if (!Number.isSafeInteger(record?.sequence) || record.sequence < 1) {
      fail("Release history contains an invalid sequence.");
    }
    if (sequences.has(record.sequence)) fail(`Release history contains duplicate sequence ${record.sequence}.`);
    if (tags.has(record.tag)) fail(`Release history contains duplicate tag ${record.tag}.`);
    sequences.add(record.sequence);
    tags.add(record.tag);
    maximumSequence = Math.max(maximumSequence, record.sequence);
  }
  if (nextSequence <= maximumSequence) {
    fail(`Next release sequence ${nextSequence} must be greater than maximum signed sequence ${maximumSequence}.`);
  }
  return maximumSequence;
}

export async function verifyReleaseHistoryDirectory({ directory, nextSequence, publicKeyPem }) {
  const entries = await readdir(resolve(directory), { withFileTypes: true });
  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const root = join(resolve(directory), entry.name);
    records.push(
      await verifyReleaseArtifacts({
        manifestPath: join(root, "release.json"),
        signaturePath: join(root, "release.sig"),
        publicKeyPem
      })
    );
  }
  return {
    maximumSequence: validateReleaseHistory(records, nextSequence),
    releases: records.length
  };
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      fail("Usage: verify-release-history.mjs --directory PATH --next-sequence N [--public-key PATH].");
    }
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) fail(`${flag} may only be provided once.`);
    options[name] = value;
  }
  return options;
}

async function runCli() {
  const options = parseOptions(process.argv.slice(2));
  for (const key of Object.keys(options)) {
    if (!["directory", "next-sequence", "public-key"].includes(key)) fail(`Unexpected option --${key}.`);
  }
  if (!options.directory || !options["next-sequence"]) fail("--directory and --next-sequence are required.");
  const publicKeyPem = options["public-key"]
    ? await readFile(resolve(options["public-key"]), "utf8")
    : (await import("../dist/compatibility.js")).RELEASE_PUBLIC_KEY_PEM;
  const result = await verifyReleaseHistoryDirectory({
    directory: options.directory,
    nextSequence: Number(options["next-sequence"]),
    publicKeyPem
  });
  process.stdout.write(
    `Verified ${result.releases} signed release record(s); maximum sequence ${result.maximumSequence}.\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
