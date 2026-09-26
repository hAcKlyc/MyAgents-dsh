import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

import { configuredReleaseTag, releaseNotesPath } from "./release-version.mjs";
import { verifyReleaseTag } from "./verify-release-tag.mjs";

const tag = configuredReleaseTag();
const otherTag = tag.replace(/\d+$/, (patch) => String(Number(patch) + 1));
const notes = readFileSync(releaseNotesPath(tag), "utf8");
const sha = "a".repeat(40);

test("release tag requires a stable package version and matching notes", () => {
  assert.equal(relative(resolve(import.meta.dirname, ".."), releaseNotesPath(tag)),
    `release-notes/${tag}.md`);
  assert.doesNotThrow(() => verifyReleaseTag(tag, sha, sha, notes));
  assert.throws(() => verifyReleaseTag(otherTag, sha, sha, notes), /stable root package version/);
  assert.throws(() => verifyReleaseTag(tag, sha, sha, "# Wrong\n"), /heading/);
});
