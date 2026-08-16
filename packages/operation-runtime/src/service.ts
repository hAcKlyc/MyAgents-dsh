import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { freezeMessage, MessageId, type ContentBlock, type UserMessage } from "@deepseek-ai/dsh-llm";
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

declare module "@deepseek-ai/cordis" {
  interface Context {
    sdkOperations: SdkOperationService;
  }
}

export interface OperationBirthAuthority {
  capture(params: MethodParams<"turn/start">): OperationBirthSnapshot | Promise<OperationBirthSnapshot>;
}

export interface SdkOperationServiceConfig {
  readonly birthAuthority: OperationBirthAuthority;
  readonly registerRetirementGuard: (guard: (agent: Agent) => Promise<void>) => void;
  readonly requireAgent: () => Agent;
  readonly retirePrimary: () => Promise<void>;
  readonly clock?: () => number;
}

export interface SdkOperationSnapshot {
  readonly recoveryRequired: boolean;
  readonly operations: readonly ProductOperationRecord[];
}

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

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
    ["birthAuthority", "registerRetirementGuard", "requireAgent", "retirePrimary"],
    ["clock"],
    "SdkOperationService config",
  );
  const authority = exactOwnDataObject(
    config.birthAuthority,
    ["capture"],
    [],
    "operation birth authority",
  );
  if (typeof authority.capture !== "function" || typeof config.requireAgent !== "function"
    || typeof config.registerRetirementGuard !== "function"
    || typeof config.retirePrimary !== "function"
    || (Object.hasOwn(config, "clock") && typeof config.clock !== "function")) {
    throw new TypeError("SdkOperationService capabilities must be functions");
  }
  const captureOperationBirth = authority.capture as OperationBirthAuthority["capture"];
  const operationBirthReceiver = config.birthAuthority;
  const registerRetirementGuard = config.registerRetirementGuard as
    (guard: (agent: Agent) => Promise<void>) => void;
  const retirePrimary = config.retirePrimary as () => Promise<void>;
  return Object.freeze({
    birthAuthority: Object.freeze({
      capture: (params: MethodParams<"turn/start">) =>
        Reflect.apply(captureOperationBirth, operationBirthReceiver, [params]),
    }),
    registerRetirementGuard: (guard: (agent: Agent) => Promise<void>) =>
      Reflect.apply(registerRetirementGuard, config, [guard]),
    requireAgent: config.requireAgent as () => Agent,
    retirePrimary: () => Reflect.apply(retirePrimary, config, []),
    clock: (config.clock ?? Date.now) as () => number,
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
  private correlationDrainValue: Promise<void> = Promise.resolve();
  private failureValue: ProtocolError | undefined;
  private primaryAgentValue: Agent | undefined;
  private serialValue: Promise<void> = Promise.resolve();

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
            throw new Error("official root Agent claimed unowned product-operation work");
          }
          const fold = foldProductOperationsForLiveClaim(agent.session.events, {
            messageId: message.id,
            dshTurn: turn,
          });
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
            throw new Error("official root Agent discarded unowned product-operation work");
          }
          const fold = foldProductOperationsForLiveDiscard(agent.session.events, {
            messageId: message.id,
          });
          const operation = findProductOperation(fold, source.clientOperationId);
          const ownedMessage = operation?.messages.find(({ messageId }) => messageId === message.id);
          if (operation === undefined || ownedMessage?.clientMessageId !== source.clientMessageId
            || ownedMessage.state !== "queued" || !ownedMessage.delivered) {
            throw new Error("discarded operation message differs from durable ownership");
          }
          agent.session.append("myagents/operation/message", {
            clientOperationId: source.clientOperationId,
            messageId: message.id,
            kind: ownedMessage.kind,
            clientMessageId: source.clientMessageId,
            state: "cancelled",
          });
          this.queueCorrelationFlush(agent);
        } catch (error) {
          this.fence(error);
          throw error;
        }
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

  lookup(clientOperationId: string): ProductOperationRecord | undefined {
    this.assertOpen();
    if (typeof clientOperationId !== "string" || clientOperationId.length === 0
      || clientOperationId.length > 256) {
      throw new ProtocolError("turn_operation_invalid", "client operation identity is invalid");
    }
    return findProductOperation(this.foldValue(this.primaryAgent()), clientOperationId);
  }

  start(value: unknown): Promise<MethodResult<"turn/start">> {
    this.assertOpen();
    const params = validateMethodParams("turn/start", value);
    return this.serialize(() => this.startValue(params));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.serialValue.then(task);
    this.serialValue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async startValue(params: MethodParams<"turn/start">): Promise<MethodResult<"turn/start">> {
    this.assertOpen();
    this.assertHealthy();
    const agent = this.primaryAgent();
    const fold = this.foldValue(agent);
    const existing = findProductOperation(fold, params.clientOperationId);
    if (existing !== undefined) {
      if (operationFingerprint(params, existing.birth) !== existing.fingerprint) {
        throw new ProtocolError(
          "turn_idempotency_conflict",
          "clientOperationId was reused with different immutable input",
        );
      }
      if (existing.state === "accepted_undelivered") {
        await this.recoverUndelivered(agent, params, existing);
        const recovered = findProductOperation(this.foldValue(agent), params.clientOperationId);
        if (recovered === undefined || recovered.state === "accepted_undelivered") {
          throw this.fence(new Error("exact retry did not durably reconstruct the accepted root message"));
        }
        return knownResult(recovered);
      }
      return knownResult(existing);
    }

    const captured = await this.configValue.birthAuthority.capture(params);
    this.assertOpen();
    if (agent !== this.configValue.requireAgent()) {
      throw new ProtocolError("primary_session_replaced", "primary Session changed during operation admission");
    }
    const birth = validateOperationBirthSnapshot(captured);
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
      agent.followup(rootMessage(params, rootMessageId));
      await this.flush(agent);
      this.assertOpen();
    } catch (error) {
      throw this.fence(error);
    }
    return Object.freeze({ state: "accepted", clientOperationId: params.clientOperationId });
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
    if (!await this.ctx.sessions.flush(agent.session)) {
      throw new Error("no Session durability Provider participated in the operation flush");
    }
  }

  private primaryAgent(): Agent {
    this.primaryAgentValue ??= this.configValue.requireAgent();
    return this.primaryAgentValue;
  }

  private async preparePrimaryRetirement(agent: Agent): Promise<void> {
    this.acceptingValue = false;
    if (this.primaryAgentValue !== undefined && this.primaryAgentValue !== agent) {
      throw this.fence(new Error("primary Session retirement changed the operation Agent identity"));
    }
    this.primaryAgentValue = agent;
    this.cancelPendingForRetirement(agent);
    await this.serialValue;
    this.assertHealthy();
    this.cancelPendingForRetirement(agent);
    await this.correlationDrainValue;
    this.assertHealthy();
  }

  private cancelPendingForRetirement(agent: Agent): void {
    const fold = this.foldValue(agent);
    let directCancellationAppended = false;
    for (const operation of fold.operations) {
      for (const message of operation.messages) {
        if (!message.delivered || message.state !== "queued") continue;
        if (!agent.inbox.remove(MessageId(message.messageId))) {
          throw this.fence(new Error("quiescent primary retirement lost one pending operation message"));
        }
        const updated = findProductOperation(
          foldProductOperationsForLiveDiscard(agent.session.events, { messageId: message.messageId }),
          operation.clientOperationId,
        )?.messages.find(({ messageId }) => messageId === message.messageId);
        if (updated?.state !== "cancelled") {
          agent.session.append("myagents/operation/message", {
            clientOperationId: operation.clientOperationId,
            messageId: message.messageId,
            kind: message.kind,
            clientMessageId: message.clientMessageId,
            state: "cancelled",
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

  private foldValue(agent: Agent): ProductOperationFold {
    try {
      return foldProductOperations(agent.session.events);
    } catch (error) {
      throw this.fence(error);
    }
  }

  private assertHealthy(): void {
    if (this.failureValue !== undefined) throw this.failureValue;
  }

  private assertOpen(): void {
    if (!this.acceptingValue) {
      throw new ProtocolError("protocol_closed", "product-operation admission is closing or disposed");
    }
  }

  private fence(cause: unknown): ProtocolError {
    this.failureValue ??= recoveryError(cause);
    return this.failureValue;
  }
}
