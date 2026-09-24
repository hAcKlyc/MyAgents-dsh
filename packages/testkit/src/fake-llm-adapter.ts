import { ToolCallId, LlmAdapter } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { types as utilTypes } from "node:util";

export interface FakeLlmAdapterOptions {
  readonly contextWindow?: number;
  readonly inputModalities?: readonly ("image" | "text")[];
  readonly model?: string;
  readonly provider?: string;
}

export type FakeLlmScript = Readonly<{
  kind: "complete";
  text: string | readonly string[];
  usage?: Readonly<TokenUsage>;
}> | Readonly<{
  calls: readonly Readonly<{
    arguments: string;
    id: string;
    name: string;
  }>[];
  kind: "tool-calls";
  usage?: Readonly<TokenUsage>;
}> | Readonly<{
  kind: "error";
  message: string;
}> | Readonly<{
  kind: "await-abort";
}> | Readonly<{
  kind: "partial-await-abort";
  text: string;
}>;

export interface FakeLlmRequestObservation {
  readonly maxTokens: number | undefined;
  readonly messages: readonly Readonly<RequestMessage>[];
  readonly model: string;
  readonly provider: string;
  readonly sessionId: string | undefined;
  readonly system: string | undefined;
  readonly toolNames: readonly string[];
}

const MAX_COMPLETION_SEGMENTS = 1_024;
const MAX_COMPLETION_TEXT_LENGTH = 1_000_000;
const usageKeys = Object.freeze([
  "cacheReadTokens",
  "cacheWriteTokens",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
] as const);

type JsonObject = Record<string, unknown>;

const exactPlainDataRecord = (
  value: unknown,
  allowedKeys: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const record = value as JsonObject;
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${description} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${description} fields must be enumerable own data properties`);
    }
  }
  return record;
};

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const frozenClone = <T>(value: T): Readonly<T> => deepFreeze(structuredClone(value));

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  return value;
};

const exactContextWindow = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new TypeError("fake LLM context window must be a bounded positive integer");
  }
  return value;
};

const exactInputModalities = (value: unknown): readonly ("image" | "text")[] => {
  if (value === undefined) return Object.freeze(["text"] as const);
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > 2 || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError("fake LLM input modalities must be a bounded dense array");
  }
  const result: ("image" | "text")[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const modality: unknown = descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || (modality !== "text" && modality !== "image")
      || result.includes(modality)) {
      throw new TypeError("fake LLM input modalities must contain unique text/image values");
    }
    result.push(modality);
  }
  if (!result.includes("text")) {
    throw new TypeError("fake LLM input modalities must include text");
  }
  return Object.freeze(result);
};

const exactUsage = (value: Readonly<TokenUsage> | undefined): Readonly<TokenUsage> => {
  const usage = value === undefined
    ? { inputTokens: 1, outputTokens: 1 }
    : exactPlainDataRecord(value, usageKeys, "fake LLM usage");
  if (!Object.hasOwn(usage, "inputTokens") || !Object.hasOwn(usage, "outputTokens")) {
    throw new TypeError("fake LLM usage must contain inputTokens and outputTokens");
  }
  const normalized: TokenUsage = {
    inputTokens: usage.inputTokens as number,
    outputTokens: usage.outputTokens as number,
  };
  for (const key of usageKeys) {
    const required = key === "inputTokens" || key === "outputTokens";
    const count = required ? normalized[key] : usage[key];
    if (count === undefined) {
      if (required) throw new TypeError(`fake LLM usage ${key} must be a non-negative safe integer`);
      continue;
    }
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new TypeError(`fake LLM usage ${key} must be a non-negative safe integer`);
    }
    if (key !== "inputTokens" && key !== "outputTokens") normalized[key] = count as number;
  }
  return Object.freeze(normalized);
};

const abortReason = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("fake LLM request aborted");
};

export class ScriptedFakeLlmAdapter extends LlmAdapter {
  readonly #contextWindow: number;
  readonly #inputModalities: readonly ("image" | "text")[];
  readonly #model: string;
  readonly #provider: string;
  readonly #requests: FakeLlmRequestObservation[] = [];
  readonly #scripts: FakeLlmScript[] = [];
  #activeStreams = 0;

  constructor(options: FakeLlmAdapterOptions = {}) {
    super();
    const candidate = exactPlainDataRecord(
      options,
      ["contextWindow", "inputModalities", "model", "provider"],
      "fake LLM adapter options",
    );
    this.#provider = boundedIdentifier(
      Object.hasOwn(candidate, "provider") ? candidate.provider : "fixture",
      "fake LLM provider",
    );
    this.#model = boundedIdentifier(
      Object.hasOwn(candidate, "model") ? candidate.model : "fixture-model",
      "fake LLM model",
    );
    this.#contextWindow = exactContextWindow(
      Object.hasOwn(candidate, "contextWindow") ? candidate.contextWindow : 4_096,
    );
    this.#inputModalities = exactInputModalities(
      Object.hasOwn(candidate, "inputModalities") ? candidate.inputModalities : undefined,
    );
  }

  get activeStreamCount(): number { return this.#activeStreams; }
  get pendingScriptCount(): number { return this.#scripts.length; }
  get requests(): readonly FakeLlmRequestObservation[] {
    return Object.freeze(this.#requests.map((request) => Object.freeze({ ...request })));
  }

  enqueue(script: FakeLlmScript): void {
    const candidate = exactPlainDataRecord(
      script,
      ["calls", "kind", "message", "text", "usage"],
      "fake LLM script",
    );
    if (candidate.kind === "complete") {
      exactPlainDataRecord(script, ["kind", "text", "usage"], "fake LLM completion script");
      if (!Object.hasOwn(candidate, "text")) throw new TypeError("fake LLM completion script requires text");
      const text = candidate.text;
      if (typeof text !== "string" && !Array.isArray(text)) {
        throw new TypeError("fake LLM completion text must be a string or dense string array");
      }
      let segments: string[];
      if (Array.isArray(text)) {
        if (Object.getPrototypeOf(text) !== Array.prototype) {
          throw new TypeError("fake LLM completion text must be a string or dense string array");
        }
        segments = [];
        const keys = Reflect.ownKeys(text);
        if (keys.length !== text.length + 1 || !keys.includes("length")) {
          throw new TypeError("fake LLM completion text must be a string or dense string array");
        }
        for (let index = 0; index < text.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(text, String(index));
          if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true
            || typeof descriptor.value !== "string") {
            throw new TypeError("fake LLM completion text must be a string or dense string array");
          }
          segments.push(descriptor.value);
        }
      } else {
        segments = [text];
      }
      const totalLength = segments.reduce((total, segment) => total + segment.length, 0);
      if (segments.length === 0 || segments.length > MAX_COMPLETION_SEGMENTS
        || totalLength > MAX_COMPLETION_TEXT_LENGTH
        || segments.some((segment) => segment.length === 0)) {
        throw new TypeError("fake LLM completion requires bounded non-empty text segments");
      }
      const usage = exactUsage(candidate.usage as Readonly<TokenUsage> | undefined);
      this.#scripts.push(frozenClone({ kind: "complete", text: segments, usage }));
      return;
    }
    if (candidate.kind === "tool-calls") {
      exactPlainDataRecord(script, ["calls", "kind", "usage"], "fake LLM tool-call script");
      const calls = candidate.calls;
      if (!Array.isArray(calls) || utilTypes.isProxy(calls) || Object.getPrototypeOf(calls) !== Array.prototype
        || calls.length < 1 || calls.length > 32 || Reflect.ownKeys(calls).length !== calls.length + 1) {
        throw new TypeError("fake LLM tool-call script requires a bounded dense call array");
      }
      const normalizedCalls = calls.map((call, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(calls, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("fake LLM tool-call script requires a bounded dense call array");
        }
        const record = exactPlainDataRecord(call, ["arguments", "id", "name"], "fake LLM tool call");
        const id = boundedIdentifier(record.id, "fake LLM tool call id");
        const name = boundedIdentifier(record.name, "fake LLM tool call name");
        if (typeof record.arguments !== "string" || record.arguments.length === 0
          || record.arguments.length > 1_000_000) {
          throw new TypeError("fake LLM tool call arguments must be bounded text");
        }
        return Object.freeze({ arguments: record.arguments, id, name });
      });
      this.#scripts.push(frozenClone({
        calls: normalizedCalls,
        kind: "tool-calls",
        usage: exactUsage(candidate.usage as Readonly<TokenUsage> | undefined),
      }));
      return;
    }
    if (candidate.kind === "error") {
      exactPlainDataRecord(script, ["kind", "message"], "fake LLM error script");
      if (typeof candidate.message !== "string"
        || candidate.message.length === 0 || candidate.message.length > 4_096) {
        throw new TypeError("fake LLM error message must be bounded primitive text");
      }
      this.#scripts.push(frozenClone({ kind: "error", message: candidate.message }));
      return;
    }
    if (candidate.kind === "await-abort") {
      exactPlainDataRecord(script, ["kind"], "fake LLM await-abort script");
      this.#scripts.push(Object.freeze({ kind: "await-abort" }));
      return;
    }
    if (candidate.kind === "partial-await-abort") {
      exactPlainDataRecord(script, ["kind", "text"], "fake LLM partial-await-abort script");
      if (typeof candidate.text !== "string" || candidate.text.length === 0
        || candidate.text.length > MAX_COMPLETION_TEXT_LENGTH) {
        throw new TypeError("fake LLM partial-await-abort text must be bounded non-empty text");
      }
      this.#scripts.push(frozenClone({ kind: "partial-await-abort", text: candidate.text }));
      return;
    }
    throw new TypeError("fake LLM script kind is unsupported");
  }

  override providerInfo(provider: string): LlmProviderInfo {
    this.#assertRoute(provider, this.#model);
    return Object.freeze({ id: provider, name: "MyAgents deterministic fixture" });
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.#assertRoute(provider, this.#model);
    return Promise.resolve(Object.freeze([Object.freeze({
      provider,
      id: this.#model,
      name: "MyAgents deterministic fixture model",
      inputModalities: this.#inputModalities,
    })]));
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.#assertRoute(provider, model);
    return Promise.resolve(Object.freeze({
      provider,
      id: model,
      name: "MyAgents deterministic fixture model",
      inputModalities: this.#inputModalities,
      context: Object.freeze({ contextWindow: this.#contextWindow }),
    }));
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.#assertRoute(options.provider, options.model);
    const script = this.#scripts.shift();
    if (script === undefined) throw new Error("fake LLM script queue is empty");
    this.#requests.push(Object.freeze({
      maxTokens: options.maxTokens,
      messages: frozenClone(options.messages),
      model: options.model,
      provider: options.provider,
      sessionId: options.sessionId,
      system: options.system,
      toolNames: Object.freeze((options.tools ?? []).map(({ name }) => name)),
    }));
    this.#activeStreams += 1;
    try {
      const throwIfAborted = (): void => {
        if (options.signal?.aborted === true) throw abortReason(options.signal);
      };
      throwIfAborted();
      if (script.kind === "error") throw new Error(script.message);
      if (script.kind === "await-abort" || script.kind === "partial-await-abort") {
        const signal = options.signal;
        if (signal === undefined) throw new Error("fake LLM await-abort script requires a request signal");
        if (script.kind === "partial-await-abort") {
          throwIfAborted();
          yield { type: "block-start", index: 0, blockType: "text" };
          throwIfAborted();
          yield { type: "text-delta", index: 0, text: script.text };
          throwIfAborted();
        }
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(abortReason(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        return;
      }
      if (script.kind === "tool-calls") {
        for (const [index, call] of script.calls.entries()) {
          const id = ToolCallId(call.id);
          throwIfAborted();
          yield { type: "block-start", index, blockType: "tool-call" };
          throwIfAborted();
          yield {
            type: "tool-call-delta",
            index,
            id,
            name: call.name,
            argumentsDelta: call.arguments,
          };
          throwIfAborted();
          yield {
            type: "block-end",
            index,
            block: { type: "tool-call", id, name: call.name, arguments: call.arguments },
          };
        }
        throwIfAborted();
        yield { type: "usage", usage: exactUsage(script.usage) };
        throwIfAborted();
        yield { type: "finish", reason: { kind: "tool-calls" } };
        return;
      }
      const segments = typeof script.text === "string" ? [script.text] : script.text;
      const text = segments.join("");
      throwIfAborted();
      yield { type: "block-start", index: 0, blockType: "text" };
      throwIfAborted();
      for (const segment of segments) {
        throwIfAborted();
        yield { type: "text-delta", index: 0, text: segment };
        throwIfAborted();
      }
      throwIfAborted();
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      throwIfAborted();
      yield {
        type: "usage",
        usage: exactUsage(script.usage),
      };
      throwIfAborted();
      yield { type: "finish", reason: { kind: "stop" } };
    } finally {
      this.#activeStreams -= 1;
    }
  }

  #assertRoute(provider: string, model: string): void {
    if (provider !== this.#provider || model !== this.#model) {
      throw new Error("fake LLM received an unowned provider or model route");
    }
  }
}
