import { RuntimeEventEnvelopeSchema } from "@myagents-dsh/protocol";
import { Type, type Static, type TSchema } from "typebox";

export const WEB_HOST_CONTRACT_VERSION = "1.0.0-draft.1" as const;
export const MAX_BROWSER_BODY_BYTES = 1_048_576;
export const MAX_SSE_EVENT_BYTES = 1_048_576;
export const MAX_WEB_SESSIONS = 128;
export const MAX_ACTIVE_RUNTIME_CHILDREN = 4;

const strictObject = <T extends Readonly<Record<string, TSchema>>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
});
const shortText = Type.String({ maxLength: 4_096 });
const title = Type.String({ minLength: 1, maxLength: 160 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const dateTime = Type.String({ format: "date-time" });
const emptyPayload = strictObject({});
const webSessionId = identifier;
const optionalSelectedSession = { webSessionId: Type.Optional(webSessionId) } as const;

export const JsonValueSchema = Type.Cyclic({
  JsonValue: Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Type.Ref("JsonValue"), { maxItems: 20_000 }),
    Type.Record(
      Type.String(),
      Type.Ref("JsonValue"),
      {
        maxProperties: 20_000,
        propertyNames: { type: "string", minLength: 1, maxLength: 4_096 },
      },
    ),
  ]),
}, "JsonValue");

export const WebSessionLifecycleSchema = Type.Union([
  Type.Literal("cold"),
  Type.Literal("starting"),
  Type.Literal("initializing"),
  Type.Literal("ready"),
  Type.Literal("stopping"),
  Type.Literal("recovery_required"),
  Type.Literal("fatal"),
]);

export const WebSessionSummarySchema = strictObject({
  webSessionId,
  title,
  lifecycle: WebSessionLifecycleSchema,
  createdAt: dateTime,
  updatedAt: dateTime,
  lastOpenedAt: dateTime,
  runtimeSessionId: Type.Optional(identifier),
  failureCode: Type.Optional(identifier),
});

export const DiagnosticSchema = strictObject({
  code: identifier,
  level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
  message: shortText,
  retryable: Type.Optional(Type.Boolean()),
});

export const OpenInteractionSchema = strictObject({
  interactionId: identifier,
  webSessionId,
  kind: Type.Union([
    Type.Literal("permission"),
    Type.Literal("ask_user"),
    Type.Literal("plan_approval"),
  ]),
  schema: JsonValueSchema,
  permissionAction: Type.Optional(identifier),
  desiredPolicyRevision: identifier,
  scenario: identifier,
  openedAt: dateTime,
  deadlineAt: Type.Optional(dateTime),
});

export const AttachmentSummarySchema = strictObject({
  attachmentId: identifier,
  name: Type.String({ minLength: 1, maxLength: 512 }),
  mimeType: Type.String({ minLength: 1, maxLength: 256 }),
  sizeBytes: Type.Integer({ minimum: 0, maximum: 52_428_800 }),
  sha256,
  state: Type.Union([
    Type.Literal("staged"),
    Type.Literal("leased"),
    Type.Literal("released"),
    Type.Literal("failed"),
  ]),
});

export const RuntimeProjectionSchema = strictObject({
  webSessionId,
  runtimeGeneration: Type.Optional(identifier),
  runtimeSessionId: Type.Optional(identifier),
  desiredConfigRevision: Type.Optional(identifier),
  effectiveConfigRevision: Type.Optional(identifier),
  events: Type.Array(RuntimeEventEnvelopeSchema, { maxItems: 2_000 }),
  historyCursor: Type.Optional(identifier),
  activeOperationIds: Type.Array(identifier, { maxItems: 1_024, uniqueItems: true }),
  openInteractions: Type.Array(OpenInteractionSchema, { maxItems: 128 }),
  attachments: Type.Array(AttachmentSummarySchema, { maxItems: 256 }),
  diagnostics: Type.Array(DiagnosticSchema, { maxItems: 256 }),
});

export const HostSnapshotSchema = strictObject({
  sessions: Type.Array(WebSessionSummarySchema, { maxItems: MAX_WEB_SESSIONS }),
  selectedWebSessionId: Type.Optional(webSessionId),
  projection: Type.Optional(RuntimeProjectionSchema),
});

export const BootstrapSchema = strictObject({
  contractVersion: Type.Literal(WEB_HOST_CONTRACT_VERSION),
  hostVersion: identifier,
  csrfToken: Type.String({ minLength: 32, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" }),
  workspace: strictObject({
    identity: identifier,
    displayName: title,
    canonicalRoot: Type.String({ minLength: 1, maxLength: 8_192 }),
  }),
  platform: strictObject({
    os: Type.Union([Type.Literal("darwin"), Type.Literal("win32"), Type.Literal("linux")]),
    arch: Type.Union([Type.Literal("arm64"), Type.Literal("x64")]),
    validation: Type.Union([
      Type.Literal("verified"),
      Type.Literal("implementation-complete_pending-native-validation"),
    ]),
  }),
  limits: strictObject({
    maxActiveRuntimeChildren: Type.Literal(MAX_ACTIVE_RUNTIME_CHILDREN),
    maxWebSessions: Type.Literal(MAX_WEB_SESSIONS),
    maxUploadBytes: Type.Integer({ minimum: 1, maximum: 52_428_800 }),
    maxSseEventBytes: Type.Literal(MAX_SSE_EVENT_BYTES),
  }),
  snapshot: HostSnapshotSchema,
});

const commandBase = <Kind extends string, Payload extends TSchema>(
  kind: Kind,
  payload: Payload,
  _session: "required",
) => {
  void _session;
  return strictObject({
    commandId: identifier,
    kind: Type.Literal(kind),
    webSessionId,
    payload,
  });
};
const hostCommand = <Kind extends string, Payload extends TSchema>(kind: Kind, payload: Payload) =>
  strictObject({ commandId: identifier, kind: Type.Literal(kind), payload });
const optionalSessionCommand = <Kind extends string, Payload extends TSchema>(
  kind: Kind,
  payload: Payload,
) => strictObject({ commandId: identifier, kind: Type.Literal(kind), ...optionalSelectedSession, payload });

const operationId = strictObject({ clientOperationId: identifier });
const mutationKind = Type.Union([
  Type.Literal("delete"),
  Type.Literal("fork"),
  Type.Literal("rewind"),
]);

export const BrowserCommandSchema = Type.Union([
  hostCommand("session.create", strictObject({ title: Type.Optional(title) })),
  commandBase("session.select", emptyPayload, "required"),
  commandBase("session.rename", strictObject({ title }), "required"),
  commandBase("session.coldStop", emptyPayload, "required"),
  commandBase("session.close", emptyPayload, "required"),
  commandBase("runtime.status", emptyPayload, "required"),
  commandBase("runtime.restart", strictObject({ reason: Type.Optional(identifier) }), "required"),
  commandBase("runtime.shutdown", strictObject({ reason: Type.Optional(identifier) }), "required"),
  commandBase("history.read", strictObject({ cursor: Type.Optional(identifier) }), "required"),
  commandBase("session.compact", operationId, "required"),
  commandBase("turn.start", strictObject({
    clientOperationId: identifier,
    clientUserMessageId: identifier,
    text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    attachmentIds: Type.Array(identifier, { maxItems: 32, uniqueItems: true }),
  }), "required"),
  commandBase("turn.steer", strictObject({
    clientOperationId: identifier,
    text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  }), "required"),
  commandBase("turn.followUp", strictObject({
    clientOperationId: identifier,
    messageId: identifier,
    text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    attachmentIds: Type.Array(identifier, { maxItems: 32, uniqueItems: true }),
  }), "required"),
  commandBase("turn.cancelQueued", strictObject({
    clientOperationId: identifier,
    messageId: identifier,
  }), "required"),
  commandBase("turn.interrupt", strictObject({
    clientOperationId: identifier,
    cancelQueued: Type.Boolean(),
  }), "required"),
  commandBase("command.invoke", strictObject({
    clientOperationId: identifier,
    clientUserMessageId: identifier,
    commandId: identifier,
    arguments: Type.Array(shortText, { maxItems: 256 }),
  }), "required"),
  commandBase("config.apply", strictObject({
    revision: identifier,
    providerRouteId: identifier,
    modelId: identifier,
    reasoningEffort: Type.Optional(Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ])),
    permissionMode: identifier,
    interactionScenario: identifier,
    visibleTools: Type.Optional(Type.Array(identifier, { maxItems: 512, uniqueItems: true })),
  }), "required"),
  commandBase("components.inspect", emptyPayload, "required"),
  commandBase("components.replace", strictObject({
    revision: identifier,
    expectedDigest: Type.Optional(sha256),
    components: Type.Array(strictObject({
      id: identifier,
      kind: Type.Union([
        Type.Literal("mcp"),
        Type.Literal("skill"),
        Type.Literal("agent"),
        Type.Literal("command"),
        Type.Literal("hook"),
        Type.Literal("host_tool"),
      ]),
      enabled: Type.Boolean(),
      configuration: JsonValueSchema,
    }), { maxItems: 2_048 }),
  }), "required"),
  commandBase("components.reload", operationId, "required"),
  commandBase("mutation.prepare", strictObject({
    mutation: mutationKind,
    clientMutationId: identifier,
    stableBoundaryId: Type.Optional(identifier),
    sourceTranscriptPostcondition: Type.Optional(sha256),
    targetTranscriptPostcondition: Type.Optional(sha256),
    forkTitle: Type.Optional(title),
  }), "required"),
  commandBase("mutation.commit", strictObject({
    mutation: mutationKind,
    token: identifier,
    confirmation: Type.String({ minLength: 1, maxLength: 256 }),
  }), "required"),
  commandBase("mutation.rollback", strictObject({ mutation: mutationKind, token: identifier }), "required"),
  commandBase("mutation.status", strictObject({ mutation: mutationKind, token: identifier }), "required"),
  commandBase("mutation.purge", strictObject({
    mutation: Type.Literal("delete"),
    token: identifier,
    confirmation: Type.String({ minLength: 1, maxLength: 256 }),
  }), "required"),
  optionalSessionCommand("utility.run", strictObject({
    clientOperationId: identifier,
    prompt: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    maxTokens: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  })),
]);

export const InteractionResponseSchema = strictObject({
  interactionId: identifier,
  expectedRevision: identifier,
  decision: Type.Union([
    Type.Literal("deny"),
    Type.Literal("allow_once"),
    Type.Literal("always_allow"),
    Type.Literal("answered"),
    Type.Literal("cancelled"),
  ]),
  value: Type.Optional(JsonValueSchema),
});

const eventBase = <Kind extends string, Payload extends TSchema>(kind: Kind, payload: Payload) =>
  strictObject({
    epoch: identifier,
    sequence: Type.Integer({ minimum: 1 }),
    emittedAt: dateTime,
    kind: Type.Literal(kind),
    payload,
  });

export const HostEventSchema = Type.Union([
  eventBase("host.snapshot", HostSnapshotSchema),
  eventBase("host.sessionChanged", WebSessionSummarySchema),
  eventBase("host.commandSettled", strictObject({
    commandId: identifier,
    webSessionId: Type.Optional(webSessionId),
    state: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
    result: Type.Optional(JsonValueSchema),
    error: Type.Optional(strictObject({
      code: identifier,
      message: shortText,
      retryable: Type.Boolean(),
    })),
  })),
  eventBase("host.interactionOpened", OpenInteractionSchema),
  eventBase("host.interactionClosed", strictObject({ interactionId: identifier, webSessionId })),
  eventBase("host.attachmentChanged", strictObject({ webSessionId, attachment: AttachmentSummarySchema })),
  eventBase("runtime.event", strictObject({ webSessionId, event: RuntimeEventEnvelopeSchema })),
  eventBase("runtime.stateChanged", strictObject({
    webSessionId,
    lifecycle: WebSessionLifecycleSchema,
    runtimeGeneration: Type.Optional(identifier),
  })),
  eventBase("runtime.fatal", strictObject({ webSessionId, diagnostic: DiagnosticSchema })),
  eventBase("host.resyncRequired", strictObject({ reason: identifier })),
]);

export const CommandAcceptedSchema = strictObject({
  commandId: identifier,
  accepted: Type.Literal(true),
});

export const InteractionAcceptedSchema = strictObject({
  interactionId: identifier,
  accepted: Type.Literal(true),
});

export const HealthSchema = strictObject({
  ready: Type.Boolean(),
  contractVersion: Type.Literal(WEB_HOST_CONTRACT_VERSION),
});

export type AttachmentSummary = Static<typeof AttachmentSummarySchema>;
export type Bootstrap = Static<typeof BootstrapSchema>;
export type BrowserCommand = Static<typeof BrowserCommandSchema>;
export type CommandAccepted = Static<typeof CommandAcceptedSchema>;
export type Diagnostic = Static<typeof DiagnosticSchema>;
export type Health = Static<typeof HealthSchema>;
export type HostEvent = Static<typeof HostEventSchema>;
export type HostSnapshot = Static<typeof HostSnapshotSchema>;
export type InteractionAccepted = Static<typeof InteractionAcceptedSchema>;
export type InteractionResponse = Static<typeof InteractionResponseSchema>;
export type OpenInteraction = Static<typeof OpenInteractionSchema>;
export type RuntimeProjection = Static<typeof RuntimeProjectionSchema>;
export type WebSessionLifecycle = Static<typeof WebSessionLifecycleSchema>;
export type WebSessionSummary = Static<typeof WebSessionSummarySchema>;
