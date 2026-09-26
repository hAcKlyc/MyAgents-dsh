#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { childCli } from "./child-cli.mjs";

const root = resolve(import.meta.dirname, "..");
const artifactFlag = process.argv.indexOf("--artifact");
if (artifactFlag < 0 || !process.argv[artifactFlag + 1] || process.argv.length !== 4) {
  throw new Error("usage: install-verified-dsh-for-checks --artifact <verified artifact directory>");
}
const artifact = resolve(process.argv[artifactFlag + 1]);
const accepted = JSON.parse(readFileSync(resolve(root,
  "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json"), "utf8"));
const verify = childCli("npm", ["run", "verify:dsh-artifact", "--", "--artifact", artifact,
  "--expected-manifest-sha256", accepted.manifestSha256]);
execFileSync(verify.command, verify.args, { cwd: root, stdio: "inherit" });
const manifest = JSON.parse(readFileSync(resolve(artifact, "patched-dsh-artifact-v1.json"), "utf8"));
if (manifest.packageCount !== manifest.packages?.length || manifest.packageCount !== accepted.packageCount) {
  throw new Error("Verified artifact package inventory differs from the accepted profile");
}
const packagePath = resolve(root, "package.json");
const packageBytes = readFileSync(packagePath);
const lockPath = resolve(root, "package-lock.json");
const lockBytes = readFileSync(lockPath);
try {
  // npm rejects a local tarball for a direct dependency while the root still pins its
  // official registry override. The checkout manifest is restored before any gate runs.
  const temporaryPackage = JSON.parse(packageBytes.toString("utf8"));
  delete temporaryPackage.overrides;
  writeFileSync(packagePath, `${JSON.stringify(temporaryPackage, null, 2)}\n`);
  const install = childCli("npm", ["install", "--no-save", "--package-lock=false", "--ignore-scripts",
    "--no-audit", "--no-fund", ...manifest.packages.map(({ tarball }) => resolve(artifact, tarball))]);
  execFileSync(install.command, install.args, { cwd: root, stdio: "inherit" });
} finally {
  writeFileSync(packagePath, packageBytes);
}
if (!readFileSync(lockPath).equals(lockBytes)) {
  throw new Error("Installing verified DSH changed the repository package lock");
}
const consumerLock = JSON.parse(readFileSync(resolve(artifact, "consumer/package-lock.json"), "utf8"));
for (const { name } of manifest.packages) {
  const version = consumerLock.packages?.[`node_modules/${name}`]?.version;
  const installed = JSON.parse(readFileSync(resolve(root, "node_modules", name, "package.json"), "utf8"));
  if (typeof version !== "string" || installed.name !== name || installed.version !== version) {
    throw new Error(`Installed DSH package differs from verified artifact: ${name}`);
  }
}
process.stdout.write(`Installed ${manifest.packageCount} verified patched DSH packages for repository checks\n`);
