import { canonicalBrowserJson, serializeCanonicalBrowserJson } from "./canonical-json.js";
import { WebHostContractError } from "./errors.js";
import {
  MAX_BROWSER_BODY_BYTES,
  type AttachmentSummary,
  type Bootstrap,
  type BrowserCommand,
  type CommandAccepted,
  type Health,
  type HostEvent,
  type InteractionAccepted,
  type InteractionResponse,
} from "./schemas.js";
import { HostEventStreamDecoder } from "./sse.js";
import {
  validateAttachmentSummary,
  validateBootstrap,
  validateBrowserCommand,
  validateCommandAccepted,
  validateHealth,
  validateInteractionAccepted,
  validateInteractionResponse,
} from "./validation.js";

export type WebHostClientOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
}>;
export type BrowserAttachmentUpload = Readonly<{
  webSessionId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
}>;
export type BrowserAttachmentPreview = Readonly<{
  bytes: Uint8Array;
  mimeType: string;
}>;

const assertFixedPath = (path: string): void => {
  if (!path.startsWith("/api/v1/") || path.includes("..") || path.includes("?") || path.includes("#")) {
    throw new WebHostContractError("browser_client_path", "Client endpoint must be a fixed same-origin API path");
  }
};
const utf8Base64url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

export class WebHostClient {
  readonly #fetch: typeof globalThis.fetch;
  #csrfToken: string | undefined;

  constructor(options: WebHostClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async bootstrap(signal?: AbortSignal): Promise<Bootstrap> {
    const result = validateBootstrap(await this.#requestJson("/api/v1/bootstrap", {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    }));
    this.#csrfToken = result.csrfToken;
    return result;
  }

  async health(signal?: AbortSignal): Promise<Health> {
    return validateHealth(await this.#requestJson("/api/v1/health", {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    }));
  }

  async command(command: BrowserCommand, signal?: AbortSignal): Promise<CommandAccepted> {
    const body = serializeCanonicalBrowserJson(canonicalBrowserJson(validateBrowserCommand(command)));
    return validateCommandAccepted(await this.#mutate("/api/v1/commands", body, signal));
  }

  async respond(response: InteractionResponse, signal?: AbortSignal): Promise<InteractionAccepted> {
    const body = serializeCanonicalBrowserJson(canonicalBrowserJson(validateInteractionResponse(response)));
    return validateInteractionAccepted(await this.#mutate(
      `/api/v1/interactions/${encodeURIComponent(response.interactionId)}`,
      body,
      signal,
    ));
  }

  async uploadAttachment(input: BrowserAttachmentUpload, signal?: AbortSignal): Promise<AttachmentSummary> {
    const csrfToken = this.#requireCsrf();
    if (input.bytes.byteLength > MAX_BROWSER_BODY_BYTES * 50) {
      throw new WebHostContractError("browser_attachment_limit", "Attachment exceeds the browser contract limit");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
      throw new WebHostContractError("browser_attachment_digest", "Attachment digest is invalid");
    }
    const response = await this.#fetch("/api/v1/attachments", {
      body: input.bytes.slice().buffer,
      credentials: "same-origin",
      headers: {
        "content-type": "application/octet-stream",
        "x-myagents-attachment-name": utf8Base64url(input.name),
        "x-myagents-attachment-sha256": input.sha256,
        "x-myagents-attachment-type": input.mimeType,
        "x-myagents-csrf": csrfToken,
        "x-myagents-web-session": input.webSessionId,
      },
      method: "POST",
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    return validateAttachmentSummary(await this.#responseJson(response));
  }

  async previewAttachment(
    webSessionId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<BrowserAttachmentPreview> {
    const path = `/api/v1/attachments/${encodeURIComponent(attachmentId)}`;
    assertFixedPath(path);
    const response = await this.#fetch(path, {
      credentials: "same-origin",
      headers: { "x-myagents-web-session": webSessionId },
      method: "GET",
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new WebHostContractError("browser_http_error", `Web Host returned HTTP ${response.status}`);
    const contentLength = response.headers.get("content-length");
    if (contentLength === null || !/^(?:0|[1-9][0-9]*)$/u.test(contentLength)
      || Number(contentLength) > MAX_BROWSER_BODY_BYTES * 50) {
      throw new WebHostContractError("browser_attachment_limit", "Attachment response byte bound is invalid");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== Number(contentLength)) {
      throw new WebHostContractError("browser_attachment_length", "Attachment response length is invalid");
    }
    return Object.freeze({
      bytes,
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    });
  }

  async releaseAttachment(webSessionId: string, attachmentId: string, signal?: AbortSignal): Promise<void> {
    const csrfToken = this.#requireCsrf();
    const path = `/api/v1/attachments/${encodeURIComponent(attachmentId)}`;
    assertFixedPath(path);
    const response = await this.#fetch(path, {
      credentials: "same-origin",
      headers: {
        "x-myagents-csrf": csrfToken,
        "x-myagents-web-session": webSessionId,
      },
      method: "DELETE",
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    const result = await this.#responseJson(response);
    if (typeof result !== "object" || result === null || Array.isArray(result)
      || Object.keys(result).length !== 1 || (result as { ok?: unknown }).ok !== true) {
      throw new WebHostContractError("browser_invalid_attachment_ack", "Attachment release response is invalid");
    }
  }

  async *events(options: Readonly<{
    lastEventId?: string;
    signal?: AbortSignal;
  }> = {}): AsyncGenerator<HostEvent> {
    const headers = new Headers({ Accept: "text/event-stream" });
    if (options.lastEventId !== undefined) headers.set("Last-Event-ID", options.lastEventId);
    const response = await this.#fetch("/api/v1/events", {
      credentials: "same-origin",
      headers,
      method: "GET",
      redirect: "error",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok || response.body === null) {
      throw new WebHostContractError("browser_event_stream", `Event stream failed with HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "text/event-stream") {
      throw new WebHostContractError("browser_event_content_type", "Event stream content type is invalid");
    }
    const decoder = new HostEventStreamDecoder();
    const textDecoder = new TextDecoder("utf-8", { fatal: true });
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const parsed of decoder.push(textDecoder.decode(chunk.value, { stream: true }))) {
          yield parsed.event;
        }
      }
      for (const parsed of decoder.push(textDecoder.decode())) yield parsed.event;
      decoder.finish();
    } finally {
      reader.releaseLock();
    }
  }

  async #mutate(path: string, body: string, signal?: AbortSignal): Promise<unknown> {
    const csrfToken = this.#requireCsrf();
    if (new TextEncoder().encode(body).byteLength > MAX_BROWSER_BODY_BYTES) {
      throw new WebHostContractError("browser_request_limit", "Browser request exceeds its byte limit");
    }
    return this.#requestJson(path, {
      body,
      headers: {
        "content-type": "application/json",
        "x-myagents-csrf": csrfToken,
      },
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #requestJson(path: string, init: RequestInit): Promise<unknown> {
    assertFixedPath(path);
    const response = await this.#fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
    });
    return this.#responseJson(response);
  }

  async #responseJson(response: Response): Promise<unknown> {
    if (!response.ok) throw new WebHostContractError("browser_http_error", `Web Host returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      throw new WebHostContractError("browser_json_content_type", "Web Host response content type is invalid");
    }
    const bytes = await response.text();
    if (new TextEncoder().encode(bytes).byteLength > MAX_BROWSER_BODY_BYTES) {
      throw new WebHostContractError("browser_response_limit", "Web Host response exceeds its byte limit");
    }
    try {
      return JSON.parse(bytes) as unknown;
    } catch (error) {
      throw new WebHostContractError("browser_response_json", "Web Host returned invalid JSON", { cause: error });
    }
  }

  #requireCsrf(): string {
    if (this.#csrfToken === undefined) {
      throw new WebHostContractError("browser_client_unbootstrapped", "Bootstrap is required before mutations");
    }
    return this.#csrfToken;
  }
}
