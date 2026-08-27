import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectVersions, verifyProjectVersions } from "./check-version-consistency.mjs";

async function fixture(versions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "neko-version-check-"));
  await Promise.all([
    writeFile(path.join(root, "Cargo.toml"), `[package]\nname = "lazycat-neko-webshell"\nversion = "${versions.cargo}"\n`),
    writeFile(path.join(root, "package.json"), JSON.stringify({ name: "lazycat-neko-webshell", version: versions.npm })),
    writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      name: "lazycat-neko-webshell",
      version: versions.lock,
      packages: { "": { name: "lazycat-neko-webshell", version: versions.lockRoot } },
    })),
    writeFile(path.join(root, "package.yml"), `package: community.lazycat.webshell.neko\nversion: ${versions.lpk}\n`),
  ]);
  return root;
}

test("accepts one application version across Rust, npm, lockfile, and LPK metadata", async () => {
  const root = await fixture({ cargo: "1.2.3", npm: "1.2.3", lock: "1.2.3", lockRoot: "1.2.3", lpk: "1.2.3" });
  assert.deepEqual(await projectVersions(root), {
    "Cargo.toml": "1.2.3",
    "package.json": "1.2.3",
    "package-lock.json": "1.2.3",
    "package-lock.json packages root": "1.2.3",
    "package.yml": "1.2.3",
  });
  assert.equal(await verifyProjectVersions(root), "1.2.3");
});

test("reports every mismatched application version", async () => {
  const root = await fixture({ cargo: "1.2.3", npm: "1.2.4", lock: "1.2.4", lockRoot: "1.2.5", lpk: "1.2.3" });
  await assert.rejects(
    verifyProjectVersions(root),
    /package\.json=1\.2\.4.*package-lock\.json packages root=1\.2\.5/s,
  );
});
