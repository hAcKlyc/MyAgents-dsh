#!/usr/bin/env node
/** Cross-release persistence acceptance; explicit artifacts and synthetic homes only. */
import assert from 'node:assert/strict';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyInstalledRuntimeArtifact } from '@myagents-dsh/artifact-verifier/runtime-artifact';
import { verifyExistingBundle } from './build-patched-dsh-artifact.js';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: {
  'old-artifact': { type: 'string' }, 'old-manifest-sha256': { type: 'string' },
  'candidate-root': { type: 'string' }, 'candidate-artifact': { type: 'string' },
  'candidate-manifest-sha256': { type: 'string' }, out: { type: 'string' },
} });
for (const key of ['old-artifact', 'old-manifest-sha256', 'candidate-root', 'candidate-artifact', 'candidate-manifest-sha256', 'out']) {
  assert(values[key], `--${key} is required`);
}
assert(isAbsolute(values.out), '--out must be an absolute new directory');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const oldRoot = resolve(values['old-artifact']);
const candidateRoot = resolve(values['candidate-root']);
const candidateArtifact = resolve(values['candidate-artifact']);
const oldVerified = verifyInstalledRuntimeArtifact(oldRoot, values['old-manifest-sha256']);
verifyExistingBundle(candidateArtifact, values['candidate-manifest-sha256'], process.env);
const candidateManifest = JSON.parse(await readFile(resolve(candidateArtifact, 'patched-dsh-artifact-v1.json'), 'utf8'));
for (const item of candidateManifest.packages) {
  const installed = JSON.parse(await readFile(resolve(candidateRoot, 'node_modules', item.name, 'package.json'), 'utf8'));
  assert.equal(installed.version, candidateManifest.artifactVersion, `${item.name} must resolve the verified candidate package`);
}
const output = resolve(values.out);
await mkdir(output, { mode: 0o700 });
const oldHome = resolve(output, 'old-writer-home');
const newReadingOldHome = resolve(output, 'candidate-reading-old-home');
const newHome = resolve(output, 'candidate-writer-home');
const oldReadingNewHome = resolve(output, 'old-reading-candidate-home');
const oldProof = resolve(output, 'old-written.json');
const newProof = resolve(output, 'candidate-written.json');
const fixture = resolve(root, 'tests/fixtures/released-history.artifact.mjs');
const tsx = pathToFileURL(resolve(root, 'node_modules/tsx/dist/loader.mjs')).href;
const run = async (runtimeRoot, mode, home, proof) => {
  // Static public imports resolve through the selected installation without
  // changing the immutable artifact or allowing arbitrary module specifiers.
  const stage = resolve(output, 'fixture-staging', mode);
  await mkdir(stage, { recursive: true });
  await copyFile(fixture, resolve(stage, 'fixture.mjs'));
  await symlink(resolve(runtimeRoot, 'node_modules'), resolve(stage, 'node_modules'), 'junction');
  const hostHome = resolve(home, 'host-home');
  const temporary = resolve(home, 'tmp');
  await mkdir(hostHome, { recursive: true });
  await mkdir(temporary, { recursive: true });
  const environment = {
    ...Object.fromEntries(['PATH', 'SystemRoot', 'LANG', 'LC_ALL', 'TZ'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    HOME: hostHome, USERPROFILE: hostHome, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  };
  const stdout = execFileSync(process.execPath, ['--import', tsx, resolve(stage, 'fixture.mjs'), mode, home, proof],
    { cwd: root, env: environment, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim());
  await writeFile(resolve(output, `${mode}.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
};
const logs = async (home, directory = home) => {
  const found = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) Object.assign(found, await logs(home, path));
    else if (/\.jsonl(?:\.zstd?)?$/.test(item.name)) found[relative(home, path)] = await readFile(path);
  }
  assert(Object.keys(found).length > 0 || directory !== home, 'history fixture must persist native JSONL logs');
  return found;
};
const assertPreserved = async (before, home, exact) => {
  const after = await logs(home);
  for (const [path, bytes] of Object.entries(before)) {
    assert(after[path], `historical generation disappeared: ${path}`);
    assert(bytes.equals(exact ? after[path] : after[path].subarray(0, bytes.length)), `historical generation changed: ${path}`);
  }
};
const oldSeed = await run(oldRoot, 'seed-old', oldHome, oldProof);
const oldBytes = await logs(oldHome);
await cp(oldHome, newReadingOldHome, { recursive: true });
const forward = await run(candidateRoot, 'continue-new', newReadingOldHome, oldProof);
await assertPreserved(oldBytes, newReadingOldHome, false);
await assertPreserved(oldBytes, oldHome, true);
const newSeed = await run(candidateRoot, 'seed-new', newHome, newProof);
const newBytes = await logs(newHome);
await cp(newHome, oldReadingNewHome, { recursive: true });
const reverse = await run(oldRoot, 'read-old', oldReadingNewHome, newProof);
await assertPreserved(newBytes, oldReadingNewHome, false);
await assertPreserved(newBytes, newHome, true);
verifyInstalledRuntimeArtifact(oldRoot, values['old-manifest-sha256']);
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceDiff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const report = { schemaVersion: 1, outcome: 'passed',
  oldRuntime: { manifestSha256: oldVerified.manifestSha256 },
  candidate: { patchedDshManifestSha256: values['candidate-manifest-sha256'], sourceHead, sourceDiffSha256: sha(sourceDiff),
    fixtureSha256: sha(await readFile(fixture)), runnerSha256: sha(await readFile(import.meta.filename)) },
  oldSeed, forward, newSeed, reverse, nativeLogPrefixesPreserved: true, originalSyntheticHomesUnchanged: true,
  downgradeSupported: false };
const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(resolve(output, 'released-history-acceptance.json'), reportBytes);
process.stdout.write(`${JSON.stringify({ outcome: report.outcome, reportSha256: sha(reportBytes), output }, null, 2)}\n`);
