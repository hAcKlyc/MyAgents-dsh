import {
  WebHostClient,
  type AttachmentSummary,
  type BrowserAttachmentPreview,
  type Bootstrap,
  type BrowserCommand,
  type HostEvent,
  type HostSnapshot,
  type InteractionResponse,
  type RuntimeProjection,
  type WebSessionSummary,
} from "@myagents-dsh/web-host-contract";

import {
  BrowserHistoryAssembler,
  type BrowserHistorySnapshot,
} from "./history.js";

export type ConnectionState = "idle" | "connecting" | "online" | "offline";
export type LocalInput = Readonly<{
  id: string;
  commandId: string;
  webSessionId: string;
  text: string;
  createdAt: string;
  attachmentNames: readonly string[];
  delivery: "turn" | "steer" | "follow_up";
  state: "submitting" | "accepted" | "failed";
}>;
export type InputDelivery = LocalInput["delivery"];
export type UiNotice = Readonly<{
  id: string;
  level: "info" | "error";
  message: string;
}>;
export type ReferenceWebState = Readonly<{
  connection: ConnectionState;
  bootstrap?: Bootstrap;
  snapshot: HostSnapshot;
  pendingCommandIds: readonly string[];
  localInputs: readonly LocalInput[];
  notices: readonly UiNotice[];
  inspectorOpen: boolean;
  history?: BrowserHistorySnapshot;
}>;

export type ReferenceWebStoreOptions = Readonly<{
  client?: WebHostClient;
  idFactory?: () => string;
  now?: () => string;
}>;

const emptySnapshot: HostSnapshot = Object.freeze({ sessions: [] });
const replaceSession = (
  sessions: readonly WebSessionSummary[],
  next: WebSessionSummary,
): WebSessionSummary[] => {
  const index = sessions.findIndex(({ webSessionId }) => webSessionId === next.webSessionId);
  if (index < 0) return [...sessions, next].sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
  const result = [...sessions];
  result[index] = next;
  return result;
};
const removeInteraction = (projection: RuntimeProjection, interactionId: string): RuntimeProjection => ({
  ...projection,
  openInteractions: projection.openInteractions.filter((item) => item.interactionId !== interactionId),
});

export class ReferenceWebStore {
  readonly #client: WebHostClient;
  readonly #idFactory: () => string;
  readonly #now: () => string;
  readonly #listeners = new Set<() => void>();
  readonly #commandInputs = new Map<string, string>();
  readonly #commandWaiters = new Map<string, Readonly<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>>();
  readonly #historyRequests = new Map<string, Readonly<{ webSessionId: string; cursor?: string }>>();
  #state: ReferenceWebState = Object.freeze({
    connection: "idle",
    snapshot: emptySnapshot,
    pendingCommandIds: [],
    localInputs: [],
    notices: [],
    inspectorOpen: false,
  });
  #abort: AbortController | undefined;
  #historyAssembler: BrowserHistoryAssembler | undefined;
  #historyPages = 0;
  #historyWebSessionId: string | undefined;
  #startPromise: Promise<void> | undefined;

  constructor(options: ReferenceWebStoreOptions = {}) {
    this.#client = options.client ?? new WebHostClient();
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  getSnapshot = (): ReferenceWebState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): Promise<void> {
    this.#startPromise ??= this.#startOwned();
    return this.#startPromise;
  }

  stop(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    this.#startPromise = undefined;
    this.#rejectCommandWaiters("The local Web Host was stopped");
    this.#update({ connection: "idle" });
  }

  toggleInspector(): void { this.#update({ inspectorOpen: !this.#state.inspectorOpen }); }
  dismissNotice(id: string): void {
    this.#update({ notices: this.#state.notices.filter((notice) => notice.id !== id) });
  }

  createSession(title?: string): Promise<void> {
    return this.#command({
      commandId: this.#idFactory(),
      kind: "session.create",
      payload: title === undefined || title.trim() === "" ? {} : { title: title.trim() },
    });
  }

  selectSession(webSessionId: string): Promise<void> {
    return this.#command({ commandId: this.#idFactory(), kind: "session.select", webSessionId, payload: {} });
  }

  restartRuntime(webSessionId: string): Promise<void> {
    return this.#command({ commandId: this.#idFactory(), kind: "runtime.restart", webSessionId, payload: {} });
  }

  coldStop(webSessionId: string): Promise<void> {
    return this.#command({ commandId: this.#idFactory(), kind: "session.coldStop", webSessionId, payload: {} });
  }

  submitTurn(text: string, attachments: readonly AttachmentSummary[]): Promise<void> {
    return this.submitInput(text, attachments, "turn");
  }

  async submitInput(
    text: string,
    attachments: readonly AttachmentSummary[],
    delivery: InputDelivery,
  ): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return;
    if (delivery === "steer" && attachments.length > 0) {
      throw new Error("Steering input cannot include attachments");
    }
    const webSessionId = this.#state.snapshot.selectedWebSessionId ?? await this.#createSessionForInput();
    const commandId = this.#idFactory();
    const localId = this.#idFactory();
    this.#commandInputs.set(commandId, localId);
    this.#update({
      localInputs: [...this.#state.localInputs, Object.freeze({
        id: localId,
        commandId,
        webSessionId,
        text: trimmed,
        createdAt: this.#now(),
        attachmentNames: attachments.map(({ name }) => name),
        delivery,
        state: "submitting" as const,
      })].slice(-512),
    });
    const clientOperationId = this.#idFactory();
    if (delivery === "steer") {
      await this.#command({
        commandId, kind: "turn.steer", webSessionId,
        payload: { clientOperationId, text: trimmed },
      });
    } else if (delivery === "follow_up") {
      await this.#command({
        commandId, kind: "turn.followUp", webSessionId,
        payload: {
          clientOperationId,
          messageId: this.#idFactory(),
          text: trimmed,
          attachmentIds: attachments.map(({ attachmentId }) => attachmentId),
        },
      });
    } else {
      await this.#command({
        commandId, kind: "turn.start", webSessionId,
        payload: {
          clientOperationId,
          clientUserMessageId: this.#idFactory(),
          text: trimmed,
          attachmentIds: attachments.map(({ attachmentId }) => attachmentId),
        },
      });
    }
  }

  interrupt(webSessionId: string): Promise<void> {
    return this.#command({
      commandId: this.#idFactory(),
      kind: "turn.interrupt",
      webSessionId,
      payload: { clientOperationId: this.#idFactory(), cancelQueued: false },
    });
  }

  cancelQueued(webSessionId: string, messageId: string): Promise<void> {
    return this.#command({
      commandId: this.#idFactory(),
      kind: "turn.cancelQueued",
      webSessionId,
      payload: { clientOperationId: this.#idFactory(), messageId },
    });
  }

  async upload(file: File): Promise<AttachmentSummary> {
    const webSessionId = this.#selectedSessionId();
    const maximum = this.#state.bootstrap?.limits.maxUploadBytes;
    if (maximum !== undefined && file.size > maximum) throw new Error("Attachment exceeds the Host upload limit");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    return this.#client.uploadAttachment({
      webSessionId,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      bytes,
      sha256,
    });
  }

  releaseAttachment(attachmentId: string): Promise<void> {
    return this.#client.releaseAttachment(this.#selectedSessionId(), attachmentId);
  }

  previewAttachment(attachmentId: string): Promise<BrowserAttachmentPreview> {
    return this.#client.previewAttachment(this.#selectedSessionId(), attachmentId);
  }

  respond(response: InteractionResponse): Promise<void> { return this.#client.respond(response).then(() => undefined); }

  async #startOwned(): Promise<void> {
    const abort = new AbortController();
    this.#abort = abort;
    this.#update({ connection: "connecting" });
    void this.#consumeEvents(abort.signal);
    try {
      const bootstrap = await this.#client.bootstrap(abort.signal);
      if (abort.signal.aborted) return;
      this.#update({ bootstrap, snapshot: bootstrap.snapshot, connection: "online" });
      this.#ensureHistory(bootstrap.snapshot);
    } catch {
      if (!abort.signal.aborted) this.#connectionFailure();
    }
  }

  async #consumeEvents(signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.#client.events({ signal })) {
        if (signal.aborted) return;
        await this.#applyEvent(event, signal);
      }
      if (!signal.aborted) this.#connectionFailure();
    } catch {
      if (!signal.aborted) this.#connectionFailure();
    }
  }

  async #applyEvent(event: HostEvent, signal: AbortSignal): Promise<void> {
    const current = this.#state.snapshot;
    switch (event.kind) {
      case "host.snapshot":
        this.#update({ snapshot: event.payload, connection: "online" });
        this.#ensureHistory(event.payload);
        return;
      case "host.sessionChanged":
        this.#update({ snapshot: { ...current, sessions: replaceSession(current.sessions, event.payload) } });
        return;
      case "runtime.stateChanged": {
        const session = current.sessions.find(({ webSessionId }) => webSessionId === event.payload.webSessionId);
        if (session === undefined) return;
        this.#update({ snapshot: {
          ...current,
          sessions: replaceSession(current.sessions, { ...session, lifecycle: event.payload.lifecycle }),
        } });
        if (event.payload.lifecycle === "ready") this.#ensureHistory(this.#state.snapshot);
        return;
      }
      case "runtime.event": {
        if (current.projection?.webSessionId !== event.payload.webSessionId) return;
        const runtimeEvent = event.payload.event;
        const activeOperationIds = runtimeEvent.event.kind === "turn_admitted"
          ? [...new Set([...current.projection.activeOperationIds, runtimeEvent.event.admission.turnId])]
          : runtimeEvent.event.kind === "turn_terminal" && runtimeEvent.turnId !== undefined
            ? current.projection.activeOperationIds.filter((id) => id !== runtimeEvent.turnId)
            : current.projection.activeOperationIds;
        this.#update({ snapshot: { ...current, projection: {
          ...current.projection,
          runtimeGeneration: runtimeEvent.runtimeGeneration,
          runtimeSessionId: runtimeEvent.runtimeSessionId,
          events: [...current.projection.events, runtimeEvent].slice(-2_000),
          activeOperationIds,
        } } });
        return;
      }
      case "host.interactionOpened": {
        if (current.projection?.webSessionId !== event.payload.webSessionId) return;
        const others = current.projection.openInteractions
          .filter(({ interactionId }) => interactionId !== event.payload.interactionId);
        this.#update({ snapshot: { ...current, projection: {
          ...current.projection,
          openInteractions: [...others, event.payload],
        } } });
        return;
      }
      case "host.interactionClosed":
        if (current.projection?.webSessionId === event.payload.webSessionId) {
          this.#update({ snapshot: {
            ...current,
            projection: removeInteraction(current.projection, event.payload.interactionId),
          } });
        }
        return;
      case "host.attachmentChanged": {
        if (current.projection?.webSessionId !== event.payload.webSessionId) return;
        const attachments = current.projection.attachments
          .filter(({ attachmentId }) => attachmentId !== event.payload.attachment.attachmentId);
        this.#update({ snapshot: { ...current, projection: {
          ...current.projection,
          attachments: event.payload.attachment.state === "released"
            ? attachments : [...attachments, event.payload.attachment],
        } } });
        return;
      }
      case "runtime.fatal": {
        if (current.projection?.webSessionId !== event.payload.webSessionId) return;
        this.#update({ snapshot: { ...current, projection: {
          ...current.projection,
          diagnostics: [...current.projection.diagnostics, event.payload.diagnostic].slice(-256),
        } } });
        return;
      }
      case "host.commandSettled":
        this.#settleCommand(event);
        await this.#settleHistory(event);
        return;
      case "host.resyncRequired": {
        const bootstrap = await this.#client.bootstrap(signal);
        this.#update({ bootstrap, snapshot: bootstrap.snapshot, connection: "online" });
        this.#ensureHistory(bootstrap.snapshot);
        return;
      }
    }
  }

  #settleCommand(event: Extract<HostEvent, { kind: "host.commandSettled" }>): void {
    const localId = this.#commandInputs.get(event.payload.commandId);
    if (localId !== undefined) this.#commandInputs.delete(event.payload.commandId);
    this.#update({
      pendingCommandIds: this.#state.pendingCommandIds.filter((id) => id !== event.payload.commandId),
      localInputs: localId === undefined ? this.#state.localInputs : this.#state.localInputs.map((input) =>
        input.id === localId ? { ...input, state: event.payload.state === "succeeded" ? "accepted" : "failed" } : input),
      ...(event.payload.state === "failed" ? { notices: [...this.#state.notices, {
        id: this.#idFactory(),
        level: "error" as const,
        message: `Command failed: ${event.payload.error?.code ?? "unknown"}`,
      }].slice(-8) } : {}),
    });
    const waiter = this.#commandWaiters.get(event.payload.commandId);
    if (waiter === undefined) return;
    this.#commandWaiters.delete(event.payload.commandId);
    if (event.payload.state === "succeeded") waiter.resolve();
    else waiter.reject(new Error(`Command failed: ${event.payload.error?.code ?? "unknown"}`));
  }

  async #commandAndWait(command: BrowserCommand): Promise<void> {
    const settled = new Promise<void>((resolveSettled, rejectSettled) => {
      this.#commandWaiters.set(command.commandId, {
        resolve: resolveSettled,
        reject: rejectSettled,
      });
    });
    try {
      await this.#command(command);
    } catch {
      // Transport failures are projected through #settleCommand, which rejects settled.
    }
    return settled;
  }

  async #createSessionForInput(): Promise<string> {
    await this.#commandAndWait({
      commandId: this.#idFactory(),
      kind: "session.create",
      payload: {},
    });
    const webSessionId = this.#state.snapshot.selectedWebSessionId;
    if (webSessionId === undefined) throw new Error("Created Session was not selected by the Host");
    return webSessionId;
  }

  async #command(command: BrowserCommand): Promise<void> {
    this.#update({ pendingCommandIds: [...this.#state.pendingCommandIds, command.commandId].slice(-2_048) });
    try {
      await this.#client.command(command);
    } catch (error) {
      this.#settleCommand({
        epoch: "local",
        sequence: 1,
        emittedAt: this.#now(),
        kind: "host.commandSettled",
        payload: {
          commandId: command.commandId,
          ...("webSessionId" in command ? { webSessionId: command.webSessionId } : {}),
          state: "failed",
          error: { code: "browser_transport_failed", message: "Command transport failed", retryable: true },
        },
      });
      throw error;
    }
  }

  #selectedSessionId(): string {
    const selected = this.#state.snapshot.selectedWebSessionId;
    if (selected === undefined) throw new Error("Select a Session first");
    return selected;
  }

  #ensureHistory(snapshot: HostSnapshot): void {
    const webSessionId = snapshot.selectedWebSessionId;
    const runtimeSessionId = snapshot.projection?.runtimeSessionId;
    const lifecycle = snapshot.sessions.find((session) => session.webSessionId === webSessionId)?.lifecycle;
    if (webSessionId === undefined || runtimeSessionId === undefined || lifecycle !== "ready") return;
    if (this.#historyWebSessionId === webSessionId
      && this.#state.history?.runtimeSessionId === runtimeSessionId
      && this.#state.history.status !== "failed") return;
    this.#historyAssembler = new BrowserHistoryAssembler(webSessionId);
    this.#historyWebSessionId = webSessionId;
    this.#historyPages = 0;
    this.#update({ history: Object.freeze({
      webSessionId,
      runtimeSessionId,
      durableSequence: 0,
      events: [],
      status: "loading" as const,
    }) });
    void this.#requestHistoryPage(webSessionId);
  }

  async #requestHistoryPage(webSessionId: string, cursor?: string): Promise<void> {
    const commandId = this.#idFactory();
    this.#historyRequests.set(commandId, Object.freeze({
      webSessionId,
      ...(cursor === undefined ? {} : { cursor }),
    }));
    try {
      await this.#command({
        commandId,
        kind: "history.read",
        webSessionId,
        payload: cursor === undefined ? {} : { cursor },
      });
    } catch {
      this.#historyRequests.delete(commandId);
      if (this.#historyWebSessionId === webSessionId && this.#state.history !== undefined) {
        this.#update({ history: { ...this.#state.history, status: "failed" } });
      }
    }
  }

  async #settleHistory(event: Extract<HostEvent, { kind: "host.commandSettled" }>): Promise<void> {
    const request = this.#historyRequests.get(event.payload.commandId);
    if (request === undefined) return;
    this.#historyRequests.delete(event.payload.commandId);
    if (request.webSessionId !== this.#historyWebSessionId || this.#historyAssembler === undefined) return;
    if (event.payload.state === "failed" || event.payload.result === undefined) {
      if (this.#state.history !== undefined) this.#update({ history: { ...this.#state.history, status: "failed" } });
      return;
    }
    try {
      await this.#historyAssembler.accept(event.payload.result, request.cursor);
      this.#historyPages += 1;
      if (this.#historyAssembler.complete) {
        this.#update({ history: this.#historyAssembler.snapshot() });
      } else if (this.#historyPages >= 512) {
        this.#update({ history: this.#historyAssembler.snapshot("truncated") });
      } else {
        this.#update({ history: this.#historyAssembler.snapshot("loading") });
        await this.#requestHistoryPage(request.webSessionId, this.#historyAssembler.nextCursor);
      }
    } catch {
      if (this.#state.history !== undefined) this.#update({ history: { ...this.#state.history, status: "failed" } });
    }
  }

  #connectionFailure(): void {
    this.#rejectCommandWaiters("The local Web Host connection was interrupted");
    this.#update({
      connection: "offline",
      notices: [...this.#state.notices, {
        id: this.#idFactory(),
        level: "error" as const,
        message: "The local Web Host connection was interrupted.",
      }].slice(-8),
    });
  }

  #rejectCommandWaiters(message: string): void {
    const error = new Error(message);
    for (const waiter of this.#commandWaiters.values()) waiter.reject(error);
    this.#commandWaiters.clear();
  }

  #update(patch: Partial<ReferenceWebState>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }
}
