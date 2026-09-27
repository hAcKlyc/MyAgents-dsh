import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertSanitizedBytes,
  canonicalJsonText,
  MAX_EVIDENCE_ARRAY_LENGTH,
  sanitizeEvidence,
  type CanonicalJson,
  type EvidenceRedactionPolicy,
} from "./redaction.js";
import { createBlankExperienceReport } from "./reporter.js";

export interface DynamicEvidenceInput {
  readonly run: unknown;
  readonly publicEvents: readonly unknown[];
  readonly diagnosticFacts: unknown;
  readonly workspaceBefore: unknown;
  readonly workspaceAfter: unknown;
  readonly resourceFinal: unknown;
  readonly hardAssertions: unknown;
}

export interface SealedEvidenceIdentity {
  readonly root: string;
  readonly manifestSha256: string;
  readonly files: readonly Readonly<{ path: string; size: number; sha256: string }>[];
}

type EvidencePhase = "black_box" | "terminal" | "sealed";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const compareCodePoint = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const writeExclusive = async (path: string, bytes: Uint8Array | string): Promise<void> => {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
};

export class DynamicEvidenceRecorder {
  #phase: EvidencePhase = "black_box";
  readonly #publicEvents: unknown[] = [];
  readonly #diagnosticFacts: unknown[] = [];

  get phase(): EvidencePhase { return this.#phase; }

  recordPublicEvent(event: unknown): void {
    if (this.#phase !== "black_box") throw new Error("public events are closed after black-box terminal");
    if (this.#publicEvents.length >= MAX_EVIDENCE_ARRAY_LENGTH) {
      throw new Error("public event evidence exceeded its bound");
    }
    this.#publicEvents.push(structuredClone(event));
  }

  recordDiagnosticFact(fact: unknown): void {
    if (this.#phase === "sealed") throw new Error("diagnostic facts are closed after sealing");
    if (this.#diagnosticFacts.length >= MAX_EVIDENCE_ARRAY_LENGTH) {
      throw new Error("diagnostic evidence exceeded its bound");
    }
    this.#diagnosticFacts.push(structuredClone(fact));
  }

  markTerminal(): void {
    if (this.#phase !== "black_box") throw new Error("dynamic evidence terminal transition is not repeatable");
    this.#phase = "terminal";
  }

  publicEvents(): readonly unknown[] { return Object.freeze(structuredClone(this.#publicEvents)); }

  diagnosticFactsForTester(): readonly unknown[] {
    if (this.#phase === "black_box") {
      throw new Error("diagnostic facts are unavailable before black-box evidence is terminal");
    }
    return Object.freeze(structuredClone(this.#diagnosticFacts));
  }

  consumeForSeal(): Readonly<{ publicEvents: readonly unknown[]; diagnosticFacts: readonly unknown[] }> {
    if (this.#phase !== "terminal") throw new Error("dynamic evidence can seal only after terminal");
    this.#phase = "sealed";
    return Object.freeze({
      publicEvents: Object.freeze(structuredClone(this.#publicEvents)),
      diagnosticFacts: Object.freeze(structuredClone(this.#diagnosticFacts)),
    });
  }
}

const sanitize = (value: unknown, policy: EvidenceRedactionPolicy): CanonicalJson =>
  sanitizeEvidence(value, policy);

export const sealDynamicEvidence = async (options: Readonly<{
  root: string;
  runId: string;
  scenarioId: string;
  input: DynamicEvidenceInput;
  redaction: EvidenceRedactionPolicy;
}>): Promise<SealedEvidenceIdentity> => {
  if ((await readdir(options.root)).length !== 0) throw new Error("dynamic evidence root must be empty before sealing");
  const jsonFiles: Readonly<Record<string, CanonicalJson>> = Object.freeze({
    "run.json": sanitize(options.input.run, options.redaction),
    "diagnostic-facts.json": sanitize(options.input.diagnosticFacts, options.redaction),
    "workspace-before.json": sanitize(options.input.workspaceBefore, options.redaction),
    "workspace-after.json": sanitize(options.input.workspaceAfter, options.redaction),
    "resource-final.json": sanitize(options.input.resourceFinal, options.redaction),
    "hard-assertions.json": sanitize(options.input.hardAssertions, options.redaction),
  });
  const publicEvents = options.input.publicEvents.map((event) => sanitize(event, options.redaction));
  const contents = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(jsonFiles)) {
    contents.set(path, Buffer.from(canonicalJsonText(value)));
  }
  contents.set(
    "public-events.ndjson",
    Buffer.from(publicEvents.map((event) => JSON.stringify(event)).join("\n") + (publicEvents.length === 0 ? "" : "\n")),
  );
  contents.set(
    "experience-report.md",
    Buffer.from(createBlankExperienceReport(options.runId, options.scenarioId)),
  );
  const files = [...contents.entries()]
    .sort(([left], [right]) => compareCodePoint(left, right))
    .map(([path, bytes]) => Object.freeze({ path, size: bytes.length, sha256: sha256(bytes) }));
  const manifest = sanitize({
    schemaVersion: 1,
    state: "sealed",
    runId: options.runId,
    scenarioId: options.scenarioId,
    files,
  }, options.redaction);
  const manifestBytes = Buffer.from(canonicalJsonText(manifest));
  for (const [path, bytes] of contents) {
    assertSanitizedBytes(bytes, options.redaction);
    await writeExclusive(resolve(options.root, path), bytes);
  }
  assertSanitizedBytes(manifestBytes, options.redaction);
  await writeExclusive(resolve(options.root, "manifest.json"), manifestBytes);
  await Promise.all([...contents.keys(), "manifest.json"].map(async (path) => {
    await chmod(resolve(options.root, path), 0o400);
  }));
  return Object.freeze({
    root: options.root,
    manifestSha256: sha256(manifestBytes),
    files: Object.freeze(files),
  });
};

export const verifySealedDynamicEvidence = async (
  root: string,
  expectedManifestSha256?: string,
): Promise<SealedEvidenceIdentity> => {
  const lexicalRoot = resolve(root);
  const rootEntry = await lstat(lexicalRoot);
  if (await realpath(lexicalRoot) !== lexicalRoot || !rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new TypeError("sealed dynamic evidence root must be canonical and non-symlinked");
  }
  const names = (await readdir(lexicalRoot)).sort(compareCodePoint);
  const expectedNames = [
    "diagnostic-facts.json", "experience-report.md", "hard-assertions.json", "manifest.json",
    "public-events.ndjson", "resource-final.json", "run.json", "workspace-after.json", "workspace-before.json",
  ].sort(compareCodePoint);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error("sealed dynamic evidence contains missing or unowned files");
  }
  const manifestPath = resolve(lexicalRoot, "manifest.json");
  const manifestEntry = await lstat(manifestPath);
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink() || manifestEntry.nlink !== 1
    || (process.platform !== "win32" && (manifestEntry.mode & 0o777) !== 0o400)) {
    throw new TypeError("sealed dynamic evidence manifest identity is unsafe");
  }
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (expectedManifestSha256 !== undefined && manifestSha256 !== expectedManifestSha256) {
    throw new Error("sealed dynamic evidence manifest differs from the expected digest");
  }
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("sealed dynamic evidence manifest is invalid");
  }
  const object = manifest as Record<string, unknown>;
  if (object.schemaVersion !== 1 || object.state !== "sealed" || !Array.isArray(object.files)) {
    throw new TypeError("sealed dynamic evidence manifest authority is invalid");
  }
  const files: Array<Readonly<{ path: string; size: number; sha256: string }>> = [];
  for (const entry of object.files) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("sealed dynamic evidence file entry is invalid");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.sha256 !== "string"
      || !Number.isSafeInteger(record.size) || (record.size as number) < 0) {
      throw new TypeError("sealed dynamic evidence file identity is invalid");
    }
    const path = record.path;
    if (!expectedNames.includes(path) || path === "manifest.json") {
      throw new TypeError("sealed dynamic evidence manifest references an invalid path");
    }
    const filePath = resolve(lexicalRoot, path);
    const fileEntry = await lstat(filePath);
    if (!fileEntry.isFile() || fileEntry.isSymbolicLink() || fileEntry.nlink !== 1
      || (process.platform !== "win32" && (fileEntry.mode & 0o777) !== 0o400)) {
      throw new TypeError("sealed dynamic evidence file identity is unsafe");
    }
    const bytes = await readFile(filePath);
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256) {
      throw new Error("sealed dynamic evidence file bytes differ from the manifest");
    }
    files.push(Object.freeze({ path, size: bytes.length, sha256: record.sha256 }));
  }
  if (files.length !== expectedNames.length - 1 || new Set(files.map(({ path }) => path)).size !== files.length) {
    throw new Error("sealed dynamic evidence file inventory is incomplete or duplicated");
  }
  return Object.freeze({ root: lexicalRoot, manifestSha256, files: Object.freeze(files) });
};
