import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  MAX_BROWSER_BODY_BYTES,
  validateBootstrap,
  validateBrowserCommand,
  validateInteractionResponse,
  WEB_HOST_CONTRACT_VERSION,
  type Bootstrap,
  type BrowserCommand,
  type InteractionResponse,
} from "@myagents-dsh/web-host-contract";

import type { HostAttachmentStore } from "./attachment-store.js";
import type { BrowserAuth, LaunchAuthenticator } from "./auth.js";
import type { HostEventHub } from "./event-hub.js";
import { WebHostError } from "./errors.js";

export const WEB_HOST_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "worker-src 'none'",
].join("; ");

export type StaticAsset = Readonly<{
  bytes: Uint8Array;
  contentType: string;
  etag: string;
  immutable: boolean;
}>;
export type BrowserServerOptions = Readonly<{
  authenticator: LaunchAuthenticator;
  eventHub: HostEventHub;
  bootstrap: (auth: BrowserAuth) => Promise<Bootstrap> | Bootstrap;
  command: (command: BrowserCommand, auth: BrowserAuth) => Promise<void>;
  interaction: (response: InteractionResponse, auth: BrowserAuth) => Promise<void>;
  attachmentStore: (webSessionId: string) => HostAttachmentStore | undefined;
  staticAsset: (path: string) => Promise<StaticAsset | undefined> | StaticAsset | undefined;
  maxUploadBytes?: number;
}>;
export type BrowserServerAddress = Readonly<{
  port: number;
  ipv4Origin: string;
  ipv6Origin: string;
  launchUrl: string;
}>;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;
const safeHeaders = (response: ServerResponse): void => {
  response.setHeader("Content-Security-Policy", WEB_HOST_CSP);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
};
const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const bytes = Buffer.from(JSON.stringify(value));
  safeHeaders(response);
  response.writeHead(status, { ...jsonHeaders, "content-length": bytes.byteLength });
  response.end(bytes);
};
const sendError = (response: ServerResponse, error: unknown): void => {
  const code = error instanceof WebHostError ? error.code : "web_host_internal_error";
  const status = code.includes("unauthorized") || code.startsWith("launch_") ? 401
    : code.includes("csrf") || code.includes("origin") || code.includes("host") ? 403
      : code.includes("unknown") ? 404
        : code.includes("overloaded") || code.includes("capacity") ? 429
          : code.includes("limit") ? 413
          : error instanceof WebHostError ? 400 : 500;
  sendJson(response, status, { error: { code, message: "Request was rejected" } });
};
const oneHeader = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;
const hasAsciiControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};
const base64urlUtf8 = (value: string | undefined, name: string, maximum: number): string => {
  if (value === undefined || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length > maximum * 2) {
    throw new WebHostError("attachment_metadata_invalid", `${name} is invalid`);
  }
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (decoded.length < 1 || decoded.length > maximum || Buffer.from(decoded).toString("base64url") !== value) {
    throw new WebHostError("attachment_metadata_invalid", `${name} is invalid`);
  }
  return decoded;
};
const readBody = async (request: IncomingMessage, maximum: number): Promise<Buffer> => {
  const declared = oneHeader(request.headers["content-length"]);
  if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    throw new WebHostError("browser_body_limit", "Request body exceeds its byte limit");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maximum) {
      request.destroy();
      throw new WebHostError("browser_body_limit", "Request body exceeds its byte limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
};
const readJson = async (request: IncomingMessage): Promise<unknown> => {
  if (oneHeader(request.headers["content-type"]) !== "application/json") {
    throw new WebHostError("browser_content_type", "Request content type is invalid");
  }
  const bytes = await readBody(request, MAX_BROWSER_BODY_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new WebHostError("browser_json_invalid", "Request JSON is invalid", false, { cause: error });
  }
};
const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error === undefined ? resolveClose() : reject(error));
    server.closeAllConnections();
  });
};

export class LoopbackBrowserServer {
  readonly #options: BrowserServerOptions;
  readonly #ipv4: Server;
  readonly #ipv6: Server;
  #address: BrowserServerAddress | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: BrowserServerOptions) {
    this.#options = options;
    this.#ipv4 = this.#createHttpServer();
    this.#ipv6 = this.#createHttpServer();
  }

  async listen(): Promise<BrowserServerAddress> {
    if (this.#address !== undefined) return this.#address;
    const port = await new Promise<number>((resolveListen, reject) => {
      this.#ipv6.once("error", reject);
      this.#ipv6.listen({ host: "::1", port: 0, ipv6Only: true }, () => {
        this.#ipv6.off("error", reject);
        const address = this.#ipv6.address();
        if (address === null || typeof address === "string") reject(new Error("IPv6 loopback address is unavailable"));
        else resolveListen(address.port);
      });
    });
    try {
      await new Promise<void>((resolveListen, reject) => {
        this.#ipv4.once("error", reject);
        this.#ipv4.listen({ host: "127.0.0.1", port }, () => {
          this.#ipv4.off("error", reject);
          resolveListen();
        });
      });
    } catch (error) {
      await closeServer(this.#ipv6);
      throw error;
    }
    const ipv4Origin = `http://127.0.0.1:${port}`;
    const ipv6Origin = `http://[::1]:${port}`;
    this.#address = Object.freeze({
      port,
      ipv4Origin,
      ipv6Origin,
      launchUrl: `${ipv4Origin}/?launch=${this.#options.authenticator.launchCapability}`,
    });
    return this.#address;
  }

  close(): Promise<void> {
    this.#closePromise ??= Promise.all([closeServer(this.#ipv4), closeServer(this.#ipv6)])
      .then(() => undefined);
    return this.#closePromise;
  }

  #createHttpServer(): Server {
    const server = createServer({
      highWaterMark: 64 * 1_024,
      insecureHTTPParser: false,
      joinDuplicateHeaders: false,
      keepAlive: true,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 16_384,
      requireHostHeader: true,
    }, (request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) sendError(response, error);
        else response.destroy();
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxRequestsPerSocket = 1_024;
    server.maxConnections = 64;
    return server;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = this.#address;
    if (address === undefined) throw new WebHostError("web_host_not_ready", "Web Host is not listening");
    const localAddress = request.socket.localAddress;
    const remoteAddress = request.socket.remoteAddress;
    if ((localAddress !== "127.0.0.1" && localAddress !== "::1")
      || (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1")) {
      throw new WebHostError("browser_host_invalid", "Request socket is not loopback");
    }
    if (request.headers["x-forwarded-for"] !== undefined
      || request.headers["x-forwarded-host"] !== undefined
      || request.headers["x-forwarded-proto"] !== undefined) {
      throw new WebHostError("browser_host_invalid", "Forwarded authority is not accepted");
    }
    const host = oneHeader(request.headers.host);
    const allowedHosts = new Set([`127.0.0.1:${address.port}`, `[::1]:${address.port}`]);
    if (host === undefined || !allowedHosts.has(host)) {
      throw new WebHostError("browser_host_invalid", "Host header is invalid");
    }
    const rawUrl = request.url;
    if (rawUrl === undefined || !rawUrl.startsWith("/") || rawUrl.startsWith("//")
      || rawUrl.includes("\\") || hasAsciiControl(rawUrl)) {
      throw new WebHostError("browser_path_invalid", "Request target is invalid");
    }
    let decodedTarget: string;
    try {
      decodedTarget = decodeURIComponent(rawUrl.split("?", 1)[0] ?? "");
    } catch (error) {
      throw new WebHostError("browser_path_invalid", "Request target encoding is invalid", false, { cause: error });
    }
    if (decodedTarget.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new WebHostError("browser_path_invalid", "Request target contains path traversal");
    }
    const origin = `http://${host}`;
    const url = new URL(rawUrl, origin);
    if (url.origin !== origin) throw new WebHostError("browser_path_invalid", "Request target origin is invalid");
    if (url.pathname === "/api/v1/health") {
      if (request.method !== "GET" || url.search !== "") return this.#methodNotAllowed(response, "GET");
      sendJson(response, 200, { ready: true, contractVersion: WEB_HOST_CONTRACT_VERSION });
      return;
    }
    if (url.pathname === "/" && url.searchParams.has("launch")) {
      if (request.method !== "GET" || [...url.searchParams.keys()].some((key) => key !== "launch")
        || url.searchParams.getAll("launch").length !== 1) {
        throw new WebHostError("launch_capability_invalid", "Launch exchange request is invalid");
      }
      const auth = this.#options.authenticator.exchange(url.searchParams.get("launch") ?? "");
      safeHeaders(response);
      response.setHeader("Set-Cookie", this.#options.authenticator.cookieHeader(auth));
      response.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (url.search !== "") throw new WebHostError("browser_path_invalid", "Query parameters are not accepted");
    const auth = this.#options.authenticator.authenticateCookie(oneHeader(request.headers.cookie));
    if (url.pathname === "/api/v1/bootstrap") {
      if (request.method !== "GET") return this.#methodNotAllowed(response, "GET");
      sendJson(response, 200, validateBootstrap(await this.#options.bootstrap(auth)));
      return;
    }
    if (url.pathname === "/api/v1/events") {
      if (request.method !== "GET") return this.#methodNotAllowed(response, "GET");
      this.#assertOrigin(request, origin);
      this.#events(request, response);
      return;
    }
    if (url.pathname === "/api/v1/commands") {
      if (request.method !== "POST") return this.#methodNotAllowed(response, "POST");
      this.#assertMutation(request, auth, origin, "application/json");
      const command = validateBrowserCommand(await readJson(request));
      await this.#options.command(command, auth);
      sendJson(response, 202, { commandId: command.commandId, accepted: true });
      return;
    }
    const interactionMatch = /^\/api\/v1\/interactions\/([^/]+)$/u.exec(url.pathname);
    if (interactionMatch !== null) {
      if (request.method !== "POST") return this.#methodNotAllowed(response, "POST");
      this.#assertMutation(request, auth, origin, "application/json");
      const interaction = validateInteractionResponse(await readJson(request));
      if (decodeURIComponent(interactionMatch[1] ?? "") !== interaction.interactionId) {
        throw new WebHostError("interaction_identity_mismatch", "Interaction path and body differ");
      }
      await this.#options.interaction(interaction, auth);
      sendJson(response, 202, { interactionId: interaction.interactionId, accepted: true });
      return;
    }
    if (url.pathname === "/api/v1/attachments") {
      if (request.method !== "POST") return this.#methodNotAllowed(response, "POST");
      this.#assertMutation(request, auth, origin, "application/octet-stream");
      const webSessionId = oneHeader(request.headers["x-myagents-web-session"]);
      const store = webSessionId === undefined ? undefined : this.#options.attachmentStore(webSessionId);
      if (store === undefined) throw new WebHostError("session_unknown", "Active Web Session is unknown");
      const bytes = await readBody(request, this.#options.maxUploadBytes ?? 10 * 1_048_576);
      const expectedSha256 = oneHeader(request.headers["x-myagents-attachment-sha256"]);
      const summary = await store.putUpload({
        name: base64urlUtf8(oneHeader(request.headers["x-myagents-attachment-name"]), "Attachment name", 512),
        mimeType: oneHeader(request.headers["x-myagents-attachment-type"]) ?? "application/octet-stream",
        bytes,
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      });
      sendJson(response, 201, summary);
      return;
    }
    const attachmentMatch = /^\/api\/v1\/attachments\/([^/]+)$/u.exec(url.pathname);
    if (attachmentMatch !== null) {
      const webSessionId = oneHeader(request.headers["x-myagents-web-session"]);
      const store = webSessionId === undefined ? undefined : this.#options.attachmentStore(webSessionId);
      if (store === undefined) throw new WebHostError("session_unknown", "Active Web Session is unknown");
      const attachmentId = decodeURIComponent(attachmentMatch[1] ?? "");
      if (request.method === "GET") {
        const preview = await store.readPreview(attachmentId);
        safeHeaders(response);
        response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
        response.writeHead(200, {
          "content-type": preview.summary.mimeType,
          "content-length": preview.bytes.byteLength,
          "cache-control": "no-store",
        });
        response.end(preview.bytes);
        return;
      }
      if (request.method === "DELETE") {
        this.#assertMutation(request, auth, origin);
        await store.releaseAttachment(attachmentId);
        sendJson(response, 200, { ok: true });
        return;
      }
      return this.#methodNotAllowed(response, "GET, DELETE");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return this.#methodNotAllowed(response, "GET, HEAD");
    }
    const asset = await this.#options.staticAsset(url.pathname);
    if (asset === undefined) {
      sendJson(response, 404, { error: { code: "asset_unknown", message: "Resource was not found" } });
      return;
    }
    safeHeaders(response);
    response.writeHead(200, {
      "content-type": asset.contentType,
      "content-length": asset.bytes.byteLength,
      etag: asset.etag,
      "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : asset.bytes);
  }

  #assertOrigin(request: IncomingMessage, origin: string): void {
    if (oneHeader(request.headers.origin) !== origin) {
      throw new WebHostError("browser_origin_invalid", "Origin is invalid");
    }
  }

  #assertMutation(
    request: IncomingMessage,
    auth: BrowserAuth,
    origin: string,
    contentType?: string,
  ): void {
    this.#assertOrigin(request, origin);
    this.#options.authenticator.assertCsrf(auth, oneHeader(request.headers["x-myagents-csrf"]));
    if (contentType !== undefined && oneHeader(request.headers["content-type"]) !== contentType) {
      throw new WebHostError("browser_content_type", "Request content type is invalid");
    }
  }

  #events(request: IncomingMessage, response: ServerResponse): void {
    safeHeaders(response);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.flushHeaders();
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      subscription.unsubscribe();
      response.end();
    };
    const subscription = this.#options.eventHub.subscribe(
      oneHeader(request.headers["last-event-id"]),
      ({ frame }) => { if (!response.write(frame)) stop(); },
    );
    request.once("close", stop);
    for (const { frame } of subscription.replay) {
      if (!response.write(frame)) {
        stop();
        break;
      }
    }
  }

  #methodNotAllowed(response: ServerResponse, allow: string): void {
    safeHeaders(response);
    response.setHeader("Allow", allow);
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Method is not allowed" } });
  }
}
