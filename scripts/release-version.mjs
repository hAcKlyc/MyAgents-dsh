import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packagePath = resolve(import.meta.dirname, "../package.json");

export function configuredReleaseTag() {
  const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Root package.json must declare a valid MyAgents-dsh release version");
  }
  return `v${version}`;
}

export function resolveReleaseTag(requestedTag) {
  const configuredTag = configuredReleaseTag();
  if (requestedTag !== undefined && requestedTag !== configuredTag) {
    throw new Error(`Release tag ${requestedTag} differs from package.json version ${configuredTag}`);
  }
  return configuredTag;
}
