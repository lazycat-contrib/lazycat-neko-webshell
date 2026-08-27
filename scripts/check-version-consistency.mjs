#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_FILES = ["Cargo.toml", "package.json", "package-lock.json", "package.yml"];

export async function projectVersions(root = process.cwd()) {
  const [cargoText, packageText, lockText, packageYml] = await Promise.all(
    VERSION_FILES.map((file) => readFile(path.join(root, file), "utf8")),
  );
  const cargoPackage = cargoText.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  const cargoVersion = cargoPackage.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(lockText);
  const lpkVersion = packageYml.match(/^version:\s*([^\s#]+)\s*(?:#.*)?$/m)?.[1];
  const versions = {
    "Cargo.toml": cargoVersion,
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    "package-lock.json packages root": packageLock.packages?.[""]?.version,
    "package.yml": lpkVersion,
  };
  for (const [file, version] of Object.entries(versions)) {
    if (typeof version !== "string" || !version.trim()) {
      throw new Error(`Missing application version in ${file}`);
    }
  }
  return versions;
}

export async function verifyProjectVersions(root = process.cwd()) {
  const versions = await projectVersions(root);
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) {
    throw new Error(`Application versions differ: ${Object.entries(versions).map(([file, version]) => `${file}=${version}`).join(", ")}`);
  }
  return Object.values(versions)[0];
}

async function main() {
  const version = await verifyProjectVersions();
  process.stdout.write(`Application version ${version} is consistent.\n`);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
