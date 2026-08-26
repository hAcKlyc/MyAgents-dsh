import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { HostEvent } from "@myagents-dsh/web-host-contract";

import type { BrowserTransportDiagnostic } from "./browser-server.js";

const MAX_LOG_BYTES = 8 * 1_048_576;

type DiagnosticRecord = Readonly<{
  at: string;
  epoch: string;
  sequence: number;
  kind: string;
  webSessionId?: string;
  commandId?: string;
  commandKind?: string;
  state?: string;
  code?: string;
  runtimeEventKind?: string;
  turnId?: string;
  pendingBytes?: number;
  resumed?: boolean;
}>;

const recordFor = (event: HostEvent): DiagnosticRecord => {
  const common = {
    at: event.emittedAt,
    epoch: event.epoch,
    sequence: event.sequence,
    kind: event.kind,
  } as const;
  switch (event.kind) {
    case "host.snapshot": return {
      ...common,
      ...(event.payload.selectedWebSessionId === undefined ? {} : { webSessionId: event.payload.selectedWebSessionId }),
      state: `sessions:${event.payload.sessions.length}`,
    };
    case "host.sessionChanged": return {
      ...common, webSessionId: event.payload.webSessionId, state: event.payload.lifecycle,
      ...(event.payload.failureCode === undefined ? {} : { code: event.payload.failureCode }),
    };
    case "host.commandSettled": return {
      ...common,
      commandId: event.payload.commandId,
      ...(event.payload.webSessionId === undefined ? {} : { webSessionId: event.payload.webSessionId }),
      state: event.payload.state,
      ...(event.payload.error === undefined ? {} : { code: event.payload.error.code }),
    };
    case "host.interactionOpened": return {
      ...common, webSessionId: event.payload.webSessionId, state: event.payload.kind,
      ...(event.payload.permissionAction === undefined ? {} : { code: event.payload.permissionAction }),
    };
    case "host.interactionClosed": return {
      ...common, webSessionId: event.payload.webSessionId, state: "closed",
    };
    case "host.attachmentChanged": return {
      ...common, webSessionId: event.payload.webSessionId, state: event.payload.attachment.state,
    };
    case "runtime.event": return {
      ...common,
      webSessionId: event.payload.webSessionId,
      runtimeEventKind: event.payload.event.event.kind,
      ...(event.payload.event.turnId === undefined ? {} : { turnId: event.payload.event.turnId }),
    };
    case "runtime.stateChanged": return {
      ...common, webSessionId: event.payload.webSessionId, state: event.payload.lifecycle,
    };
    case "runtime.fatal": return {
      ...common, webSessionId: event.payload.webSessionId, state: "fatal", code: event.payload.diagnostic.code,
    };
    case "host.resyncRequired": return { ...common, state: event.payload.reason };
  }
};

export class ReferenceWebDiagnosticLog {
  readonly path: string;
  readonly #handle: FileHandle;
  #bytes: number;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  private constructor(path: string, handle: FileHandle, bytes: number) {
    this.path = path;
    this.#handle = handle;
    this.#bytes = bytes;
  }

  static async open(path: string): Promise<ReferenceWebDiagnosticLog> {
    const canonical = resolve(path);
    await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
    try {
      const metadata = await lstat(canonical);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_LOG_BYTES) {
        throw new TypeError("Reference Web diagnostic log is not a bounded regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = await open(canonical, "a", 0o600);
    await handle.chmod(0o600);
    const metadata = await handle.stat();
    return new ReferenceWebDiagnosticLog(canonical, handle, metadata.size);
  }

  append(event: HostEvent): void {
    this.#append(recordFor(event));
  }

  appendBrowser(event: BrowserTransportDiagnostic): void {
    this.#append({
      at: new Date().toISOString(),
      epoch: "browser",
      sequence: 0,
      kind: `browser.${event.kind}`,
      ...(event.code === undefined ? {} : { code: event.code }),
      ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
      ...(event.commandKind === undefined ? {} : { commandKind: event.commandKind }),
      ...(event.webSessionId === undefined ? {} : { webSessionId: event.webSessionId }),
      ...(event.pendingBytes === undefined ? {} : { pendingBytes: event.pendingBytes }),
      ...(event.resumed === undefined ? {} : { resumed: event.resumed }),
    });
  }

  #append(record: DiagnosticRecord): void {
    if (this.#closed) return;
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (this.#bytes + bytes.byteLength > MAX_LOG_BYTES) return;
    this.#bytes += bytes.byteLength;
    this.#tail = this.#tail.then(async () => {
      await this.#handle.appendFile(bytes);
    });
    void this.#tail.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#tail;
    } finally {
      await this.#handle.close();
    }
  }
}
