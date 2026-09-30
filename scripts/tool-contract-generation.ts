import { createHash } from "node:crypto";

import { Value } from "typebox/value";
import { buildToolCatalogSchema } from "../packages/protocol/src/tool-catalog-schema.js";
import { modelToolNames } from "../packages/protocol/src/native-tool-names.js";

import {
  CANONICAL_TOOL_CONTRACTS,
  CANONICAL_TOOL_NAMES,
  isOfficialShellTool,
  CANONICAL_TOOL_REUSE_MATRIX,
  CANONICAL_TOOL_SCHEMA_FIXTURES,
  TOOL_CONTRACT_SOURCE,
  canonicalToolContractAuthority,
  orderedCanonicalToolReuseMatrix,
} from "../packages/tool-contracts/src/contract-source.js";
import {
  compareCodePoints,
  stableJson,
} from "../packages/tool-contracts/src/schema.js";

export { TOOL_CONTRACT_SOURCE };

const TOOL_CONTRACT_GENERATOR_SOURCES = [
  "scripts/generate-tool-contracts.ts",
  "scripts/tool-contract-generation.ts",
  "packages/protocol/src/tool-catalog-schema.ts",
  "packages/protocol/src/native-tool-names.ts",
] as const;

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const exactCanonicalAuthority = (): void => {
  const contractNames = Object.keys(CANONICAL_TOOL_CONTRACTS);
  const reuseNames = Object.keys(CANONICAL_TOOL_REUSE_MATRIX);
  if (JSON.stringify(contractNames) !== JSON.stringify(CANONICAL_TOOL_NAMES)
    || JSON.stringify(reuseNames) !== JSON.stringify(CANONICAL_TOOL_NAMES)
    || new Set(CANONICAL_TOOL_NAMES).size !== CANONICAL_TOOL_NAMES.length) {
    throw new Error("canonical tool source must own unique names in model order");
  }
  const behaviorIds = new Set<string>();
  for (const name of CANONICAL_TOOL_NAMES) {
    const contract = CANONICAL_TOOL_CONTRACTS[name];
    const fixture = CANONICAL_TOOL_SCHEMA_FIXTURES[name];
    const reuse = CANONICAL_TOOL_REUSE_MATRIX[name];
    if (contract.name !== name || reuse.tool !== name) {
      throw new Error(`${name} contract or DSH reuse identity is inconsistent`);
    }
    if (!Value.Check(contract.inputSchema, fixture.input)) {
      throw new Error(`${name} minimum input fixture does not satisfy its canonical schema`);
    }
    if (!Value.Check(contract.executionInputSchema, fixture.input)) {
      throw new Error(`${name} minimum input fixture does not satisfy its execution schema`);
    }
    if (!Value.Check(contract.outputSchema, fixture.output)) {
      throw new Error(`${name} minimum output fixture does not satisfy its canonical schema`);
    }
    if (!isOfficialShellTool(name) && Value.Check(contract.inputSchema, { ...fixture.input, unexpected: true })) {
      throw new Error(`${name} input schema is not strict`);
    }
    if (!isOfficialShellTool(name) && Value.Check(contract.executionInputSchema, { ...fixture.input, unexpected: true })) {
      throw new Error(`${name} execution input schema is not strict`);
    }
    const invalidOutput = Object.assign({}, fixture.output, { unexpected: true });
    if (Value.Check(contract.outputSchema, invalidOutput)) {
      throw new Error(`${name} output schema is not strict`);
    }
    if (new Set(contract.behaviorFixtureIds).size !== contract.behaviorFixtureIds.length) {
      throw new Error(`${name} must own at least five unique behavior fixtures`);
    }
    for (const id of contract.behaviorFixtureIds) {
      if (!/^[a-z0-9][a-z0-9_]*$/u.test(id) || behaviorIds.has(`${name}:${id}`)) {
        throw new Error(`${name} behavior fixture identity is invalid or duplicated: ${id}`);
      }
      behaviorIds.add(`${name}:${id}`);
    }
    if (new Set(contract.errorCodes.map(({ code }) => code)).size !== contract.errorCodes.length) {
      throw new Error(`${name} must own a non-empty unique error vocabulary`);
    }
    if (!Number.isSafeInteger(contract.outputLimits.maxInlineBytes)
      || !Number.isSafeInteger(contract.outputLimits.maxStructuredItems)
      || contract.outputLimits.maxInlineBytes <= 0
      || contract.outputLimits.maxStructuredItems <= 0) {
      throw new Error(`${name} output limits must be positive safe integers`);
    }
    for (const seam of reuse.dshPublicReuse) {
      if (!/^@deepseek-ai\/(?:cordis|dsh-[a-z0-9-]+)$/u.test(seam.importPath)
        || seam.importPath.includes("/src/") || seam.importPath.includes("/dist/")
        || new Set(seam.symbols).size !== seam.symbols.length) {
        throw new Error(`${name} DSH reuse must use one public package root and explicit symbols`);
      }
    }
  }
};

export type ToolContractArtifacts = ReadonlyMap<string, string>;

export const buildToolContractArtifacts = (): ToolContractArtifacts => {
  exactCanonicalAuthority();
  const contractAuthority = canonicalToolContractAuthority();
  const contractBytes = stableJson(contractAuthority);
  const contractSha256 = sha256(contractBytes);
  const reuseAuthority = {
    artifactFormatVersion: 1,
    profile: "canonical-agent-experience-v1",
    contractSha256,
    decisions: orderedCanonicalToolReuseMatrix(),
  };
  const reuseBytes = stableJson(reuseAuthority);
  const reuseSha256 = sha256(reuseBytes);
  const fixtureAuthority = {
    artifactFormatVersion: 1,
    contractSha256,
    tools: CANONICAL_TOOL_NAMES.map((name) => ({
      name,
      validInput: CANONICAL_TOOL_SCHEMA_FIXTURES[name].input,
      validOutput: CANONICAL_TOOL_SCHEMA_FIXTURES[name].output,
      invalidInput: { ...CANONICAL_TOOL_SCHEMA_FIXTURES[name].input, unexpected: true },
      behaviorFixtureIds: CANONICAL_TOOL_CONTRACTS[name].behaviorFixtureIds,
    })),
  };
  const fixtureBytes = stableJson(fixtureAuthority);
  const fixtureSha256 = sha256(fixtureBytes);
  const catalogSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "MyAgents DSH effective canonical tool catalog",
    ...buildToolCatalogSchema(modelToolNames(CANONICAL_TOOL_NAMES), contractSha256),
  };
  const catalogSchemaBytes = stableJson(catalogSchema);
  const toolDigests = Object.fromEntries(CANONICAL_TOOL_NAMES.map((name) => [
    name,
    sha256(stableJson(CANONICAL_TOOL_CONTRACTS[name])),
  ]));
  const documentationBytes = [
    "<!-- Generated by scripts/generate-tool-contracts.ts. Do not edit by hand. -->",
    "",
    "# Canonical tool contract and DSH reuse projection",
    "",
    `Contract SHA-256: \`${contractSha256}\``,
    "",
    "| Tool | Concurrency | Side effect | Permission | Checkpoint | Public DSH reuse | Product owner |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...CANONICAL_TOOL_NAMES.map((name) => {
      const contract = CANONICAL_TOOL_CONTRACTS[name];
      const reuse = CANONICAL_TOOL_REUSE_MATRIX[name];
      return `| \`${name}\` | \`${contract.concurrency}\` | \`${contract.sideEffect}\` | \`${contract.permissionClass}\` | \`${contract.checkpoint}\` | ${reuse.dshPublicReuse.map(({ importPath, classification }) => `\`${importPath}\` (${classification})`).join("<br>")} | \`${reuse.productOwner}\` |`;
    }),
    "",
    "Shell and Job tools use official DSH definitions. Other tools retain their explicitly recorded product contracts.",
    "",
  ].join("\n");
  const metaBytes = stableJson({
    artifactFormatVersion: 1,
    profile: "canonical-agent-experience-v1",
    authority: "packages/tool-contracts/src/contract-source.ts",
    generator: "scripts/generate-tool-contracts.ts",
    generatorSources: TOOL_CONTRACT_GENERATOR_SOURCES,
    canonicalToolCount: CANONICAL_TOOL_NAMES.length,
    behaviorFixtureCount: CANONICAL_TOOL_NAMES.reduce(
      (count, name) => count + CANONICAL_TOOL_CONTRACTS[name].behaviorFixtureIds.length,
      0,
    ),
    contractSha256,
    toolDigests,
    reuseMatrixSha256: reuseSha256,
    fixturesSha256: fixtureSha256,
    catalogSchemaSha256: sha256(catalogSchemaBytes),
    documentationSha256: sha256(documentationBytes),
  });
  const protocolProjection = [
    "// Generated by scripts/generate-tool-contracts.ts. Do not edit by hand.",
    `export const CANONICAL_TOOL_NAMES = Object.freeze(${JSON.stringify(CANONICAL_TOOL_NAMES)} as const);`,
    "export type CanonicalToolName = (typeof CANONICAL_TOOL_NAMES)[number];",
    `export const CANONICAL_TOOL_CONTRACT_SHA256 = ${JSON.stringify(contractSha256)} as const;`,
    "",
  ].join("\n");
  const evidenceBytes = stableJson({
    artifactFormatVersion: 1,
    profile: "canonical-agent-experience-v1",
    authority: "packages/tool-contracts/src/contract-source.ts",
    generator: "scripts/generate-tool-contracts.ts",
    generatorSources: TOOL_CONTRACT_GENERATOR_SOURCES,
    source: TOOL_CONTRACT_SOURCE,
    contractSha256,
    toolDigests,
    inventory: {
      canonicalToolCount: CANONICAL_TOOL_NAMES.length,
      behaviorFixtureCount: CANONICAL_TOOL_NAMES.reduce(
        (count, name) => count + CANONICAL_TOOL_CONTRACTS[name].behaviorFixtureIds.length,
        0,
      ),
      compatToolCount: CANONICAL_TOOL_NAMES.filter((name) => CANONICAL_TOOL_REUSE_MATRIX[name].modelDefinition === "compat-tool").length,
      stockModelDefinitionCount: CANONICAL_TOOL_NAMES.filter((name) => CANONICAL_TOOL_REUSE_MATRIX[name].modelDefinition === "official-tool").length,
    },
    outputs: {
      "canonical-tool-contracts-v1.json": sha256(contractBytes),
      "dsh-reuse-matrix-v1.json": sha256(reuseBytes),
      "catalog-fixtures-v1.json": sha256(fixtureBytes),
      "tool-catalog.schema.json": sha256(catalogSchemaBytes),
      "tool-contract-meta.json": sha256(metaBytes),
      "canonical-tools.generated.ts": sha256(protocolProjection),
      "canonical-tools-v1.md": sha256(documentationBytes),
    },
    bindings: [
      "packages/protocol/generated/canonical-tools.generated.ts",
      "packages/protocol/generated/protocol-meta.json",
      "packages/product-profile/manifests/batch-1-candidate-profile-v1.json",
    ],
  });
  const outputs: Array<readonly [string, string]> = [
    ["packages/tool-contracts/generated/canonical-tool-contracts-v1.json", contractBytes],
    ["packages/tool-contracts/generated/dsh-reuse-matrix-v1.json", reuseBytes],
    ["packages/tool-contracts/generated/catalog-fixtures-v1.json", fixtureBytes],
    ["packages/tool-contracts/generated/tool-catalog.schema.json", catalogSchemaBytes],
    ["packages/tool-contracts/generated/tool-contract-meta.json", metaBytes],
    ["packages/protocol/generated/canonical-tools.generated.ts", protocolProjection],
    ["specs/contracts/canonical-tools-v1-evidence.json", evidenceBytes],
    ["specs/contracts/canonical-tools-v1.md", documentationBytes],
  ];
  return new Map(outputs.sort(([left], [right]) => compareCodePoints(left, right)));
};

export const findToolContractDrift = async (
  artifacts: ToolContractArtifacts,
  readCurrent: (relativePath: string) => Promise<string | undefined>,
): Promise<string[]> => {
  const failures: string[] = [];
  for (const [relativePath, bytes] of artifacts) {
    if (await readCurrent(relativePath) !== bytes) failures.push(relativePath);
  }
  return failures;
};
