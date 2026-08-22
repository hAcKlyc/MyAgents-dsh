import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  freezeMessage,
  MessageId,
  type ContentBlock,
  type MessageSource,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import {
  ProtocolError,
  validateMethodParams,
  type MethodParams,
  type MethodResult,
} from "@myagents-dsh/protocol";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { OperationBirthSnapshot } from "./events.js";
import {
  findProductOperation,
  foldProductOperations,
  foldProductOperationsForLiveClaim,
  foldProductOperationsForLiveDiscard,
  readOperationMessageSource,
  validateOperationBirthSnapshot,
  type ProductOperationFold,
  type ProductOperationRecord,
} from "./fold.js";
import { deriveOperationTerminal } from "./terminal.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sdkOperations: SdkOperationService;
  }
}

export interface OperationBirthAuthority {
  capture(params: MethodParams<"turn/start">): OperationBirthSnapshot | Promise<OperationBirthSnapshot>;
}

export interface SettlementDeadlineAuthority {
  readonly wait: <T>(operation: PromiseLike<T>, description: string) => Promise<T>;
}

export interface SdkOperationServiceConfig {
  readonly birthAuthority: OperationBirthAuthority;
  readonly drainOwnedWork: (agent: Agent) => Promise<void>;
  readonly ownsRootContextMessage: (
    agent: Agent,
    source: MessageSource | undefined,
    messageId: string,
  ) => boolean;
  readonly registerRetirementGuard: (guard: (agent: Agent) => Promise<void>) => void;
  readonly requireAgent: () => Agent;
  readonly retirePrimary: (cause?: unknown) => Promise<void>;
  readonly settlementDeadlineAuthority: SettlementDeadlineAuthority;
  readonly clock?: () => number;
  readonly modelProfileBirthGuard?: (revision: string) => void;
}

export interface OperationAdmissionControl {
  readonly signal: AbortSignal;
  readonly commit: () => void;
}

export interface OperationTerminalReservationAuthority {
  readonly reserve: (clientOperationId: string) => void;
  readonly whenIdle: () => Promise<void>;
}

export interface ModelRequestOperationAuthority {
  readonly assertCurrent: () => void;
  readonly callId?: string;
  readonly clientOperationId: string;
  readonly dshTurn: number;
  readonly modelRequestId: string;
  readonly rootCallId: string;
  readonly turnId: string;
}

export interface SdkOperationSnapshot {
  readonly recoveryRequired: boolean;
  readonly operations: readonly ProductOperationRecord[];
}

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const agentIsIdle = (agent: Agent): boolean => agent.status === "idle";

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

const operationFingerprint = (
  params: MethodParams<"turn/start">,
  birth: OperationBirthSnapshot,
): string => createHash("sha256").update(stableJson({
  format: "myagents-dsh-operation-fingerprint-v1",
  birth,
  params,
})).digest("hex");

const deterministicId = (
  kind: "message" | "turn",
  clientOperationId: string,
  clientUserMessageId: string,
): string => `${kind}-${createHash("sha256").update(stableJson([
  `myagents-dsh-operation-${kind}-v1`,
  clientOperationId,
  clientUserMessageId,
])).digest("hex").slice(0, 48)}`;

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): Record<string, unknown> => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError(`${description} must not be a Proxy`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(object, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} contains unsupported or non-data fields`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return object;
};

const validateServiceConfig = (value: unknown): Required<SdkOperationServiceConfig> => {
  const config = exactOwnDataObject(
    value,
    [
      "birthAuthority",
      "drainOwnedWork",
      "ownsRootContextMessage",
      "registerRetirementGuard",
      "requireAgent",
      "retirePrimary",
      "settlementDeadlineAuthority",
    ],
    ["clock", "modelProfileBirthGuard"],
    "SdkOperationService config",
  );
  const authority = exactOwnDataObject(
    config.birthAuthority,
    ["capture"],
    [],
    "operation birth authority",
  );
  const deadlineAuthority = exactOwnDataObject(
    config.settlementDeadlineAuthority,
    ["wait"],
    [],
    "operation settlement deadline authority",
  );
  if (typeof authority.capture !== "function" || typeof config.requireAgent !== "function"
    || typeof config.drainOwnedWork !== "function" || typeof config.ownsRootContextMessage !== "function"
    || typeof config.registerRetirementGuard !== "function"
    || typeof config.retirePrimary !== "function"
    || typeof deadlineAuthority.wait !== "function"
    || (Object.hasOwn(config, "clock") && typeof config.clock !== "function")
    || (Object.hasOwn(config, "modelProfileBirthGuard")
      && (typeof config.modelProfileBirthGuard !== "function"
        || utilTypes.isProxy(config.modelProfileBirthGuard)))) {
    throw new TypeError("SdkOperationService capabilities must be functions");
  }
  const captureOperationBirth = authority.capture as OperationBirthAuthority["capture"];
  const operationBirthReceiver = config.birthAuthority;
  const registerRetirementGuard = config.registerRetirementGuard as
    (guard: (agent: Agent) => Promise<void>) => void;
  const drainOwnedWork = config.drainOwnedWork as (agent: Agent) => Promise<void>;
  const ownsRootContextMessage = config.ownsRootContextMessage as SdkOperationServiceConfig["ownsRootContextMessage"];
  const retirePrimary = config.retirePrimary as (cause?: unknown) => Promise<void>;
  const settlementWait = deadlineAuthority.wait as SettlementDeadlineAuthority["wait"];
  const settlementDeadlineReceiver = config.settlementDeadlineAuthority;
  return Object.freeze({
    birthAuthority: Object.freeze({
      capture: (params: MethodParams<"turn/start">) =>
        Reflect.apply(captureOperationBirth, operationBirthReceiver, [params]),
    }),
    drainOwnedWork: (agent: Agent) => Reflect.apply(drainOwnedWork, config, [agent]),
    ownsRootContextMessage: (agent: Agent, source: MessageSource | undefined, messageId: string) =>
      Reflect.apply(ownsRootContextMessage, config, [agent, source, messageId]),
    registerRetirementGuard: (guard: (agent: Agent) => Promise<void>) =>
      Reflect.apply(registerRetirementGuard, config, [guard]),
    requireAgent: config.requireAgent as () => Agent,
    retirePrimary: (cause?: unknown) => Reflect.apply(retirePrimary, config, [cause]),
    settlementDeadlineAuthority: Object.freeze({
      wait: <T>(operation: PromiseLike<T>, description: string): Promise<T> =>
        Reflect.apply(settlementWait, settlementDeadlineReceiver, [operation, description]),
    }),
    clock: (config.clock ?? Date.now) as () => number,
    modelProfileBirthGuard: Object.hasOwn(config, "modelProfileBirthGuard")
      ? config.modelProfileBirthGuard as (revision: string) => void
      : () => undefined,
  });
};

const validateBirthAgainstParams = (
  birth: OperationBirthSnapshot,
  params: MethodParams<"turn/start">,
): void => {
  if (birth.configRevision !== params.configRevision
    || birth.executionEnvironmentRevision !== params.executionEnvironmentRevision
    || birth.executionEnvironmentDigest !== params.executionEnvironmentDigest
    || stableJson(birth.limits) !== stableJson(params.limits)) {
    throw new ProtocolError(
      "turn_birth_conflict",
      "operation birth authority differs from the immutable turn/start request",
    );
  }
};

const textContent = (params: MethodParams<"turn/start">): readonly ContentBlock[] => Object.freeze(
  params.input.parts.map((part): ContentBlock => {
    if (part.kind !== "text") {
      throw new ProtocolError(
        "turn_attachment_unavailable",
        "image_ref admission remains unavailable until the Host attachment lease Provider is installed",
      );
    }
    return Object.freeze({ type: "text", text: part.text });
  }),
);

const rootMessage = (
  params: MethodParams<"turn/start">,
  messageId: string,
): UserMessage => freezeMessage({
  id: MessageId(messageId),
  role: "user",
  content: [...textContent(params)],
  source: Object.freeze({
    kind: "myagents-operation",
    clientOperationId: params.clientOperationId,
    clientMessageId: params.clientUserMessageId,
    delivery: "root",
  }),
});

const knownResult = (operation: ProductOperationRecord): MethodResult<"turn/start"> => Object.freeze({
  state: "already_known",
  admission: Object.freeze({
    turnId: operation.productTurnId,
    admittedAt: new Date(operation.acceptedAt).toISOString(),
  }),
  ...(operation.terminal === undefined ? {} : { terminal: operation.terminal }),
});

const recoveryError = (cause: unknown): ProtocolError => new ProtocolError(
  "session_recovery_required",
  cause instanceof Error
    ? `product-operation durability became uncertain: ${cause.message}`
    : "product-operation durability became uncertain",
);

export class SdkOperationService extends Service {
  static inject = ["sessions", "productSession"];

  private readonly configValue: Required<SdkOperationServiceConfig>;
  private acceptingValue = true;
  private readonly cancellationReasonsValue = new Map<
    string,
    "user" | "host_shutdown" | "session_replaced"
  >();
  private correlationDrainValue: Promise<void> = Promise.resolve();
  private failureValue: ProtocolError | undefined;
  private primaryAgentValue: Agent | undefined;
  private nextModelRequestValue = 1;
  private readonly pendingRequestContextSeqs = new Set<number>();
  private serialValue: Promise<void> = Promise.resolve();
  private retirementEscalationValue: Promise<void> | undefined;
  private terminalReservationAuthorityValue: OperationTerminalReservationAuthority | undefined;

  constructor(ctx: Context, config: SdkOperationServiceConfig) {
    super(ctx, "sdkOperations");
    this.configValue = validateServiceConfig(config);
    this.configValue.registerRetirementGuard((agent) => this.preparePrimaryRetirement(agent));
    ctx.effect(function* (this: SdkOperationService) {
      const stopClaimed = ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
        try {
          const primaryAgent = this.primaryAgent();
          const source = readOperationMessageSource(message.source);
          if (agent !== primaryAgent) {
            if (source !== undefined) {
              throw new Error("operation-sourced message was claimed by a foreign Agent");
            }
            return;
          }
          this.assertHealthy();
          if (source === undefined) {
            if (this.configValue.ownsRootContextMessage(agent, message.source, message.id)) return;
            throw new Error("official root Agent claimed unowned product-operation work");
          }
          const fold = foldProductOperationsForLiveClaim(agent.session.events, {
            messageId: message.id,
            dshTurn: turn,
          }, agent.id);
          const operation = findProductOperation(fold, source.clientOperationId);
          const ownedMessage = operation?.messages.find(({ messageId }) => messageId === message.id);
          if (operation === undefined || ownedMessage?.clientMessageId !== source.clientMessageId
            || ownedMessage.state !== "queued" || !ownedMessage.delivered) {
            throw new Error("claimed operation message differs from durable ownership");
          }
          if ([...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(
            (pending) => pending.id === message.id,
          )) {
            throw new Error("claimed operation message remains pending in the DSH Inbox");
          }
          const matchingStarts = agent.session.events.filter(
            (event) => event.type === "turn/start" && event.data.turn === turn,
          );
          if (matchingStarts.length !== 1 || agent.session.events.some(
            (event) => event.type === "turn/end" && event.data.turn === turn,
          )) {
            throw new Error("claimed operation message lacks one open DSH turn boundary");
          }
          if (fold.operations.some((candidate) =>
            candidate.clientOperationId !== source.clientOperationId && candidate.dshTurns.includes(turn))) {
            throw new Error("one DSH turn is assigned across product operations");
          }
          const priorTurn = operation.dshTurns.at(-1);
          if (!Number.isSafeInteger(turn) || turn < 1 || (priorTurn !== undefined && turn < priorTurn)) {
            throw new Error("claimed operation DSH turn is invalid or non-monotonic");
          }
          agent.session.append("myagents/operation/claimed", {
            clientOperationId: source.clientOperationId,
            messageId: message.id,
            dshTurn: turn,
          });
          this.queueCorrelationFlush(agent);
        } catch (error) {
          this.fence(error);
          throw error;
        }
      });
      const stopDiscarded = ctx.on("agent/inbox/discarded", ({ agent, message }) => {
        try {
          const primaryAgent = this.primaryAgent();
          const source = readOperationMessageSource(message.source);
          if (agent !== primaryAgent) {
            if (source !== undefined) {
              throw new Error("operation-sourced message was discarded by a foreign Agent");
            }
            return;
          }
          this.assertHealthy();
          if (source === undefined) {
            if (this.configValue.ownsRootContextMessage(agent, message.source, message.id)) return;
            throw new Error("official root Agent discarded unowned product-operation work");
          }
          const fold = foldProductOperationsForLiveDiscard(agent.session.events, {
            messageId: message.id,
          }, agent.id);
          const operation = findProductOperation(fold, source.clientOperationId);
          const ownedMessage = operation?.messages.find(({ messageId }) => messageId === message.id);
          if (operation === undefined || ownedMessage?.clientMessageId !== source.clientMessageId
            || ownedMessage.state !== "queued" || !ownedMessage.delivered) {
            throw new Error("discarded operation message differs from durable ownership");
          }
          const cancellationReason = this.cancellationReasonsValue.get(message.id);
          if (cancellationReason === undefined) {
            throw new Error("operation message discard lacks a product cancellation owner");
          }
          this.cancellationReasonsValue.delete(message.id);
          agent.session.append("myagents/operation/message", {
            clientOperationId: source.clientOperationId,
            messageId: message.id,
            kind: ownedMessage.kind,
            clientMessageId: source.clientMessageId,
            state: "cancelled",
            cancellationReason,
          });
          this.queueCorrelationFlush(agent);
        } catch (error) {
          this.fence(error);
          throw error;
        }
      });
      const stopStatus = ctx.on("agent/status", ({ agent, status }) => {
        if (status === "idle" && this.isPrimaryAgent(agent)) this.queueTerminalEvaluation(agent);
      });
      const stopSessionEvent = ctx.on("session/event", (session, event) => {
        if (!this.primaryAgentForSession(session)) return;
        const agent = this.primaryAgentValue;
        if (agent === undefined) return;
        if (event.type === "assistant/message" && event.data.usage !== undefined) {
          this.queueRequestContextCapture(agent, event);
        } else if (event.type === "turn/end") this.queueTerminalEvaluation(agent);
      });
      yield async () => {
        this.acceptingValue = false;
        const failures: unknown[] = [];
        try {
          await this.configValue.retirePrimary();
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.correlationDrainValue;
        } catch (error) {
          if (!failures.includes(error)) failures.push(error);
        } finally {
          try {
            stopSessionEvent();
          } catch (error) {
            failures.push(error);
          }
          try {
            stopStatus();
          } catch (error) {
            failures.push(error);
          }
          try {
            stopDiscarded();
          } catch (error) {
            failures.push(error);
          }
          try {
            stopClaimed();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "product-operation lifecycle cleanup failed");
        }
      };
    }.bind(this), "sdk-operation-lifecycle");
  }

  snapshot(): SdkOperationSnapshot {
    this.assertOpen();
    const agent = this.primaryAgent();
    const fold = this.foldValue(agent);
    return Object.freeze({
      recoveryRequired: this.failureValue !== undefined,
      operations: fold.operations,
    });
  }

  bindTerminalReservationAuthority(authority: unknown): void {
    this.assertOpen();
    if (this.terminalReservationAuthorityValue !== undefined
      || authority === null || typeof authority !== "object" || utilTypes.isProxy(authority)) {
      throw new Error("product-operation terminal reservation authority must bind exactly once");
    }
    const reserve = Object.getOwnPropertyDescriptor(authority, "reserve");
    const whenIdle = Object.getOwnPropertyDescriptor(authority, "whenIdle");
    if (Reflect.ownKeys(authority).length !== 2 || reserve === undefined || whenIdle === undefined
      || !reserve.enumerable || !("value" in reserve) || typeof reserve.value !== "function"
      || !whenIdle.enumerable || !("value" in whenIdle) || typeof whenIdle.value !== "function") {
      throw new TypeError(
        "product-operation terminal reservation authority must expose reserve and whenIdle own data functions",
      );
    }
    const receiver = authority;
    const reserveValue = reserve.value as (clientOperationId: string) => void;
    const whenIdleValue = whenIdle.value as () => Promise<void>;
    this.terminalReservationAuthorityValue = Object.freeze({
      reserve: (clientOperationId: string) => Reflect.apply(reserveValue, receiver, [clientOperationId]),
      whenIdle: () => Reflect.apply(whenIdleValue, receiver, []),
    });
  }

  reconcile(): Promise<void> {
    this.assertOpen();
    return this.serialize(() => this.reconcileAgent(this.primaryAgent()));
  }

  lookup(clientOperationId: string): ProductOperationRecord | undefined {
    this.assertOpen();
    this.assertHealthy();
    if (typeof clientOperationId !== "string" || clientOperationId.length === 0
      || clientOperationId.length > 256) {
      throw new ProtocolError("turn_operation_invalid", "client operation identity is invalid");
    }
    return findProductOperation(this.foldValue(this.primaryAgent()), clientOperationId);
  }

  resolveActiveToolOperation(agent: Agent): Readonly<{
    dshTurn: number;
    operation: ProductOperationRecord;
  }> {
    this.assertOpen();
    this.assertHealthy();
    if (agent !== this.primaryAgent() || agent !== this.configValue.requireAgent()) {
      throw new ProtocolError(
        "turn_operation_conflict",
        "tool execution does not belong to the official primary Agent",
      );
    }
    const dshTurn = this.openDshTurn(agent);
    if (dshTurn === undefined) {
      throw new ProtocolError(
        "turn_operation_conflict",
        "tool execution lacks one open DSH turn",
      );
    }
    const owners = this.foldValue(agent).operations.filter((operation) =>
      operation.state !== "terminal" && operation.dshTurns.includes(dshTurn));
    if (owners.length !== 1 || owners[0] === undefined) {
      throw this.fence(new Error("open DSH tool turn lacks one durable product-operation owner"));
    }
    return Object.freeze({ dshTurn, operation: owners[0] });
  }

  createModelRequestAuthority(
    agent: Agent,
    configRevision: string,
    modelProfileRevision: string,
  ): ModelRequestOperationAuthority {
    const initial = this.resolveActiveToolOperation(agent);
    if (initial.operation.birth.configRevision !== configRevision
      || initial.operation.birth.modelProfileRevision !== modelProfileRevision) {
      throw new ProtocolError(
        "provider_profile_stale",
        "model request differs from the operation-frozen Provider profile",
      );
    }
    const sequence = this.nextModelRequestValue++;
    const modelRequestId = `model-${createHash("sha256").update(JSON.stringify([
      initial.operation.clientOperationId,
      initial.operation.productTurnId,
      initial.dshTurn,
      sequence,
    ])).digest("hex").slice(0, 48)}`;
    const assertCurrent = (): void => {
      const current = this.resolveActiveToolOperation(agent);
      if (current.dshTurn !== initial.dshTurn
        || current.operation.clientOperationId !== initial.operation.clientOperationId
        || current.operation.productTurnId !== initial.operation.productTurnId
        || current.operation.birth.configRevision !== configRevision
        || current.operation.birth.modelProfileRevision !== modelProfileRevision) {
        throw new ProtocolError(
          "provider_request_stale",
          "model request operation authority is no longer current",
        );
      }
    };
    return Object.freeze({
      assertCurrent,
      clientOperationId: initial.operation.clientOperationId,
      dshTurn: initial.dshTurn,
      modelRequestId,
      rootCallId: modelRequestId,
      turnId: initial.operation.productTurnId,
    });
  }

  start(
    value: unknown,
    control?: OperationAdmissionControl,
  ): Promise<MethodResult<"turn/start">> {
    this.assertOpen();
    const params = validateMethodParams("turn/start", value);
    return this.serialize(() => this.startValue(params, control));
  }

  cancelMessage(value: unknown): Promise<MethodResult<"turn/message/cancel">> {
    this.assertOpen();
    const params = validateMethodParams("turn/message/cancel", value);
    return this.serialize(() => this.cancelMessageValue(params));
  }

  interrupt(value: unknown): Promise<MethodResult<"turn/interrupt">> {
    this.assertOpen();
    const params = validateMethodParams("turn/interrupt", value);
    return this.serialize(() => this.interruptValue(params));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.serialValue.then(task);
    this.serialValue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async startValue(
    params: MethodParams<"turn/start">,
    control?: OperationAdmissionControl,
  ): Promise<MethodResult<"turn/start">> {
    this.assertOpen();
    this.assertHealthy();
    this.assertAdmissionNotCancelled(control);
    const agent = this.primaryAgent();
    await this.reconcileAgent(agent);
    const fold = this.foldValue(agent);
    const existing = findProductOperation(fold, params.clientOperationId);
    if (existing !== undefined) {
      if (existing.state !== "terminal") this.reserveTerminal(existing.clientOperationId);
      if (operationFingerprint(params, existing.birth) !== existing.fingerprint) {
        throw new ProtocolError(
          "turn_idempotency_conflict",
          "clientOperationId was reused with different immutable input",
        );
      }
      if (existing.state === "accepted_undelivered") {
        this.assertAdmissionNotCancelled(control);
        control?.commit();
        await this.recoverUndelivered(agent, params, existing);
        const recovered = findProductOperation(this.foldValue(agent), params.clientOperationId);
        if (recovered === undefined || recovered.state === "accepted_undelivered") {
          throw this.fence(new Error("exact retry did not durably reconstruct the accepted root message"));
        }
        return knownResult(recovered);
      }
      this.assertAdmissionNotCancelled(control);
      control?.commit();
      return knownResult(existing);
    }

    const captured = await this.configValue.birthAuthority.capture(params);
    this.assertOpen();
    this.assertAdmissionNotCancelled(control);
    if (agent !== this.configValue.requireAgent()) {
      throw new ProtocolError("primary_session_replaced", "primary Session changed during operation admission");
    }
    const birth = validateOperationBirthSnapshot(captured);
    this.configValue.modelProfileBirthGuard(birth.modelProfileRevision);
    validateBirthAgainstParams(birth, params);
    const fingerprint = operationFingerprint(params, birth);
    const productTurnId = deterministicId(
      "turn",
      params.clientOperationId,
      params.clientUserMessageId,
    );
    const rootMessageId = deterministicId(
      "message",
      params.clientOperationId,
      params.clientUserMessageId,
    );
    const acceptedAt = this.configValue.clock();
    if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0 || acceptedAt > 8_640_000_000_000_000) {
      throw new TypeError("operation clock must return a valid non-negative epoch millisecond");
    }

    this.reserveTerminal(params.clientOperationId);
    try {
      agent.session.append("myagents/operation/accepted", {
        clientOperationId: params.clientOperationId,
        clientUserMessageId: params.clientUserMessageId,
        fingerprint,
        productTurnId,
        rootMessageId,
        birth,
        acceptedAt,
      });
      control?.commit();
      agent.followup(rootMessage(params, rootMessageId));
      await this.flush(agent);
      this.assertOpen();
    } catch (error) {
      throw this.fence(error);
    }
    return Object.freeze({ state: "accepted", clientOperationId: params.clientOperationId });
  }

  private async cancelMessageValue(
    params: MethodParams<"turn/message/cancel">,
  ): Promise<MethodResult<"turn/message/cancel">> {
    this.assertOpen();
    this.assertHealthy();
    const agent = this.primaryAgent();
    const operation = findProductOperation(this.foldValue(agent), params.clientOperationId);
    if (operation === undefined) {
      throw new ProtocolError("turn_operation_unknown", "turn/message/cancel references an unknown operation");
    }
    const message = operation.messages.find(({ messageId }) => messageId === params.messageId);
    if (message === undefined) {
      throw new ProtocolError("turn_message_unknown", "turn/message/cancel references an unknown message");
    }
    if (message.state === "cancelled") {
      return Object.freeze({ messageId: message.messageId, state: "cancelled" as const });
    }
    if (message.state === "claimed") {
      return this.confirmDurableClaim(agent, params.clientOperationId, message.messageId);
    }
    if (!message.delivered) {
      throw this.fence(new Error("accepted-undelivered operation message cannot be cancelled by guessing"));
    }
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
      .some(({ id }) => id === message.messageId);
    if (!pending || !this.removePendingMessage(agent, message.messageId, "user")) {
      const raced = findProductOperation(this.foldValue(agent), params.clientOperationId)
        ?.messages.find(({ messageId }) => messageId === params.messageId);
      if (raced?.state === "claimed") {
        return this.confirmDurableClaim(agent, params.clientOperationId, message.messageId);
      }
      if (raced?.state === "cancelled") {
        return Object.freeze({ messageId: message.messageId, state: "cancelled" as const });
      }
      throw this.fence(new Error("queued operation message disappeared during cancellation"));
    }
    await this.flush(agent);
    await this.reconcileAgent(agent);
    const cancelled = findProductOperation(this.foldValue(agent), params.clientOperationId)
      ?.messages.find(({ messageId }) => messageId === params.messageId);
    if (cancelled?.state !== "cancelled") {
      throw this.fence(new Error("operation message cancellation did not become durable"));
    }
    return Object.freeze({ messageId: message.messageId, state: "cancelled" as const });
  }

  private async interruptValue(
    params: MethodParams<"turn/interrupt">,
  ): Promise<MethodResult<"turn/interrupt">> {
    this.assertOpen();
    this.assertHealthy();
    const agent = this.primaryAgent();
    await this.reconcileAgent(agent);
    let operation = findProductOperation(this.foldValue(agent), params.clientOperationId);
    if (operation === undefined) {
      throw new ProtocolError("turn_operation_unknown", "turn/interrupt references an unknown operation");
    }
    if (operation.state === "terminal") {
      return Object.freeze({ ok: true as const, stillQueuedMessageIds: [], cancelledMessageIds: [] });
    }
    const cancelledMessageIds: string[] = [];
    if (params.cancelQueued === true) {
      for (const message of operation.messages) {
        if (message.state !== "queued" || !message.delivered) continue;
        if (this.removePendingMessage(agent, message.messageId, "user")) {
          cancelledMessageIds.push(message.messageId);
        }
      }
    }
    operation = findProductOperation(this.foldValue(agent), params.clientOperationId);
    if (operation === undefined) {
      throw this.fence(new Error("turn/interrupt lost its durable operation owner"));
    }
    const openTurn = this.openDshTurn(agent);
    const interruptsActiveTurn = openTurn !== undefined && operation.dshTurns.includes(openTurn);
    if (interruptsActiveTurn) {
      try {
        agent.cancel({ kind: "user" }, { keepInbox: true });
        await this.configValue.settlementDeadlineAuthority.wait(
          agent.whenIdle(),
          "turn/interrupt Agent settlement",
        );
      } catch (error) {
        throw this.escalatePrimaryRetirement(error);
      }
    }
    if (cancelledMessageIds.length > 0 || interruptsActiveTurn) await this.flush(agent);
    await this.reconcileAgent(agent);
    const settled = findProductOperation(this.foldValue(agent), params.clientOperationId);
    if (settled === undefined) {
      throw this.fence(new Error("turn/interrupt lost its settled operation owner"));
    }
    if (interruptsActiveTurn && this.openDshTurn(agent) === openTurn) {
      throw this.escalatePrimaryRetirement(
        new Error("turn/interrupt did not close its active DSH turn"),
      );
    }
    const stillQueuedMessageIds = settled.messages
      .filter(({ state }) => state === "queued")
      .map(({ messageId }) => messageId);
    return Object.freeze({
      ok: true as const,
      stillQueuedMessageIds,
      cancelledMessageIds,
    });
  }

  private openDshTurn(agent: Agent): number | undefined {
    let open: number | undefined;
    for (const event of agent.session.events) {
      if (event.type === "turn/start") open = event.data.turn;
      else if (event.type === "turn/end" && event.data.turn === open) open = undefined;
    }
    return open;
  }

  private assertAdmissionNotCancelled(control: OperationAdmissionControl | undefined): void {
    if (control?.signal.aborted === true) {
      throw new ProtocolError("protocol_cancelled", "turn/start was cancelled before durable admission", true);
    }
  }

  private async recoverUndelivered(
    agent: Agent,
    params: MethodParams<"turn/start">,
    operation: ProductOperationRecord,
  ): Promise<void> {
    const root = operation.messages[0];
    if (root?.kind !== "root" || root.delivered
      || root.clientMessageId !== params.clientUserMessageId
      || root.messageId !== deterministicId("message", params.clientOperationId, params.clientUserMessageId)) {
      throw this.fence(new Error("accepted-undelivered operation cannot prove exact root reconstruction"));
    }
    try {
      agent.followup(rootMessage(params, root.messageId));
      await this.flush(agent);
      this.assertOpen();
    } catch (error) {
      throw this.fence(error);
    }
  }

  private async flush(agent: Agent): Promise<void> {
    const participated = await this.configValue.settlementDeadlineAuthority.wait(
      this.ctx.sessions.flush(agent.session),
      "product-operation durability flush",
    );
    if (!participated) {
      throw new Error("no Session durability Provider participated in the operation flush");
    }
  }

  private async confirmDurableClaim(
    agent: Agent,
    clientOperationId: string,
    messageId: string,
  ): Promise<MethodResult<"turn/message/cancel">> {
    await this.correlationDrainValue;
    this.assertHealthy();
    const claimed = findProductOperation(this.foldValue(agent), clientOperationId)
      ?.messages.find((message) => message.messageId === messageId);
    if (claimed?.state !== "claimed") {
      throw this.fence(new Error("claimed operation delivery lacks its durability barrier"));
    }
    return Object.freeze({ messageId, state: "delivered" as const });
  }

  private primaryAgent(): Agent {
    this.primaryAgentValue ??= this.configValue.requireAgent();
    return this.primaryAgentValue;
  }

  private isPrimaryAgent(agent: Agent): boolean {
    if (this.primaryAgentValue !== undefined) return this.primaryAgentValue === agent;
    try {
      this.primaryAgentValue = this.configValue.requireAgent();
    } catch {
      return false;
    }
    return this.primaryAgentValue === agent;
  }

  private primaryAgentForSession(session: Agent["session"]): boolean {
    if (this.primaryAgentValue === undefined) {
      try {
        this.primaryAgentValue = this.configValue.requireAgent();
      } catch {
        return false;
      }
    }
    return this.primaryAgentValue.session === session;
  }

  private captureRequestContext(
    agent: Agent,
    event: Extract<Agent["session"]["events"][number], { type: "assistant/message" }>,
  ): void {
    try {
      this.assertHealthy();
      const operation = this.foldValue(agent).operations.find(
        ({ dshTurns }) => dshTurns.includes(event.data.turn),
      );
      const contextEvent = agent.session.events.findLast((candidate) =>
        candidate.seq < event.seq && candidate.type === "request/context");
      const context = contextEvent?.type === "request/context" ? contextEvent.data : undefined;
      const contextWindow = context?.contextWindow;
      const source = event.data.message.source;
      if (operation === undefined
        || context?.provider !== source.provider
        || context.model !== source.model
        || typeof contextWindow !== "number"
        || !Number.isSafeInteger(contextWindow)
        || contextWindow < 1) {
        throw new Error("assistant usage lacks exact DSH request-context authority");
      }
      agent.session.append("myagents/operation/request-context", {
        clientOperationId: operation.clientOperationId,
        dshTurn: event.data.turn,
        dshStep: event.data.step,
        assistantEventSeq: event.seq,
        provider: source.provider,
        model: source.model,
        contextWindow,
      });
      this.queueCorrelationFlush(agent);
    } catch (error) {
      this.fence(error);
      throw error;
    }
  }

  private queueRequestContextCapture(
    agent: Agent,
    event: Extract<Agent["session"]["events"][number], { type: "assistant/message" }>,
  ): void {
    if (!this.acceptingValue || this.failureValue !== undefined) return;
    const capture = this.serialize(() => {
      try {
        this.captureRequestContext(agent, event);
      } finally {
        this.pendingRequestContextSeqs.delete(event.seq);
      }
      return Promise.resolve();
    });
    this.pendingRequestContextSeqs.add(event.seq);
    void capture.catch((error: unknown) => {
      this.fence(error);
    });
  }

  private queueTerminalEvaluation(agent: Agent): void {
    if (!this.acceptingValue || this.failureValue !== undefined) return;
    const evaluation = this.serialize(() => this.reconcileAgent(agent));
    void evaluation.catch((error: unknown) => {
      this.fence(error);
    });
  }

  private async reconcileAgent(agent: Agent, allowClosing = false): Promise<void> {
    try {
      await this.settleEligibleOperations(agent, allowClosing);
    } catch (error) {
      throw this.fence(error);
    }
  }

  private async settleEligibleOperations(agent: Agent, allowClosing: boolean): Promise<void> {
    let fold = this.foldValue(agent);
    for (const operation of fold.operations) {
      if (operation.state !== "terminal") this.reserveTerminal(operation.clientOperationId);
    }
    if (!fold.operations.some((operation) =>
      operation.state === "settling" && operation.terminal === undefined
        && (operation.dshTurns.length > 0
          || operation.messages.every(({ state }) => state === "cancelled")))) return;
    if (!agentIsIdle(agent)) return;
    await this.configValue.settlementDeadlineAuthority.wait(
      agent.whenIdle(),
      "operation terminal idle settlement",
    );
    if ((!this.acceptingValue && !allowClosing) || !agentIsIdle(agent)) return;
    this.assertHealthy();
    if (!allowClosing && agent !== this.configValue.requireAgent()) {
      throw new Error("primary Session changed before product-operation terminal settlement");
    }
    fold = this.foldValue(agent);
    if (this.pendingRequestContextSeqs.size > 0) return;
    for (const operation of fold.operations) {
      if (operation.state !== "settling" || operation.terminal !== undefined
        || (operation.dshTurns.length === 0
          && operation.messages.some(({ state }) => state !== "cancelled"))) continue;
      const derived = deriveOperationTerminal(agent.id, agent.session.events, operation);
      const terminalAt = this.configValue.clock();
      if (!Number.isSafeInteger(terminalAt) || terminalAt < 0
        || terminalAt > 8_640_000_000_000_000) {
        throw new TypeError("operation terminal clock must return a valid non-negative epoch millisecond");
      }
      agent.session.append("myagents/operation/terminal", {
        clientOperationId: operation.clientOperationId,
        productTurnId: operation.productTurnId,
        terminal: derived.terminal,
        ...(derived.finalDshTurn === undefined ? {} : { finalDshTurn: derived.finalDshTurn }),
        terminalAt,
      });
      await this.flush(agent);
    }
  }

  private async preparePrimaryRetirement(agent: Agent): Promise<void> {
    this.acceptingValue = false;
    if (this.primaryAgentValue !== undefined && this.primaryAgentValue !== agent) {
      throw this.fence(new Error("primary Session retirement changed the operation Agent identity"));
    }
    this.primaryAgentValue = agent;
    this.cancelPendingForRetirement(agent);
    await this.configValue.settlementDeadlineAuthority.wait(
      this.serialValue,
      "primary retirement operation admission drain",
    );
    this.assertHealthy();
    this.cancelPendingForRetirement(agent);
    await this.configValue.settlementDeadlineAuthority.wait(
      this.correlationDrainValue,
      "primary retirement correlation durability",
    );
    this.assertHealthy();
    await this.configValue.settlementDeadlineAuthority.wait(
      this.configValue.drainOwnedWork(agent),
      "primary retirement product work drain",
    );
    this.assertHealthy();
    await this.configValue.settlementDeadlineAuthority.wait(
      agent.whenIdle(),
      "primary retirement Agent settlement",
    );
    await this.configValue.settlementDeadlineAuthority.wait(
      this.settleEligibleOperations(agent, true),
      "primary retirement terminal settlement",
    );
    const settledFold = this.foldValue(agent);
    if (settledFold.operations.length > 0) {
      const terminalAuthority = this.terminalReservationAuthorityValue;
      if (terminalAuthority === undefined) {
        throw this.fence(new Error("primary retirement lost terminal-delivery ownership"));
      }
      await this.configValue.settlementDeadlineAuthority.wait(
        terminalAuthority.whenIdle(),
        "primary retirement terminal projection drain",
      );
    }
    this.assertHealthy();
  }

  private cancelPendingForRetirement(agent: Agent): void {
    const fold = this.foldValue(agent);
    let directCancellationAppended = false;
    for (const operation of fold.operations) {
      for (const message of operation.messages) {
        if (!message.delivered || message.state !== "queued") continue;
        if (!this.removePendingMessage(agent, message.messageId, "host_shutdown")) {
          throw this.fence(new Error("quiescent primary retirement lost one pending operation message"));
        }
        const updated = findProductOperation(
          foldProductOperationsForLiveDiscard(
            agent.session.events,
            { messageId: message.messageId },
            agent.id,
          ),
          operation.clientOperationId,
        )?.messages.find(({ messageId }) => messageId === message.messageId);
        if (updated?.state !== "cancelled") {
          agent.session.append("myagents/operation/message", {
            clientOperationId: operation.clientOperationId,
            messageId: message.messageId,
            kind: message.kind,
            clientMessageId: message.clientMessageId,
            state: "cancelled",
            cancellationReason: "host_shutdown",
          });
          directCancellationAppended = true;
        }
      }
    }
    if (directCancellationAppended) this.queueCorrelationFlush(agent);
  }

  private queueCorrelationFlush(agent: Agent): void {
    const flush = this.correlationDrainValue.then(() => this.flush(agent));
    this.correlationDrainValue = flush.catch((error: unknown) => {
      throw this.fence(error);
    });
    void this.correlationDrainValue.catch(() => undefined);
  }

  private removePendingMessage(
    agent: Agent,
    messageId: string,
    reason: "user" | "host_shutdown" | "session_replaced",
  ): boolean {
    if (this.cancellationReasonsValue.has(messageId)) {
      throw this.fence(new Error("operation message already has an in-flight cancellation owner"));
    }
    this.cancellationReasonsValue.set(messageId, reason);
    try {
      return agent.inbox.remove(MessageId(messageId));
    } finally {
      this.cancellationReasonsValue.delete(messageId);
    }
  }

  private foldValue(agent: Agent): ProductOperationFold {
    try {
      return foldProductOperations(agent.session.events, agent.id);
    } catch (error) {
      throw this.fence(error);
    }
  }

  private assertHealthy(): void {
    if (this.failureValue !== undefined) throw this.failureValue;
  }

  private reserveTerminal(clientOperationId: string): void {
    const authority = this.terminalReservationAuthorityValue;
    if (authority === undefined) {
      throw new ProtocolError(
        "terminal_delivery_unavailable",
        "turn admission requires a bound terminal-delivery reservation authority",
        true,
      );
    }
    authority.reserve(clientOperationId);
  }

  private assertOpen(): void {
    if (!this.acceptingValue) {
      throw new ProtocolError("protocol_closed", "product-operation admission is closing or disposed");
    }
  }

  private escalatePrimaryRetirement(cause: unknown): ProtocolError {
    const failure = this.fence(cause);
    this.retirementEscalationValue ??= Promise.resolve()
      .then(() => this.configValue.retirePrimary(failure))
      .catch((error: unknown) => {
        this.fence(error);
      });
    return failure;
  }

  private fence(cause: unknown): ProtocolError {
    this.failureValue ??= recoveryError(cause);
    return this.failureValue;
  }
}
