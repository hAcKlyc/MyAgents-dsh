import type { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isProxy } from "node:util/types";

import type {
  McpConnectionFactory,
  McpConnectionFactoryInput,
} from "./compiler.js";
import { createSdkMcpConnectionFactory } from "./sdk-connection.js";

export interface ManagedMcpLaunchProfile {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ManagedMcpTransportConfig {
  readonly launchProfiles: Readonly<Record<string, ManagedMcpLaunchProfile>>;
}

type JsonObject = Record<string, unknown>;

const exactObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const record = value as JsonObject;
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(record, key) : undefined;
    if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable
      || !("value" in descriptor)) {
      throw new TypeError(`${description} must contain only enumerable own data properties`);
    }
  }
  return record;
};

const boundedString = (value: unknown, maximum: number, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${description} must be bounded non-empty text`);
  }
  return value;
};

const normalizeLaunchProfiles = (
  value: unknown,
): Readonly<Record<string, ManagedMcpLaunchProfile>> => {
  const profiles = exactObject(value, "MCP launch-profile catalog");
  if (Reflect.ownKeys(profiles).length > 128) {
    throw new TypeError("MCP launch-profile catalog exceeds its bound");
  }
  const normalized: Record<string, ManagedMcpLaunchProfile> = Object.create(null) as Record<
    string,
    ManagedMcpLaunchProfile
  >;
  for (const [reference, candidate] of Object.entries(profiles)) {
    boundedString(reference, 256, "MCP launch-profile reference");
    const profile = exactObject(candidate, `MCP launch profile ${reference}`);
    if (Reflect.ownKeys(profile).some((key) => key !== "argv" && key !== "cwd" && key !== "env")
      || !Object.hasOwn(profile, "argv") || !Object.hasOwn(profile, "cwd")) {
      throw new TypeError(`MCP launch profile ${reference} has an invalid exact shape`);
    }
    if (!Array.isArray(profile.argv) || isProxy(profile.argv) || profile.argv.length < 1
      || profile.argv.length > 256 || Reflect.ownKeys(profile.argv).length !== profile.argv.length + 1) {
      throw new TypeError(`MCP launch profile ${reference} argv is invalid`);
    }
    const argv = Object.freeze(profile.argv.map((entry, index) =>
      boundedString(entry, 262_144, `MCP launch profile ${reference} argv[${String(index)}]`)));
    const cwd = boundedString(profile.cwd, 8_192, `MCP launch profile ${reference} cwd`);
    let env: Readonly<Record<string, string>> | undefined;
    if (Object.hasOwn(profile, "env")) {
      const entries = exactObject(profile.env, `MCP launch profile ${reference} environment`);
      if (Reflect.ownKeys(entries).length > 256) {
        throw new TypeError(`MCP launch profile ${reference} environment exceeds its bound`);
      }
      env = Object.freeze(Object.fromEntries(Object.entries(entries).map(([key, entry]) => [
        boundedString(key, 256, `MCP launch profile ${reference} environment key`),
        boundedString(entry, 65_536, `MCP launch profile ${reference} environment value`),
      ])));
    }
    normalized[reference] = Object.freeze({ argv, cwd, ...(env === undefined ? {} : { env }) });
  }
  return Object.freeze(normalized);
};

const normalizeConfig = (value: unknown): Readonly<{
  launchProfiles: Readonly<Record<string, ManagedMcpLaunchProfile>>;
}> => {
  const config = exactObject(value, "managed MCP transport config");
  if (Reflect.ownKeys(config).length !== 1 || !Object.hasOwn(config, "launchProfiles")) {
    throw new TypeError("managed MCP transport config has an invalid exact shape");
  }
  return Object.freeze({ launchProfiles: normalizeLaunchProfiles(config.launchProfiles) });
};

const blockedIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".").map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
};

const isIpv4Literal = (hostname: string): boolean => {
  const octets = hostname.split(".");
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/u.test(octet)
    && Number(octet) <= 255);
};

const remoteEndpoint = (raw: string): URL => {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== "" || url.password !== "" || url.hash !== ""
    || hostname.length === 0 || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home")
    || hostname.endsWith(".lan") || hostname.includes(":")
    || (isIpv4Literal(hostname) && blockedIpv4(hostname))) {
    throw new TypeError("MCP remote endpoint is not an approved public HTTP(S) destination");
  }
  url.hostname = hostname;
  return url;
};

const credentialHeaders = (material: Readonly<Record<string, string>>): Headers => {
  const headers = new Headers();
  let bytes = 0;
  for (const [name, value] of Object.entries(material)) {
    if (value.includes("\r") || value.includes("\n")) {
      throw new TypeError("MCP remote credential header contains a line break");
    }
    const lower = name.toLowerCase();
    if (["connection", "content-length", "host", "proxy-authorization", "transfer-encoding"].includes(lower)) {
      throw new TypeError("MCP remote credential material targets a transport-owned header");
    }
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (bytes > 65_536) throw new TypeError("MCP remote credential headers exceed their bound");
    headers.set(name, value);
  }
  return headers;
};

const guardedFetch = (
  endpoint: URL,
  credentials: Headers,
): typeof globalThis.fetch => async (input, init) => {
  const requested = new URL(input instanceof Request ? input.url : input);
  if (requested.origin !== endpoint.origin) {
    throw new TypeError("MCP transport attempted a cross-origin request");
  }
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  credentials.forEach((value, name) => headers.set(name, value));
  return await globalThis.fetch(input, { ...init, headers, redirect: "error" });
};

const boundedResponseText = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1_048_576) throw new Error("MCP HTTP response exceeds its frame bound");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
};

const parseHttpMessages = (contentType: string, text: string): readonly JSONRPCMessage[] => {
  if (text.length === 0) return Object.freeze([]);
  if (contentType.toLowerCase().includes("text/event-stream")) {
    const messages: JSONRPCMessage[] = [];
    for (const event of text.replaceAll("\r\n", "\n").split("\n\n")) {
      const data = event.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) messages.push(JSON.parse(data) as JSONRPCMessage);
    }
    return Object.freeze(messages);
  }
  return Object.freeze([JSON.parse(text) as JSONRPCMessage]);
};

class ManagedHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credentials: Headers;
  readonly #sourceSignal: AbortSignal;
  readonly #lifetime = new AbortController();
  #protocolVersion: string | undefined;
  #sessionId: string | undefined;
  #started = false;
  #closed = false;

  constructor(endpoint: URL, credentials: Headers, sourceSignal: AbortSignal) {
    this.#endpoint = endpoint;
    this.#credentials = credentials;
    this.#fetch = guardedFetch(endpoint, credentials);
    this.#sourceSignal = sourceSignal;
  }

  start(): Promise<void> {
    if (this.#started || this.#closed) return Promise.reject(new Error("managed MCP HTTP transport is not startable"));
    this.#sourceSignal.throwIfAborted();
    this.#started = true;
    return Promise.resolve();
  }

  setProtocolVersion(version: string): void {
    this.#protocolVersion = boundedString(version, 64, "MCP protocol version");
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#started || this.#closed) throw new Error("managed MCP HTTP transport is closed");
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body, "utf8") > 1_048_576) {
      throw new Error("managed MCP request exceeds its frame bound");
    }
    const headers = new Headers(this.#credentials);
    headers.set("accept", "application/json, text/event-stream");
    headers.set("content-type", "application/json");
    if (this.#sessionId !== undefined) headers.set("mcp-session-id", this.#sessionId);
    if (this.#protocolVersion !== undefined) headers.set("mcp-protocol-version", this.#protocolVersion);
    const signal = AbortSignal.any([this.#sourceSignal, this.#lifetime.signal]);
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, Object.freeze({
        body,
        headers,
        method: "POST",
        redirect: "error" as const,
        signal,
      }));
    } catch (error) {
      if (!signal.aborted) this.onerror?.(error instanceof Error ? error : new Error("managed MCP HTTP request failed"));
      throw error;
    }
    if (!response.ok) throw new Error(`managed MCP HTTP request failed with status ${String(response.status)}`);
    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId !== null) {
      this.#sessionId = boundedString(nextSessionId, 256, "MCP session ID");
    }
    if (response.status === 202 || response.status === 204) return;
    const text = await boundedResponseText(response);
    for (const incoming of parseHttpMessages(response.headers.get("content-type") ?? "", text)) {
      this.onmessage?.(incoming);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const sessionId = this.#sessionId;
    if (this.#started && sessionId !== undefined && !this.#sourceSignal.aborted) {
      const headers = new Headers(this.#credentials);
      headers.set("mcp-session-id", sessionId);
      if (this.#protocolVersion !== undefined) headers.set("mcp-protocol-version", this.#protocolVersion);
      try {
        await this.#fetch(this.#endpoint, Object.freeze({
          headers,
          method: "DELETE",
          redirect: "error" as const,
          signal: AbortSignal.timeout(2_000),
        }));
      } catch {
        // Local generation retirement still owns and completes cancellation.
      }
    }
    this.#lifetime.abort(new Error("managed MCP HTTP transport closed"));
    this.onclose?.();
  }
}

class ManagedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #context: Context;
  readonly #profile: ManagedMcpLaunchProfile;
  readonly #material: Readonly<Record<string, string>>;
  readonly #signal: AbortSignal;
  #handle: SubprocessHandle | undefined;
  #closed = false;
  #closeNotified = false;
  readonly #readBuffer = new ReadBuffer({ maxBufferSize: 1_048_576 });

  constructor(
    context: Context,
    profile: ManagedMcpLaunchProfile,
    material: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ) {
    this.#context = context;
    this.#profile = profile;
    this.#material = material;
    this.#signal = signal;
  }

  async start(): Promise<void> {
    if (this.#handle !== undefined || this.#closed) throw new Error("managed MCP stdio transport is not startable");
    this.#signal.throwIfAborted();
    const command = this.#profile.argv.at(0);
    if (command === undefined) throw new Error("managed MCP launch profile lost its executable");
    const executable = await this.#context.subprocess.resolveExecutable(
      command,
      { ...this.#profile.env, ...this.#material },
      this.#signal,
    );
    this.#signal.throwIfAborted();
    const handle = this.#context.subprocess.spawn({
      argv: Object.freeze([executable, ...this.#profile.argv.slice(1)]),
      cwd: this.#profile.cwd,
      env: Object.freeze({ ...this.#profile.env, ...this.#material }),
      graceMs: 2_000,
      signal: this.#signal,
      stdio: Object.freeze({
        stdin: "pipe" as const,
        stdout: "pipe" as const,
        stderr: Object.freeze({ maxBytes: 65_536 }),
      }),
    });
    if (handle.stdin === undefined || handle.stdout === undefined) {
      handle.terminate();
      await handle.waitForExit().catch(() => false);
      throw new Error("managed MCP subprocess lacks its protocol pipes");
    }
    this.#handle = handle;
    handle.stdout.on("data", (chunk: Buffer | string) => {
      try {
        this.#readBuffer.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        for (;;) {
          const message = this.#readBuffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error("managed MCP stdout decode failed"));
        void this.close();
      }
    });
    handle.stdout.on("error", (error: Error) => this.onerror?.(error));
    void handle.done.then(
      () => this.#notifyClose(),
      (error: unknown) => {
        this.onerror?.(error instanceof Error ? error : new Error("managed MCP subprocess failed"));
        this.#notifyClose();
      },
    );
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#handle?.stdin;
    if (stdin === undefined || this.#closed) return Promise.reject(new Error("managed MCP transport is closed"));
    const payload = serializeMessage(message);
    if (Buffer.byteLength(payload, "utf8") > 1_048_576) {
      return Promise.reject(new Error("managed MCP request exceeds its frame bound"));
    }
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onDrain = (): void => { cleanup(); resolve(); };
      const cleanup = (): void => {
        stdin.off("error", onError);
        stdin.off("drain", onDrain);
      };
      stdin.once("error", onError);
      if (stdin.write(payload)) { cleanup(); resolve(); }
      else stdin.once("drain", onDrain);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const handle = this.#handle;
    if (handle !== undefined) {
      handle.stdin?.end();
      const graceful = await handle.waitForExit(AbortSignal.timeout(2_000));
      if (!graceful) handle.terminate();
      await handle.waitForExit();
    }
    this.#readBuffer.clear();
    this.#notifyClose();
  }

  #notifyClose(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.onclose?.();
  }
}

export const createManagedMcpConnectionFactory = (
  context: Context,
  value: ManagedMcpTransportConfig,
): McpConnectionFactory => {
  if (context !== context.root) {
    throw new TypeError("managed MCP transport requires the direct-root composition Context");
  }
  const config = normalizeConfig(value);
  return createSdkMcpConnectionFactory(Object.freeze({
    createTransport: (input: McpConnectionFactoryInput): Promise<Transport> => {
      input.signal.throwIfAborted();
      if (input.descriptor.transport === "stdio") {
        const profile = config.launchProfiles[input.descriptor.launchProfileRef];
        if (profile === undefined) throw new Error("MCP stdio launch profile is not approved by this Runtime build");
        return Promise.resolve(new ManagedStdioTransport(context, profile, input.material, input.signal));
      }
      const endpoint = remoteEndpoint(input.descriptor.url);
      const headers = credentialHeaders(input.material);
      const fetch = guardedFetch(endpoint, headers);
      if (input.descriptor.transport === "http") {
        return Promise.resolve(new ManagedHttpTransport(endpoint, headers, input.signal));
      }
      // Protocol v2 retains explicit legacy SSE descriptors for compatible MCP servers.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      return Promise.resolve(new SSEClientTransport(endpoint, Object.freeze({
        eventSourceInit: Object.freeze({ fetch: fetch as never }),
        requestInit: Object.freeze({ headers, redirect: "error" as const }),
      })));
    },
  }));
};
