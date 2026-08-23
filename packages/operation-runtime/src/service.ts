import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  freezeMessage,
  MessageId,
  type ContentBlock,
  type MessageSource,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
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
import { deriveOperationAccruedCostUsd, deriveOperationTerminal } from "./terminal.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sdkOperations: SdkOperationService;
  }
}

export interface OperationBirthAuthority {
  capture(params: MethodParams<"turn/start">): OperationBirthSnapshot | Promise<OperationBirthSnapshot>;
}

export interface OperationInputAuthority {
  readonly prepare: (
    input: MethodParams<"turn/start">["input"],
    birth: OperationBirthSnapshot,
    signal: AbortSignal,
  ) => Promise<readonly ContentBlock[]>;
}

export interface SettlementDeadlineAuthority {
  readonly wait: <T>(operation: PromiseLike<T>, description: string) => Promise<T>;
}

export interface OperationLifecycleController {
  readonly runAtQuiescentBoundary: (
    signal: AbortSignal,
    commit: () => void,
  ) => Promise<boolean>;
  readonly runAtNextQuiescentBoundary: <T>(
    signal: AbortSignal,
    commit: () => void,
    action: () => Promise<T>,
  ) => Promise<T>;
}

type IncompleteRecoveryWake = Readonly<{
  attemptId: string;
  clientOperationId: string;
  messageId: string;
}>;

type WakePendingAgent = Agent & Readonly<{
  wakePending?: (messageId: MessageId) => boolean;
}>;

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
  readonly inputAuthority?: OperationInputAuthority;
  readonly registerLifecycleController?: (controller: OperationLifecycleController) => void;
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

const inputFingerprint = (input: MethodParams<"turn/followUp">["input"]): string =>
  createHash("sha256").update(stableJson({
    format: "myagents-dsh-operation-input-v1",
    input,
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

const incompleteRecoveryWakes = (
  events: readonly SessionEvent[],
): ReadonlyMap<string, IncompleteRecoveryWake> => {
  const result = new Map<string, IncompleteRecoveryWake>();
  for (const event of events) {
    if (event.type !== "myagents/operation/recovery-wake") continue;
    const wake = event.data;
    if (wake.phase === "intent") {
      result.set(wake.messageId, Object.freeze({
        attemptId: wake.attemptId,
        clientOperationId: wake.clientOperationId,
        messageId: wake.messageId,
      }));
    } else {
      const intent = result.get(wake.messageId);
      if (intent?.attemptId === wake.attemptId) result.delete(wake.messageId);
    }
  }
  return result;
};

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
    ["clock", "inputAuthority", "modelProfileBirthGuard", "registerLifecycleController"],
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
  const inputAuthority = Object.hasOwn(config, "inputAuthority")
    ? exactOwnDataObject(config.inputAuthority, ["prepare"], [], "operation input authority")
    : undefined;
  if (typeof authority.capture !== "function" || typeof config.requireAgent !== "function"
    || typeof config.drainOwnedWork !== "function" || typeof config.ownsRootContextMessage !== "function"
    || typeof config.registerRetirementGuard !== "function"
    || typeof config.retirePrimary !== "function"
    || typeof deadlineAuthority.wait !== "function"
    || (inputAuthority !== undefined && (typeof inputAuthority.prepare !== "function"
      || utilTypes.isProxy(inputAuthority.prepare)))
    || (Object.hasOwn(config, "clock") && typeof config.clock !== "function")
    || (Object.hasOwn(config, "modelProfileBirthGuard")
      && (typeof config.modelProfileBirthGuard !== "function"
        || utilTypes.isProxy(config.modelProfileBirthGuard)))
    || (Object.hasOwn(config, "registerLifecycleController")
      && (typeof config.registerLifecycleController !== "function"
        || utilTypes.isProxy(config.registerLifecycleController)))) {
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
  const prepareInput = inputAuthority?.prepare as OperationInputAuthority["prepare"] | undefined;
  const inputAuthorityReceiver = config.inputAuthority;
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
    inputAuthority: Object.freeze({
      prepare: prepareInput === undefined
        ? (input: MethodParams<"turn/start">["input"]) => Promise.resolve(textContent(input))
        : (input: MethodParams<"turn/start">["input"], birth: OperationBirthSnapshot, signal: AbortSignal) =>
          Reflect.apply(prepareInput, inputAuthorityReceiver, [input, birth, signal]),
    }),
    modelProfileBirthGuard: Object.hasOwn(config, "modelProfileBirthGuard")
      ? config.modelProfileBirthGuard as (revision: string) => void
      : () => undefined,
    registerLifecycleController: Object.hasOwn(config, "registerLifecycleController")
      ? config.registerLifecycleController as (controller: OperationLifecycleController) => void
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

const textContent = (input: MethodParams<"turn/start">["input"]): readonly ContentBlock[] => Object.freeze(
  input.parts.map((part): ContentBlock => {
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
  content: readonly ContentBlock[],
): UserMessage => freezeMessage({
  id: MessageId(messageId),
  role: "user",
  content: [...content],
  source: Object.freeze({
    kind: "myagents-operation",
    clientOperationId: params.clientOperationId,
    clientMessageId: params.clientUserMessageId,
    delivery: "root",
  }),
});

const continuationMessage = (
  operation: ProductOperationRecord,
  kind: "steer" | "follow_up",
  clientMessageId: string,
  messageId: string,
  content: readonly ContentBlock[],
): UserMessage => freezeMessage({
  id: MessageId(messageId),
  role: "user",
  content: [...content],
  source: Object.freeze({
    kind: "myagents-operation",
    clientOperationId: operation.clientOperationId,
    clientMessageId,
    delivery: kind,
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
    "user" | "host_shutdown" | "session_replaced" | "limit"
  >();
  private correlationDrainValue: Promise<void> = Promise.resolve();
  private failureValue: ProtocolError | undefined;
  private primaryAgentValue: Agent | undefined;
  private nextModelRequestValue = 1;
  private readonly pendingRequestContextSeqs = new Set<number>();
  private readonly durationTimersValue = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stoppingTurnsValue = new Set<number>();
  private quiescentMutationValue = false;
  private serialValue: Promise<void> = Promise.resolve();
  private retirementEscalationValue: Promise<void> | undefined;
  private terminalReservationAuthorityValue: OperationTerminalReservationAuthority | undefined;

  constructor(ctx: Context, config: SdkOperationServiceConfig) {
    super(ctx, "sdkOperations");
    this.configValue = validateServiceConfig(config);
    this.configValue.registerRetirementGuard((agent) => this.preparePrimaryRetirement(agent));
    this.configValue.registerLifecycleController(Object.freeze({
      runAtQuiescentBoundary: (signal: AbortSignal, commit: () => void) =>
        this.runAtQuiescentBoundary(signal, commit),
      runAtNextQuiescentBoundary: <T>(
        signal: AbortSignal,
        commit: () => void,
        action: () => Promise<T>,
      ) => this.runAtNextQuiescentBoundary(signal, commit, action),
    }));
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
      const stopTurnStopping = ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
        if (!this.isPrimaryAgent(agent)) return;
        this.stoppingTurnsValue.add(turn);
        return this.serialize(async () => {
          signal.throwIfAborted();
          await this.enforceTurnBoundaryLimits(agent, turn);
        });
      });
      const stopSessionEvent = ctx.on("session/event", (session, event) => {
        if (!this.primaryAgentForSession(session)) return;
        const agent = this.primaryAgentValue;
        if (agent === undefined) return;
        if (event.type === "assistant/message" && event.data.usage !== undefined) {
          this.queueRequestContextCapture(agent, event);
        } else if (event.type === "turn/end") {
          this.stoppingTurnsValue.delete(event.data.turn);
          this.queueTerminalEvaluation(agent);
        }
      });
      yield async () => {
        this.acceptingValue = false;
        this.clearDurationTimers();
        this.stoppingTurnsValue.clear();
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
            stopTurnStopping();
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

  reconcileResumed(agent: Agent): Promise<void> {
    this.assertOpen();
    return this.serialize(() => this.reconcileResumedAgent(agent));
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

  get(value: unknown): MethodResult<"turn/get"> {
    this.assertOpen();
    const params = validateMethodParams("turn/get", value);
    const operation = this.lookup(params.clientOperationId);
    if (operation === undefined) {
      return Object.freeze({ clientOperationId: params.clientOperationId });
    }
    return Object.freeze({
      clientOperationId: operation.clientOperationId,
      admission: Object.freeze({
        turnId: operation.productTurnId,
        admittedAt: new Date(operation.acceptedAt).toISOString(),
      }),
      ...(operation.terminal === undefined ? {} : { terminal: operation.terminal }),
    });
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
    this.enforceSynchronousRequestLimits(agent, initial.operation);
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

  steer(value: unknown, signal?: AbortSignal): Promise<MethodResult<"turn/steer">> {
    this.assertOpen();
    const params = validateMethodParams("turn/steer", value);
    return this.serialize(() => this.steerValue(params, signal));
  }

  followUp(value: unknown, signal?: AbortSignal): Promise<MethodResult<"turn/followUp">> {
    this.assertOpen();
    const params = validateMethodParams("turn/followUp", value);
    return this.serialize(() => this.followUpValue(params, signal));
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

  private runAtQuiescentBoundary(
    signal: AbortSignal,
    commit: () => void,
  ): Promise<boolean> {
    if (!(signal instanceof AbortSignal) || utilTypes.isProxy(signal)
      || typeof commit !== "function" || utilTypes.isProxy(commit)) {
      return Promise.reject(new TypeError(
        "operation lifecycle boundary requires a native AbortSignal and non-proxy commit",
      ));
    }
    return this.serialize(async () => {
      this.assertOpen();
      this.assertHealthy();
      signal.throwIfAborted();
      let agent: Agent;
      try {
        agent = this.primaryAgent();
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "primary_session_not_ready") {
          commit();
          return true;
        }
        throw error;
      }
      await this.reconcileAgent(agent);
      signal.throwIfAborted();
      const fold = this.foldValue(agent);
      if (!agentIsIdle(agent)
        || fold.operations.some(({ state }) => state !== "terminal")) {
        return false;
      }
      commit();
      return true;
    });
  }

  private runAtNextQuiescentBoundary<T>(
    signal: AbortSignal,
    commit: () => void,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!(signal instanceof AbortSignal) || utilTypes.isProxy(signal)
      || typeof commit !== "function" || utilTypes.isProxy(commit)
      || typeof action !== "function" || utilTypes.isProxy(action)) {
      return Promise.reject(new TypeError(
        "next operation lifecycle boundary requires a native AbortSignal and non-proxy callbacks",
      ));
    }
    return this.serialize(async () => {
      this.assertOpen();
      this.assertHealthy();
      signal.throwIfAborted();
      const agent = this.primaryAgent();
      await this.reconcileAgent(agent);
      if (!agentIsIdle(agent) || this.foldValue(agent).operations.some(({ state }) => state !== "terminal")) {
        let rejectAbort!: (reason: unknown) => void;
        const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
        const onAbort = () => rejectAbort(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          await Promise.race([agent.whenIdle(), aborted]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
        signal.throwIfAborted();
        await this.reconcileAgent(agent);
      }
      if (!agentIsIdle(agent)
        || this.foldValue(agent).operations.some(({ state }) => state !== "terminal")) {
        throw new ProtocolError(
          "runtime_busy",
          "Runtime did not reach a quiescent operation boundary",
          true,
        );
      }
      if (this.quiescentMutationValue) {
        throw this.fence(new Error("operation lifecycle mutation boundary was entered recursively"));
      }
      commit();
      this.quiescentMutationValue = true;
      try {
        return await action();
      } finally {
        this.quiescentMutationValue = false;
      }
    });
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
        const content = await this.configValue.inputAuthority.prepare(
          params.input,
          existing.birth,
          control?.signal ?? new AbortController().signal,
        );
        this.assertAdmissionNotCancelled(control);
        control?.commit();
        await this.recoverUndelivered(agent, params, existing, content);
        const recovered = findProductOperation(this.foldValue(agent), params.clientOperationId);
        if (recovered === undefined || recovered.state === "accepted_undelivered") {
          throw this.fence(new Error("exact retry did not durably reconstruct the accepted root message"));
        }
        this.armDurationTimer(agent, recovered);
        return knownResult(recovered);
      }
      this.assertAdmissionNotCancelled(control);
      control?.commit();
      if (existing.state !== "terminal") this.armDurationTimer(agent, existing);
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
    if (birth.limits.maxCostUsd !== undefined && birth.pricing === undefined) {
      throw new ProtocolError(
        "provider_pricing_unavailable",
        "USD cost limits require an authoritative Provider pricing profile",
      );
    }
    const content = await this.configValue.inputAuthority.prepare(
      params.input,
      birth,
      control?.signal ?? new AbortController().signal,
    );
    this.assertOpen();
    this.assertAdmissionNotCancelled(control);
    if (agent !== this.configValue.requireAgent()) {
      throw new ProtocolError("primary_session_replaced", "primary Session changed during input admission");
    }
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
      agent.followup(rootMessage(params, rootMessageId, content));
      await this.flush(agent);
      this.assertOpen();
      const admitted = findProductOperation(this.foldValue(agent), params.clientOperationId);
      if (admitted === undefined) {
        throw new Error("durable operation admission disappeared before duration scheduling");
      }
      this.armDurationTimer(agent, admitted);
    } catch (error) {
      throw this.fence(error);
    }
    return Object.freeze({ state: "accepted", clientOperationId: params.clientOperationId });
  }

  private async steerValue(
    params: MethodParams<"turn/steer">,
    signal = new AbortController().signal,
  ): Promise<MethodResult<"turn/steer">> {
    this.assertOpen();
    this.assertHealthy();
    const agent = this.primaryAgent();
    await this.reconcileAgent(agent);
    const operation = findProductOperation(this.foldValue(agent), params.clientOperationId);
    if (operation?.state !== "active") {
      throw new ProtocolError("turn_not_active", "turn/steer requires the target operation to be active", true);
    }
    if (operation.limit !== undefined) {
      throw new ProtocolError("turn_limit_reached", "turn/steer cannot extend a limited operation");
    }
    const fingerprint = inputFingerprint(params.input);
    const clientMessageId = `steer-${fingerprint.slice(0, 32)}-${String(agent.session.seq)}`;
    const messageId = deterministicId("message", params.clientOperationId, clientMessageId);
    const content = await this.configValue.inputAuthority.prepare(
      params.input,
      operation.birth,
      signal,
    );
    if (agent !== this.configValue.requireAgent()) {
      throw new ProtocolError("primary_session_replaced", "primary Session changed during steering admission");
    }
    try {
      agent.session.append("myagents/operation/message", {
        clientOperationId: operation.clientOperationId,
        messageId,
        kind: "steer",
        clientMessageId,
        state: "queued",
        inputFingerprint: fingerprint,
      });
      agent.steer(continuationMessage(operation, "steer", clientMessageId, messageId, content));
      await this.flush(agent);
    } catch (error) {
      throw this.fence(error);
    }
    return Object.freeze({ ok: true as const });
  }

  private async followUpValue(
    params: MethodParams<"turn/followUp">,
    signal = new AbortController().signal,
  ): Promise<MethodResult<"turn/followUp">> {
    this.assertOpen();
    this.assertHealthy();
    const agent = this.primaryAgent();
    await this.reconcileAgent(agent);
    const operation = findProductOperation(this.foldValue(agent), params.clientOperationId);
    if (operation === undefined || operation.state === "terminal") {
      throw new ProtocolError("turn_not_active", "turn/followUp requires a non-terminal target operation", true);
    }
    if (operation.limit !== undefined) {
      throw new ProtocolError("turn_limit_reached", "turn/followUp cannot extend a limited operation");
    }
    const fingerprint = inputFingerprint(params.input);
    const existing = operation.messages.find(({ messageId }) => messageId === params.messageId);
    if (existing !== undefined) {
      if (existing.kind !== "follow_up" || existing.clientMessageId !== params.messageId
        || existing.inputFingerprint !== fingerprint) {
        throw new ProtocolError(
          "queued_message_id_conflict",
          "follow-up message identity was reused with different immutable input",
        );
      }
      if (existing.state === "cancelled") {
        return Object.freeze({ messageId: params.messageId, state: "cancelled" as const });
      }
      if (existing.delivered) {
        return Object.freeze({
          messageId: params.messageId,
          state: existing.state === "claimed" ? "delivered" as const : "admitted" as const,
        });
      }
    }
    const content = await this.configValue.inputAuthority.prepare(
      params.input,
      operation.birth,
      signal,
    );
    if (agent !== this.configValue.requireAgent()) {
      throw new ProtocolError("primary_session_replaced", "primary Session changed during follow-up admission");
    }
    const current = findProductOperation(this.foldValue(agent), params.clientOperationId);
    if (current === undefined || current.state === "terminal") {
      throw new ProtocolError("turn_not_active", "turn/followUp target settled during input admission", true);
    }
    if (current.limit !== undefined) {
      throw new ProtocolError("turn_limit_reached", "turn/followUp cannot extend a limited operation");
    }
    try {
      if (existing === undefined) {
        agent.session.append("myagents/operation/message", {
          clientOperationId: current.clientOperationId,
          messageId: params.messageId,
          kind: "follow_up",
          clientMessageId: params.messageId,
          state: "queued",
          inputFingerprint: fingerprint,
        });
      }
      agent.followup(continuationMessage(
        current,
        "follow_up",
        params.messageId,
        params.messageId,
        content,
      ));
      const stoppingTurn = current.dshTurns.at(-1);
      const stoppingTurnEnded = stoppingTurn !== undefined && agent.session.events.some(
        (event) => event.type === "turn/end" && event.data.turn === stoppingTurn,
      );
      if (stoppingTurn !== undefined
        && (this.stoppingTurnsValue.has(stoppingTurn) || stoppingTurnEnded)) {
        await this.enforceTurnBoundaryLimits(agent, stoppingTurn);
      }
      await this.flush(agent);
    } catch (error) {
      throw this.fence(error);
    }
    const delivered = findProductOperation(this.foldValue(agent), params.clientOperationId)
      ?.messages.find(({ messageId }) => messageId === params.messageId);
    return Object.freeze({
      messageId: params.messageId,
      state: delivered?.state === "cancelled" ? "cancelled" as const : "admitted" as const,
    });
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
    content: readonly ContentBlock[],
  ): Promise<void> {
    const root = operation.messages[0];
    if (root?.kind !== "root" || root.delivered
      || root.clientMessageId !== params.clientUserMessageId
      || root.messageId !== deterministicId("message", params.clientOperationId, params.clientUserMessageId)) {
      throw this.fence(new Error("accepted-undelivered operation cannot prove exact root reconstruction"));
    }
    try {
      agent.followup(rootMessage(params, root.messageId, content));
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
      this.clearDurationTimer(operation.clientOperationId);
    }
  }

  private async preparePrimaryRetirement(agent: Agent): Promise<void> {
    this.acceptingValue = false;
    if (this.primaryAgentValue !== undefined && this.primaryAgentValue !== agent) {
      throw this.fence(new Error("primary Session retirement changed the operation Agent identity"));
    }
    this.primaryAgentValue = agent;
    this.cancelPendingForRetirement(agent);
    if (!this.quiescentMutationValue) {
      await this.configValue.settlementDeadlineAuthority.wait(
        this.serialValue,
        "primary retirement operation admission drain",
      );
    }
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
      if (terminalAuthority !== undefined) {
        await this.configValue.settlementDeadlineAuthority.wait(
          terminalAuthority.whenIdle(),
          "primary retirement terminal projection drain",
        );
      }
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

  private operationClock(): number {
    const value = this.configValue.clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new TypeError("operation limit clock must return a valid non-negative epoch millisecond");
    }
    return value;
  }

  private appendLimit(
    agent: Agent,
    operation: ProductOperationRecord,
    limit: NonNullable<ProductOperationRecord["limit"]>,
  ): ProductOperationRecord {
    const current = findProductOperation(this.foldValue(agent), operation.clientOperationId);
    if (current === undefined || current.state === "terminal") {
      throw new ProtocolError("turn_not_active", "operation limit target is no longer active", true);
    }
    if (current.limit !== undefined) return current;
    agent.session.append("myagents/operation/limit", limit);
    this.clearDurationTimer(operation.clientOperationId);
    this.queueCorrelationFlush(agent);
    const updated = findProductOperation(this.foldValue(agent), operation.clientOperationId);
    if (updated?.limit === undefined) {
      throw this.fence(new Error("operation limit did not become a durable fold fact"));
    }
    return updated;
  }

  private enforceSynchronousRequestLimits(agent: Agent, operation: ProductOperationRecord): void {
    if (operation.limit !== undefined) {
      throw new ProtocolError("turn_limit_reached", "model request belongs to a limited operation");
    }
    const duration = operation.birth.limits.maxDurationMs;
    const now = this.operationClock();
    const maxTurns = operation.birth.limits.maxTurns;
    if (maxTurns !== undefined && operation.dshTurns.length > maxTurns) {
      this.appendLimit(agent, operation, Object.freeze({
        clientOperationId: operation.clientOperationId,
        kind: "max_turns" as const,
        limit: maxTurns,
        observedAt: now,
      }));
      throw new ProtocolError("operation_max_turns", "operation exceeded its maximum DSH turn count");
    }
    if (duration !== undefined && now - operation.acceptedAt >= duration) {
      this.appendLimit(agent, operation, Object.freeze({
        clientOperationId: operation.clientOperationId,
        kind: "max_duration" as const,
        limitMs: duration,
        observedAt: now,
      }));
      throw new ProtocolError("operation_max_duration", "operation exceeded its maximum duration");
    }
    const budget = operation.birth.limits.maxCostUsd;
    if (budget === undefined) return;
    const accrued = deriveOperationAccruedCostUsd(agent.session.events, operation);
    if (accrued === null) {
      throw this.fence(new Error("priced operation lost its authoritative birth rate card"));
    }
    if (accrued >= budget) {
      this.appendLimit(agent, operation, Object.freeze({
        clientOperationId: operation.clientOperationId,
        kind: "max_budget" as const,
        limitUsd: budget,
        observedAt: now,
      }));
      throw new ProtocolError("operation_max_budget", "operation reached its maximum USD budget");
    }
  }

  private async enforceTurnBoundaryLimits(agent: Agent, turn: number): Promise<void> {
    this.assertHealthy();
    let operation = this.foldValue(agent).operations.find((candidate) =>
      candidate.state !== "terminal" && candidate.dshTurns.includes(turn));
    if (operation === undefined) {
      throw this.fence(new Error("DSH turn-stopping boundary lacks one product-operation owner"));
    }
    if (operation.limit === undefined) {
      const hasPendingContinuation = operation.messages.some((message) =>
        message.delivered && message.state === "queued");
      const budget = operation.birth.limits.maxCostUsd;
      const accrued = deriveOperationAccruedCostUsd(agent.session.events, operation);
      if (budget !== undefined && accrued !== null
        && (accrued > budget || (accrued === budget && hasPendingContinuation))) {
        operation = this.appendLimit(agent, operation, Object.freeze({
          clientOperationId: operation.clientOperationId,
          kind: "max_budget" as const,
          limitUsd: budget,
          observedAt: this.operationClock(),
        }));
      } else {
        const maxTurns = operation.birth.limits.maxTurns;
        if (maxTurns !== undefined && (operation.dshTurns.length > maxTurns
          || (operation.dshTurns.length === maxTurns && hasPendingContinuation))) {
          operation = this.appendLimit(agent, operation, Object.freeze({
            clientOperationId: operation.clientOperationId,
            kind: "max_turns" as const,
            limit: maxTurns,
            observedAt: this.operationClock(),
          }));
        }
      }
    }
    if (operation.limit === undefined) return;
    for (const message of operation.messages) {
      if (message.delivered && message.state === "queued"
        && !this.removePendingMessage(agent, message.messageId, "limit")) {
        throw this.fence(new Error("limited operation lost one pending continuation"));
      }
    }
    await this.correlationDrainValue;
    this.assertHealthy();
  }

  private armDurationTimer(agent: Agent, operation: ProductOperationRecord): void {
    const duration = operation.birth.limits.maxDurationMs;
    if (duration === undefined || operation.state === "terminal" || operation.limit !== undefined
      || this.durationTimersValue.has(operation.clientOperationId)) return;
    const deadline = operation.acceptedAt + duration;
    if (!Number.isSafeInteger(deadline) || deadline > 8_640_000_000_000_000) {
      throw new TypeError("operation duration deadline exceeds the supported epoch range");
    }
    const remaining = deadline - this.operationClock();
    const delay = Math.max(0, Math.min(remaining, 2_147_483_647));
    const timer = setTimeout(() => {
      this.durationTimersValue.delete(operation.clientOperationId);
      if (!this.acceptingValue || this.failureValue !== undefined) return;
      const enforcement = this.serialize(() => this.enforceDurationLimit(
        agent,
        operation.clientOperationId,
        deadline,
      ));
      void enforcement.catch((error: unknown) => { this.fence(error); });
    }, delay);
    timer.unref();
    this.durationTimersValue.set(operation.clientOperationId, timer);
  }

  private async enforceDurationLimit(
    agent: Agent,
    clientOperationId: string,
    deadline: number,
  ): Promise<void> {
    this.assertHealthy();
    let operation = findProductOperation(this.foldValue(agent), clientOperationId);
    if (operation === undefined || operation.state === "terminal" || operation.limit !== undefined) return;
    const now = this.operationClock();
    if (now < deadline) {
      this.armDurationTimer(agent, operation);
      return;
    }
    const duration = operation.birth.limits.maxDurationMs;
    if (duration === undefined) return;
    operation = this.appendLimit(agent, operation, Object.freeze({
      clientOperationId,
      kind: "max_duration" as const,
      limitMs: duration,
      observedAt: now,
    }));
    for (const message of operation.messages) {
      if (message.delivered && message.state === "queued"
        && !this.removePendingMessage(agent, message.messageId, "limit")) {
        throw this.fence(new Error("expired operation lost one pending message"));
      }
    }
    await this.correlationDrainValue;
    this.assertHealthy();
    const openTurn = this.openDshTurn(agent);
    if (openTurn !== undefined && operation.dshTurns.includes(openTurn)) {
      agent.cancel({ kind: "user" }, { keepInbox: true });
      await this.configValue.settlementDeadlineAuthority.wait(
        agent.whenIdle(),
        "operation duration-limit Agent settlement",
      );
    }
    await this.reconcileAgent(agent);
  }

  private clearDurationTimer(clientOperationId: string): void {
    const timer = this.durationTimersValue.get(clientOperationId);
    if (timer !== undefined) clearTimeout(timer);
    this.durationTimersValue.delete(clientOperationId);
  }

  private clearDurationTimers(): void {
    for (const timer of this.durationTimersValue.values()) clearTimeout(timer);
    this.durationTimersValue.clear();
  }

  private async reconcileResumedAgent(agent: Agent): Promise<void> {
    this.assertHealthy();
    if (this.primaryAgentValue !== undefined && this.primaryAgentValue !== agent) {
      throw this.fence(new Error("resumed operation Agent differs from the prepared generation"));
    }
    this.primaryAgentValue = agent;
    const wakePending = (agent as WakePendingAgent).wakePending;
    if (typeof wakePending !== "function" || utilTypes.isProxy(wakePending)) {
      throw this.fence(new Error("accepted DSH Agent.wakePending seam is unavailable"));
    }
    this.foldValue(agent);
    const incomplete = incompleteRecoveryWakes(agent.session.events);
    const wake = async (candidate: IncompleteRecoveryWake, hasIntent: boolean): Promise<void> => {
      if (!hasIntent) {
        agent.session.append("myagents/operation/recovery-wake", {
          ...candidate,
          phase: "intent",
          recordedAt: this.operationClock(),
        });
      }
      const woke = Reflect.apply(wakePending, agent, [MessageId(candidate.messageId)]) as unknown;
      if (typeof woke !== "boolean") {
        throw this.fence(new Error("DSH Agent.wakePending returned an invalid result"));
      }
      agent.session.append("myagents/operation/recovery-wake", {
        ...candidate,
        phase: "completed",
        recordedAt: this.operationClock(),
      });
      await this.flush(agent);
      if (!woke && [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
        .some(({ id }) => id === candidate.messageId)) {
        throw this.fence(new Error("DSH Agent.wakePending refused an identity that remains pending"));
      }
    };
    for (const candidate of incomplete.values()) await wake(candidate, true);
    const wokenMessageIds = new Set(incomplete.keys());

    let fold = this.foldValue(agent);
    for (const operation of fold.operations) {
      if (operation.state === "terminal" || operation.limit !== undefined) continue;
      const duration = operation.birth.limits.maxDurationMs;
      if (duration !== undefined && this.operationClock() - operation.acceptedAt >= duration) {
        await this.enforceDurationLimit(
          agent,
          operation.clientOperationId,
          operation.acceptedAt + duration,
        );
      }
    }
    fold = this.foldValue(agent);
    for (const operation of fold.operations) {
      if (operation.state === "terminal" || operation.limit !== undefined
        || !operation.messages.some((message) => message.delivered && message.state === "queued")) continue;
      const finalTurn = operation.dshTurns.at(-1);
      if (finalTurn !== undefined) await this.enforceTurnBoundaryLimits(agent, finalTurn);
    }

    for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (wokenMessageIds.has(message.id)) continue;
      const source = readOperationMessageSource(message.source);
      if (source === undefined) continue;
      const operation = findProductOperation(this.foldValue(agent), source.clientOperationId);
      const owned = operation?.messages.find(({ messageId }) => messageId === message.id);
      if (operation === undefined || operation.state === "terminal" || operation.limit !== undefined
        || owned?.delivered !== true || owned.state !== "queued") {
        throw this.fence(new Error("resumed pending Inbox message lacks active operation ownership"));
      }
      await wake(Object.freeze({
        attemptId: `recovery-wake-${createHash("sha256").update(stableJson([
          operation.clientOperationId,
          message.id,
          agent.session.seq,
        ])).digest("hex").slice(0, 40)}`,
        clientOperationId: operation.clientOperationId,
        messageId: message.id,
      }), false);
    }
    await this.reconcileAgent(agent);
    for (const operation of this.foldValue(agent).operations) {
      if (operation.state !== "terminal") this.armDurationTimer(agent, operation);
    }
  }

  private removePendingMessage(
    agent: Agent,
    messageId: string,
    reason: "user" | "host_shutdown" | "session_replaced" | "limit",
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

  validatePersisted(agent: Agent): ProductOperationFold {
    this.assertHealthy();
    return this.foldValue(agent);
  }

  prepareGenerationReplacement(agent: Agent): void {
    this.assertHealthy();
    const previous = this.primaryAgentValue;
    if (previous === undefined) return;
    if (previous === agent || this.ctx.agents.get(previous.id) === previous
      || this.acceptingValue || this.cancellationReasonsValue.size !== 0
      || this.pendingRequestContextSeqs.size !== 0) {
      throw this.fence(new Error("product-operation generation replacement is not quiescent"));
    }
    this.primaryAgentValue = undefined;
    this.clearDurationTimers();
    this.stoppingTurnsValue.clear();
    this.acceptingValue = true;
    this.correlationDrainValue = Promise.resolve();
    this.serialValue = Promise.resolve();
    this.retirementEscalationValue = undefined;
    this.nextModelRequestValue = 1;
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
