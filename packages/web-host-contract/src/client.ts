import { canonicalBrowserJson, serializeCanonicalBrowserJson } from "./canonical-json.js";
import { WebHostContractError } from "./errors.js";
import {
  MAX_BROWSER_BODY_BYTES,
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

const assertFixedPath = (path: string): void => {
  if (!path.startsWith("/api/v1/") || path.includes("..") || path.includes("?") || path.includes("#")) {
    throw new WebHostContractError("browser_client_path", "Client endpoint must be a fixed same-origin API path");
  }
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
    const csrfToken = this.#csrfToken;
    if (csrfToken === undefined) {
      throw new WebHostContractError("browser_client_unbootstrapped", "Bootstrap is required before mutations");
    }
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
    if (!response.ok) {
      throw new WebHostContractError("browser_http_error", `Web Host returned HTTP ${response.status}`);
    }
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
}
