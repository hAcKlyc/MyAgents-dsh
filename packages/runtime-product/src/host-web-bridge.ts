import type { Context } from "@deepseek-ai/cordis";
import type { HostPortServiceController } from "@myagents-dsh/host-ports";
import { ProtocolError } from "@myagents-dsh/protocol";
import { ProductToolError, productRootAgent, type ProductToolContext } from "@myagents-dsh/tool-runtime-product";
import { isProxy } from "node:util/types";

import type { HostModelAuthority } from "./host-model.js";

type CanonicalHostWebTool = "WebFetch" | "WebSearch";
type JsonObject = Record<string, unknown>;

const COMPONENT_GENERATION_ID = "myagents-host-canonical-web-v1";

const failedHostMessage = (value: unknown, fallback: string): string => {
  if (!Array.isArray(value)) return fallback;
  const first = value.find((item) => item !== null && typeof item === "object"
    && !Array.isArray(item) && (item as JsonObject).type === "text"
    && typeof (item as JsonObject).text === "string") as JsonObject | undefined;
  return typeof first?.text === "string" && first.text.length > 0
    ? first.text.slice(0, 4_096)
    : fallback;
};

const exactStructuredResult = (value: unknown, tool: CanonicalHostWebTool): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new ProductToolError("host_web_failed", `${tool} Host result is not a plain object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProductToolError("host_web_failed", `${tool} Host result is not a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(value, key)
      : undefined;
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new ProductToolError("host_web_failed", `${tool} Host result contains unsafe fields`);
    }
  }
  return value as JsonObject;
};

export const executeHostCanonicalWebTool = (
  root: Context,
  ports: HostPortServiceController,
  authority: HostModelAuthority,
  context: ProductToolContext,
  tool: CanonicalHostWebTool,
  input: Readonly<Record<string, unknown>>,
): Promise<JsonObject> => authority.runHostWebRequest(
  context,
  async (profile, assertCurrent, configRevision) => {
    assertCurrent();
    const requestAuthority = ports.createRequestAuthority(Object.freeze({
      assertCurrent,
      callId: context.callId,
      clientOperationId: context.clientOperationId,
      componentGenerationId: COMPONENT_GENERATION_ID,
      componentId: tool === "WebFetch" ? "canonical-web-fetch" : "canonical-web-search",
      deadlineMs: 120_000,
      dshTurn: context.dshTurn,
      expectedConfigRevision: configRevision,
      rootCallId: context.rootCallId,
      runtimeSessionId: String(productRootAgent(context).id),
      signal: context.signal,
      turnId: context.productTurnId,
    }));
    let result;
    try {
      result = await root.hostPorts.executeHostTool(requestAuthority, Object.freeze({
        input: Object.freeze({ ...input, modelProfileRevision: profile.revision }),
        tool,
      }));
    } catch (error) {
      context.signal.throwIfAborted();
      throw new ProductToolError("host_web_failed", `${tool} Host reverse request failed`, {
        cause: error,
      });
    }
    context.signal.throwIfAborted();
    assertCurrent();
    if (result.state !== "succeeded") {
      throw new ProductToolError(
        result.code ?? "host_web_failed",
        failedHostMessage(result.content, `${tool} Host reverse request did not succeed`),
      );
    }
    if (result.structured === undefined) {
      throw new ProtocolError(
        "host_web_result_invalid",
        `${tool} Host reverse request omitted its canonical structured result`,
      );
    }
    return exactStructuredResult(result.structured, tool);
  },
);
