import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  SessionReadAssembler,
  type MethodParams,
} from "@myagents-dsh/protocol";
import { launchArtifactRuntime } from "@myagents-dsh/test-host";

import { inspectDynamicArtifact, type DynamicArtifactIdentity } from "./artifact.js";
import {
  dynamicCheckerAuthoritySha256,
  dynamicFixtureManifestSha256,
  evaluateDynamicScenarioPostconditions,
} from "./checker.js";
import type { ApprovedDynamicRoute } from "./credential.js";
import { DynamicEvidenceRecorder, sealDynamicEvidence, type SealedEvidenceIdentity } from "./evidence.js";
import { DynamicArtifactHostProcess } from "./host.js";
import type { EvidenceRedactionPolicy } from "./redaction.js";
import type { DynamicScenario } from "./scenario.js";
import {
  assertRunTreesSecretFree,
  createDynamicRunWorkspace,
  snapshotWorkspaceManifest,
  type DynamicRunWorkspace,
} from "./workspace.js";

export interface DynamicDriverResult {
  readonly outcome: "passed" | "failed" | "unavailable";
  readonly reasonCode?: string;
  readonly publicEvents: readonly unknown[];
  readonly diagnosticFacts: readonly unknown[];
  readonly hardAssertions: unknown;
  readonly resourceFinal: unknown;
}

export interface DynamicRunDriver {
  readonly kind: "artifact-lifecycle-probe" | "approved-route" | "fixture";
  execute(input: Readonly<{
    artifact: DynamicArtifactIdentity;
    scenario: DynamicScenario;
    workspace: DynamicRunWorkspace;
    evidence: DynamicEvidenceRecorder;
    signal: AbortSignal;
  }>): Promise<DynamicDriverResult>;
}

export interface DynamicRunResult {
  readonly runId: string;
  readonly scenarioId: string;
  readonly outcome: DynamicDriverResult["outcome"];
  readonly reasonCode?: string;
  readonly artifact: DynamicArtifactIdentity;
  readonly evidence: SealedEvidenceIdentity;
  readonly runRoot: string;
}

const sha256Text = (text: string): string => createHash("sha256").update(text).digest("hex");

const compactionPressurePrompt = (prompt: string, operation: number): string => {
  const records = Array.from({ length: 320 }, (_, index) => {
    const identity = createHash("sha256")
      .update(`compaction-pressure-v1\0${String(operation)}\0${String(index)}`)
      .digest("hex")
      .slice(0, 20);
    return `pressure-record-${String(operation)}-${String(index)}=${identity}`;
  });
  return [
    prompt,
    "",
    "Synthetic non-secret context-pressure appendix. It is test ballast, not task state; do not repeat it.",
    ...records,
  ].join("\n");
};

const messageText = (data: unknown): string => {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return "";
  const message = (data as { message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return [];
    const candidate = block as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  }).join("\n");
};

export const createScriptedQuestionAnswer = (
  params: MethodParams<"host/interaction/request">,
): Readonly<{ answers: readonly Readonly<{ id: string; selected: readonly string[]; custom?: string }>[] }> => {
  if (params.kind !== "ask_user" && params.kind !== "plan_approval") {
    throw new TypeError("scripted question answer requires a question interaction");
  }
  const schema = params.schema;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("scripted question interaction schema must be an object");
  }
  const questions = (schema as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 64) {
    throw new TypeError("scripted question interaction must contain bounded questions");
  }
  return Object.freeze({
    answers: Object.freeze(questions.map((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("scripted question item must be an object");
      }
      const question = candidate as {
        id?: unknown;
        intent?: unknown;
        options?: unknown;
      };
      if (typeof question.id !== "string") throw new TypeError("scripted question id is invalid");
      const options = Array.isArray(question.options) ? question.options : [];
      const labels = options.flatMap((option) => {
        if (option === null || typeof option !== "object" || Array.isArray(option)) return [];
        const label = (option as { label?: unknown }).label;
        return typeof label === "string" ? [label] : [];
      });
      const intent = question.intent !== null && typeof question.intent === "object"
        && !Array.isArray(question.intent)
        ? question.intent as { kind?: unknown; approve?: unknown }
        : undefined;
      const desired = intent?.kind === "plan-review" && typeof intent.approve === "string"
        ? intent.approve
        : labels.includes("stable") ? "stable" : labels[0];
      if (desired !== undefined && labels.includes(desired)) {
        return Object.freeze({ id: question.id, selected: Object.freeze([desired]) });
      }
      return Object.freeze({ id: question.id, selected: Object.freeze([]), custom: "stable" });
    })),
  });
};

const platformTarget = (): "darwin-arm64" | "win32-x64" | "linux-x64" => {
  const identity = `${process.platform}-${process.arch}`;
  if (identity === "darwin-arm64" || identity === "win32-x64" || identity === "linux-x64") return identity;
  throw new Error(`dynamic E2E is not implemented for ${identity}`);
};

const createInitializeParams = (
  workspace: DynamicRunWorkspace,
  target: ReturnType<typeof platformTarget>,
  options?: Readonly<{
    networkPolicyRef: string;
    webSearchAdapters: readonly string[];
    permitNetwork: boolean;
    permitBackground: boolean;
    maxChildren: number;
  }>,
): MethodParams<"initialize"> => {
  const platform = target === "win32-x64" ? "win32" : target === "linux-x64" ? "linux" : "darwin";
  const arch = target === "darwin-arm64" ? "arm64" : "x64";
  const executionDigest = sha256Text([
    workspace.workspace,
    workspace.runtimeHome,
    workspace.attachmentRoot,
    target,
  ].join("\0"));
  return {
    protocol: { minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION },
    host: {
      name: "dynamic-e2e-standard-test-host",
      version: "1.0.0",
      platform,
      arch,
      nodeVersion: globalThis.process.versions.node,
    },
    productSessionId: `dynamic-${workspace.runId}`,
    runtimeHome: workspace.runtimeHome,
    workspace: { path: workspace.workspace, identity: `workspace-${workspace.runId}` },
    executionEnvironment: {
      revision: "dynamic-environment-v1",
      digest: executionDigest,
      workspace: {
        identity: `workspace-${workspace.runId}`,
        canonicalRoot: workspace.workspace,
        allowedReadRoots: [workspace.workspace],
        allowedWriteRoots: [workspace.workspace],
      },
      executables: {
        bundledNodeRef: "bundled-node",
        bashRef: "bundled-bash",
        ripgrepRef: "bundled-ripgrep",
        ...(target === "win32-x64" ? {
          windowsPowerShellRef: "bundled-powershell",
          windowsUtf8PreludeRef: "windows-utf8-v1",
        } : {}),
        bashDialect: "bash",
        allowedCommandRefs: target === "win32-x64"
          ? ["bundled-bash", "bundled-node", "bundled-powershell", "bundled-ripgrep"]
          : ["bundled-bash", "bundled-node", "bundled-ripgrep"],
        pathPolicy: "sealed",
      },
      environment: { allowedKeys: [], inheritedKeys: [], secretValues: "reverse-port-only" },
      network: options?.permitNetwork === true
        ? { mode: "host-policy", policyRef: options.networkPolicyRef }
        : { mode: "deny" },
      process: {
        backgroundRetention: options?.permitBackground === true ? "allow" : "deny",
        maxChildren: options?.maxChildren ?? 1,
        killTreeOnAbort: true,
      },
      checkpoint: {
        mode: "managed-file-tools",
        version: 1,
        policyRevision: "dynamic-checkpoint-v1",
        trackedTools: ["Write", "Edit"],
        tracksShell: false,
        tracksChildAgents: false,
        tracksExternalChanges: false,
      },
      attachmentStagingRoot: workspace.attachmentRoot,
    },
    hostCapabilities: {
      interaction: "deterministic-headless",
      attachments: "generation-leases-v1",
      productProjection: "transactional-postconditions-v1",
      credentialAuthority: "revisioned-reverse-port-v1",
      webSearchAdapters: [...(options?.webSearchAdapters ?? [])],
    },
    limits: REFERENCE_PROTOCOL_LIMITS,
  };
};

export class ArtifactLifecycleProbeDriver implements DynamicRunDriver {
  readonly kind = "artifact-lifecycle-probe" as const;
  readonly #reasonCode: "real_provider_route_not_selected" | "real_provider_credential_unavailable";
  readonly #routeIdentity: Readonly<{
    routeConfigSha256: string;
    providerRouteId: string;
    modelId: string;
  }> | undefined;

  constructor(options?: Readonly<{
    reasonCode: "real_provider_credential_unavailable";
    routeIdentity: Readonly<{
      routeConfigSha256: string;
      providerRouteId: string;
      modelId: string;
    }>;
  }>) {
    this.#reasonCode = options?.reasonCode ?? "real_provider_route_not_selected";
    this.#routeIdentity = options?.routeIdentity;
  }

  async execute(input: Parameters<DynamicRunDriver["execute"]>[0]): Promise<DynamicDriverResult> {
    const target = platformTarget();
    const runtime = launchArtifactRuntime({
      nodeExecutable: globalThis.process.execPath,
      artifactEntrypoint: input.artifact.entrypoint,
      cwd: input.workspace.workspace,
      environment: Object.freeze({
        PATH: globalThis.process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: input.workspace.temporaryRoot,
      }),
    });
    const recordRuntimeEvent = (event: unknown): void => {
      input.evidence.recordPublicEvent(event);
    };
    const stopNotifications = runtime.client.registerRuntimeNotificationHandlers({
      "runtime/event": recordRuntimeEvent,
      "host/interaction/cancel": (event) => { recordRuntimeEvent({ kind: "host_interaction_cancel", event }); },
    });
    try {
      const initialized = await runtime.client.initialize(createInitializeParams(input.workspace, target), {
        signal: input.signal,
      });
      await runtime.client.initialized();
      const status = await runtime.client.runtimeStatus({}, { signal: input.signal });
      input.evidence.recordPublicEvent({ kind: "initialize", runtimeGeneration: initialized.runtimeGeneration });
      input.evidence.recordPublicEvent({ kind: "runtime_status", initialized: status.initialized });
      await runtime.client.runtimeShutdown({ reason: "dynamic-harness-probe" }, { signal: input.signal });
      const exit = await runtime.waitForExit(30_000);
      const expectedTransportClosures = new Set([
        "protocol_eof", "protocol_input_closed", "protocol_output_closed",
      ]);
      const hostFatalCodes = runtime.hostFatalErrors.map(({ code }) => code);
      const unexpectedHostFatalCodes = hostFatalCodes.filter((code) => !expectedTransportClosures.has(code));
      return Object.freeze({
        outcome: "unavailable" as const,
        reasonCode: this.#reasonCode,
        publicEvents: Object.freeze([]),
        diagnosticFacts: Object.freeze([{
          kind: "artifact_lifecycle_probe",
          artifactManifestSha256: input.artifact.manifestSha256,
          runtimeGeneration: initialized.runtimeGeneration,
          profileDigest: initialized.profileDigest,
          schemaSha256: initialized.schemaSha256,
          hostFatalCodes,
          exit,
          unavailableReasonCode: this.#reasonCode,
          ...(this.#routeIdentity === undefined ? {} : { routeIdentity: this.#routeIdentity }),
        }]),
        hardAssertions: Object.freeze({
          artifactIdentityMatched: initialized.runtimeEngine.buildRevision === input.artifact.dshManifestSha256,
          generatedClientSchemaMatched: initialized.schemaSha256 === input.artifact.protocolSha256,
          scenarioExecuted: false,
          unavailableEvidenceIsNotPass: true,
        }),
        resourceFinal: Object.freeze({
          runtimeProcess: exit.code === 0 ? "exited" : "failed",
          expectedTransportClosures: hostFatalCodes.length - unexpectedHostFatalCodes.length,
          unexpectedHostFatalErrors: unexpectedHostFatalCodes.length,
          attachmentLeases: 0,
          credentialScopes: 0,
          unsealedWriters: 0,
        }),
      });
    } finally {
      stopNotifications();
      await runtime.close();
    }
  }
}

const waitForOperationTerminal = async (
  client: DynamicArtifactHostProcess["client"],
  clientOperationId: string,
  signal: AbortSignal,
): Promise<NonNullable<Awaited<ReturnType<typeof client.turnGet>>["terminal"]>> => {
  for (;;) {
    signal.throwIfAborted();
    const state = await client.turnGet({ clientOperationId }, { signal });
    if (state.terminal !== undefined) return state.terminal;
    await new Promise<void>((resolveDelay, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("dynamic operation was aborted"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolveDelay();
      }, 50);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
};

export class ApprovedRouteDynamicDriver implements DynamicRunDriver {
  readonly kind = "approved-route" as const;
  readonly #route: ApprovedDynamicRoute;

  constructor(route: ApprovedDynamicRoute) { this.#route = route; }

  async execute(input: Parameters<DynamicRunDriver["execute"]>[0]): Promise<DynamicDriverResult> {
    const target = platformTarget();
    const asynchronousHostFailures: Error[] = [];
    const overriddenHostCalls: unknown[] = [];
    const runtimes: DynamicArtifactHostProcess[] = [];
    const stopNotifications: Array<() => void> = [];
    const exits: Array<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> = [];
    const recordHostCall = (method: string, params: unknown): void => {
      if (overriddenHostCalls.length >= 10_000) throw new Error("dynamic Host call evidence exceeded its bound");
      overriddenHostCalls.push(Object.freeze({ method, params: structuredClone(params) }));
    };
    const recordRuntimeEvent = (event: unknown): void => {
      input.evidence.recordPublicEvent(event);
    };
    const createRuntime = (): DynamicArtifactHostProcess => {
      const runtime = new DynamicArtifactHostProcess({
        artifact: input.artifact,
        cwd: input.workspace.workspace,
        temporaryRoot: input.workspace.temporaryRoot,
        secretCanaries: [this.#route.credentialMaterial()],
        createHandlers: (client) => ({
          "host/credential/resolve": (params) => {
            recordHostCall("host/credential/resolve", params);
            if (params.subject === "mcp") {
              return {
                kind: "availability" as const,
                available: false,
                authoritativeCredentialRevision: this.#route.credentialRevision,
                reasonCode: "dynamic_mcp_credential_unavailable",
              };
            }
            return params.purpose === "availability"
              ? {
                  kind: "availability" as const,
                  available: true,
                  authoritativeCredentialRevision: this.#route.credentialRevision,
                }
              : {
                  kind: "material" as const,
                  authoritativeCredentialRevision: this.#route.credentialRevision,
                  material: { [this.#route.materialField]: this.#route.credentialMaterial() },
                };
          },
          "host/interaction/request": (params, context) => {
            recordHostCall("host/interaction/request", params);
            context.afterResponse(() => {
              const question = params.kind === "ask_user" || params.kind === "plan_approval";
              const response = question
                ? input.scenario.hostPolicy.interaction === "deny"
                  ? {
                      interactionId: params.interactionId,
                      expectedRevision: params.desiredPolicyRevision,
                      decision: "cancelled" as const,
                    }
                  : {
                      interactionId: params.interactionId,
                      expectedRevision: params.desiredPolicyRevision,
                      decision: "answered" as const,
                      value: createScriptedQuestionAnswer(params),
                    }
                : {
                    interactionId: params.interactionId,
                    expectedRevision: params.desiredPolicyRevision,
                    decision: input.scenario.hostPolicy.interaction === "deny" ? "deny" as const : "allow_once" as const,
                  };
              void client.interactionRespond(response).catch((error: unknown) => {
                asynchronousHostFailures.push(error instanceof Error ? error : new Error("Host interaction response failed"));
              });
            });
            return { registered: true };
          },
        }),
      });
      runtimes.push(runtime);
      stopNotifications.push(runtime.client.registerRuntimeNotificationHandlers({
        "runtime/event": recordRuntimeEvent,
        "host/interaction/cancel": (event) => { recordRuntimeEvent({ kind: "host_interaction_cancel", event }); },
      }));
      return runtime;
    };
    let runtime = createRuntime();
    try {
      const initialize = createInitializeParams(input.workspace, target, {
        networkPolicyRef: this.#route.networkPolicyRef,
        webSearchAdapters: this.#route.webSearchAdapters,
        permitNetwork: input.scenario.hostPolicy.network !== "deny",
        permitBackground: input.scenario.budgets.children > 0 || input.scenario.budgets.processes > 0,
        maxChildren: Math.max(1, Math.min(128, input.scenario.budgets.children + input.scenario.budgets.processes)),
      });
      const initializeRuntime = async (candidate: DynamicArtifactHostProcess) => {
        const initialized = await candidate.client.initialize(initialize, { signal: input.signal });
        await candidate.client.initialized();
        const extensionCatalog = await candidate.client.extensionCatalog({}, { signal: input.signal });
        return Object.freeze({ initialized, extensionCatalog });
      };
      const initialRuntime = await initializeRuntime(runtime);
      const initialized = initialRuntime.initialized;
      let extensionCatalog = initialRuntime.extensionCatalog;
      const runtimeSessionId = `session-${input.workspace.runId}`;
      const persistenceRef = `persistence-${input.workspace.runId}`;
      const configRevision = "dynamic-config-v1";
      const binding = await runtime.client.sessionCreate({
        clientOperationId: `create-${input.workspace.runId}`,
        runtimeSessionId,
        persistenceRef,
        provider: this.#route.provider,
        configRevision,
        extensionDigest: extensionCatalog.digest,
        systemPrompt: this.#route.systemPrompt,
        permissionMode: this.#route.permissionMode,
        interactionScenario: this.#route.interactionScenario,
      }, { signal: input.signal });
      if (binding.state !== "ready") throw new Error(`dynamic Session admission is ${binding.state}`);
      const terminals: unknown[] = [];
      let persistenceLifecycleEvidence: Readonly<Record<string, unknown>> | undefined;
      for (let index = 0; index < input.scenario.prompts.length; index += 1) {
        const sourcePrompt = input.scenario.prompts[index];
        if (sourcePrompt === undefined) throw new Error("dynamic scenario prompt inventory changed");
        const prompt = input.scenario.id === "compaction-continuity"
          ? compactionPressurePrompt(sourcePrompt, index + 1)
          : sourcePrompt;
        const clientOperationId = `${input.workspace.runId}-operation-${String(index + 1)}`;
        await runtime.client.turnStart({
          clientOperationId,
          clientUserMessageId: `${input.workspace.runId}-message-${String(index + 1)}`,
          input: { parts: [{ kind: "text", text: prompt }] },
          configRevision,
          extensionDigest: extensionCatalog.digest,
          executionEnvironmentRevision: initialize.executionEnvironment.revision,
          executionEnvironmentDigest: initialize.executionEnvironment.digest,
          limits: {
            maxTurns: input.scenario.budgets.turns,
            maxDurationMs: input.scenario.budgets.wallTimeMs,
          },
          origin: { kind: "headless", scenario: input.scenario.id },
        }, { signal: input.signal });
        terminals.push(await waitForOperationTerminal(runtime.client, clientOperationId, input.signal));
        if (input.scenario.id === "persistence-lifecycle"
          && index === input.scenario.prompts.length - 2) {
          const compactOperationId = `${input.workspace.runId}-compact`;
          const compact = await runtime.client.sessionCompact(
            { clientOperationId: compactOperationId },
            { signal: input.signal },
          );
          const beforeRestart = await runtime.client.sessionRead({}, { signal: input.signal });
          const stableBoundaryId = beforeRestart.durableHead.stableBoundaryId;
          if (stableBoundaryId === undefined) {
            throw new Error("persistence lifecycle lacks a stable boundary before restart");
          }
          await runtime.client.sessionClose({
            clientOperationId: `restart-close-${input.workspace.runId}`,
          }, { signal: input.signal });
          await runtime.client.runtimeShutdown({ reason: "dynamic-persistence-restart" }, { signal: input.signal });
          const firstExit = await runtime.waitForExit(30_000);
          exits.push(firstExit);
          runtime = createRuntime();
          const resumedRuntime = await initializeRuntime(runtime);
          extensionCatalog = resumedRuntime.extensionCatalog;
          const resumed = await runtime.client.sessionResume({
            clientOperationId: `resume-${input.workspace.runId}`,
            runtimeSessionId,
            persistenceRef,
            provider: this.#route.provider,
            configRevision,
            extensionDigest: extensionCatalog.digest,
            systemPrompt: this.#route.systemPrompt,
            permissionMode: this.#route.permissionMode,
            interactionScenario: this.#route.interactionScenario,
          }, { signal: input.signal });
          if (resumed.state !== "ready") throw new Error(`dynamic Session resume is ${resumed.state}`);
          const afterResume = await runtime.client.sessionRead({}, { signal: input.signal });
          const forkTargetRuntimeHome = resolve(input.workspace.temporaryRoot, "fork-target-runtime-home");
          await mkdir(forkTargetRuntimeHome, { recursive: false });
          const forkMutationId = `${input.workspace.runId}-fork`;
          const forkPrepared = await runtime.client.sessionForkPrepare({
            clientMutationId: forkMutationId,
            sourceStableBoundaryId: stableBoundaryId,
            targetRuntimeHome: forkTargetRuntimeHome,
            targetPersistenceRef: `${persistenceRef}-fork-target`,
            targetRuntimeSessionId: `${runtimeSessionId}-fork-target`,
            targetWorkspaceIdentity: initialize.workspace.identity,
          }, { signal: input.signal });
          const forkAborted = await runtime.client.sessionForkAbort({
            clientMutationId: forkMutationId,
            token: forkPrepared.token,
          }, { signal: input.signal });
          const forkStatus = await runtime.client.sessionForkStatus(
            { token: forkPrepared.token },
            { signal: input.signal },
          );
          persistenceLifecycleEvidence = Object.freeze({
            compactState: compact.state,
            firstExitCode: firstExit.code,
            resumedState: resumed.state,
            durableSequenceBeforeRestart: beforeRestart.durableHead.sequence,
            durableSequenceAfterResume: afterResume.durableHead.sequence,
            stableBoundaryBeforeRestart: stableBoundaryId,
            stableBoundaryAfterResume: afterResume.durableHead.stableBoundaryId,
            forkPreparedState: forkPrepared.state,
            forkAbortedState: forkAborted.state,
            forkStatusState: forkStatus.state,
          });
        }
      }
      if (asynchronousHostFailures.length > 0) throw new AggregateError(asynchronousHostFailures, "Host interaction response failed");
      const diagnosticRecords: unknown[] = [];
      const sessionReadAssembler = new SessionReadAssembler();
      let cursor: string | undefined;
      let diagnosticsComplete = false;
      for (let page = 0; page < 1_024; page += 1) {
        const requestCursor = cursor;
        const result = await runtime.client.sessionRead(
          requestCursor === undefined ? {} : { cursor: requestCursor },
          { signal: input.signal },
        );
        sessionReadAssembler.accept(result, requestCursor);
        diagnosticRecords.push(...result.records);
        cursor = result.nextCursor;
        if (cursor === undefined) {
          diagnosticsComplete = true;
          break;
        }
      }
      if (!diagnosticsComplete) throw new Error("dynamic Session diagnostics exceeded their page bound");
      const durableEvents = sessionReadAssembler.finish();
      const completedCompactions = durableEvents.filter(({ eventType, data }) => {
        if (eventType !== "compaction/end" || data === null || typeof data !== "object" || Array.isArray(data)) {
          return false;
        }
        return !("error" in data);
      }).length;
      const summaryCompactions = durableEvents.filter(({ eventType }) =>
        eventType === "compaction/summary").length;
      const terminalAssistantText = messageText(durableEvents.findLast(({ eventType }) =>
        eventType === "assistant/message")?.data);
      const requiredContinuityFacts = [
        "finish-compaction-continuity-audit",
        "integrity-first",
        "specs/continuity-target.md",
        "COMPACTION_SENTINEL_42",
        "report-terminal-evidence",
      ];
      const terminalContinuityFactsPresent = requiredContinuityFacts.every((fact) =>
        terminalAssistantText.includes(fact));
      const supersededContinuityFactsAbsent = !terminalAssistantText.includes("speed-first")
        && !terminalAssistantText.includes("inspect-compaction-evidence");
      const compactionContinuityVerified = input.scenario.id !== "compaction-continuity"
        || completedCompactions >= 3
          && summaryCompactions >= 3
          && terminalContinuityFactsPresent
          && supersededContinuityFactsAbsent;
      await runtime.client.sessionClose({ clientOperationId: `close-${input.workspace.runId}` }, { signal: input.signal });
      const finalStatus = await runtime.client.runtimeStatus({}, { signal: input.signal });
      await runtime.client.runtimeShutdown({ reason: "dynamic-scenario-complete" }, { signal: input.signal });
      const exit = await runtime.waitForExit(30_000);
      exits.push(exit);
      const succeeded = terminals.every((terminal) => (terminal as { kind?: unknown }).kind === "succeeded");
      const activeTotal = Object.values(finalStatus.active).reduce((sum, value) => sum + value, 0);
      const fatalErrors = runtimes.flatMap((candidate) => candidate.fatalErrors);
      const noUnexpectedFatal = fatalErrors.every(({ code }) =>
        code === "protocol_eof" || code === "protocol_input_closed" || code === "protocol_output_closed");
      const persistenceLifecycleVerified = input.scenario.id !== "persistence-lifecycle"
        || (persistenceLifecycleEvidence?.compactState === "accepted"
          || persistenceLifecycleEvidence?.compactState === "already_known")
          && persistenceLifecycleEvidence.firstExitCode === 0
          && persistenceLifecycleEvidence.resumedState === "ready"
          && typeof persistenceLifecycleEvidence.stableBoundaryAfterResume === "string"
          && typeof persistenceLifecycleEvidence.durableSequenceBeforeRestart === "number"
          && typeof persistenceLifecycleEvidence.durableSequenceAfterResume === "number"
          && persistenceLifecycleEvidence.durableSequenceAfterResume
            >= persistenceLifecycleEvidence.durableSequenceBeforeRestart
          && persistenceLifecycleEvidence.forkPreparedState === "prepared"
          && persistenceLifecycleEvidence.forkAbortedState === "aborted"
          && persistenceLifecycleEvidence.forkStatusState === "aborted";
      const passed = succeeded && persistenceLifecycleVerified && compactionContinuityVerified
        && activeTotal === 0 && exits.every(({ code }) => code === 0) && noUnexpectedFatal;
      const reasonCode = !succeeded
        ? "operation_terminal_failed"
        : !persistenceLifecycleVerified
          ? "persistence_lifecycle_failed"
          : !compactionContinuityVerified
            ? "compaction_continuity_failed"
            : activeTotal !== 0
              ? "runtime_resources_remained_live"
              : exits.some(({ code }) => code !== 0)
                ? "runtime_exit_failed"
                : !noUnexpectedFatal
                  ? "runtime_transport_failed"
                  : undefined;
      return Object.freeze({
        outcome: passed ? "passed" as const : "failed" as const,
        ...(reasonCode === undefined ? {} : { reasonCode }),
        publicEvents: Object.freeze([]),
        diagnosticFacts: Object.freeze([{
          kind: "approved_route_identity",
          routeConfigSha256: this.#route.routeConfigSha256,
          providerRouteId: this.#route.provider.providerRouteId,
          api: this.#route.provider.api,
          modelId: this.#route.provider.modelId,
          artifactManifestSha256: input.artifact.manifestSha256,
          runtimeGeneration: initialized.runtimeGeneration,
        }, {
          kind: "host_reverse_calls",
          calls: [...overriddenHostCalls, ...runtimes.flatMap((candidate) => candidate.standardHost.calls)],
        }, ...(persistenceLifecycleEvidence === undefined ? [] : [{
          kind: "persistence_lifecycle",
          ...persistenceLifecycleEvidence,
        }]), ...(input.scenario.id === "compaction-continuity" ? [{
          kind: "compaction_continuity",
          completedCompactions,
          summaryCompactions,
          terminalAssistantSha256: sha256Text(terminalAssistantText),
          terminalContinuityFactsPresent,
          supersededContinuityFactsAbsent,
        }] : []), ...diagnosticRecords]),
        hardAssertions: Object.freeze({
          promptCount: input.scenario.prompts.length,
          terminalCount: terminals.length,
          allOperationsSucceeded: succeeded,
          exactArtifactIdentity: initialized.runtimeEngine.buildRevision === input.artifact.dshManifestSha256,
          generatedClientSchemaMatched: initialized.schemaSha256 === input.artifact.protocolSha256,
          zeroActiveResources: activeTotal === 0,
          diagnosticProjectionComplete: diagnosticsComplete,
          persistenceLifecycleVerified,
          compactionContinuityVerified,
        }),
        resourceFinal: Object.freeze({
          runtimeProcess: exit.code === 0 ? "exited" : "failed",
          active: finalStatus.active,
          runtimeProcessCount: runtimes.length,
          unexpectedHostFatalErrors: noUnexpectedFatal ? 0 : fatalErrors.length,
          credentialScopes: 0,
          attachmentLeases: 0,
        }),
      });
    } finally {
      for (const stop of stopNotifications.reverse()) stop();
      await Promise.all(runtimes.map((candidate) => candidate.close()));
    }
  }
}

export const runDynamicScenario = async (options: Readonly<{
  repositoryRoot: string;
  outputRoot: string;
  artifactRoot: string;
  expectedArtifactManifestSha256?: string;
  scenario: DynamicScenario;
  driver: DynamicRunDriver;
  secretCanaries?: readonly string[];
}>): Promise<DynamicRunResult> => {
  const target = platformTarget();
  if (!options.scenario.platforms.includes(target)) {
    throw new Error(`dynamic scenario ${options.scenario.id} does not support ${target}`);
  }
  const artifact = inspectDynamicArtifact(options.artifactRoot, options.expectedArtifactManifestSha256);
  const workspace = await createDynamicRunWorkspace({
    outputRoot: options.outputRoot,
    repositoryRoot: options.repositoryRoot,
    scenario: options.scenario,
  });
  const recorder = new DynamicEvidenceRecorder();
  let workspaceBefore: Awaited<ReturnType<typeof snapshotWorkspaceManifest>>;
  try {
    workspaceBefore = await snapshotWorkspaceManifest(workspace.workspace, options.scenario.budgets.bytes);
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("dynamic scenario exceeded its wall-time budget")), options.scenario.budgets.wallTimeMs);
  timeout.unref();
  let result: DynamicDriverResult;
  try {
    result = await options.driver.execute({ artifact, scenario: options.scenario, workspace, evidence: recorder, signal: controller.signal });
    for (const event of result.publicEvents) recorder.recordPublicEvent(event);
    for (const fact of result.diagnosticFacts) recorder.recordDiagnosticFact(fact);
  } catch (error) {
    result = Object.freeze({
      outcome: "failed",
      reasonCode: controller.signal.aborted ? "budget_timeout" : "dynamic_driver_failed",
      publicEvents: Object.freeze([]),
      diagnosticFacts: Object.freeze([{ kind: "driver_failure", message: error instanceof Error ? error.message : "unknown failure" }]),
      hardAssertions: Object.freeze({ driverCompleted: false }),
      resourceFinal: Object.freeze({ cleanupRequired: true }),
    });
    for (const fact of result.diagnosticFacts) recorder.recordDiagnosticFact(fact);
  }
  clearTimeout(timeout);
  let workspaceAfter: Awaited<ReturnType<typeof snapshotWorkspaceManifest>> = Object.freeze([]);
  try {
    workspaceAfter = await snapshotWorkspaceManifest(workspace.workspace, options.scenario.budgets.bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace evidence capture failed";
    recorder.recordDiagnosticFact({ kind: "workspace_capture_failure", message });
    result = Object.freeze({
      ...result,
      outcome: "failed" as const,
      reasonCode: "workspace_evidence_failed",
      hardAssertions: { prior: result.hardAssertions, workspaceEvidenceCaptured: false },
    });
  }
  const scenarioCheck = evaluateDynamicScenarioPostconditions(options.scenario, workspaceBefore, workspaceAfter);
  if (result.outcome === "passed" && !scenarioCheck.passed) {
    result = Object.freeze({
      ...result,
      outcome: "failed" as const,
      reasonCode: "scenario_postcondition_failed",
    });
  }
  result = Object.freeze({
    ...result,
    hardAssertions: Object.freeze({ driver: result.hardAssertions, scenario: scenarioCheck }),
  });
  let ownedResourcesRemoved = false;
  try {
    await assertRunTreesSecretFree({
      roots: [workspace.workspace, workspace.runtimeHome, workspace.attachmentRoot, workspace.temporaryRoot],
      secretCanaries: options.secretCanaries ?? [],
      maximumBytes: Math.min(512 * 1024 * 1024, Math.max(64 * 1024 * 1024, options.scenario.budgets.bytes * 4)),
    });
  } catch {
    recorder.recordDiagnosticFact({ kind: "secret_boundary_failure" });
    result = Object.freeze({
      ...result,
      outcome: "failed" as const,
      reasonCode: "secret_boundary_failed",
      hardAssertions: { prior: result.hardAssertions, wholeRunTreeSecretFree: false },
    });
  }
  try {
    await workspace.cleanupOwnedResources();
    ownedResourcesRemoved = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "owned resource cleanup failed";
    recorder.recordDiagnosticFact({ kind: "owned_resource_cleanup_failure", message });
    result = Object.freeze({
      ...result,
      outcome: "failed" as const,
      reasonCode: "resource_cleanup_failed",
      hardAssertions: { prior: result.hardAssertions, ownedResourcesRemoved: false },
    });
  }
  recorder.markTerminal();
  const recorded = recorder.consumeForSeal();
  const redaction: EvidenceRedactionPolicy = Object.freeze({
    maxNodes: 1_000_000,
    privatePaths: Object.freeze({
      [options.repositoryRoot]: "$REPOSITORY",
      [workspace.root]: "$RUN_ROOT",
      [artifact.root]: "$ARTIFACT",
    }),
    secretCanaries: Object.freeze([...(options.secretCanaries ?? [])]),
  });
  const evidence = await sealDynamicEvidence({
    root: workspace.evidenceRoot,
    runId: workspace.runId,
    scenarioId: options.scenario.id,
    redaction,
    input: {
      run: {
        schemaVersion: 1,
        runId: workspace.runId,
        scenario: { id: options.scenario.id, sha256: options.scenario.sourceSha256 },
        scenarioAuthority: {
          fixtureManifestSha256: dynamicFixtureManifestSha256(workspaceBefore),
          checkerSha256: await dynamicCheckerAuthoritySha256(),
        },
        artifact,
        driver: options.driver.kind,
        outcome: result.outcome,
        ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
        platform: target,
        roles: {
          mainAgent: "development-release-authority",
          testerAgent: "external-observer-not-release-authority",
          rootAgent: "packed-runtime-system-under-test",
          runtimeChildren: "nested-product-capabilities-under-test",
        },
      },
      publicEvents: recorded.publicEvents,
      diagnosticFacts: recorded.diagnosticFacts,
      workspaceBefore: { entries: workspaceBefore },
      workspaceAfter: { entries: workspaceAfter },
      resourceFinal: { driver: result.resourceFinal, ownedResourcesRemoved },
      hardAssertions: result.hardAssertions,
    },
  });
  return Object.freeze({
    runId: workspace.runId,
    scenarioId: options.scenario.id,
    outcome: result.outcome,
    ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
    artifact,
    evidence,
    runRoot: workspace.root,
  });
};
