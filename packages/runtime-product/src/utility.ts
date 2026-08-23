import { Service, symbols, type Context } from "@deepseek-ai/cordis";
import {
  freezeMessage,
  MessageId,
  ReasoningEffortId,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import {
  ProtocolError,
  validateMethodParams,
  validateMethodResult,
  type MethodParams,
  type MethodResult,
} from "@myagents-dsh/protocol";
import { priceDshTokenUsage } from "@myagents-dsh/operation-runtime";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type { HostDeepSeekModelAuthority } from "./host-model.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productUtility: ProductUtilityService;
  }
}

export interface ProductUtilityServiceConfig {
  readonly authority: HostDeepSeekModelAuthority;
  readonly maxKnownOperations?: number;
}

const normalizeConfig = (value: unknown): Readonly<{
  authority: HostDeepSeekModelAuthority;
  maxKnownOperations: number;
}> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("product utility config must be a non-proxy plain object");
  }
  const config = value as unknown as Record<PropertyKey, unknown>;
  const keys = Reflect.ownKeys(config);
  if (!Object.hasOwn(config, "authority")
    || keys.some((key) => key !== "authority" && key !== "maxKnownOperations")) {
    throw new TypeError("product utility config has an invalid exact shape");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(config, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("product utility config fields must be enumerable own data properties");
    }
  }
  const authority = config.authority;
  const runUtilityRequest = authority === null || typeof authority !== "object"
    ? undefined
    : Reflect.get(authority, "runUtilityRequest") as unknown;
  if (authority === null || typeof authority !== "object" || isProxy(authority)
    || typeof runUtilityRequest !== "function" || isProxy(runUtilityRequest)) {
    throw new TypeError("product utility requires the Host model authority");
  }
  const maxKnownOperations = config.maxKnownOperations ?? 4_096;
  if (!Number.isSafeInteger(maxKnownOperations)
    || (maxKnownOperations as number) < 1 || (maxKnownOperations as number) > 65_536) {
    throw new TypeError("product utility known-operation bound is invalid");
  }
  return Object.freeze({
    authority: authority as HostDeepSeekModelAuthority,
    maxKnownOperations: maxKnownOperations as number,
  });
};

type KnownUtility = Readonly<{
  fingerprint: string;
  result: Promise<MethodResult<"utility/run">>;
}>;

const fingerprint = (params: MethodParams<"utility/run">): string => createHash("sha256")
  .update(JSON.stringify(["myagents-dsh-utility-v1", params]))
  .digest("hex");

const originalProductUtilityService = (service: ProductUtilityService): ProductUtilityService => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original instanceof ProductUtilityService ? original : service;
};

const normalizedUsage = (
  usage: TokenUsage | undefined,
  pricing: MethodParams<"session/create">["provider"]["pricing"],
): MethodResult<"utility/run">["usage"] => {
  if (usage === undefined) return undefined;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  for (const count of [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ProtocolError("utility_usage_invalid", "utility model returned invalid token usage");
    }
  }
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    throw new ProtocolError("utility_usage_invalid", "utility model token usage overflowed");
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd: pricing === undefined ? null : priceDshTokenUsage({
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }, pricing),
  });
};

export class ProductUtilityService extends Service {
  static inject = ["llm", "productSession"];
  readonly #authority: HostDeepSeekModelAuthority;
  readonly #known = new Map<string, KnownUtility>();
  readonly #maxKnownOperations: number;
  #active = 0;

  constructor(ctx: Context, config: ProductUtilityServiceConfig) {
    super(ctx, "productUtility");
    const normalized = normalizeConfig(config);
    this.#authority = normalized.authority;
    this.#maxKnownOperations = normalized.maxKnownOperations;
  }

  get activeCount(): number { return originalProductUtilityService(this).#active; }

  run(
    value: unknown,
    signal: AbortSignal,
    maxResultBytes: number,
  ): Promise<MethodResult<"utility/run">> {
    const owner = originalProductUtilityService(this);
    if (owner !== this) return owner.run(value, signal, maxResultBytes);
    const params = validateMethodParams("utility/run", value);
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError("utility request signal must be a native AbortSignal"));
    }
    if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 256 || maxResultBytes > 8 * 1_024 * 1_024) {
      return Promise.reject(new TypeError("utility result byte budget is invalid"));
    }
    const identity = fingerprint(params);
    const known = this.#known.get(params.clientOperationId);
    if (known !== undefined) {
      if (known.fingerprint !== identity) {
        return Promise.reject(new ProtocolError(
          "utility_operation_conflict",
          "utility client operation identity was reused with different immutable input",
        ));
      }
      return known.result;
    }
    if (this.#known.size >= this.#maxKnownOperations) {
      return Promise.reject(new ProtocolError(
        "utility_operation_limit",
        "utility operation registry reached its bounded capacity",
        true,
      ));
    }
    const result = this.#execute(params, signal, maxResultBytes);
    this.#known.set(params.clientOperationId, Object.freeze({ fingerprint: identity, result }));
    return result;
  }

  async #execute(
    params: MethodParams<"utility/run">,
    signal: AbortSignal,
    maxResultBytes: number,
  ): Promise<MethodResult<"utility/run">> {
    this.#active += 1;
    try {
      signal.throwIfAborted();
      const session = this.ctx.productSession.snapshot();
      if (session.state !== "ready") {
        throw new ProtocolError("primary_session_not_ready", "utility execution requires a ready primary Session");
      }
      return await this.#authority.runUtilityRequest(params, signal, async (profile) => {
        let text = "";
        let textBytes = 0;
        let usage: TokenUsage | undefined;
        let finish: Extract<StreamChunk, { type: "finish" }>["reason"] | undefined;
        const messageId = MessageId(`utility-${fingerprint(params).slice(0, 48)}`);
        const chunks = this.ctx.llm.stream({
          provider: profile.providerRouteId,
          model: profile.modelId,
          ...(profile.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(profile.effort) }),
          messages: [freezeMessage({
            id: messageId,
            role: "user",
            content: [{ type: "text", text: params.prompt }],
            source: { kind: "user" },
          })],
          system: params.systemPrompt,
          tools: [],
          maxTokens: Math.min(params.maxTokens, profile.maxTokens),
          signal,
        });
        for await (const chunk of chunks) {
          signal.throwIfAborted();
          if (chunk.type === "text-delta") {
            const nextBytes = Buffer.byteLength(chunk.text);
            if (text.length + chunk.text.length > 1_000_000
              || textBytes + nextBytes > maxResultBytes) {
              throw new ProtocolError("utility_result_too_large", "utility model output exceeds its bound");
            }
            text += chunk.text;
            textBytes += nextBytes;
          } else if (chunk.type === "usage") {
            usage = chunk.usage;
          } else if (chunk.type === "finish") {
            finish = chunk.reason;
          }
        }
        const projectedUsage = normalizedUsage(usage, profile.pricing);
        if (finish?.kind === "stop") {
          const result = validateMethodResult("utility/run", Object.freeze({
            state: "succeeded" as const,
            text,
            ...(projectedUsage === undefined ? {} : { usage: projectedUsage }),
          }));
          if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxResultBytes) {
            throw new ProtocolError("utility_result_too_large", "utility model output exceeds its frame budget");
          }
          return result;
        }
        if (finish?.kind === "aborted" || signal.aborted) {
          return validateMethodResult("utility/run", Object.freeze({
            state: "aborted" as const,
            ...(projectedUsage === undefined ? {} : { usage: projectedUsage }),
          }));
        }
        return validateMethodResult("utility/run", Object.freeze({
          state: "failed" as const,
          code: finish?.kind === "max-tokens"
            ? "max_output_tokens"
            : finish?.kind === "tool-calls"
              ? "utility_tool_call_forbidden"
              : "provider_error",
          ...(projectedUsage === undefined ? {} : { usage: projectedUsage }),
        }));
      });
    } catch (error) {
      if (signal.aborted) {
        return validateMethodResult("utility/run", Object.freeze({ state: "aborted" as const }));
      }
      return validateMethodResult("utility/run", Object.freeze({
        state: "failed" as const,
        code: error instanceof ProtocolError ? error.code : "utility_failed",
      }));
    } finally {
      this.#active -= 1;
    }
  }
}
