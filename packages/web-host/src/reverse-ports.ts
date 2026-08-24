import {
  ProtocolError,
  type HostRequestAuthority,
  type MethodParams,
  type MethodResult,
  type NotificationParams,
  type RuntimeEventEnvelope,
} from "@myagents-dsh/protocol";
import type {
  GeneratedHostClient,
  GeneratedHostRequestHandlers,
  GeneratedRuntimeNotificationHandlers,
} from "@myagents-dsh/protocol/generated/host-client";
import {
  canonicalBrowserJson,
  validateInteractionResponse,
  type InteractionResponse,
} from "@myagents-dsh/web-host-contract";

import type { HostEventHub } from "./event-hub.js";

export type CredentialResolver = (
  params: MethodParams<"host/credential/resolve">,
) => Promise<MethodResult<"host/credential/resolve">> | MethodResult<"host/credential/resolve">;
export type HostToolExecutor = (
  params: MethodParams<"host/tool/execute">,
) => Promise<MethodResult<"host/tool/execute">> | MethodResult<"host/tool/execute">;
export type HostHookExecutor = (
  params: MethodParams<"host/hook/execute">,
) => Promise<MethodResult<"host/hook/execute">> | MethodResult<"host/hook/execute">;
export type AttachmentPorts = Readonly<{
  put: (params: MethodParams<"host/attachment/put">) => Promise<MethodResult<"host/attachment/put">>;
  acquire: (params: MethodParams<"host/attachment/acquire">) => Promise<MethodResult<"host/attachment/acquire">>;
  release: (params: MethodParams<"host/attachment/release">) => Promise<MethodResult<"host/attachment/release">>;
  close: () => Promise<void>;
}>;

export type ReversePortRegistryOptions = Readonly<{
  webSessionId: string;
  productSessionId: string;
  eventHub: HostEventHub;
  resolveCredential?: CredentialResolver;
  executeHostTool?: HostToolExecutor;
  executeHook?: HostHookExecutor;
  attachments?: AttachmentPorts;
  onRuntimeEvent?: (event: RuntimeEventEnvelope) => void;
}>;

type OpenInteraction = Readonly<{
  desiredPolicyRevision: string;
  runtimeGeneration: string;
  runtimeSessionId: string;
}>;

const unavailableCredential: CredentialResolver = (params) => ({
  kind: "availability",
  available: false,
  authoritativeCredentialRevision: params.subject === "provider"
    ? params.profileRevision
    : params.credentialRevision,
  reasonCode: "credential_unavailable",
});
const unavailableTool: HostToolExecutor = () => ({
  state: "failed",
  code: "host_tool_unavailable",
});
const inertHook: HostHookExecutor = () => ({ state: "continue" });
const unavailableAttachments: AttachmentPorts = Object.freeze({
  put: () => Promise.reject(new ProtocolError(
    "host_attachment_unavailable",
    "Attachment Host port is unavailable",
    true,
  )),
  acquire: () => Promise.reject(new ProtocolError(
    "host_attachment_unavailable",
    "Attachment Host port is unavailable",
    true,
  )),
  release: () => Promise.reject(new ProtocolError(
    "host_attachment_unavailable",
    "Attachment Host port is unavailable",
    true,
  )),
  close: () => Promise.resolve(),
});

export class ReversePortRegistry {
  readonly handlers: GeneratedHostRequestHandlers;
  readonly notifications: GeneratedRuntimeNotificationHandlers;
  readonly #options: ReversePortRegistryOptions;
  readonly #interactions = new Map<string, OpenInteraction>();
  #runtimeGeneration: string | undefined;
  #runtimeSessionId: string | undefined;
  #closed = false;

  constructor(options: ReversePortRegistryOptions) {
    this.#options = options;
    const attachments = options.attachments ?? unavailableAttachments;
    this.handlers = Object.freeze({
      "host/credential/resolve": (params) => {
        this.#assertAuthority(params.authority);
        return (options.resolveCredential ?? unavailableCredential)(params);
      },
      "host/interaction/request": (params) => {
        this.#assertAuthority(params.authority, true);
        if (this.#interactions.has(params.interactionId)) {
          throw new ProtocolError("host_interaction_duplicate", "Interaction id is already registered");
        }
        if (this.#interactions.size >= 128) {
          throw new ProtocolError("host_interaction_overloaded", "Too many open Host interactions", true);
        }
        const runtimeSessionId = params.authority.runtimeSessionId;
        if (runtimeSessionId === undefined) {
          throw new ProtocolError("host_interaction_authority", "Interaction lacks a Runtime Session identity");
        }
        this.#interactions.set(params.interactionId, Object.freeze({
          desiredPolicyRevision: params.desiredPolicyRevision,
          runtimeGeneration: params.authority.runtimeGeneration,
          runtimeSessionId,
        }));
        options.eventHub.publish({
          kind: "host.interactionOpened",
          payload: {
            interactionId: params.interactionId,
            webSessionId: options.webSessionId,
            kind: params.kind,
            schema: canonicalBrowserJson(params.schema),
            ...(params.permissionAction === undefined ? {} : {
              permissionAction: params.permissionAction,
            }),
            desiredPolicyRevision: params.desiredPolicyRevision,
            scenario: params.scenario,
            openedAt: new Date().toISOString(),
            deadlineAt: new Date(Date.now() + params.authority.deadlineMs).toISOString(),
          },
        });
        return { registered: true };
      },
      "host/tool/execute": (params) => {
        this.#assertAuthority(params.authority, true);
        return (options.executeHostTool ?? unavailableTool)(params);
      },
      "host/hook/execute": (params) => {
        this.#assertAuthority(params.authority, true);
        return (options.executeHook ?? inertHook)(params);
      },
      "host/attachment/put": (params) => {
        this.#assertAuthority(params.authority, true);
        return attachments.put(params);
      },
      "host/attachment/acquire": (params) => {
        this.#assertAuthority(params.authority, true);
        return attachments.acquire(params);
      },
      "host/attachment/release": (params) => {
        this.#assertAuthority(params.authority, true);
        return attachments.release(params);
      },
    });
    this.notifications = Object.freeze({
      "runtime/event": (params) => {
        this.#assertEvent(params);
        options.onRuntimeEvent?.(params);
        options.eventHub.publish({
          kind: "runtime.event",
          payload: { webSessionId: options.webSessionId, event: params },
        });
      },
      "host/interaction/cancel": (params) => this.#cancelInteraction(params),
    });
  }

  bindInitialized(runtimeGeneration: string): void {
    if (this.#runtimeGeneration !== undefined && this.#runtimeGeneration !== runtimeGeneration) {
      throw new ProtocolError("host_generation_conflict", "Runtime generation changed during initialization");
    }
    this.#runtimeGeneration = runtimeGeneration;
  }

  bindRuntimeSession(runtimeSessionId: string): void {
    if (this.#runtimeSessionId !== undefined && this.#runtimeSessionId !== runtimeSessionId) {
      throw new ProtocolError("host_session_conflict", "Runtime process attempted to bind a second primary Session");
    }
    this.#runtimeSessionId = runtimeSessionId;
  }

  async respond(client: GeneratedHostClient, value: InteractionResponse): Promise<MethodResult<"interaction/respond">> {
    const response = validateInteractionResponse(value);
    const interaction = this.#interactions.get(response.interactionId);
    if (interaction === undefined) {
      throw new ProtocolError("host_interaction_stale", "Interaction is no longer open", true);
    }
    if (interaction.desiredPolicyRevision !== response.expectedRevision
      || interaction.runtimeGeneration !== this.#runtimeGeneration
      || interaction.runtimeSessionId !== this.#runtimeSessionId) {
      throw new ProtocolError("host_interaction_stale", "Interaction authority is stale", true);
    }
    const result = await client.interactionRespond({
      interactionId: response.interactionId,
      expectedRevision: response.expectedRevision,
      decision: response.decision,
      ...(response.value === undefined ? {} : { value: response.value }),
    });
    if (result.state !== "rejected") this.#closeInteraction(response.interactionId);
    return result;
  }

  get openInteractionCount(): number { return this.#interactions.size; }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const interactionId of [...this.#interactions.keys()]) this.#closeInteraction(interactionId);
    await (this.#options.attachments ?? unavailableAttachments).close();
  }

  #assertAuthority(authority: HostRequestAuthority, requireSession = false): void {
    if (this.#closed) throw new ProtocolError("host_generation_closed", "Host generation is closed", true);
    if (authority.productSessionId !== this.#options.productSessionId) {
      throw new ProtocolError("host_product_session_mismatch", "Reverse request targets another product Session");
    }
    this.#runtimeGeneration ??= authority.runtimeGeneration;
    if (authority.runtimeGeneration !== this.#runtimeGeneration) {
      throw new ProtocolError("host_generation_stale", "Reverse request generation is stale", true);
    }
    if (requireSession) {
      if (authority.runtimeSessionId === undefined) {
        throw new ProtocolError("host_runtime_session_missing", "Reverse request lacks a Runtime Session");
      }
      this.#runtimeSessionId ??= authority.runtimeSessionId;
      if (authority.runtimeSessionId !== this.#runtimeSessionId) {
        throw new ProtocolError("host_runtime_session_stale", "Reverse request Session is stale", true);
      }
    }
  }

  #assertEvent(event: RuntimeEventEnvelope): void {
    this.#assertAuthority({
      requestId: `event:${event.sequence}`,
      runtimeGeneration: event.runtimeGeneration,
      productSessionId: event.productSessionId,
      runtimeSessionId: event.runtimeSessionId,
      deadlineMs: 1,
    }, true);
  }

  #cancelInteraction(params: NotificationParams<"host/interaction/cancel">): void {
    this.#closeInteraction(params.interactionId);
  }

  #closeInteraction(interactionId: string): void {
    if (!this.#interactions.delete(interactionId)) return;
    this.#options.eventHub.publish({
      kind: "host.interactionClosed",
      payload: { interactionId, webSessionId: this.#options.webSessionId },
    });
  }
}
