import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { unexpectedDiagnostics } from "./lint-repository.mjs";

const path = resolve(import.meta.dirname, "../packages/example.ts");
const message = { line: 1, ruleId: "@typescript-eslint/no-deprecated", message: "`snapshotEvents` is deprecated.\nDetails" };
const baseline = [{ path: "packages/example.ts", ruleId: message.ruleId,
  message: "`snapshotEvents` is deprecated.", lineText: "session.snapshotEvents()", count: 1 }];

test("grandfathers one exact existing read but rejects a new duplicate or a changed call", () => {
  const report = (messages, source) => unexpectedDiagnostics([{ filePath: path, messages }], baseline, () => source);
  assert.deepEqual(report([message], "session.snapshotEvents()"), []);
  assert.equal(report([message, message], "session.snapshotEvents()").length, 1);
  assert.equal(report([message], "other.snapshotEvents()").length, 1);
  assert.equal(report([{ ...message, ruleId: "other-rule" }], "session.snapshotEvents()").length, 1);
});
