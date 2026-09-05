import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_TOOL_NAMES,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
  SessionReadAssembler,
  canonicalSessionReadData,
  parseJsonRpcFrame,
  validateMethodParams,
  validateMethodResult,
  validateNotificationParams,
  type JsonRpcPeer,
  type MethodParams,
  type RpcMethodName,
  type RpcNotificationName,
} from "../packages/protocol/src/index.js";
import { GeneratedHostClient } from "../packages/protocol/generated/host-client.generated.js";
import {
  buildProtocolArtifacts,
  findProtocolArtifactDrift,
} from "../scripts/protocol-generation.js";

type FixtureTarget = {
  kind: "methodParams" | "methodResult" | "notificationParams";
  name: string;
};
type ValidFixture = { name: string; target: FixtureTarget; frame: Record<string, unknown> };
type InvalidFixture = { name: string; target: FixtureTarget; value: unknown };
type FixtureCorpus = {
  schemaSha256: string;
  valid: ValidFixture[];
  invalid: InvalidFixture[];
};

const repositoryRoot = resolve(import.meta.dirname, "..");

const validateTarget = (target: FixtureTarget, value: unknown): unknown => {
  if (target.kind === "methodParams") {
    return validateMethodParams(target.name as RpcMethodName, value);
  }
  if (target.kind === "methodResult") {
    return validateMethodResult(target.name as RpcMethodName, value);
  }
  return validateNotificationParams(target.name as RpcNotificationName, value);
};

describe("candidate-v2 protocol authority", () => {
  it("owns the exact method, notification, and canonical-tool inventory", () => {
    const hostMethods = Object.values(RPC_METHODS)
      .filter(({ direction }) => direction === "host_to_runtime");
    const reverseMethods = Object.values(RPC_METHODS)
      .filter(({ direction }) => direction === "runtime_to_host");

    expect(hostMethods).toHaveLength(44);
    expect(reverseMethods).toHaveLength(7);
    expect(Object.keys(RPC_NOTIFICATIONS)).toHaveLength(4);
    expect(CANONICAL_TOOL_NAMES).toHaveLength(24);
    expect(new Set(CANONICAL_TOOL_NAMES)).toHaveLength(24);
  });

  it("regenerates every checked-in projection byte-for-byte", async () => {
    const artifacts = await buildProtocolArtifacts(repositoryRoot);
    const drift = await findProtocolArtifactDrift(artifacts, async (relativePath) => {
      return readFile(resolve(repositoryRoot, relativePath), "utf8");
    });

    expect(artifacts.size).toBe(5);
    expect(drift).toEqual([]);
  });

  it("detects a manual generated-file edit and a missing projection", async () => {
    const artifacts = await buildProtocolArtifacts(repositoryRoot);
    const drift = await findProtocolArtifactDrift(artifacts, (relativePath) => {
      let current = artifacts.get(relativePath);
      if (relativePath.endsWith("protocol-meta.json")) current = "manually edited\n";
      if (relativePath.endsWith("host-client.generated.ts")) current = undefined;
      return Promise.resolve(current);
    });

    expect(drift).toEqual([
      "packages/protocol/generated/protocol-meta.json",
      "packages/protocol/generated/host-client.generated.ts",
    ]);
  });

  it("fails initialize when the Runtime reports a different schema digest", async () => {
    const peer = {
      role: "host",
      request: () => Promise.resolve({ schemaSha256: "f".repeat(64) }),
    } as unknown as JsonRpcPeer;
    const client = new GeneratedHostClient(peer);
    await expect(client.initialize({} as MethodParams<"initialize">))
      .rejects.toMatchObject({ code: "protocol_schema_mismatch" });
  });

  it("separates ready Session bindings from bounded recovery-only facts", () => {
    const recovery = {
      state: "recovery_required",
      runtimeSessionId: "runtime-recovery",
      persistenceRef: "persistence-recovery",
      reason: "persisted_history_invalid",
      retryable: false,
      unsettledMutations: [],
    };
    expect(validateMethodResult("session/resume", recovery)).toEqual(recovery);
    expect(() => validateMethodResult("session/resume", {
      ...recovery,
      toolCatalog: {},
    })).toThrow();
    expect(() => validateMethodResult("session/resume", {
      state: "ready",
      runtimeSessionId: "runtime-recovery",
      historyFormat: "dsh-session-events-v1",
      durableHead: { sequence: 0 },
      effectiveConfigRevision: "config-v1",
    })).toThrow();
  });

  it("binds the schema digest and validates every positive and negative fixture", async () => {
    const [schemaBytes, fixtureBytes] = await Promise.all([
      readFile(resolve(repositoryRoot, "packages/protocol/generated/protocol.schema.json"), "utf8"),
      readFile(resolve(repositoryRoot, "packages/protocol/generated/protocol-fixtures.json"), "utf8"),
    ]);
    const fixtures = JSON.parse(fixtureBytes) as FixtureCorpus;
    expect(createHash("sha256").update(schemaBytes).digest("hex")).toBe(fixtures.schemaSha256);

    for (const fixture of fixtures.valid) {
      const frame = parseJsonRpcFrame(JSON.stringify(fixture.frame));
      const value = fixture.target.kind === "methodParams" || fixture.target.kind === "notificationParams"
        ? (frame as { params?: unknown }).params ?? {}
        : (frame as { result?: unknown }).result;
      expect(() => validateTarget(fixture.target, value), fixture.name).not.toThrow();
    }
    for (const fixture of fixtures.invalid) {
      expect(() => validateTarget(fixture.target, fixture.value), fixture.name).toThrow();
    }
    const piLeakage = fixtures.invalid.find(({ name }) => name === "pi-runtime-field-is-not-v2");
    const nativeLeafLeakage = fixtures.invalid.find(({ name }) => name === "native-leaf-is-not-session-binding");
    expect(piLeakage).toBeDefined();
    expect(nativeLeafLeakage).toBeDefined();
    const validInitializeResult = structuredClone(piLeakage?.value) as Record<string, unknown>;
    const validSessionBinding = structuredClone(nativeLeafLeakage?.value) as Record<string, unknown>;
    delete validInitializeResult.piVersion;
    delete validSessionBinding.nativeLeafId;
    expect(() => validateMethodResult("initialize", validInitializeResult)).not.toThrow();
    expect(() => validateMethodResult("session/create", validSessionBinding)).not.toThrow();
    expect(fixtures.invalid.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "extension-module-field-is-forbidden",
      "extension-source-and-code-fields-are-forbidden",
      "extension-package-launch-specifier-is-forbidden",
      "extension-credential-value-is-forbidden",
      "extension-env-map-is-forbidden",
      "extension-executable-resource-media-is-forbidden",
      "extension-unknown-component-field-is-forbidden",
      "extension-skill-glob-is-forbidden",
    ]));
    const initializeFixture = fixtures.valid.find(({ name }) => name === "initialize-request");
    expect(initializeFixture).toBeDefined();
    const initializeFrame = structuredClone(initializeFixture?.frame) as {
      params: Record<string, unknown>;
    };
    initializeFrame.params.runtimeHome = "C:\\fixture\\runtime-home";
    expect(() => validateMethodParams("initialize", initializeFrame.params)).not.toThrow();
    initializeFrame.params.runtimeHome = "\\\\server\\share\\runtime-home";
    expect(() => validateMethodParams("initialize", initializeFrame.params)).not.toThrow();
    expect(fixtureBytes).not.toMatch(/DEEPSEEK_API_KEY|sk-[A-Za-z0-9]|-----BEGIN|\/Users\//u);

    const generatedClient = await readFile(resolve(
      repositoryRoot,
      "packages/protocol/generated/host-client.generated.ts",
    ), "utf8");
    expect(generatedClient).toContain("protocol_schema_mismatch");
    expect(generatedClient).toContain("GENERATED_CAPABILITY_PROFILE_DIGEST");
    expect(generatedClient).not.toContain("GENERATED_PROFILE_DIGEST");
  });

  it("rejects non-strict JSON-RPC envelopes", () => {
    expect(() => parseJsonRpcFrame(JSON.stringify({
      jsonrpc: "2.0",
      id: "h:1",
      method: "runtime/status",
      params: {},
      extra: true,
    }))).toThrow("unexpected fields");
    expect(() => parseJsonRpcFrame(JSON.stringify({
      jsonrpc: "2.0",
      id: "h:1",
      error: {
        code: -32603,
        message: "synthetic",
        data: { protocolCode: "old-shape", retryable: false },
      },
    }))).toThrow("error data");
  });

  it("verifies whole Session data hashes and rejects a corrupted chunk chain", () => {
    const data = { turn: 1 };
    expect(() => validateMethodResult("session/read", {
      runtimeSessionId: "session-read-hash",
      historyFormat: "dsh-session-events-v1",
      durableHead: { sequence: 1 },
      records: [{
        kind: "event",
        sequence: 0,
        eventType: "turn/start",
        eventSha256: canonicalSessionReadData(data).sha256,
        data,
      }],
    })).not.toThrow();
    expect(() => validateMethodResult("session/read", {
      runtimeSessionId: "session-read-hash",
      historyFormat: "dsh-session-events-v1",
      durableHead: { sequence: 1 },
      records: [{
        kind: "event",
        sequence: 0,
        eventType: "turn/start",
        eventSha256: "f".repeat(64),
        data,
      }],
    })).toThrow("canonical SHA-256");

    const bytes = Buffer.from(JSON.stringify({ text: "chunked" }), "utf8");
    const eventSha256 = createHash("sha256").update(bytes).digest("hex");
    const assembler = new SessionReadAssembler();
    assembler.accept({
      runtimeSessionId: "session-read-chunks",
      historyFormat: "dsh-session-events-v1",
      durableHead: { sequence: 1 },
      records: [{
        kind: "event_chunk",
        sequence: 0,
        eventType: "assistant/chunk",
        eventSha256,
        chunkIndex: 0,
        chunkCount: 2,
        offsetBytes: 0,
        totalBytes: bytes.length,
        dataBase64: bytes.subarray(0, 4).toString("base64"),
      }],
      nextCursor: "cursor-1",
    });
    expect(() => assembler.accept({
      runtimeSessionId: "session-read-chunks",
      historyFormat: "dsh-session-events-v1",
      durableHead: { sequence: 1 },
      records: [{
        kind: "event_chunk",
        sequence: 0,
        eventType: "assistant/chunk",
        eventSha256,
        chunkIndex: 1,
        chunkCount: 2,
        offsetBytes: 4,
        totalBytes: bytes.length,
        dataBase64: Buffer.concat([Buffer.from("y"), bytes.subarray(5)]).toString("base64"),
      }],
    }, "cursor-1")).toThrow("SHA-256");

    expect(() => validateMethodResult("session/read", {
      runtimeSessionId: "session-read-stalled",
      historyFormat: "dsh-session-events-v1",
      durableHead: { sequence: 1 },
      records: [],
      nextCursor: "cursor-stalled",
    })).toThrow("record progress");
    const repeatedCursorAssembler = new SessionReadAssembler();
    repeatedCursorAssembler.accept({
      runtimeSessionId: "session-read-repeat",
      historyFormat: "dsh-session-events-v1",
      durableHead: { sequence: 2 },
      records: [{
        kind: "event",
        sequence: 0,
        eventType: "turn/start",
        eventSha256: canonicalSessionReadData(data).sha256,
        data,
      }],
      nextCursor: "cursor-repeat",
    });
    expect(() => repeatedCursorAssembler.accept({
      runtimeSessionId: "session-read-repeat",
      historyFormat: "dsh-session-events-v1",
      durableHead: { sequence: 2 },
      records: [{
        kind: "event",
        sequence: 1,
        eventType: "turn/start",
        eventSha256: canonicalSessionReadData(data).sha256,
        data,
      }],
      nextCursor: "cursor-repeat",
    }, "cursor-repeat")).toThrow("repeated its request cursor");
  });
});
