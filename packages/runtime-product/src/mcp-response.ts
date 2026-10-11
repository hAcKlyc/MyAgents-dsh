import type { ProductSafeHttpOpenResponse } from "@myagents-dsh/tools-web";
import { isProxy } from "node:util/types";

export const mcpOpenResponse = async (
  response: ProductSafeHttpOpenResponse,
  signal: AbortSignal,
): Promise<Response> => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (typeof value === "string") headers.append(name, value);
    else for (const item of value) headers.append(name, item);
  }
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    await response.dispose();
    throw new TypeError("managed MCP response ignored the required identity encoding");
  }
  if (response.statusCode < 200) {
    await response.dispose();
    throw new TypeError("managed MCP response status is unsupported");
  }
  if ([204, 205, 304].includes(response.statusCode)) {
    await response.dispose();
    return new Response(null, { headers, status: response.statusCode });
  }
  const iterator = response.body[Symbol.asyncIterator]();
  let disposal: Promise<void> | undefined;
  let bytes = 0;
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      signal.removeEventListener("abort", abort);
      // Destroy the owned response first: return() queues behind a pending next().
      try {
        await response.dispose();
      } finally {
        await iterator.return?.();
      }
    })();
    return disposal;
  };
  const abort = (): void => { void dispose().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const next = await iterator.next();
        if (next.done) {
          await dispose();
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array) || isProxy(next.value)) {
          throw new TypeError("managed MCP response yielded an invalid byte chunk");
        }
        bytes += next.value.byteLength;
        if (bytes > 1_048_576) throw new TypeError("managed MCP response exceeds its stream bound");
        controller.enqueue(Uint8Array.from(next.value));
      } catch (error) {
        await dispose().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await dispose();
    },
  });
  return new Response(body, { headers, status: response.statusCode });
};

