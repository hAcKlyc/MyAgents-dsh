#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";

import { ESLint } from "eslint";

const root = resolve(import.meta.dirname, "..");
const baselinePath = resolve(root, "specs/lint/existing-deprecated-session-reads.json");

export function diagnosticIdentity(path, message, lineText) {
  return JSON.stringify([path, message.ruleId, message.message.split("\n", 1)[0], lineText.trim()]);
}

export function unexpectedDiagnostics(results, baseline, source) {
  const remaining = new Map(baseline.map(({ path, ruleId, message, lineText, count }) =>
    [diagnosticIdentity(path, { ruleId, message }, lineText), count]));
  const unexpected = [];
  for (const result of results) {
    const path = relative(root, result.filePath).replaceAll("\\", "/");
    const lines = source(result.filePath).split(/\r?\n/);
    for (const message of result.messages) {
      const lineText = lines[(message.line ?? 1) - 1] ?? "";
      const identity = diagnosticIdentity(path, message, lineText);
      const available = remaining.get(identity) ?? 0;
      if (available > 0) {
        remaining.set(identity, available - 1);
      } else {
        unexpected.push({ path, line: message.line, ruleId: message.ruleId, message: message.message });
      }
    }
  }
  return unexpected;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const results = await new ESLint({ cwd: root }).lintFiles(".");
  const unexpected = unexpectedDiagnostics(results, baseline, (path) => readFileSync(path, "utf8"));
  if (unexpected.length > 0) {
    for (const item of unexpected) {
      process.stderr.write(`${item.path}:${item.line} ${item.ruleId}: ${item.message}\n`);
    }
    process.stderr.write(`${unexpected.length} new lint diagnostics; existing deprecated Session reads are grandfathered exactly\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Lint passed; no new diagnostics beyond the recorded deprecated Session reads\n");
  }
}
