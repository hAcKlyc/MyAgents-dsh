import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { describe, expect, it } from "vitest";

import { BATCH1_CANDIDATE_PROFILE } from "../packages/product-profile/src/index.js";
import {
  CANONICAL_TOOL_CONTRACT_SHA256 as PROTOCOL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES as PROTOCOL_TOOL_NAMES,
  ToolCatalogSchema,
} from "../packages/protocol/src/index.js";
import {
  CANONICAL_TOOL_CONTRACT_SHA256 as TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_CONTRACTS,
  CANONICAL_TOOL_NAMES,
  CANONICAL_TOOL_REUSE_MATRIX,
  CANONICAL_TOOL_SCHEMA_FIXTURES,
  canonicalInputSchemaForDsh,
  effectiveToolCatalogDigest,
  validateCanonicalToolInput,
  validateCanonicalToolOutput,
  validateEffectiveToolCatalog,
} from "../packages/tool-contracts/src/index.js";
import { publicSeams } from "../scripts/dsh-baseline-policy.js";
import {
  TOOL_CONTRACT_SOURCE,
  buildToolContractArtifacts,
  findToolContractDrift,
} from "../scripts/tool-contract-generation.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("canonical twenty-tool contract authority", () => {
  it("owns the only exact ordered model catalog and immutable per-tool facts", () => {
    expect(CANONICAL_TOOL_NAMES).toEqual([
      "Read", "Write", "Edit", "Glob", "Grep", "Bash", "ls",
      "WebFetch", "WebSearch", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
      "Skill", "Agent", "TaskStop", "SendMessage",
      "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
    ]);
    expect(PROTOCOL_TOOL_NAMES).toEqual(CANONICAL_TOOL_NAMES);
    expect(TOOL_CONTRACT_SHA256).toBe(PROTOCOL_TOOL_CONTRACT_SHA256);
    expect(Object.isFrozen(CANONICAL_TOOL_NAMES)).toBe(true);
    expect(Object.isFrozen(PROTOCOL_TOOL_NAMES)).toBe(true);
    expect(() => (CANONICAL_TOOL_NAMES as unknown as string[]).pop()).toThrow(TypeError);
    expect(() => (PROTOCOL_TOOL_NAMES as unknown as string[]).splice(0, 1)).toThrow(TypeError);
    expect(CANONICAL_TOOL_NAMES).toHaveLength(20);
    expect(PROTOCOL_TOOL_NAMES).toHaveLength(20);
    expect(Object.keys(CANONICAL_TOOL_CONTRACTS)).toEqual(CANONICAL_TOOL_NAMES);
    expect(Object.keys(CANONICAL_TOOL_REUSE_MATRIX)).toEqual(CANONICAL_TOOL_NAMES);
    expect(Object.isFrozen(CANONICAL_TOOL_CONTRACTS)).toBe(true);
    expect(Object.isFrozen(CANONICAL_TOOL_REUSE_MATRIX)).toBe(true);

    for (const name of CANONICAL_TOOL_NAMES) {
      const contract = CANONICAL_TOOL_CONTRACTS[name];
      expect(contract.name).toBe(name);
      expect(contract.description.length).toBeGreaterThan(40);
      expect(contract.behaviorFixtureIds).toHaveLength(5);
      expect(new Set(contract.behaviorFixtureIds).size).toBe(5);
      expect(contract.errorCodes.length).toBeGreaterThan(0);
      expect(contract.lifecycle.cancellation).toBe("abort_signal_exactly_one_terminal");
      expect(contract.lifecycle.durableResult).toBe("dsh_tool_result_before_runtime_visibility");
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.inputSchema)).toBe(true);
      expect(Object.isFrozen(contract.outputSchema)).toBe(true);
      expect(Object.isFrozen(contract.originPolicy)).toBe(true);
      expect(Object.isFrozen(contract.planPolicy)).toBe(true);
    }
    expect(CANONICAL_TOOL_CONTRACTS.Write.checkpoint).toBe("root_managed_file");
    expect(CANONICAL_TOOL_CONTRACTS.Edit.checkpoint).toBe("root_managed_file");
    expect(CANONICAL_TOOL_NAMES.filter((name) =>
      CANONICAL_TOOL_CONTRACTS[name].checkpoint === "root_managed_file")).toEqual(["Write", "Edit"]);
    expect(CANONICAL_TOOL_CONTRACTS.Agent.sideEffect).toBe("delegation");
    expect(CANONICAL_TOOL_CONTRACTS.SendMessage.sideEffect).toBe("delegation");
    expect(CANONICAL_TOOL_CONTRACTS.AskUserQuestion.timeoutMs).toBeUndefined();
    expect(CANONICAL_TOOL_CONTRACTS.Agent.inputSchema.properties).not.toHaveProperty("name");
    expect(CANONICAL_TOOL_CONTRACTS.Agent.description).toContain("taskId is for TaskStop");
    expect(CANONICAL_TOOL_CONTRACTS.SendMessage.description).toContain("agentId returned by Agent");
    expect(CANONICAL_TOOL_CONTRACTS.SendMessage.description).toContain("literal parent");
    expect(CANONICAL_TOOL_NAMES.filter((name) =>
      CANONICAL_TOOL_CONTRACTS[name].planPolicy.mode === "managed-plan-file-only")).toEqual(["Write", "Edit"]);
    expect(CANONICAL_TOOL_NAMES.filter((name) =>
      CANONICAL_TOOL_CONTRACTS[name].planPolicy.mode === "denied")).toEqual(["Bash", "TaskStop", "SendMessage"]);
    expect(CANONICAL_TOOL_CONTRACTS.Agent.planPolicy).toMatchObject({
      denialCode: "plan_safe_agent_unavailable",
      mode: "plan-safe-child-only",
    });
    expect(CANONICAL_TOOL_NAMES.filter((name) =>
      CANONICAL_TOOL_CONTRACTS[name].originPolicy.mode === "root-only")).toEqual(["EnterPlanMode", "Agent"]);
    expect(CANONICAL_TOOL_NAMES.filter((name) =>
      CANONICAL_TOOL_CONTRACTS[name].originPolicy.mode === "no-background-child"))
      .toEqual(["AskUserQuestion", "ExitPlanMode"]);
  });

  it("validates minimum input/output fixtures and rejects unknown or over-bound values", () => {
    for (const name of CANONICAL_TOOL_NAMES) {
      const contract = CANONICAL_TOOL_CONTRACTS[name];
      const fixture = CANONICAL_TOOL_SCHEMA_FIXTURES[name];
      expect(Value.Check(contract.inputSchema, fixture.input), `${name} input`).toBe(true);
      expect(Value.Check(contract.executionInputSchema, fixture.input), `${name} execution input`).toBe(true);
      expect(Value.Check(contract.outputSchema, fixture.output), `${name} output`).toBe(true);
      expect(validateCanonicalToolInput(name, fixture.input), `${name} guarded input`).toEqual(fixture.input);
      expect(validateCanonicalToolOutput(name, fixture.output), `${name} guarded output`).toEqual(fixture.output);
      expect(Value.Check(contract.inputSchema, {
        ...fixture.input,
        unexpected: true,
      }), `${name} unknown input`).toBe(false);
    }
    expect(Value.Check(CANONICAL_TOOL_CONTRACTS.Read.inputSchema, {
      file_path: `/${"x".repeat(8_192)}`,
    })).toBe(false);
    expect(Value.Check(CANONICAL_TOOL_CONTRACTS.Bash.inputSchema, {
      command: "fixture",
      timeout: 600_001,
    })).toBe(false);
    expect(validateCanonicalToolInput("Agent", {
      description: "调研子代理能力\n只读探索",
      prompt: "检查当前实现并返回结论。",
    })).toEqual({
      description: "调研子代理能力\n只读探索",
      prompt: "检查当前实现并返回结论。",
    });
    expect(Value.Check(CANONICAL_TOOL_CONTRACTS.Glob.outputSchema, {
      ...CANONICAL_TOOL_SCHEMA_FIXTURES.Glob.output,
      filenames: Array.from({ length: 101 }, (_, index) => `file-${index}`),
    })).toBe(false);
    expect(Value.Check(CANONICAL_TOOL_CONTRACTS.Write.outputSchema, {
      ...CANONICAL_TOOL_SCHEMA_FIXTURES.Write.output,
      sha256: "not-a-digest",
    })).toBe(false);
    expect(Value.Check(CANONICAL_TOOL_CONTRACTS.TaskCreate.inputSchema, {
      subject: "bounded metadata",
      description: "flat scalar metadata remains portable",
      metadata: { priority: 3, pinned: true, label: "ready", removed: null },
    })).toBe(true);
    for (const metadata of [{ nested: { value: "no" } }, { list: [1, 2] }]) {
      expect(Value.Check(CANONICAL_TOOL_CONTRACTS.TaskCreate.inputSchema, {
        subject: "structured metadata",
        description: "nested values are outside the portable Task contract",
        metadata,
      })).toBe(false);
    }
    expect(Value.Check(CANONICAL_TOOL_CONTRACTS.TaskCreate.inputSchema, {
      subject: "non-JSON metadata",
      description: "functions are never declarative extension input",
      metadata: { callback: () => undefined },
    })).toBe(false);
    expect(Value.Check(CANONICAL_TOOL_CONTRACTS.TaskCreate.inputSchema, {
      subject: "over-bound metadata",
      description: "metadata object work is bounded",
      metadata: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key-${index}`, index])),
    })).toBe(false);
    expect(Value.Check(CANONICAL_TOOL_CONTRACTS.TaskCreate.inputSchema, {
      subject: "invalid metadata key",
      description: "metadata keys are non-empty and bounded",
      metadata: { "": true },
    })).toBe(false);
    for (const exactPiLimit of [-1, 0, 0.5, 501, Number.MAX_VALUE]) {
      expect(validateCanonicalToolInput("ls", { limit: exactPiLimit })).toEqual({ limit: exactPiLimit });
    }
    const exactPiLongPath = "x".repeat(32_769);
    expect(validateCanonicalToolInput("ls", { path: exactPiLongPath })).toEqual({ path: exactPiLongPath });
    expect(() => validateCanonicalToolInput("ls", { limit: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("projects portable reference-free Task metadata schemas for every Provider family", () => {
    for (const name of ["TaskCreate", "TaskUpdate"] as const) {
      const schema = canonicalInputSchemaForDsh(CANONICAL_TOOL_CONTRACTS[name].inputSchema);
      const metadata = (schema as unknown as TSchema & {
        properties: Readonly<Record<string, TSchema>>;
      }).properties.metadata;
      const serialized = JSON.stringify(metadata);
      expect(serialized).not.toContain('"$ref"');
      expect(serialized).not.toContain("MetadataJsonValue");
      expect(serialized).not.toContain('"type":"array"');
      expect(serialized).toContain('"type":"string"');
      expect(serialized).toContain('"type":"number"');
      expect(serialized).toContain('"type":"boolean"');
      expect(serialized).toContain('"type":"null"');
    }
  });

  it("normalizes untrusted values without invoking accessors or Proxy traps", () => {
    let getterHits = 0;
    const accessorInput = { file_path: "/fixture.txt" } as Record<string, unknown>;
    Object.defineProperty(accessorInput, "content", {
      enumerable: true,
      get: () => {
        getterHits += 1;
        return "must-not-run";
      },
    });
    expect(() => validateCanonicalToolInput("Write", accessorInput)).toThrow(/own data property/u);
    expect(getterHits).toBe(0);

    let proxyTraps = 0;
    const proxyInput = new Proxy({ file_path: "/fixture.txt", content: "fixture" }, {
      get: (target, key, receiver) => {
        proxyTraps += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
      getOwnPropertyDescriptor: (target, key) => {
        proxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf: (target) => {
        proxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => validateCanonicalToolInput("Write", proxyInput)).toThrow(/Proxy/u);
    expect(proxyTraps).toBe(0);

    class MetadataClass { public readonly value = "class"; }
    for (const metadata of [new Date(0), new Map(), new Set(), /fixture/u, new MetadataClass()]) {
      expect(() => validateCanonicalToolInput("TaskCreate", {
        subject: "invalid metadata",
        description: "non-plain values fail closed",
        metadata,
      })).toThrow(/plain object/u);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateCanonicalToolInput("TaskCreate", {
      subject: "cyclic metadata",
      description: "cycles fail closed",
      metadata: cyclic,
    })).toThrow(/cycle/u);
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 70; depth += 1) deep = { nested: deep };
    expect(() => validateCanonicalToolInput("TaskCreate", {
      subject: "deep metadata",
      description: "depth is bounded",
      metadata: deep,
    })).toThrow(/depth bound/u);
    const nonEnumerable = { visible: true };
    Object.defineProperty(nonEnumerable, "hidden", { enumerable: false, value: true });
    expect(() => validateCanonicalToolInput("TaskCreate", {
      subject: "hidden metadata",
      description: "hidden properties fail closed",
      metadata: nonEnumerable,
    })).toThrow(/own data property/u);
    expect(() => validateCanonicalToolInput("TaskCreate", {
      subject: "symbol metadata",
      description: "symbol properties fail closed",
      metadata: { [Symbol("hidden")]: true },
    })).toThrow(/symbol/u);
  });

  it("enforces correlated outputs, safe integers, and UTF-8 byte limits", () => {
    const grepBase = { offset: 0, limit: 1, truncated: false, durationMs: 1 };
    expect(() => validateCanonicalToolOutput("Grep", {
      ...grepBase,
      mode: "count",
      records: [{ path: "/fixture.txt", line: 1, text: "fixture" }],
    })).toThrow();
    expect(() => validateCanonicalToolOutput("Grep", {
      ...grepBase,
      mode: "content",
      records: [{ path: "/fixture.txt", count: 1 }],
    })).toThrow();
    expect(() => validateCanonicalToolOutput("ExitPlanMode", {
      disposition: "approved",
      plan: "fixture",
      revision: "revision-1",
      mode: "plan",
    })).toThrow();
    expect(() => validateCanonicalToolOutput("ExitPlanMode", {
      disposition: "rejected",
      plan: "fixture",
      revision: "revision-1",
      mode: "normal",
    })).toThrow();
    expect(() => validateCanonicalToolOutput("SendMessage", {
      ...CANONICAL_TOOL_SCHEMA_FIXTURES.SendMessage.output,
      sequence: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow();
    expect(() => validateCanonicalToolOutput("Glob", {
      ...CANONICAL_TOOL_SCHEMA_FIXTURES.Glob.output,
      numFiles: 999,
    })).toThrow(/filename count/u);
    for (const name of ["WebFetch", "WebSearch", "Agent"] as const) {
      expect(() => validateCanonicalToolOutput(name, {
        ...CANONICAL_TOOL_SCHEMA_FIXTURES[name].output,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 999,
        },
      })).toThrow(/component token counts/u);
    }
    expect(() => validateCanonicalToolOutput("AskUserQuestion", {
      ...CANONICAL_TOOL_SCHEMA_FIXTURES.AskUserQuestion.output,
      answers: [
        { questionIndex: 0, selectedLabels: ["Yes"] },
        { questionIndex: 0, selectedLabels: ["No"] },
      ],
    })).toThrow(/duplicate questionIndex/u);
    expect(() => validateCanonicalToolOutput("TaskCreate", {
      ...CANONICAL_TOOL_SCHEMA_FIXTURES.TaskCreate.output,
      task: {
        ...CANONICAL_TOOL_SCHEMA_FIXTURES.TaskCreate.output.task,
        createdSequence: 9,
        updatedSequence: 1,
      },
    })).toThrow(/precedes/u);
    expect(() => validateCanonicalToolOutput("TaskCreate", {
      ...CANONICAL_TOOL_SCHEMA_FIXTURES.TaskCreate.output,
      task: {
        ...CANONICAL_TOOL_SCHEMA_FIXTURES.TaskCreate.output.task,
        createdSequence: 0,
        updatedSequence: 0,
      },
    })).toThrow();
    expect(() => validateCanonicalToolOutput("TaskUpdate", {
      ...CANONICAL_TOOL_SCHEMA_FIXTURES.TaskUpdate.output,
      changedFields: ["__forged__"],
    })).toThrow();
    expect(Value.Check(CANONICAL_TOOL_CONTRACTS.ls.outputSchema, "😀".repeat(20_000))).toBe(true);
    expect(() => validateCanonicalToolOutput("ls", "😀".repeat(20_000))).toThrow(/UTF-8/u);
  });

  it("validates the exact catalog shape and its semantic digest", async () => {
    const schema = JSON.parse(await readFile(
      resolve(repositoryRoot, "packages/tool-contracts/generated/tool-catalog.schema.json"),
      "utf8",
    )) as TSchema;
    const diagnostics = CANONICAL_TOOL_NAMES.map((tool) => tool === "Read"
      ? { tool, available: true }
      : { tool, available: false, reasonCode: "fixture_unavailable" });
    const withoutDigest = {
      formatVersion: 1 as const,
      contractSha256: PROTOCOL_TOOL_CONTRACT_SHA256,
      implementationCatalog: CANONICAL_TOOL_NAMES,
      effectiveTools: ["Read"] as const,
      revision: "fixture-v1",
      diagnostics,
    };
    const catalog = { ...withoutDigest, digest: effectiveToolCatalogDigest(withoutDigest) };
    expect(Value.Check(schema, catalog)).toBe(true);
    expect(Value.Check(ToolCatalogSchema, catalog)).toBe(true);
    expect(validateEffectiveToolCatalog(catalog)).toEqual(catalog);
    const mutableSchemaView = ToolCatalogSchema as unknown as {
      properties: Record<string, unknown>;
    };
    expect(Object.isFrozen(ToolCatalogSchema)).toBe(true);
    expect(Object.isFrozen(mutableSchemaView.properties)).toBe(true);
    expect(Object.isFrozen(mutableSchemaView.properties.diagnostics)).toBe(true);
    expect(() => Object.defineProperty(mutableSchemaView.properties, "diagnostics", {
      configurable: true,
      value: {},
      writable: true,
    })).toThrow(TypeError);
    expect(() => Object.defineProperty(mutableSchemaView.properties, "implementationCatalog", {
      configurable: true,
      value: {},
      writable: true,
    })).toThrow(TypeError);
    expect(() => validateEffectiveToolCatalog({
      ...catalog,
      diagnostics: [{ tool: "Read", available: true }],
    })).toThrow();
    expect(() => validateEffectiveToolCatalog({
      ...catalog,
      implementationCatalog: ["Forged"],
    })).toThrow();
    const sharedCanonicalAliasWithoutDigest = {
      ...withoutDigest,
      implementationCatalog: CANONICAL_TOOL_NAMES,
      effectiveTools: CANONICAL_TOOL_NAMES,
      diagnostics: CANONICAL_TOOL_NAMES.map((tool) => ({ tool, available: true as const })),
    };
    expect(validateEffectiveToolCatalog({
      ...sharedCanonicalAliasWithoutDigest,
      digest: effectiveToolCatalogDigest(sharedCanonicalAliasWithoutDigest),
    }).effectiveTools).toEqual(CANONICAL_TOOL_NAMES);
    for (const implementationCatalog of [
      [],
      ["Read"],
      CANONICAL_TOOL_NAMES.slice(0, 19),
      [...CANONICAL_TOOL_NAMES, "Read"],
      ["Write", "Read", ...CANONICAL_TOOL_NAMES.slice(2)],
    ]) {
      expect(Value.Check(schema, { ...catalog, implementationCatalog })).toBe(false);
      expect(() => validateEffectiveToolCatalog({ ...catalog, implementationCatalog })).toThrow();
    }
    expect(Value.Check(schema, { ...catalog, diagnostics: [] })).toBe(false);
    expect(() => validateEffectiveToolCatalog({
      ...catalog,
      effectiveTools: [],
    })).toThrow(/disagree/u);
    const availableWithReason = {
      ...catalog,
      diagnostics: diagnostics.map((entry) => entry.tool === "Read"
        ? { ...entry, reasonCode: "must-not-exist" }
        : entry),
    };
    const unavailableWithoutReason = {
      ...catalog,
      diagnostics: diagnostics.map((entry) => entry.tool === "Write"
        ? { tool: entry.tool, available: false }
        : entry),
    };
    for (const invalidDiscriminant of [availableWithReason, unavailableWithoutReason]) {
      expect(Value.Check(schema, invalidDiscriminant)).toBe(false);
      expect(Value.Check(ToolCatalogSchema, invalidDiscriminant)).toBe(false);
      expect(() => validateEffectiveToolCatalog(invalidDiscriminant)).toThrow();
    }
    expect(() => validateEffectiveToolCatalog({ ...catalog, digest: "f".repeat(64) })).toThrow(/digest differs/u);
    for (const invalidIdentifierCatalog of [
      { ...catalog, revision: "invalid\nrevision" },
      {
        ...catalog,
        diagnostics: diagnostics.map((entry) => entry.tool === "Write"
          ? { ...entry, reasonCode: "invalid\nreason" }
          : entry),
      },
    ]) {
      expect(Value.Check(ToolCatalogSchema, invalidIdentifierCatalog)).toBe(false);
      expect(() => validateEffectiveToolCatalog(invalidIdentifierCatalog)).toThrow();
    }
    const forgedProtocolCatalog = {
      formatVersion: 1,
      contractSha256: PROTOCOL_TOOL_CONTRACT_SHA256,
      implementationCatalog: Array.from({ length: 20 }, (_, index) => `Forged${index}`),
      effectiveTools: ["StockWrongTool"],
      revision: "forged-v1",
      digest: "a".repeat(64),
      diagnostics: [],
    };
    expect(Value.Check(ToolCatalogSchema, forgedProtocolCatalog)).toBe(false);

    const metaModule = await import(
      "../packages/tool-contracts/generated/tool-contract-meta.json",
      { with: { type: "json" } }
    );
    const mutableMeta = metaModule.default as { contractSha256: string };
    const originalMetaDigest = mutableMeta.contractSha256;
    try {
      mutableMeta.contractSha256 = "f".repeat(64);
      const forgedWithoutDigest = { ...withoutDigest, contractSha256: mutableMeta.contractSha256 };
      expect(() => validateEffectiveToolCatalog({
        ...forgedWithoutDigest,
        digest: effectiveToolCatalogDigest(forgedWithoutDigest),
      })).toThrow(/effective tool catalog/u);
    } finally {
      mutableMeta.contractSha256 = originalMetaDigest;
    }
  });

  it("maps every model definition to one product compat-tool over audited public DSH roots", () => {
    const seams = new Map(publicSeams.map((seam) => [seam.importPath, seam]));
    for (const name of CANONICAL_TOOL_NAMES) {
      const decision = CANONICAL_TOOL_REUSE_MATRIX[name];
      expect(decision.modelDefinition).toBe("compat-tool");
      expect(decision.stockModelDefinition).toBe("excluded");
      expect(decision.productOwner).toMatch(/^@myagents-dsh\//u);
      expect(decision.dshPublicReuse.length).toBeGreaterThan(0);
      for (const reuse of decision.dshPublicReuse) {
        expect(reuse.importPath).toMatch(/^@deepseek-ai\/(?:cordis|dsh-[a-z0-9-]+)$/u);
        expect(reuse.importPath).not.toMatch(/\/(?:src|dist)\//u);
        const baseline = seams.get(reuse.importPath);
        expect(baseline, `${name}:${reuse.importPath}`).toBeDefined();
        const exported = new Set([...(baseline?.values ?? []), ...(baseline?.types ?? [])]);
        for (const symbol of reuse.symbols) expect(exported.has(symbol), `${name}:${symbol}`).toBe(true);
      }
    }
  });

  it("regenerates all projections byte-for-byte and detects edited/missing outputs", async () => {
    const artifacts = buildToolContractArtifacts();
    expect(artifacts.size).toBe(8);
    expect(await findToolContractDrift(artifacts, (relativePath) =>
      readFile(resolve(repositoryRoot, relativePath), "utf8"))).toEqual([]);

    expect(await findToolContractDrift(artifacts, (relativePath) => {
      if (relativePath.endsWith("tool-contract-meta.json")) return Promise.resolve("edited\n");
      if (relativePath.endsWith("canonical-tools.generated.ts")) return Promise.resolve(undefined);
      return Promise.resolve(artifacts.get(relativePath));
    })).toEqual([
      "packages/protocol/generated/canonical-tools.generated.ts",
      "packages/tool-contracts/generated/tool-contract-meta.json",
    ]);
  });

  it("binds the same contract digest into generated metadata, protocol, and candidate profile", async () => {
    const [contractBytes, metaBytes, protocolMetaBytes] = await Promise.all([
      readFile(resolve(repositoryRoot, "packages/tool-contracts/generated/canonical-tool-contracts-v1.json"), "utf8"),
      readFile(resolve(repositoryRoot, "packages/tool-contracts/generated/tool-contract-meta.json"), "utf8"),
      readFile(resolve(repositoryRoot, "packages/protocol/generated/protocol-meta.json"), "utf8"),
    ]);
    const meta = JSON.parse(metaBytes) as { contractSha256: string; canonicalToolCount: number };
    const protocolMeta = JSON.parse(protocolMetaBytes) as { canonicalToolContractSha256: string };
    const digest = createHash("sha256").update(contractBytes).digest("hex");
    expect(meta.canonicalToolCount).toBe(20);
    expect(meta.contractSha256).toBe(digest);
    expect(PROTOCOL_TOOL_CONTRACT_SHA256).toBe(digest);
    expect(protocolMeta.canonicalToolContractSha256).toBe(digest);
    expect(BATCH1_CANDIDATE_PROFILE.tools).toEqual({
      contractProfile: "canonical-agent-experience-v1",
      contractSha256: digest,
    });
    expect(TOOL_CONTRACT_SOURCE.commit).toBe("b7bbcadb172254defc0ea86229dd5de043fbb5f3");
  });
});
