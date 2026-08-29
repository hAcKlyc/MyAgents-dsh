import { WebHostContractError } from "./errors.js";
import { MAX_SSE_EVENT_BYTES, type HostEvent } from "./schemas.js";
import { validateHostEvent } from "./validation.js";

export type ParsedHostEvent = Readonly<{
  id: string;
  event: HostEvent;
}>;

export class HostEventStreamDecoder {
  #buffer = "";

  push(chunk: string): ParsedHostEvent[] {
    this.#buffer += chunk.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (new TextEncoder().encode(this.#buffer).byteLength > MAX_SSE_EVENT_BYTES * 2) {
      throw new WebHostContractError("browser_sse_limit", "SSE receive buffer exceeds its limit");
    }
    const events: ParsedHostEvent[] = [];
    let boundary = this.#buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      if (new TextEncoder().encode(frame).byteLength > MAX_SSE_EVENT_BYTES) {
        throw new WebHostContractError("browser_sse_limit", "SSE event exceeds its limit");
      }
      const parsed = this.#parseFrame(frame);
      if (parsed !== undefined) events.push(parsed);
      boundary = this.#buffer.indexOf("\n\n");
    }
    return events;
  }

  finish(): void {
    if (this.#buffer.trim().length !== 0) {
      throw new WebHostContractError("browser_sse_truncated", "SSE stream ended mid-event");
    }
    this.#buffer = "";
  }

  #parseFrame(frame: string): ParsedHostEvent | undefined {
    if (frame.trim().length === 0) return undefined;
    let id: string | undefined;
    let eventName: string | undefined;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      switch (field) {
        case "id": id = value; break;
        case "event": eventName = value; break;
        case "data": data.push(value); break;
        case "retry": break;
        default:
          throw new WebHostContractError("browser_sse_field", `Unsupported SSE field: ${field}`);
      }
    }
    if (id === undefined || id.length === 0 || data.length === 0) {
      throw new WebHostContractError("browser_sse_shape", "SSE event requires id and data");
    }
    let value: unknown;
    try {
      value = JSON.parse(data.join("\n")) as unknown;
    } catch (error) {
      throw new WebHostContractError("browser_sse_json", "SSE data is not valid JSON", { cause: error });
    }
    const event = validateHostEvent(value);
    if (eventName !== undefined && eventName !== event.kind) {
      throw new WebHostContractError("browser_sse_kind", "SSE event name does not match its typed payload");
    }
    return Object.freeze({ id, event });
  }
}
