import assert from "node:assert/strict";
import test from "node:test";

import { nativeReleaseTarget } from "./build-release-target.mjs";

test("Release target follows the native process architecture", () => {
  assert.equal(nativeReleaseTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(nativeReleaseTarget("darwin", "x64"), "darwin-x64");
  assert.equal(nativeReleaseTarget("win32", "x64"), "win32-x64");
  assert.throws(() => nativeReleaseTarget("linux", "arm64"), /Unsupported/);
});
