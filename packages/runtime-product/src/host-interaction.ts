import { createHash } from "node:crypto";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type {
  HostPortRequestAuthority,
  HostPortService,
  HostPortServiceController,
  InteractionRequest,
} from "@myagents-dsh/host-ports";
import type { MethodParams, MethodResult } from "@myagents-dsh/protocol";
import {
  ProductPermissionError,
  validateProductPermissionInteractionResponse,
  validateProductQuestionAnswer,
  type ProductLocalInteractionProvider,
  type ProductLocalInteractionSettlement,
  type ProductPermissionInteractionRequest,
} from "@myagents-dsh/tool-runtime-product";

export interface HostBackedInteractionProviderConfig {
  readonly revision: string;
  readonly deadlineMs: number;
}

export interface HostInteractionOperationAuthority {
  readonly authority: HostPortRequestAuthority;
  readonly assertCurrent: () => void;
  readonly clientOperationId: string;
  readonly dshTurn: number;
  readonly expectedConfigRevision: string;
  readonly expectedPermissionRevision: string;
  readonly productTurnId: string;
}

export interface HostInteractionBridgeConfig {
  readonly controller: Pick<HostPortServiceController, "notifyInteractionCancelled">;
  readonly hostPorts: HostPortService;
  readonly resolveAuthority: (
    agent: Agent,
    signal: AbortSignal,
    expectedPermissionRevision: string | undefined,
    deadlineMs: number,
  ) => HostInteractionOperationAuthority;
  readonly revision: string;
  readonly deadlineMs: number;
}

export interface HostInteractionResponseController {
  readonly respond: (
    params: MethodParams<"interaction/respond">,
  ) => Promise<MethodResult<"interaction/respond">>;
}

type InteractionState = "registering" | "waiting";
type TerminalState = "settled" | "expired";

type InteractionRecord = {
  readonly authority: HostPortRequestAuthority;
  readonly assertCurrent: () => void;
  readonly expectedRevision: string;
  readonly interactionId: string;
  readonly registration: Promise<"waiting" | "expired">;
  readonly reject: (error: Error) => void;
  readonly resolve: (params: MethodParams<"interaction/respond">) => void;
  state: InteractionState;
};

const MAX_TERMINAL_INTERACTIONS = 1_024;
const MAX_INTERACTION_SCHEMA_BYTES = 786_432;

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError(`${description} must be a bounded identifier`);
    }
  }
  return value;
};

const positiveDeadline = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 600_000) {
    throw new TypeError("Host interaction deadline must be between 1 and 600000 milliseconds");
  }
  return value as number;
};

const boundedSchema = <Value>(value: Value): Value => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_INTERACTION_SCHEMA_BYTES) {
    throw new ProductPermissionError(
      "interaction_overloaded",
      "Host interaction schema exceeds its bounded wire budget",
    );
  }
  return value;
};

const interactionId = (
  kind: "ask_user" | "plan_approval",
  authority: HostInteractionOperationAuthority,
  request: AskUserQuestionRequest,
): string => `interaction-${createHash("sha256").update(JSON.stringify([
  kind,
  authority.clientOperationId,
  authority.productTurnId,
  authority.dshTurn,
  request.questions,
])).digest("hex")}`;

class ProductHostInteractionBridge {
  readonly provider: ProductLocalInteractionProvider;
  readonly controller: HostInteractionResponseController;
  readonly #config: HostInteractionBridgeConfig;
  readonly #active = new Map<string, InteractionRecord>();
  readonly #terminal = new Map<string, TerminalState>();

  constructor(config: HostInteractionBridgeConfig) {
    this.#config = Object.freeze({
      ...config,
      revision: boundedIdentifier(config.revision, "Host interaction scenario revision"),
      deadlineMs: positiveDeadline(config.deadlineMs),
    });
    this.provider = Object.freeze({
      revision: this.#config.revision,
      decidePermission: (
        request: ProductPermissionInteractionRequest,
        settlement: ProductLocalInteractionSettlement<unknown>,
      ) => this.#registerPermission(request, settlement),
      answerQuestions: (
        request: AskUserQuestionRequest,
        settlement: ProductLocalInteractionSettlement<unknown>,
      ) => this.#registerQuestions(request, settlement),
    } satisfies ProductLocalInteractionProvider);
    this.controller = Object.freeze({
      respond: (params: MethodParams<"interaction/respond">) => this.#respond(params),
    });
  }

  #registerPermission(
    request: ProductPermissionInteractionRequest,
    settlement: ProductLocalInteractionSettlement<unknown>,
  ): () => void {
    const authority = this.#config.resolveAuthority(
      request.agent,
      request.signal,
      request.expectedPermissionRevision,
      this.#config.deadlineMs,
    );
    if (authority.clientOperationId !== request.clientOperationId
      || authority.productTurnId !== request.productTurnId
      || authority.dshTurn !== request.dshTurn
      || authority.expectedPermissionRevision !== request.expectedPermissionRevision) {
      throw new ProductPermissionError(
        "interaction_stale",
        "permission interaction differs from its operation authority",
      );
    }
    const schema = boundedSchema(Object.freeze({
      origin: request.origin,
      permissionClass: request.permissionClass,
      target: request.target,
      tool: request.tool,
    }));
    const wireRequest: InteractionRequest = Object.freeze({
      interactionId: request.interactionId,
      kind: "permission",
      schema,
      permissionAction: request.permissionClass,
      desiredPolicyRevision: request.expectedPermissionRevision,
      scenario: request.interactionScenarioRevision,
      cancellationToken: request.interactionId,
    });
    return this.#register(
      authority.authority,
      authority.assertCurrent,
      wireRequest,
      request.expectedPermissionRevision,
      (params) => {
        if (Object.hasOwn(params, "value")
          || params.decision === "answered") {
          throw new TypeError("permission interaction response has an invalid decision or value");
        }
        settlement.resolve(validateProductPermissionInteractionResponse(Object.freeze({
          interactionId: request.interactionId,
          expectedPermissionRevision: request.expectedPermissionRevision,
          decision: params.decision,
        }), request));
      },
      (error) => settlement.reject(error),
    );
  }

  #registerQuestions(
    request: AskUserQuestionRequest,
    settlement: ProductLocalInteractionSettlement<unknown>,
  ): () => void {
    const agent = request.agent;
    if (agent === undefined) {
      throw new ProductPermissionError(
        "interaction_unavailable",
        "Host question interaction requires the official primary Agent authority",
      );
    }
    const authority = this.#config.resolveAuthority(
      agent,
      request.signal ?? new AbortController().signal,
      undefined,
      this.#config.deadlineMs,
    );
    const kind = request.questions.length === 1 && request.questions[0]?.intent?.kind === "plan-review"
      ? "plan_approval" as const
      : "ask_user" as const;
    const id = interactionId(kind, authority, request);
    const schema = boundedSchema(Object.freeze({ questions: request.questions }));
    const wireRequest: InteractionRequest = Object.freeze({
      interactionId: id,
      kind,
      schema,
      desiredPolicyRevision: authority.expectedPermissionRevision,
      scenario: this.#config.revision,
      cancellationToken: id,
    });
    return this.#register(
      authority.authority,
      authority.assertCurrent,
      wireRequest,
      authority.expectedPermissionRevision,
      (params) => {
        if (params.decision === "cancelled" && !Object.hasOwn(params, "value")) {
          settlement.reject(new ProductPermissionError(
            "interaction_cancelled",
            "Host cancelled the question interaction",
          ));
          return;
        }
        if (params.decision !== "answered" || !Object.hasOwn(params, "value")) {
          throw new TypeError("question interaction response has an invalid decision or value");
        }
        settlement.resolve(validateProductQuestionAnswer(params.value, request));
      },
      (error) => settlement.reject(error),
    );
  }

  #register(
    authority: HostPortRequestAuthority,
    assertCurrent: () => void,
    request: InteractionRequest,
    expectedRevision: string,
    resolve: (params: MethodParams<"interaction/respond">) => void,
    reject: (error: Error) => void,
  ): () => void {
    const id = boundedIdentifier(request.interactionId, "Host interaction id");
    if (this.#active.has(id) || this.#terminal.has(id)) {
      throw new ProductPermissionError(
        "interaction_duplicate",
        "Host interaction identity was already registered",
      );
    }
    let settleRegistration: (state: "waiting" | "expired") => void = () => undefined;
    const registrationState = new Promise<"waiting" | "expired">((resolveRegistration) => {
      settleRegistration = resolveRegistration;
    });
    const record: InteractionRecord = {
      authority,
      assertCurrent,
      expectedRevision: boundedIdentifier(expectedRevision, "Host interaction expected revision"),
      interactionId: id,
      registration: registrationState,
      reject,
      resolve,
      state: "registering",
    };
    this.#active.set(id, record);
    const registration = this.#config.hostPorts.requestInteraction(authority, request);
    void registration.then(
      () => {
        if (this.#active.get(id) === record) {
          record.state = "waiting";
          settleRegistration("waiting");
        } else {
          settleRegistration("expired");
        }
      },
      () => {
        if (this.#active.get(id) === record) {
          this.#active.delete(id);
          this.#remember(id, "expired");
          reject(new ProductPermissionError(
            "interaction_unavailable",
            "Host did not register the interaction",
          ));
        }
        settleRegistration("expired");
      },
    );
    return () => {
      if (this.#active.get(id) !== record) return;
      this.#active.delete(id);
      this.#remember(id, "expired");
      settleRegistration("expired");
      if (record.state === "waiting") {
        this.#config.controller.notifyInteractionCancelled(Object.freeze({
          interactionId: id,
          reason: "interaction_cancelled",
        }));
      }
    };
  }

  async #respond(
    params: MethodParams<"interaction/respond">,
  ): Promise<MethodResult<"interaction/respond">> {
    const id = boundedIdentifier(params.interactionId, "Host interaction response id");
    const record = this.#active.get(id);
    if (record === undefined) {
      return this.#terminal.get(id) === "settled"
        ? Object.freeze({ state: "already_settled" as const })
        : Object.freeze({ state: "expired" as const });
    }
    if (record.state === "registering") {
      await record.registration;
      return this.#respond(params);
    }
    if (params.expectedRevision !== record.expectedRevision) {
      return Object.freeze({ state: "rejected" as const, code: "interaction_revision_stale" });
    }
    try {
      record.assertCurrent();
    } catch {
      this.#active.delete(id);
      this.#remember(id, "expired");
      record.reject(new ProductPermissionError(
        "interaction_stale",
        "Host interaction operation authority became stale",
      ));
      return Object.freeze({ state: "rejected" as const, code: "interaction_authority_stale" });
    }
    this.#active.delete(id);
    try {
      record.resolve(params);
      this.#remember(id, "settled");
      return Object.freeze({
        state: "applied" as const,
        effectivePolicyRevision: record.expectedRevision,
      });
    } catch {
      this.#remember(id, "expired");
      record.reject(new ProductPermissionError(
        "interaction_response_invalid",
        "Host interaction response failed strict validation",
      ));
      return Object.freeze({ state: "rejected" as const, code: "interaction_response_invalid" });
    }
  }

  #remember(id: string, state: TerminalState): void {
    this.#terminal.set(id, state);
    while (this.#terminal.size > MAX_TERMINAL_INTERACTIONS) {
      const oldest = this.#terminal.keys().next().value;
      if (oldest === undefined) break;
      this.#terminal.delete(oldest);
    }
  }
}

export const createProductHostInteractionBridge = (
  config: HostInteractionBridgeConfig,
): Readonly<{
  controller: HostInteractionResponseController;
  provider: ProductLocalInteractionProvider;
}> => {
  const bridge = new ProductHostInteractionBridge(config);
  return Object.freeze({ controller: bridge.controller, provider: bridge.provider });
};

Object.freeze(ProductHostInteractionBridge.prototype);
Object.freeze(ProductHostInteractionBridge);
