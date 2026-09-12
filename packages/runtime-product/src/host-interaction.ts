import { createHash } from "node:crypto";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type {
  HostPortRequestAuthority,
  HostPortService,
  HostPortServiceController,
  InteractionRequest,
} from "@myagents-dsh/host-ports";
import type { MethodParams, MethodResult, PermissionReview } from "@myagents-dsh/protocol";
import {
  ProductPermissionError,
  validateProductPermissionInteractionResponse,
  validateProductQuestionAnswer,
  type ProductLocalInteractionProvider,
  type ProductLocalInteractionSettlement,
  type ProductLocalInteractionEffectReceipt,
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
    correlation?: Readonly<{ callId: string; rootCallId: string }>,
  ) => HostInteractionOperationAuthority;
  readonly preparePermissionReview?: (request: ProductPermissionInteractionRequest, review: PermissionReview) => Promise<Pick<InteractionRequest, "review" | "reviewRef">>;
  readonly revision: string;
  readonly deadlineMs: number;
}

export interface HostInteractionResponseController {
  readonly respond: (
    params: MethodParams<"interaction/respond">,
  ) => Promise<MethodResult<"interaction/respond">>;
}

type InteractionState = "registering" | "waiting";
type TerminalState = "settled" | "expired" | Readonly<{ state: "rejected"; code: string }>;

type InteractionRecord = {
  readonly authority: HostPortRequestAuthority;
  readonly assertCurrent: () => void;
  readonly expectedRevision: string;
  readonly interactionId: string;
  readonly registration: Promise<"waiting" | "expired">;
  readonly reject: (error: Error) => void;
  readonly prepareResponse: (
    params: MethodParams<"interaction/respond">,
  ) => () => Promise<ProductLocalInteractionEffectReceipt>;
  state: InteractionState;
  settlement?: Promise<MethodResult<"interaction/respond">>;
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
  agent: Agent,
): string => `interaction-${createHash("sha256").update(JSON.stringify([
  kind,
  agent.id,
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
      { callId: request.callId, rootCallId: request.rootCallId },
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
    const review: PermissionReview = {
      operation: request.review ?? { kind: "generic", action: request.tool, target: request.target },
      actor: { agentId: request.agent.id, origin: request.origin },
      scope: { tool: request.tool, permissionClass: request.permissionClass, target: request.target, lifetimeMs: null, owner: "session_tree" },
    };
    const prepareReview = this.#config.preparePermissionReview;
    const wireRequest: InteractionRequest = Object.freeze({
      interactionId: request.interactionId,
      kind: "permission",
      schema,
      review,
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
        const response = validateProductPermissionInteractionResponse(Object.freeze({
          interactionId: request.interactionId,
          expectedPermissionRevision: request.expectedPermissionRevision,
          decision: params.decision,
        }), request);
        return () => settlement.resolve(response);
      },
      (error) => settlement.reject(error),
      prepareReview === undefined ? undefined : async () => {
        const control = { ...wireRequest };
        delete control.review;
        return { ...control, ...await prepareReview(request, review) };
      },
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
    const id = interactionId(kind, authority, request, agent);
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
          const error = new ProductPermissionError(
            "interaction_cancelled",
            "Host cancelled the question interaction",
          );
          return () => {
            settlement.reject(error);
            return Promise.resolve({});
          };
        }
        if (params.decision !== "answered" || !Object.hasOwn(params, "value")) {
          throw new TypeError("question interaction response has an invalid decision or value");
        }
        const answer = validateProductQuestionAnswer(params.value, request);
        return () => settlement.resolve(answer);
      },
      (error) => settlement.reject(error),
    );
  }

  #register(
    authority: HostPortRequestAuthority,
    assertCurrent: () => void,
    request: InteractionRequest,
    expectedRevision: string,
    prepareResponse: (
      params: MethodParams<"interaction/respond">,
    ) => () => Promise<ProductLocalInteractionEffectReceipt>,
    reject: (error: Error) => void,
    prepare?: () => Promise<InteractionRequest>,
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
      prepareResponse,
      state: "registering",
    };
    this.#active.set(id, record);
    const registration = (async () => {
      const prepared = prepare === undefined ? request : await prepare();
      if (this.#active.get(id) !== record) return;
      assertCurrent();
      await this.#config.hostPorts.requestInteraction(authority, prepared);
    })();
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
      // Once answering starts, its receipt owns completion. Normal provider cleanup
      // may dispose registration before the asynchronous effect returns.
      if (record.settlement !== undefined) return;
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
      const terminal = this.#terminal.get(id);
      if (typeof terminal === "object") return terminal;
      return terminal === "settled"
        ? Object.freeze({ state: "already_settled" as const })
        : Object.freeze({ state: "expired" as const });
    }
    if (record.state === "registering") {
      await record.registration;
      return this.#respond(params);
    }
    if (record.settlement !== undefined) {
      const result = await record.settlement;
      return result.state === "applied" ? { state: "already_settled" } : result;
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
    // Input validation does not consume the interaction or enter its effect phase.
    // Only a prepared response may acquire the single settlement promise.
    let apply: () => Promise<ProductLocalInteractionEffectReceipt>;
    try {
      apply = record.prepareResponse(params);
    } catch {
      return { state: "rejected", code: "interaction_response_invalid" };
    }
    const settlement = Promise.resolve().then(() => this.#settle(record, apply));
    record.settlement = settlement;
    return await settlement;
  }

  async #settle(record: InteractionRecord, apply: () => Promise<ProductLocalInteractionEffectReceipt>): Promise<MethodResult<"interaction/respond">> {
    const id = record.interactionId;
    try {
      const receipt = await apply();
      this.#remember(id, "settled");
      return { state: "applied", effectivePolicyRevision: receipt.effectivePolicyRevision ?? record.expectedRevision };
    } catch (error) {
      const result = { state: "rejected" as const, code: error instanceof ProductPermissionError ? error.code : "interaction_effect_failed" };
      this.#remember(id, result);
      return result;
    } finally {
      this.#active.delete(id);
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
