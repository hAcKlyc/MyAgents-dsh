import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { ScriptedFakeLlmAdapter } from "@myagents-dsh/testkit";
import { describe, expect, it } from "vitest";

const request = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: "fixture",
  model: "fixture-model",
  messages: [createUserMessage({
    content: [{ type: "text", text: "original prompt" }],
    source: { kind: "user" },
  })],
  ...overrides,
});

const collect = async (adapter: ScriptedFakeLlmAdapter, options: GenerateOptions): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
};

describe("ScriptedFakeLlmAdapter", () => {
  it("records an immutable exact context and emits bounded deterministic usage", async () => {
    const adapter = new ScriptedFakeLlmAdapter();
    const options = request();
    adapter.enqueue({
      kind: "complete",
      text: ["deterministic ", "reply"],
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
    });
    const chunks = await collect(adapter, options);
    options.messages[0] = createUserMessage({
      content: [{ type: "text", text: "mutated after request" }],
      source: { kind: "user" },
    });

    expect(chunks.at(-2)).toEqual({
      type: "usage",
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
    });
    expect(adapter.requests[0]?.messages[0]?.content).toEqual([{ type: "text", text: "original prompt" }]);
    expect(Object.isFrozen(adapter.requests[0]?.messages[0]?.content)).toBe(true);
    expect(adapter.activeStreamCount).toBe(0);
    expect(adapter.pendingScriptCount).toBe(0);
  });

  it("fails at every cancellation boundary without emitting later terminal chunks", async () => {
    const adapter = new ScriptedFakeLlmAdapter();
    const controller = new AbortController();
    adapter.enqueue({ kind: "complete", text: ["one"] });
    const iterator = adapter.stream(request({ signal: controller.signal }))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "block-start" });
    expect((await iterator.next()).value).toMatchObject({ type: "text-delta" });
    controller.abort(new Error("synthetic cancellation"));
    await expect(iterator.next()).rejects.toThrow("synthetic cancellation");
    expect(adapter.activeStreamCount).toBe(0);

    const preAborted = new AbortController();
    preAborted.abort(new Error("pre-aborted"));
    adapter.enqueue({ kind: "complete", text: "not emitted" });
    await expect(collect(adapter, request({ signal: preAborted.signal }))).rejects.toThrow("pre-aborted");
    expect(adapter.activeStreamCount).toBe(0);
  });

  it("settles explicit error and overlapping await-abort scripts without residue", async () => {
    const adapter = new ScriptedFakeLlmAdapter();
    adapter.enqueue({ kind: "error", message: "synthetic provider failure" });
    await expect(collect(adapter, request())).rejects.toThrow("synthetic provider failure");

    const first = new AbortController();
    const second = new AbortController();
    adapter.enqueue({ kind: "await-abort" });
    adapter.enqueue({ kind: "await-abort" });
    const firstRequest = collect(adapter, request({ signal: first.signal }));
    const secondRequest = collect(adapter, request({ signal: second.signal }));
    await Promise.resolve();
    expect(adapter.activeStreamCount).toBe(2);
    first.abort(new Error("first stopped"));
    second.abort(new Error("second stopped"));
    await expect(firstRequest).rejects.toThrow("first stopped");
    await expect(secondRequest).rejects.toThrow("second stopped");
    expect(adapter.activeStreamCount).toBe(0);
    expect(adapter.pendingScriptCount).toBe(0);
  });

  it("holds one delivered assistant prefix until exact cancellation", async () => {
    const adapter = new ScriptedFakeLlmAdapter();
    const controller = new AbortController();
    adapter.enqueue({ kind: "partial-await-abort", text: "durable partial prefix" });
    const iterator = adapter.stream(request({ signal: controller.signal }))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "block-start", index: 0, blockType: "text" });
    expect((await iterator.next()).value).toEqual({
      type: "text-delta",
      index: 0,
      text: "durable partial prefix",
    });
    const settlement = iterator.next();
    controller.abort(new Error("partial stream cancelled"));
    await expect(settlement).rejects.toThrow("partial stream cancelled");
    expect(adapter.activeStreamCount).toBe(0);
    expect(adapter.pendingScriptCount).toBe(0);
  });

  it("emits deterministic model tool-call blocks through the real stream vocabulary", async () => {
    const adapter = new ScriptedFakeLlmAdapter();
    adapter.enqueue({
      calls: [{ id: "call-read", name: "Read", arguments: '{"file_path":"/fixture/a.txt"}' }],
      kind: "tool-calls",
      usage: { inputTokens: 3, outputTokens: 1 },
    });
    const chunks = await collect(adapter, request());
    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "tool-call" },
      {
        type: "tool-call-delta",
        index: 0,
        id: "call-read",
        name: "Read",
        argumentsDelta: '{"file_path":"/fixture/a.txt"}',
      },
      {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: "call-read",
          name: "Read",
          arguments: '{"file_path":"/fixture/a.txt"}',
        },
      },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]);
  });

  it("rejects invalid context, scripts, and token accounting at enqueue time", () => {
    expect(() => new ScriptedFakeLlmAdapter({ contextWindow: 0 })).toThrow("bounded positive integer");
    expect(() => new ScriptedFakeLlmAdapter({ provider: 1 } as never)).toThrow("bounded identifier");
    expect(() => new ScriptedFakeLlmAdapter({ model: 1 } as never)).toThrow("bounded identifier");
    expect(() => new ScriptedFakeLlmAdapter({ provider: null } as never)).toThrow("bounded identifier");
    expect(() => new ScriptedFakeLlmAdapter({ model: null } as never)).toThrow("bounded identifier");
    expect(() => new ScriptedFakeLlmAdapter({ provider: undefined } as never)).toThrow("bounded identifier");
    expect(() => new ScriptedFakeLlmAdapter({ contextWindow: null } as never))
      .toThrow("bounded positive integer");
    expect(() => new ScriptedFakeLlmAdapter({ extra: true } as never)).toThrow("unsupported field");
    expect(() => new ScriptedFakeLlmAdapter({ inputModalities: ["image"] })).toThrow("include text");
    expect(() => new ScriptedFakeLlmAdapter({ inputModalities: ["text", "text"] })).toThrow("unique");
    expect(() => new ScriptedFakeLlmAdapter({ inputModalities: new Proxy(["text"], {}) as never }))
      .toThrow("bounded dense array");
    let optionGetterHits = 0;
    const accessorOptions = {} as Record<string, unknown>;
    Object.defineProperty(accessorOptions, "provider", {
      enumerable: true,
      get: () => { optionGetterHits += 1; return "fixture"; },
    });
    expect(() => new ScriptedFakeLlmAdapter(accessorOptions as never)).toThrow("own data properties");
    expect(optionGetterHits).toBe(0);
    const adapter = new ScriptedFakeLlmAdapter();
    expect(() => adapter.enqueue({ kind: "complete", text: Array.from({ length: 1_025 }, () => "x") }))
      .toThrow("bounded non-empty text segments");
    expect(() => adapter.enqueue({ kind: "complete", text: "x".repeat(1_000_001) }))
      .toThrow("bounded non-empty text segments");
    expect(() => adapter.enqueue({
      kind: "complete",
      text: "x",
      usage: { inputTokens: -1, outputTokens: Number.NaN },
    })).toThrow("non-negative safe integer");
    expect(() => adapter.enqueue({
      kind: "complete",
      text: "x",
      usage: { inputTokens: 1, outputTokens: 1, unknown: 1 },
    } as never)).toThrow("unsupported field");
    expect(() => adapter.enqueue({ kind: "complete", text: [1] } as never))
      .toThrow("dense string array");
    expect(() => adapter.enqueue({ kind: "complete", text: new Array<string>(1) } as never))
      .toThrow("dense string array");
    expect(() => adapter.enqueue({ kind: "complete", text: new Set(["x"]) } as never))
      .toThrow("string or dense string array");
    expect(() => adapter.enqueue({ kind: "complete", text: "x", usage: null } as never))
      .toThrow("plain object");
    expect(() => adapter.enqueue({
      kind: "complete",
      text: "x",
      usage: { inputTokens: null, outputTokens: null },
    } as never)).toThrow("non-negative safe integer");
    expect(() => adapter.enqueue({
      kind: "complete",
      text: "x",
      usage: { inputTokens: undefined, outputTokens: undefined },
    } as never)).toThrow("non-negative safe integer");
    expect(() => adapter.enqueue({ kind: "error", message: 1 } as never))
      .toThrow("bounded primitive text");
    expect(() => adapter.enqueue({ kind: "partial-await-abort", text: "" }))
      .toThrow("bounded non-empty text");
    expect(() => adapter.enqueue({ kind: "tool-calls", calls: [] })).toThrow("bounded dense call array");
    expect(() => adapter.enqueue({
      kind: "tool-calls",
      calls: [{ id: "call", name: "Read", arguments: "" }],
    })).toThrow("bounded text");
    let proxyTraps = 0;
    const proxyScript = new Proxy({}, {
      get: () => { proxyTraps += 1; return undefined; },
      getOwnPropertyDescriptor: () => { proxyTraps += 1; return undefined; },
      getPrototypeOf: () => { proxyTraps += 1; return Object.prototype; },
      ownKeys: () => { proxyTraps += 1; return []; },
    });
    expect(() => adapter.enqueue(proxyScript as never)).toThrow("plain object");
    expect(proxyTraps).toBe(0);
    expect(() => adapter.enqueue({ kind: "unknown" } as never)).toThrow("kind is unsupported");

    const symbolUsage = { inputTokens: 1, outputTokens: 1, [Symbol("hidden")]: 1 };
    expect(() => adapter.enqueue({ kind: "complete", text: "x", usage: symbolUsage } as never))
      .toThrow("unsupported field");
    const hiddenUsage = { inputTokens: 1, outputTokens: 1 } as Record<string, unknown>;
    Object.defineProperty(hiddenUsage, "hidden", { enumerable: false, value: 1 });
    expect(() => adapter.enqueue({ kind: "complete", text: "x", usage: hiddenUsage } as never))
      .toThrow("unsupported field");
    let getterHits = 0;
    const accessorUsage = { inputTokens: 1 } as Record<string, unknown>;
    Object.defineProperty(accessorUsage, "outputTokens", {
      enumerable: true,
      get: () => { getterHits += 1; return 1; },
    });
    expect(() => adapter.enqueue({ kind: "complete", text: "x", usage: accessorUsage } as never))
      .toThrow("own data properties");
    expect(getterHits).toBe(0);
    expect(adapter.pendingScriptCount).toBe(0);
  });

  it("projects one exact frozen image-capable model identity", async () => {
    const adapter = new ScriptedFakeLlmAdapter({ inputModalities: ["text", "image"] });
    const models = await adapter.listModels("fixture");
    const resolved = await adapter.resolveModel("fixture", "fixture-model");
    expect(models[0]?.inputModalities).toEqual(["text", "image"]);
    expect(resolved.inputModalities).toEqual(["text", "image"]);
    expect(Object.isFrozen(models[0]?.inputModalities)).toBe(true);
    expect(Object.isFrozen(resolved.inputModalities)).toBe(true);
  });
});
