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
  type BrowserComponentDefinition,
  type BrowserComponentSnapshot,
  type SessionConfiguration,
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
export type HostTraceEntry = Readonly<{
  id: string;
  emittedAt: string;
  kind: string;
  detail: string;
  count: number;
}>;
export type ControlTab = "settings" | "components" | "session" | "runtime";
export type ControlInspection = Readonly<{
  controls: Readonly<{
    configuration: SessionConfiguration;
    components: BrowserComponentSnapshot;
  }>;
  runtime: Readonly<Record<string, unknown>>;
  catalog: Readonly<{
    revision: string;
    digest: string;
    tools: readonly string[];
    commands: readonly Readonly<Record<string, unknown>>[];
    skills: readonly Readonly<Record<string, unknown>>[];
    agents: readonly string[];
    mcpServers: readonly Readonly<Record<string, unknown>>[];
  }>;
  status: Readonly<Record<string, unknown>>;
  mutations: readonly MutationDraft[];
}>;
export type MutationDraft = Readonly<{
  mutation: "delete" | "fork" | "rewind";
  clientMutationId: string;
  token: string;
  state: string;
  targetWebSessionId?: string;
}>;
export type ReferenceWebState = Readonly<{
  connection: ConnectionState;
  bootstrap?: Bootstrap;
  snapshot: HostSnapshot;
  pendingCommandIds: readonly string[];
  localInputs: readonly LocalInput[];
  notices: readonly UiNotice[];
  trace: readonly HostTraceEntry[];
  inspectorOpen: boolean;
  controlsOpen: boolean;
  controlTab: ControlTab;
  controlsLoading: boolean;
  controlInspection: ControlInspection | undefined;
  mutation: MutationDraft | undefined;
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
const MAX_MERGED_DELTA_LENGTH = 262_144;
const appendVisibleRuntimeEvent = (
  events: RuntimeProjection["events"],
  next: RuntimeProjection["events"][number],
): RuntimeProjection["events"] => {
  const previous = events.at(-1);
  const nextEvent = next.event;
  const previousEvent = previous?.event;
  if ((nextEvent.kind === "assistant_delta" || nextEvent.kind === "thinking_delta")
    && previousEvent?.kind === nextEvent.kind
    && previous?.runtimeGeneration === next.runtimeGeneration
    && previous.turnId === next.turnId
    && previousEvent.delta.length + nextEvent.delta.length <= MAX_MERGED_DELTA_LENGTH) {
    return [...events.slice(0, -1), {
      ...next,
      event: { ...nextEvent, delta: `${previousEvent.delta}${nextEvent.delta}` },
    }];
  }
  return [...events, next].slice(-2_000);
};

export class ReferenceWebStore {
  readonly #client: WebHostClient;
  readonly #idFactory: () => string;
  readonly #now: () => string;
  readonly #listeners = new Set<() => void>();
  readonly #commandInputs = new Map<string, string>();
  readonly #commandWaiters = new Map<string, Readonly<{
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>>();
  readonly #historyRequests = new Map<string, Readonly<{ webSessionId: string; cursor?: string }>>();
  #state: ReferenceWebState = Object.freeze({
    connection: "idle",
    snapshot: emptySnapshot,
    pendingCommandIds: [],
    localInputs: [],
    notices: [],
    trace: [],
    inspectorOpen: false,
    controlsOpen: false,
    controlTab: "settings",
    controlsLoading: false,
    controlInspection: undefined,
    mutation: undefined,
  });
  #abort: AbortController | undefined;
  #historyAssembler: BrowserHistoryAssembler | undefined;
  #historyPages = 0;
  #historyWebSessionId: string | undefined;
  #notifyScheduled = false;
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
  openControls(tab: ControlTab = "settings"): void {
    this.#update({ controlsOpen: true, controlTab: tab });
    void this.refreshControls();
  }
  closeControls(): void { this.#update({ controlsOpen: false }); }
  selectControlTab(tab: ControlTab): void { this.#update({ controlTab: tab }); }
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

  async refreshControls(): Promise<void> {
    const webSessionId = this.#state.snapshot.selectedWebSessionId;
    if (webSessionId === undefined || this.#state.controlsLoading) return;
    this.#update({ controlsLoading: true });
    try {
      const result = await this.#commandAndWait({
        commandId: this.#idFactory(),
        kind: "controls.inspect",
        webSessionId,
        payload: {},
      });
      const inspection = this.#controlInspection(result);
      this.#update({ controlInspection: inspection, mutation: inspection.mutations[0] });
    } finally {
      this.#update({ controlsLoading: false });
    }
  }

  async applyConfiguration(configuration: SessionConfiguration): Promise<void> {
    const webSessionId = this.#selectedSessionId();
    await this.#commandAndWait({
      commandId: this.#idFactory(),
      kind: "config.apply",
      webSessionId,
      payload: configuration,
    });
    await this.refreshControls();
    this.#notice("Configuration applied to the selected Session.", "info");
  }

  async replaceComponents(
    revision: string,
    components: readonly BrowserComponentDefinition[],
  ): Promise<void> {
    const webSessionId = this.#selectedSessionId();
    await this.#commandAndWait({
      commandId: this.#idFactory(),
      kind: "components.replace",
      webSessionId,
      payload: {
        revision,
        ...(this.#state.controlInspection?.controls.components.digest === undefined ? {} : {
          expectedDigest: this.#state.controlInspection.controls.components.digest,
        }),
        components: [...components],
      },
    });
    await this.refreshControls();
    this.#notice("Component generation accepted by the Runtime.", "info");
  }

  async compactSession(): Promise<void> {
    const webSessionId = this.#selectedSessionId();
    await this.#commandAndWait({
      commandId: this.#idFactory(),
      kind: "session.compact",
      webSessionId,
      payload: { clientOperationId: this.#idFactory() },
    });
    this.#notice("Compaction was accepted.", "info");
  }

  async prepareMutation(
    mutation: MutationDraft["mutation"],
    options: Readonly<{ boundaryId?: string; forkTitle?: string }> = {},
  ): Promise<void> {
    const webSessionId = this.#selectedSessionId();
    const history = this.#state.history;
    const clientMutationId = this.#idFactory();
    const boundary = mutation === "delete" ? undefined : history?.mutationBoundaries.find(
      ({ stableBoundaryId }) => stableBoundaryId === options.boundaryId,
    ) ?? history?.mutationBoundaries.at(-1);
    if (mutation !== "delete" && boundary === undefined) {
      throw new Error("No stable Session boundary is available yet");
    }
    const sourceTranscriptPostcondition = history?.transcriptPostcondition;
    if (mutation === "rewind" && sourceTranscriptPostcondition === undefined) {
      throw new Error("The complete transcript postcondition is unavailable");
    }
    const rewindAuthority = mutation === "rewind"
      ? (() => {
          if (boundary === undefined || sourceTranscriptPostcondition === undefined) {
            throw new Error("The rewind authority is unavailable");
          }
          return {
            sourceTranscriptPostcondition,
            targetTranscriptPostcondition: boundary.transcriptPostcondition,
          };
        })()
      : {};
    const result = await this.#commandAndWait({
      commandId: this.#idFactory(),
      kind: "mutation.prepare",
      webSessionId,
      payload: {
        mutation,
        clientMutationId,
        ...(boundary === undefined ? {} : { stableBoundaryId: boundary.stableBoundaryId }),
        ...rewindAuthority,
        ...(options.forkTitle === undefined || options.forkTitle.trim() === ""
          ? {} : { forkTitle: options.forkTitle.trim() }),
      },
    });
    const record = this.#record(result, "mutation result");
    const token = this.#string(record.token, "mutation token");
    const state = this.#string(record.state, "mutation state");
    const targetWebSessionId = typeof record.targetWebSessionId === "string"
      ? record.targetWebSessionId : undefined;
    this.#update({ mutation: Object.freeze({
      mutation,
      clientMutationId,
      token,
      state,
      ...(targetWebSessionId === undefined ? {} : { targetWebSessionId }),
    }) });
  }

  async commitMutation(confirmation: string): Promise<void> {
    const webSessionId = this.#selectedSessionId();
    const mutation = this.#state.mutation;
    if (mutation === undefined) throw new Error("Prepare a mutation first");
    const result = await this.#commandAndWait({
      commandId: this.#idFactory(),
      kind: "mutation.commit",
      webSessionId,
      payload: {
        mutation: mutation.mutation,
        clientMutationId: mutation.clientMutationId,
        token: mutation.token,
        confirmation,
      },
    });
    const state = this.#mutationState(result);
    if (mutation.mutation === "delete" || mutation.mutation === "rewind") {
      this.#update({ mutation: Object.freeze({ ...mutation, state }) });
      this.#notice(mutation.mutation === "delete"
        ? "Session deletion committed. Roll back or explicitly purge it."
        : "Session rewind committed. The same operation can still be rolled back.", "info");
    } else {
      this.#update({ mutation: undefined });
      this.#notice("Fork committed.", "info");
    }
  }

  async rollbackMutation(): Promise<void> {
    const webSessionId = this.#selectedSessionId();
    const mutation = this.#state.mutation;
    if (mutation === undefined) throw new Error("Prepare a mutation first");
    const result = await this.#commandAndWait({
      commandId: this.#idFactory(),
      kind: "mutation.rollback",
      webSessionId,
      payload: {
        mutation: mutation.mutation,
        clientMutationId: mutation.clientMutationId,
        token: mutation.token,
      },
    });
    this.#mutationState(result);
    this.#update({ mutation: undefined });
    this.#notice("Prepared Session mutation was rolled back.", "info");
  }

  async purgeDeletedSession(confirmation: string): Promise<void> {
    const webSessionId = this.#selectedSessionId();
    const mutation = this.#state.mutation;
    if (mutation?.mutation !== "delete") throw new Error("Prepare Session deletion first");
    const result = await this.#commandAndWait({
      commandId: this.#idFactory(),
      kind: "mutation.purge",
      webSessionId,
      payload: {
        mutation: "delete",
        clientMutationId: mutation.clientMutationId,
        token: mutation.token,
        confirmation,
      },
    });
    this.#mutationState(result);
    this.#update({ mutation: undefined, controlsOpen: false, controlInspection: undefined });
    this.#notice("Session was permanently purged.", "info");
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
    const clientOperationId = delivery === "turn"
      ? this.#idFactory()
      : this.#activeOperationId(webSessionId);
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
      payload: { clientOperationId: this.#activeOperationId(webSessionId), cancelQueued: true },
    });
  }

  cancelQueued(webSessionId: string, messageId: string): Promise<void> {
    return this.#command({
      commandId: this.#idFactory(),
      kind: "turn.cancelQueued",
      webSessionId,
      payload: { clientOperationId: this.#activeOperationId(webSessionId), messageId },
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
    this.#recordTrace(event);
    const current = this.#state.snapshot;
    switch (event.kind) {
      case "host.snapshot": {
        const selectedChanged = current.selectedWebSessionId !== event.payload.selectedWebSessionId;
        this.#update({
          snapshot: event.payload,
          connection: "online",
          ...(selectedChanged ? {
            controlInspection: undefined,
            mutation: undefined,
            ...(event.payload.selectedWebSessionId === undefined ? { controlsOpen: false } : {}),
          } : {}),
        });
        this.#ensureHistory(event.payload);
        return;
      }
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
        return;
      }
      case "runtime.event": {
        if (current.projection?.webSessionId !== event.payload.webSessionId) return;
        const runtimeEvent = event.payload.event;
        const terminalOperationId = runtimeEvent.event.kind === "turn_terminal"
          ? runtimeEvent.event.clientOperationId
          : undefined;
        const activeOperationIds = runtimeEvent.event.kind === "turn_admitted"
          ? [...new Set([...current.projection.activeOperationIds, runtimeEvent.event.admission.clientOperationId])]
          : terminalOperationId !== undefined
            ? current.projection.activeOperationIds.filter((id) => id !== terminalOperationId)
            : current.projection.activeOperationIds;
        this.#update({ snapshot: { ...current, projection: {
          ...current.projection,
          runtimeGeneration: runtimeEvent.runtimeGeneration,
          runtimeSessionId: runtimeEvent.runtimeSessionId,
          events: appendVisibleRuntimeEvent(current.projection.events, runtimeEvent),
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
        this.#settleCommand(event, !this.#historyRequests.has(event.payload.commandId));
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

  #settleCommand(
    event: Extract<HostEvent, { kind: "host.commandSettled" }>,
    reportFailure = true,
  ): void {
    const localId = this.#commandInputs.get(event.payload.commandId);
    if (localId !== undefined) this.#commandInputs.delete(event.payload.commandId);
    this.#update({
      pendingCommandIds: this.#state.pendingCommandIds.filter((id) => id !== event.payload.commandId),
      localInputs: localId === undefined ? this.#state.localInputs : this.#state.localInputs.map((input) =>
        input.id === localId ? { ...input, state: event.payload.state === "succeeded" ? "accepted" : "failed" } : input),
      ...(event.payload.state === "failed" && reportFailure ? { notices: [...this.#state.notices, {
        id: this.#idFactory(),
        level: "error" as const,
        message: `Command failed: ${event.payload.error?.code ?? "unknown"}`,
      }].slice(-8) } : {}),
    });
    const waiter = this.#commandWaiters.get(event.payload.commandId);
    if (waiter === undefined) return;
    this.#commandWaiters.delete(event.payload.commandId);
    if (event.payload.state === "succeeded") waiter.resolve(event.payload.result);
    else waiter.reject(new Error(`Command failed: ${event.payload.error?.code ?? "unknown"}`));
  }

  async #commandAndWait(command: BrowserCommand): Promise<unknown> {
    const settled = new Promise<unknown>((resolveSettled, rejectSettled) => {
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

  #activeOperationId(webSessionId: string): string {
    const projection = this.#state.snapshot.projection;
    const clientOperationId = projection?.webSessionId === webSessionId
      ? projection.activeOperationIds.at(-1)
      : undefined;
    if (clientOperationId === undefined) {
      throw new Error("The selected Session has no active operation");
    }
    return clientOperationId;
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
      mutationBoundaries: [],
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
      const projection = this.#state.snapshot.projection;
      const freshEmptySession = event.payload.error?.code === "primary_session_not_ready"
        && projection?.webSessionId === request.webSessionId
        && projection.events.length === 0;
      if (this.#state.history !== undefined) this.#update({
        history: freshEmptySession
          ? { ...this.#state.history, status: "complete" }
          : { ...this.#state.history, status: "failed" },
      });
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

  #record(value: unknown, label: string): Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${label} is unavailable`);
    }
    return value as Readonly<Record<string, unknown>>;
  }

  #string(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
      throw new TypeError(`${label} is unavailable`);
    }
    return value;
  }

  #controlInspection(value: unknown): ControlInspection {
    const result = this.#record(value, "control inspection");
    const controls = this.#record(result.controls, "Session controls");
    const configuration = this.#record(controls.configuration, "Session configuration") as SessionConfiguration;
    const components = this.#record(controls.components, "component snapshot") as BrowserComponentSnapshot;
    const catalog = this.#record(result.catalog, "component catalog");
    if (!Array.isArray(catalog.tools) || !Array.isArray(catalog.commands)
      || !Array.isArray(catalog.skills) || !Array.isArray(catalog.agents)
      || !Array.isArray(catalog.mcpServers)) {
      throw new TypeError("component catalog is unavailable");
    }
    if (!Array.isArray(result.mutations) || result.mutations.length > 1) {
      throw new TypeError("mutation recovery state is unavailable");
    }
    const mutations = result.mutations.map((value) => {
      const mutation = this.#record(value, "mutation recovery item");
      if (mutation.mutation !== "delete" && mutation.mutation !== "fork" && mutation.mutation !== "rewind") {
        throw new TypeError("mutation recovery kind is unavailable");
      }
      const targetWebSessionId = mutation.targetWebSessionId === undefined
        ? undefined : this.#string(mutation.targetWebSessionId, "fork target Web Session id");
      return Object.freeze({
        mutation: mutation.mutation,
        clientMutationId: this.#string(mutation.clientMutationId, "client mutation id"),
        token: this.#string(mutation.token, "mutation token"),
        state: this.#string(mutation.state, "mutation state"),
        ...(targetWebSessionId === undefined ? {} : { targetWebSessionId }),
      });
    });
    return Object.freeze({
      controls: Object.freeze({ configuration, components }),
      runtime: this.#record(result.runtime, "Runtime status"),
      catalog: Object.freeze({
        revision: this.#string(catalog.revision, "component catalog revision"),
        digest: this.#string(catalog.digest, "component catalog digest"),
        tools: catalog.tools.filter((item): item is string => typeof item === "string"),
        commands: catalog.commands.map((item) => this.#record(item, "command catalog item")),
        skills: catalog.skills.map((item) => this.#record(item, "Skill catalog item")),
        agents: catalog.agents.filter((item): item is string => typeof item === "string"),
        mcpServers: catalog.mcpServers.map((item) => this.#record(item, "MCP catalog item")),
      }),
      status: this.#record(result.status, "component status"),
      mutations,
    });
  }

  #mutationState(value: unknown): string {
    const result = this.#record(value, "mutation result");
    return this.#string(result.state, "mutation state");
  }

  #notice(message: string, level: UiNotice["level"]): void {
    this.#update({ notices: [...this.#state.notices, {
      id: this.#idFactory(),
      level,
      message,
    }].slice(-8) });
  }

  #rejectCommandWaiters(message: string): void {
    const error = new Error(message);
    for (const waiter of this.#commandWaiters.values()) waiter.reject(error);
    this.#commandWaiters.clear();
  }

  #recordTrace(event: HostEvent): void {
    const kind = event.kind === "runtime.event"
      ? `${event.kind}:${event.payload.event.event.kind}`
      : event.kind;
    const detail = (() => {
      switch (event.kind) {
        case "host.snapshot": return `sessions=${event.payload.sessions.length} selected=${event.payload.selectedWebSessionId === undefined ? "none" : "yes"}`;
        case "host.sessionChanged": return `lifecycle=${event.payload.lifecycle}`;
        case "host.commandSettled": return `${event.payload.state}${event.payload.error === undefined ? "" : ` code=${event.payload.error.code}`}`;
        case "host.interactionOpened": return `kind=${event.payload.kind}${event.payload.permissionAction === undefined ? "" : ` action=${event.payload.permissionAction}`}`;
        case "host.interactionClosed": return "closed";
        case "host.attachmentChanged": return `state=${event.payload.attachment.state}`;
        case "runtime.event": return `turn=${event.payload.event.turnId ?? "none"}`;
        case "runtime.stateChanged": return `lifecycle=${event.payload.lifecycle}`;
        case "runtime.fatal": return `code=${event.payload.diagnostic.code}`;
        case "host.resyncRequired": return `reason=${event.payload.reason}`;
      }
    })();
    const current = this.#state.trace;
    const previous = current.at(-1);
    const next = previous?.kind === kind && (kind.endsWith(":assistant_delta") || kind.endsWith(":thinking_delta"))
      ? [...current.slice(0, -1), { ...previous, emittedAt: event.emittedAt, count: previous.count + 1 }]
      : [...current, {
          id: `${event.epoch}:${event.sequence}`,
          emittedAt: event.emittedAt,
          kind,
          detail,
          count: 1,
        }].slice(-256);
    this.#update({ trace: next });
  }

  #update(patch: Partial<ReferenceWebState>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    if (this.#notifyScheduled) return;
    this.#notifyScheduled = true;
    const notify = (): void => {
      this.#notifyScheduled = false;
      for (const listener of this.#listeners) listener();
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(notify);
    } else {
      setTimeout(notify, 0);
    }
  }
}
