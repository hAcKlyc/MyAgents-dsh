import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { WEB_HOST_CONTRACT_VERSION } from "@myagents-dsh/web-host-contract/schemas";

type JsonRecord = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, "..");
const failures: string[] = [];
const assert = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};
const readObject = async (relativePath: string): Promise<JsonRecord> => {
  const value: unknown = JSON.parse(await readFile(resolve(repositoryRoot, relativePath), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${relativePath} must contain an object`);
  }
  return value as JsonRecord;
};
const exactKeys = (value: JsonRecord, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

const requiredScenarioIds = [
  "accessibility-keyboard-focus-live-region",
  "artifact-clean-install-static-digests",
  "attachment-bounds-preview-lease-release",
  "browser-command-closed-union",
  "browser-json-canonical-trap-free",
  "browser-reload-reconnect-resync",
  "catalog-atomic-bounded-no-transcript",
  "catalog-corruption-quarantine",
  "component-inspect-replace-reload-health",
  "credential-secret-canary-browser-log-catalog",
  "csrf-cookie-origin-host-content-type",
  "csp-no-remote-assets-worker-frame",
  "direct-open-macos-arm64",
  "exact-runtime-browser-complete-flow",
  "host-hook-tool-fail-closed",
  "interaction-register-render-settle-stale",
  "launch-capability-one-time-token-free-redirect",
  "long-history-bounded-render-performance",
  "loopback-ipv4-ipv6-no-wildcard",
  "multi-session-one-runtime-process-each",
  "mutation-prepare-status-commit-rollback-purge",
  "mutation-typed-confirmation-stale-token",
  "process-crash-restart-resume-recovery",
  "process-quiescent-cleanup-no-orphans",
  "responsive-320px-zoom-cjk-theme-motion",
  "reverse-port-generation-staleness-cleanup",
  "runtime-event-projection-all-kinds",
  "session-create-select-cold-stop-resume-close",
  "session-read-pagination-rebuild",
  "slow-consumer-sse-backpressure-resync",
  "sse-typed-sequence-replay-cursor",
  "static-traversal-method-body-deadline-bounds",
  "turn-start-steer-follow-up-queue-interrupt",
  "ui-provenance-license-no-copied-myagents",
  "windows-linux-implementation-pending-native-label",
  "workspace-path-authority-no-browser-escape",
] as const;

const [matrix, provenance, metadata] = await Promise.all([
  readObject("specs/contracts/reference-web-host-acceptance-v1.json"),
  readObject("specs/contracts/reference-web-host-ui-provenance-v1.json"),
  readObject("packages/web-host-contract/generated/browser-contract-meta.json"),
]);

assert(exactKeys(matrix, ["formatVersion", "contractVersion", "scope", "entries"]), "acceptance matrix top-level shape is closed");
assert(matrix.formatVersion === 1, "acceptance matrix formatVersion must be 1");
assert(matrix.contractVersion === WEB_HOST_CONTRACT_VERSION, "acceptance matrix contract version must match source");
assert(matrix.scope === "batch-1-reference-web-host", "acceptance matrix scope must remain fixed");
const entries = Array.isArray(matrix.entries) ? matrix.entries : [];
const ids: string[] = [];
for (const [index, value] of entries.entries()) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failures.push(`acceptance entry ${index} must be an object`);
    continue;
  }
  const entry = value as JsonRecord;
  assert(exactKeys(entry, ["id", "owner", "layer", "evidence", "status"]), `acceptance entry ${index} shape is closed`);
  if (typeof entry.id === "string") ids.push(entry.id);
  else failures.push(`acceptance entry ${index} id must be a string`);
  assert(typeof entry.owner === "string" && entry.owner.length > 0, `acceptance entry ${index} owner is required`);
  assert(typeof entry.layer === "string" && entry.layer.length > 0, `acceptance entry ${index} layer is required`);
  assert(typeof entry.evidence === "string" && entry.evidence.length > 0, `acceptance entry ${index} evidence is required`);
  assert(entry.status === "required", `acceptance entry ${index} must remain required`);
}
assert(new Set(ids).size === ids.length, "acceptance scenario ids must be unique");
assert(
  JSON.stringify([...ids].sort()) === JSON.stringify([...requiredScenarioIds].sort()),
  "acceptance scenario inventory must match the fixed W5 matrix",
);

assert(exactKeys(provenance, ["formatVersion", "policy", "sources"]), "UI provenance top-level shape is closed");
assert(provenance.formatVersion === 1, "UI provenance formatVersion must be 1");
assert(provenance.policy === "clean-room-unless-explicitly-recorded", "UI provenance policy must remain clean-room");
const sources = Array.isArray(provenance.sources) ? provenance.sources : [];
assert(sources.length === 2, "UI provenance must bind exactly DSH and MyAgents references");
const expectedSources = new Map([
  ["deepseek-harness-webui", {
    revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    licenseBlob: "c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785",
    use: "visual-and-interaction-reference",
  }],
  ["myagents-client", {
    revision: "e444872834fbf7ec2869d7bad6aa718c290e522a",
    licenseBlob: "be3f7b28e564e7dd05eaf59d64adba1a4065ac0e",
    use: "product-interaction-research-only",
  }],
]);
for (const [index, value] of sources.entries()) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failures.push(`UI provenance source ${index} must be an object`);
    continue;
  }
  const source = value as JsonRecord;
  assert(exactKeys(source, ["id", "repository", "revision", "license", "licenseBlob", "surfaces", "use", "copiedFiles", "copiedAssets"]), `UI provenance source ${index} shape is closed`);
  const expected = typeof source.id === "string" ? expectedSources.get(source.id) : undefined;
  assert(expected !== undefined, `UI provenance source ${index} id is recognized`);
  if (expected !== undefined) {
    assert(source.revision === expected.revision, `${source.id as string} revision remains exact`);
    assert(source.licenseBlob === expected.licenseBlob, `${source.id as string} license blob remains exact`);
    assert(source.use === expected.use, `${source.id as string} use policy remains exact`);
  }
  assert(Array.isArray(source.copiedFiles) && source.copiedFiles.length === 0, `UI provenance source ${index} copies no files`);
  assert(Array.isArray(source.copiedAssets) && source.copiedAssets.length === 0, `UI provenance source ${index} copies no assets`);
}
assert(metadata.contractVersion === WEB_HOST_CONTRACT_VERSION, "generated browser metadata matches contract source");
assert(typeof metadata.schemaSha256 === "string" && /^[a-f0-9]{64}$/u.test(metadata.schemaSha256), "generated browser schema digest is valid");

if (failures.length > 0) {
  for (const failure of failures) console.error(`reference Web Host foundation: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`reference Web Host foundation OK: ${ids.length} required scenarios, ${sources.length} provenance sources`);
}
