import { Context, type Plugin } from "@deepseek-ai/cordis";
import { createUserMessage, LlmRuntime, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { describe, expect, it, vi } from "vitest";

const PI_AI_PLUGIN_SPECIFIER = "@deepseek-ai/dsh-llm-pi-ai";
type ApiFamily = "anthropic-messages" | "openai-completions" | "openai-responses";
type ReplyKind = "reasoning" | "text" | "tool";

const sse = (events: readonly string[]): Response => new Response(
  `${events.join("\n\n")}\n\n`,
  { headers: { "content-type": "text/event-stream" }, status: 200 },
);

const textReply = (family: ApiFamily): Response => {
  if (family === "anthropic-messages") {
    return sse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"fixture-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"fixture reply"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);
  }
  if (family === "openai-completions") {
    return sse([
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"fixture reply"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      "data: [DONE]",
    ]);
  }
  return sse([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fixture","object":"response","created_at":1,"status":"in_progress","error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":16,"model":"fixture-model","output":[],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":null,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[],"top_p":null,"truncation":"disabled","usage":null,"user":null,"metadata":{}}}',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_fixture","type":"message","status":"in_progress","role":"assistant","content":[]}}',
    'event: response.content_part.added\ndata: {"type":"response.content_part.added","item_id":"msg_fixture","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[],"logprobs":[]}}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_fixture","output_index":0,"content_index":0,"delta":"fixture reply","logprobs":[]}',
    'event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"msg_fixture","output_index":0,"content_index":0,"text":"fixture reply","logprobs":[]}',
    'event: response.content_part.done\ndata: {"type":"response.content_part.done","item_id":"msg_fixture","output_index":0,"content_index":0,"part":{"type":"output_text","text":"fixture reply","annotations":[],"logprobs":[]}}',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_fixture","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"fixture reply","annotations":[],"logprobs":[]}]}}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fixture","object":"response","created_at":1,"status":"completed","error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":16,"model":"fixture-model","output":[{"id":"msg_fixture","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"fixture reply","annotations":[],"logprobs":[]}]}],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":null,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[],"top_p":null,"truncation":"disabled","usage":{"input_tokens":3,"input_tokens_details":{"cached_tokens":0},"output_tokens":2,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":5},"user":null,"metadata":{}}}',
  ]);
};

const toolReply = (family: ApiFamily): Response => {
  const argumentsText = '{"city":"Paris"}';
  if (family === "anthropic-messages") {
    return sse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"fixture-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_fixture","name":"lookup_weather","input":{}}}',
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(argumentsText)}}}`,
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);
  }
  if (family === "openai-completions") {
    return sse([
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"lookup_weather","arguments":""}}]},"finish_reason":null}]}',
      `data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"lookup_weather","arguments":${JSON.stringify(argumentsText)}}}]},"finish_reason":null}]}`,
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":5,"total_tokens":9}}',
      "data: [DONE]",
    ]);
  }
  const item = {
    id: "fc_fixture",
    type: "function_call",
    status: "completed",
    name: "lookup_weather",
    arguments: argumentsText,
    call_id: "call_fixture",
  } as const;
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 16,
    model: "fixture-model",
    output: [item],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 4,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 9,
    },
    user: null,
    metadata: {},
  } as const;
  return sse([
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } })}`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } })}`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: argumentsText })}`,
    `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: argumentsText })}`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}`,
  ]);
};

const reasoningReply = (family: ApiFamily): Response => {
  if (family === "anthropic-messages") {
    return sse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"fixture-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"fixture thought"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"fixture reply"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);
  }
  if (family === "openai-completions") {
    return sse([
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":"fixture thought"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"content":"fixture reply"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
      "data: [DONE]",
    ]);
  }
  const reasoning = {
    id: "reasoning_fixture",
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: "fixture thought" }],
  } as const;
  const message = {
    id: "msg_fixture",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "fixture reply", annotations: [], logprobs: [] }],
  } as const;
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 16,
    model: "fixture-model",
    output: [reasoning, message],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: "high", summary: "auto" },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 7,
    },
    user: null,
    metadata: {},
  } as const;
  return sse([
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } })}`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...reasoning, status: "in_progress", summary: [] } })}`,
    `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", item_id: reasoning.id, output_index: 0, summary_index: 0, delta: "fixture thought" })}`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: reasoning })}`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { ...message, status: "in_progress", content: [] } })}`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: message.id, output_index: 1, content_index: 0, delta: "fixture reply", logprobs: [] })}`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: message })}`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}`,
  ]);
};

const reply = (family: ApiFamily, kind: ReplyKind): Response =>
  kind === "tool" ? toolReply(family) : kind === "reasoning" ? reasoningReply(family) : textReply(family);

const execute = async (family: ApiFamily, kind: ReplyKind = "text"): Promise<Readonly<{
  chunks: readonly StreamChunk[];
  request: Readonly<{ body: string; headers: Readonly<Record<string, string>>; url: string }>;
}>> => {
  const observed = Promise.withResolvers<Readonly<{
    body: string;
    headers: Readonly<Record<string, string>>;
    url: string;
  }>>();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    observed.resolve(Object.freeze({
      body: await request.clone().text(),
      headers: Object.freeze(Object.fromEntries(request.headers.entries())),
      url: request.url,
    }));
    return reply(family, kind);
  }));
  const context = new Context();
  context.provide("credentials", {
    resolve: () => Promise.resolve(Object.freeze({ value: "fixture-api-key" })),
  } as never);
  await context.plugin(LlmRuntime);
  const plugin = await import(PI_AI_PLUGIN_SPECIFIER) as unknown as Plugin;
  const route = `fixture-${family}`;
  await context.plugin(plugin, {
    providers: {
      [route]: {
        api: family,
        apiKeyEnv: "FIXTURE_PROVIDER_API_KEY",
        baseURL: family === "anthropic-messages"
          ? "https://provider.fixture.invalid"
          : "https://provider.fixture.invalid/v1",
        models: [{
          contextWindow: 8_192,
          id: "fixture-model",
          input: ["text"],
          maxTokens: 16,
          name: "Fixture model",
        }],
        retryPolicy: { maxRetries: 0, mode: "normal" },
        timeoutMs: 5_000,
      },
    },
  });
  const chunks: StreamChunk[] = [];
  try {
    for await (const chunk of context.llm.stream({
      maxTokens: 16,
      messages: [createUserMessage({
        content: [{ type: "text", text: "fixture prompt" }],
        source: { kind: "plugin", plugin: "myagents-dsh-provider-conformance" },
      })],
      model: "fixture-model",
      provider: route,
      signal: AbortSignal.timeout(2_000),
      system: "fixture system",
      ...(kind === "tool" ? {
        tools: [{
          name: "lookup_weather",
          description: "Look up the weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        }],
      } : {}),
    })) chunks.push(chunk);
    expect(chunks, "Provider must finish through the intercepted transport").toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "finish", reason: { kind: kind === "tool" ? "tool-calls" : "stop" } })]),
    );
    expect(globalThis.fetch).toHaveBeenCalled();
    const request = await observed.promise;
    return Object.freeze({ chunks: Object.freeze(chunks), request });
  } finally {
    await context.fiber.dispose();
  }
};

describe("official pi-ai Provider protocol conformance", () => {
  for (const family of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
    it(`streams canonical text, usage, and terminal state for ${family}`, async () => {
      const { chunks, request } = await execute(family);
      expect(chunks.some((chunk) => chunk.type === "text-delta"
        && chunk.text === "fixture reply")).toBe(true);
      const usage = chunks.find((chunk) => chunk.type === "usage");
      expect(usage?.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
      const finish = chunks.find((chunk) => chunk.type === "finish");
      expect(finish?.reason).toEqual({ kind: "stop" });
      expect(request.body).toContain("fixture prompt");
      expect(request.body).toContain("fixture system");
      expect(request.url).not.toContain("fixture prompt");
      expect(JSON.stringify(request.headers)).not.toContain("fixture prompt");
      expect(request.body).not.toContain("fixture-api-key");
      expect(JSON.stringify(request.headers)).toContain("fixture-api-key");
      expect(new URL(request.url).pathname).toBe(family === "anthropic-messages"
        ? "/v1/messages"
        : family === "openai-completions" ? "/v1/chat/completions" : "/v1/responses");
    });

    it(`streams canonical reasoning blocks for ${family}`, async () => {
      const { chunks } = await execute(family, "reasoning");
      expect(chunks.some((chunk) => chunk.type === "reasoning-delta"
        && chunk.text === "fixture thought")).toBe(true);
      expect(chunks.some((chunk) => chunk.type === "block-end"
        && chunk.block.type === "reasoning"
        && chunk.block.text === "fixture thought")).toBe(true);
      expect(chunks.find((chunk) => chunk.type === "finish")?.reason)
        .toEqual({ kind: "stop" });
    });

    it(`streams one stable canonical tool call for ${family}`, async () => {
      const { chunks, request } = await execute(family, "tool");
      const call = chunks.find((chunk) => chunk.type === "block-end"
        && chunk.block.type === "tool-call");
      expect(call).toBeDefined();
      if (call?.type !== "block-end" || call.block.type !== "tool-call") {
        throw new Error("fixture did not produce one canonical tool call");
      }
      expect(call.block.id.length).toBeGreaterThan(0);
      expect(call.block.name).toBe("lookup_weather");
      expect(JSON.parse(call.block.arguments)).toEqual({ city: "Paris" });
      expect(chunks.find((chunk) => chunk.type === "finish")?.reason)
        .toEqual({ kind: "tool-calls" });
      expect(request.body).toContain("lookup_weather");
    });
  }
});
