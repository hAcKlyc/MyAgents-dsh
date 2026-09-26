import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { verifyReleaseTag } from "./verify-release-tag.mjs";

const notes = readFileSync(resolve(import.meta.dirname, "../RELEASE_NOTES.md"), "utf8");
const sha = "a".repeat(40);

test("release tag requires a stable package version and matching notes", () => {
  assert.doesNotThrow(() => verifyReleaseTag("v0.1.0", sha, sha, notes));
  assert.throws(() => verifyReleaseTag("v0.1.1", sha, sha, notes), /stable root package version/);
  assert.throws(() => verifyReleaseTag("v0.1.0", sha, sha, "# Wrong\n"), /heading/);
});
