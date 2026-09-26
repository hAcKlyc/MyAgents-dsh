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

export function releaseNotesPath(requestedTag) {
  const tag = resolveReleaseTag(requestedTag);
  return resolve(import.meta.dirname, "../release-notes", `${tag}.md`);
}

export function assertReleaseNotesHeading(tag, notes) {
  if (notes.split(/\r?\n/, 1)[0] !== `# MyAgents-dsh ${tag.slice(1)}`) {
    throw new Error(`release-notes/${tag}.md heading must match the Release version`);
  }
}
