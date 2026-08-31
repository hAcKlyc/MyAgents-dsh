import { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { MethodParams } from "@myagents-dsh/protocol";
import {
  PrimarySessionAdmission,
  ProductSessionService,
  RuntimeSettlementTimeoutError,
  createRuntimeSettlementDeadlineAuthority,
  validateProductExecutionEnvironment,
  validatePrimarySessionWorkspace,
  type PrimarySessionBackend,
  type PrimarySessionBackendRequest,
  type PrimarySessionBackendResult,
  type PrimarySessionWorkspace,
} from "@myagents-dsh/runtime-product";
import { describe, expect, it, vi } from "vitest";

const digest = "a".repeat(64);
const workspace: PrimarySessionWorkspace = Object.freeze({
  identity: "fixture-workspace",
  path: "/fixture/workspace",
  platformTarget: "darwin-arm64",
});

const processEnvironmentFields = (windows = false) => ({
  checkpoint: {
    mode: "managed-file-tools" as const,
    policyRevision: "checkpoint-v1",
    trackedTools: ["Write", "Edit"] as const,
    tracksChildAgents: false as const,
    tracksExternalChanges: false as const,
    tracksShell: false as const,
    version: 1 as const,
  },
  environment: { allowedKeys: [], inheritedKeys: [], secretValues: "reverse-port-only" as const },
  executables: {
    allowedCommandRefs: [],
    bashDialect: "bash" as const,
    bashRef: "bash-v1",
    bundledNodeRef: "node-v1",
    pathPolicy: "sealed" as const,
    ripgrepRef: "ripgrep-v1",
    ...(windows ? {
      windowsPowerShellRef: "powershell-v1",
      windowsUtf8PreludeRef: "utf8-prelude-v1",
    } : {}),
  },
  network: { mode: "deny" as const },
  process: { backgroundRetention: "allow" as const, killTreeOnAbort: true as const, maxChildren: 4 },
});

const createParams = (
  overrides: Partial<MethodParams<"session/create">> = {},
): MethodParams<"session/create"> => ({
  clientOperationId: "bind-primary",
  runtimeSessionId: "runtime-primary",
  persistenceRef: "persistence-primary",
  provider: {
    revision: "provider-v1",
    providerRouteId: "fixture",
    api: "openai-completions",
    provider: "fixture-provider",
    modelId: "fixture-model",
    credentialRef: "credential-primary",
    contextWindow: 8_192,
    maxTokens: 1_024,
    compatibility: {
      credentialMode: "pi-ai-api-key",
      family: "openai-completions",
      version: 1,
      wireCompat: { supportsStrictMode: true, supportsDeveloperRole: true },
    },
  },
  configRevision: "config-v1",
  extensionDigest: digest,
  systemPrompt: "Synthetic primary Session prompt.",
  permissionMode: "default",
  toolPolicy: { builtinTools: [], autoAllowTools: [], disallowedTools: [] },
  interactionScenario: "deterministic-headless",
  ...overrides,
});

const resumeParams = (
  overrides: Partial<MethodParams<"session/resume">> = {},
): MethodParams<"session/resume"> => ({
  ...createParams(),
  ...overrides,
  runtimeSessionId: overrides.runtimeSessionId ?? "runtime-resume",
});

const fakeHandle = (id: string) => {
  const dispose = vi.fn(() => Promise.resolve());
  const cancel = vi.fn();
  const whenIdle = vi.fn(() => Promise.resolve());
  const session = Session.create(SessionId(id));
  const agent = { cancel, id: SessionId(id), session, whenIdle } as unknown as Agent;
  return {
    cancel,
    dispose,
    handle: { agent, dispose } satisfies AgentHandle,
    whenIdle,
  };
};

const readyResult = (
  handle: AgentHandle,
  id = "runtime-primary",
  sequence = 0,
  effectiveConfigRevision?: string,
): PrimarySessionBackendResult => ({
  state: "ready",
  handle,
  runtimeSessionId: id,
  durableSequence: sequence,
  ...(effectiveConfigRevision === undefined ? {} : { effectiveConfigRevision }),
});

const backendWith = (
  create: (request: PrimarySessionBackendRequest) => Promise<PrimarySessionBackendResult>,
  resume: (request: PrimarySessionBackendRequest) => Promise<PrimarySessionBackendResult>,
): PrimarySessionBackend => ({ create, resume });

describe("one-primary-session admission", () => {
  it("rolls back a prepared Provider when backend admission fails", async () => {
    const failure = new Error("synthetic backend failure");
    const admissionGuard = vi.fn(() => Promise.resolve());
    const rollback = vi.fn<(request: PrimarySessionBackendRequest) => Promise<void>>(
      () => Promise.resolve(),
    );
    const admission = new PrimarySessionAdmission(
      backendWith(
        () => Promise.reject(failure),
        () => Promise.reject(new Error("resume must not run")),
      ),
      workspace,
      createRuntimeSettlementDeadlineAuthority(),
      admissionGuard,
      undefined,
      rollback,
    );
    await expect(admission.bindCreate(createParams())).rejects.toBe(failure);
    expect(admissionGuard).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(rollback.mock.calls[0]?.[0]).toMatchObject({
      mode: "create",
      runtimeSessionId: "runtime-primary",
    });
    expect(admission.snapshot().state).toBe("recovery_required");
  });

  it("coalesces exact create retries and permanently fences a different primary identity", async () => {
    const pending = Promise.withResolvers<PrimarySessionBackendResult>();
    const create = vi.fn(() => pending.promise);
    const admission = new PrimarySessionAdmission(backendWith(
      create,
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    const params = createParams();
    const first = admission.bindCreate(params);
    const exactRetry = admission.bindCreate(params);
    expect(exactRetry).toBe(first);
    expect(admission.snapshot()).toMatchObject({
      state: "creating",
      runtimeSessionId: "runtime-primary",
      desiredConfigRevision: "config-v1",
    });
    expect(() => admission.bindCreate(createParams({ systemPrompt: "Different immutable input." })))
      .toThrow("different or retired primary Session admission");

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const { handle, dispose } = fakeHandle("runtime-primary");
    pending.resolve(readyResult(handle, "runtime-primary", 7));
    await expect(first).resolves.toMatchObject({
      state: "ready",
      runtimeSessionId: "runtime-primary",
      durableSequence: 7,
    });
    expect(admission.requireAgent()).toBe(handle.agent);
    expect(admission.snapshot()).toEqual({
      state: "ready",
      clientOperationId: "bind-primary",
      desiredConfigRevision: "config-v1",
      durableSequence: 7,
      mode: "create",
      persistenceRef: "persistence-primary",
      runtimeSessionId: "runtime-primary",
    });
    await expect(admission.bindCreate(params)).resolves.toEqual(await first);

    const firstRetire = admission.retire();
    const secondRetire = admission.retire();
    expect(secondRetire).toBe(firstRetire);
    await firstRetire;
    expect(dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot().state).toBe("retired");
    expect(() => admission.bindCreate(params)).toThrow("retired primary Session admission");
  });

  it("normalizes compatibility key order into one immutable retry fingerprint", async () => {
    const { handle } = fakeHandle("runtime-primary");
    const create = vi.fn(() => Promise.resolve(readyResult(handle)));
    const admission = new PrimarySessionAdmission(backendWith(
      create,
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    const firstParams = createParams();
    const secondParams = createParams({
      provider: {
        ...firstParams.provider,
        compatibility: {
          credentialMode: "pi-ai-api-key",
          family: "openai-completions",
          version: 1,
          wireCompat: { supportsDeveloperRole: true, supportsStrictMode: true },
        },
      },
    });
    const first = admission.bindCreate(firstParams);
    const retry = admission.bindCreate(secondParams);
    expect(retry).toBe(first);
    await first;
    expect(create).toHaveBeenCalledOnce();
    await admission.retire();
  });

  it("replaces one durable generation through quiescent disposal and exact resume", async () => {
    const source = fakeHandle("runtime-primary");
    const rewound = fakeHandle("runtime-primary");
    const restored = fakeHandle("runtime-primary");
    const resume = vi.fn<(
      request: PrimarySessionBackendRequest,
    ) => Promise<PrimarySessionBackendResult>>()
      .mockResolvedValueOnce(readyResult(rewound.handle, "runtime-primary", 2, "config-v1"))
      .mockResolvedValueOnce(readyResult(restored.handle, "runtime-primary", 4, "config-v1"));
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(source.handle, "runtime-primary", 4, "config-v1")),
      resume,
    ), workspace);
    await admission.bindCreate(createParams());
    const mutate = vi.fn(() => Promise.resolve());
    const guard = vi.fn(() => Promise.resolve());
    const first = admission.replaceGeneration("commit:rewind-1", mutate, guard);
    expect(admission.replaceGeneration("commit:rewind-1", mutate, guard)).toBe(first);
    await expect(first).resolves.toMatchObject({
      durableSequence: 2,
      mode: "resume",
      state: "ready",
    });
    expect(source.cancel).toHaveBeenCalledWith({ kind: "disposed" }, { keepInbox: true });
    expect(source.whenIdle).toHaveBeenCalledOnce();
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    const resumeRequest = resume.mock.calls[0]?.[0];
    expect(resumeRequest?.mode).toBe("resume");
    expect(resumeRequest?.params.runtimeSessionId).toBe("runtime-primary");
    expect(resumeRequest?.runtimeSessionId).toBe("runtime-primary");
    expect(admission.requireAgent()).toBe(rewound.handle.agent);

    await admission.replaceGeneration("rollback:rewind-1", () => Promise.resolve(), guard);
    expect(rewound.dispose).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(admission.snapshot()).toMatchObject({ durableSequence: 4, state: "ready" });
    await admission.retire();
    expect(restored.dispose).toHaveBeenCalledOnce();
  });

  it("preflights and atomically resumes one updated configuration generation", async () => {
    const source = fakeHandle("runtime-primary");
    const replacement = fakeHandle("runtime-primary");
    const resume = vi.fn((request: PrimarySessionBackendRequest) => Promise.resolve(
      readyResult(replacement.handle, request.runtimeSessionId, 5, request.params.configRevision),
    ));
    const admissionGuard = vi.fn(() => Promise.resolve());
    const configurationGuard = vi.fn(() => Promise.resolve());
    const admission = new PrimarySessionAdmission(
      backendWith(
        () => Promise.resolve(readyResult(source.handle, "runtime-primary", 4, "config-v1")),
        resume,
      ),
      workspace,
      createRuntimeSettlementDeadlineAuthority(),
      admissionGuard,
      configurationGuard,
    );
    await admission.bindCreate(createParams());
    const config: MethodParams<"config/apply"> = {
      revision: "config-v2",
      provider: {
        ...createParams().provider,
        revision: "provider-v2",
        modelId: "fixture-model-v2",
      },
      permissionMode: "dontAsk",
      toolPolicy: { builtinTools: [], autoAllowTools: [], disallowedTools: [] },
      interactionScenario: "headless-v2",
      systemPrompt: "Replacement primary Session prompt.",
      executionEnvironmentRevision: "environment-v1",
      executionEnvironmentDigest: digest,
    };
    const candidate = await admission.prepareConfiguration(config, new AbortController().signal);
    expect(candidate.alreadyEffective).toBe(false);
    expect(configurationGuard).toHaveBeenCalledOnce();
    expect(admissionGuard).toHaveBeenCalledOnce();
    const applyAuthorities = vi.fn(() => Promise.resolve());
    await admission.replaceGeneration(
      candidate.mutationKey,
      () => Promise.resolve(),
      applyAuthorities,
      candidate.params,
      candidate.systemContext,
    );
    expect(applyAuthorities).toHaveBeenCalledWith(source.handle.agent);
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0].params).toMatchObject({
      configRevision: "config-v2",
      provider: { revision: "provider-v2", modelId: "fixture-model-v2" },
      permissionMode: "dontAsk",
      interactionScenario: "headless-v2",
      systemPrompt: "Replacement primary Session prompt.",
    });
    expect(admission.snapshot()).toMatchObject({
      state: "ready",
      desiredConfigRevision: "config-v2",
      effectiveConfigRevision: "config-v2",
    });
    await expect(admission.prepareConfiguration(
      { ...config, systemPrompt: "conflicting content" },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "config_revision_conflict" });
    await admission.retire();
  });

  it("retries durable mutation resume after the locator committed but first publication failed", async () => {
    const source = fakeHandle("runtime-primary");
    const recovered = fakeHandle("runtime-primary");
    const resume = vi.fn()
      .mockRejectedValueOnce(new Error("synthetic post-commit resume failure"))
      .mockResolvedValueOnce(readyResult(recovered.handle, "runtime-primary", 3, "config-v1"));
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(source.handle, "runtime-primary", 4, "config-v1")),
      resume,
    ), workspace);
    await admission.bindCreate(createParams());
    const mutate = vi.fn(() => Promise.resolve());
    const first = admission.replaceGeneration("commit:rewind-recovery", mutate);
    await expect(first).rejects.toThrow("synthetic post-commit resume failure");
    expect(admission.snapshot().state).toBe("recovery_required");
    expect(source.dispose).toHaveBeenCalledOnce();

    const retry = admission.replaceGeneration("commit:rewind-recovery", mutate);
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toMatchObject({ durableSequence: 3, state: "ready" });
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(admission.requireAgent()).toBe(recovered.handle.agent);
    await admission.retire();
    expect(recovered.dispose).toHaveBeenCalledOnce();
  });

  it("starts the Inbox-preserving retirement guard before awaiting idle and handle disposal", async () => {
    const candidate = fakeHandle("runtime-primary");
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    await admission.bindCreate(createParams());
    const guard = vi.fn(() => {
      expect(candidate.cancel).toHaveBeenCalledWith({ kind: "disposed" }, { keepInbox: true });
      expect(candidate.whenIdle).not.toHaveBeenCalled();
      expect(candidate.dispose).not.toHaveBeenCalled();
      return Promise.resolve();
    });
    await admission.retire(guard);
    expect(guard).toHaveBeenCalledWith(candidate.handle.agent);
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("retires through one exact session/close operation and retains the retired identity", async () => {
    const candidate = fakeHandle("runtime-primary");
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle, "runtime-primary", 12)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    await admission.bindCreate(createParams());
    const guard = vi.fn(() => Promise.resolve());
    const first = admission.close({ clientOperationId: "close-primary" }, guard);
    const exactRetry = admission.close({ clientOperationId: "close-primary" }, guard);
    expect(exactRetry).toBe(first);
    expect(() => admission.close({ clientOperationId: "different-close" }, guard))
      .toThrow("clientOperationId differs");
    await expect(first).resolves.toEqual({ ok: true });
    expect(candidate.cancel).toHaveBeenCalledWith({ kind: "disposed" }, { keepInbox: true });
    expect(candidate.whenIdle).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot()).toEqual({
      state: "retired",
      clientOperationId: "bind-primary",
      desiredConfigRevision: "config-v1",
      durableSequence: 12,
      mode: "create",
      persistenceRef: "persistence-primary",
      runtimeSessionId: "runtime-primary",
    });
    await expect(admission.close({ clientOperationId: "close-primary" }, guard))
      .resolves.toEqual({ ok: true });
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("rejects close before admission without consuming the close idempotency identity", async () => {
    const candidate = fakeHandle("runtime-primary");
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    expect(() => admission.close({ clientOperationId: "close-before-bind" }))
      .toThrow("no admitted identity");
    expect(admission.snapshot().state).toBe("unbound");

    await admission.bindCreate(createParams());
    await expect(admission.close({ clientOperationId: "close-before-bind" }))
      .resolves.toEqual({ ok: true });
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("runs guard, idle, and disposal even when Agent cancellation throws", async () => {
    const candidate = fakeHandle("runtime-primary");
    const cancelError = new Error("synthetic Agent cancellation failure");
    candidate.cancel.mockImplementation(() => { throw cancelError; });
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    await admission.bindCreate(createParams());
    const guard = vi.fn(() => Promise.resolve());

    await expect(admission.retire(guard)).rejects.toBe(cancelError);
    expect(guard).toHaveBeenCalledOnce();
    expect(candidate.whenIdle).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot().state).toBe("retired");
  });

  it("bounds a never-settling retirement guard and still disposes exactly once", async () => {
    const candidate = fakeHandle("runtime-primary");
    candidate.whenIdle.mockImplementation(() => new Promise<void>(() => undefined));
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace, createRuntimeSettlementDeadlineAuthority(10));
    await admission.bindCreate(createParams());
    const guard = vi.fn(() => new Promise<void>(() => undefined));
    const retirement = admission.retire(guard);

    await expect(retirement).rejects.toBeInstanceOf(RuntimeSettlementTimeoutError);
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot().state).toBe("recovery_required");
    expect(admission.retire(guard)).toBe(retirement);
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("bounds a never-settling handle disposal and exposes recovery-required truth", async () => {
    const candidate = fakeHandle("runtime-primary");
    candidate.dispose.mockImplementation(() => new Promise<void>(() => undefined));
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace, createRuntimeSettlementDeadlineAuthority(10));
    await admission.bindCreate(createParams());
    const retirement = admission.retire();

    await expect(retirement).rejects.toBeInstanceOf(RuntimeSettlementTimeoutError);
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot().state).toBe("recovery_required");
    expect(admission.retire()).toBe(retirement);
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("keeps recovery-required truth when handle disposal rejects immediately", async () => {
    const candidate = fakeHandle("runtime-primary");
    const disposalError = new Error("synthetic immediate handle disposal failure");
    candidate.dispose.mockImplementation(() => Promise.reject(disposalError));
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    await admission.bindCreate(createParams());

    await expect(admission.retire()).rejects.toBe(disposalError);
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot().state).toBe("recovery_required");
    expect(() => admission.requireAgent()).toThrow("not ready");
  });

  it("does not turn a timed-out late disposal rejection into retired truth", async () => {
    const candidate = fakeHandle("runtime-primary");
    const disposal = Promise.withResolvers<undefined>();
    candidate.dispose.mockImplementation(() => disposal.promise);
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace, createRuntimeSettlementDeadlineAuthority(10));
    await admission.bindCreate(createParams());

    await expect(admission.retire()).rejects.toBeInstanceOf(RuntimeSettlementTimeoutError);
    expect(admission.snapshot().state).toBe("recovery_required");
    disposal.reject(new Error("synthetic late handle disposal failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(admission.snapshot().state).toBe("recovery_required");
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("retires and disposes exactly once when settlement and cancellation flush fail", async () => {
    const candidate = fakeHandle("runtime-primary");
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    await admission.bindCreate(createParams());
    const guardError = new Error("synthetic cancellation flush failure");
    const guard = vi.fn(() => Promise.reject(guardError));
    const firstRetirement = admission.retire(guard);
    const exactRetry = admission.retire(guard);

    expect(exactRetry).toBe(firstRetirement);
    await expect(firstRetirement).rejects.toBe(guardError);
    expect(candidate.cancel).toHaveBeenCalledOnce();
    expect(candidate.whenIdle).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot().state).toBe("retired");
    expect(() => admission.requireAgent()).toThrow("not ready");
    await expect(admission.retire(guard)).rejects.toBe(guardError);
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("fences the first failed identity and disposes an invalid ready handle", async () => {
    const wrong = fakeHandle("wrong-session");
    const create = vi.fn(() => Promise.resolve(readyResult(wrong.handle)));
    const admission = new PrimarySessionAdmission(backendWith(
      create,
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    const first = admission.bindCreate(createParams());
    await expect(first).rejects.toThrow("differs from the admitted identity");
    expect(wrong.dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot()).toMatchObject({
      state: "recovery_required",
      runtimeSessionId: "runtime-primary",
    });
    expect(admission.bindCreate(createParams())).toBe(first);
    await expect(first).rejects.toThrow("differs from the admitted identity");
    expect(create).toHaveBeenCalledOnce();
    expect(() => admission.bindCreate(createParams({ runtimeSessionId: "another-primary" })))
      .toThrow("different or retired primary Session admission");
    await admission.retire();
  });

  it("rejects invalid durable truth and cleans the captured handle exactly once", async () => {
    const candidate = fakeHandle("runtime-primary");
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve(readyResult(candidate.handle, "runtime-primary", Number.NaN)),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    await expect(admission.bindCreate(createParams())).rejects.toThrow("non-negative safe integer");
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot().state).toBe("recovery_required");
    await admission.retire();
  });

  it("rejects nested handle accessors without invoking them", async () => {
    const agent = { id: SessionId("runtime-primary") } as unknown as Agent;
    let getterHits = 0;
    const handle = { agent } as AgentHandle & Record<string, unknown>;
    Object.defineProperty(handle, "dispose", {
      enumerable: true,
      get: () => {
        getterHits += 1;
        return () => Promise.resolve();
      },
    });
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve({
        state: "ready",
        handle,
        runtimeSessionId: "runtime-primary",
        durableSequence: 0,
      }),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    await expect(admission.bindCreate(createParams())).rejects.toThrow("own data properties");
    expect(getterHits).toBe(0);
    expect(admission.snapshot().state).toBe("recovery_required");
    await admission.retire();
  });

  it("runs a safely captured disposer when another handle field is malformed", async () => {
    let agentGetterHits = 0;
    const dispose = vi.fn(() => Promise.resolve());
    const handle = { dispose } as unknown as AgentHandle & Record<string, unknown>;
    Object.defineProperty(handle, "agent", {
      enumerable: true,
      get: () => {
        agentGetterHits += 1;
        return { id: SessionId("runtime-primary") };
      },
    });
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.resolve({
        state: "ready",
        handle,
        runtimeSessionId: "runtime-primary",
        durableSequence: 0,
      }),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);

    await expect(admission.bindCreate(createParams())).rejects.toThrow("own data properties");
    expect(agentGetterHits).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    await admission.retire();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects result, handle, and Agent proxies before invoking reflection traps", async () => {
    const cases = ["result", "handle", "agent"] as const;
    for (const kind of cases) {
      let trapHits = 0;
      const dispose = vi.fn(() => Promise.resolve());
      const baseAgent = { id: SessionId("runtime-primary") } as unknown as Agent;
      const proxied = <T extends object>(target: T): T =>
        new Proxy(target, {
          getPrototypeOf: (candidate) => {
            trapHits += 1;
            return Reflect.getPrototypeOf(candidate);
          },
          ownKeys: (candidate) => {
            trapHits += 1;
            return Reflect.ownKeys(candidate);
          },
          getOwnPropertyDescriptor: (candidate, key) => {
            trapHits += 1;
            return Reflect.getOwnPropertyDescriptor(candidate, key);
          },
        });
      const agent = kind === "agent" ? proxied(baseAgent) : baseAgent;
      const baseHandle = { agent, dispose } satisfies AgentHandle;
      const handle = kind === "handle" ? proxied(baseHandle) : baseHandle;
      const baseResult = readyResult(handle);
      const result = kind === "result" ? proxied(baseResult) : baseResult;
      const admission = new PrimarySessionAdmission(backendWith(
        () => Promise.resolve(result),
        () => Promise.reject(new Error("resume must not run")),
      ), workspace);

      await expect(admission.bindCreate(createParams())).rejects.toThrow(/Proxy|differs/);
      expect(trapHits).toBe(0);
      expect(dispose).toHaveBeenCalledTimes(kind === "agent" ? 1 : 0);
      await admission.retire();
    }
  });

  it("binds recovery-required resume without inventing durable or effective truth", async () => {
    const recovery = Object.freeze({
      state: "recovery_required" as const,
      runtimeSessionId: "runtime-resume",
      persistenceRef: "persistence-primary",
      reason: "persisted_product_state_invalid" as const,
      retryable: false,
      unsettledMutations: Object.freeze([]),
    });
    const resume = vi.fn(() => Promise.resolve({ state: "recovery_required" as const, recovery }));
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.reject(new Error("create must not run")),
      resume,
    ), workspace);
    await expect(admission.bindResume(resumeParams())).resolves.toMatchObject({
      state: "recovery_required",
      mode: "resume",
      runtimeSessionId: "runtime-resume",
      recovery,
    });
    expect(admission.snapshot()).toEqual({
      state: "recovery_required",
      clientOperationId: "bind-primary",
      desiredConfigRevision: "config-v1",
      mode: "resume",
      persistenceRef: "persistence-primary",
      runtimeSessionId: "runtime-resume",
      recovery,
    });
    expect(() => admission.requireAgent()).toThrow("not ready");
    expect(() => admission.bindCreate(createParams()))
      .toThrow("different or retired primary Session admission");
    await admission.retire();
  });

  it("rejects pre- and mid-flight cancellation even when the backend ignores its signal", async () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error("pre-aborted"));
    const skippedCreate = vi.fn(() => Promise.reject(new Error("must not run")));
    const skipped = new PrimarySessionAdmission(backendWith(
      skippedCreate,
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    await expect(skipped.bindCreate(createParams(), preAborted.signal)).rejects.toThrow("pre-aborted");
    expect(skippedCreate).not.toHaveBeenCalled();
    expect(skipped.snapshot().state).toBe("recovery_required");

    const pending = Promise.withResolvers<PrimarySessionBackendResult>();
    const admitted = fakeHandle("runtime-primary");
    const controller = new AbortController();
    const admission = new PrimarySessionAdmission(backendWith(
      vi.fn(() => pending.promise),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    const binding = admission.bindCreate(createParams(), controller.signal);
    await vi.waitFor(() => expect(admission.snapshot().state).toBe("creating"));
    await Promise.resolve();
    controller.abort(new Error("mid-flight abort"));
    pending.resolve(readyResult(admitted.handle));
    await expect(binding).rejects.toThrow("mid-flight abort");
    expect(admitted.dispose).toHaveBeenCalledOnce();
    expect(admission.snapshot().state).toBe("recovery_required");
    await admission.retire();
  });

  it("aborts and drains an admission that is still starting", async () => {
    const create = vi.fn((request: PrimarySessionBackendRequest) => new Promise<PrimarySessionBackendResult>(
      (_resolve, reject) => request.signal.addEventListener("abort", () => reject(
        request.signal.reason instanceof Error
          ? request.signal.reason
          : new Error("primary Session admission aborted"),
      ), { once: true }),
    ));
    const admission = new PrimarySessionAdmission(backendWith(
      create,
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    const binding = admission.bindCreate(createParams());
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const retirement = admission.retire();
    await expect(binding).rejects.toThrow("owner is disposing");
    await retirement;
    expect(admission.snapshot()).toMatchObject({ state: "retired" });
  });

  it("rejects accessor-bearing input and non-canonical workspace authority", () => {
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.reject(new Error("create must not run")),
      () => Promise.reject(new Error("resume must not run")),
    ), workspace);
    const params = createParams() as MethodParams<"session/create"> & Record<string, unknown>;
    let getterHits = 0;
    Object.defineProperty(params, "systemPrompt", {
      enumerable: true,
      get: () => {
        getterHits += 1;
        return "must not run";
      },
    });
    expect(() => admission.bindCreate(params)).toThrow("enumerable data properties");
    expect(getterHits).toBe(0);
    expect(() => validatePrimarySessionWorkspace({
      identity: "fixture-workspace",
      path: "../outside",
      platformTarget: "darwin-arm64",
    })).toThrow("canonical initialized absolute path");
    expect(() => validatePrimarySessionWorkspace({
      identity: "fixture-workspace",
      path: "/fixture/workspace\0alias",
      platformTarget: "darwin-arm64",
    })).toThrow("canonical initialized absolute path");

    let proxyTraps = 0;
    const environmentProxy = new Proxy({}, {
      get: () => { proxyTraps += 1; return undefined; },
      getOwnPropertyDescriptor: () => { proxyTraps += 1; return undefined; },
      getPrototypeOf: () => { proxyTraps += 1; return Object.prototype; },
      ownKeys: () => { proxyTraps += 1; return []; },
    });
    expect(() => validateProductExecutionEnvironment(environmentProxy)).toThrow("must not be a Proxy");
    expect(proxyTraps).toBe(0);
    const posixEnvironment = {
      ...processEnvironmentFields(),
      attachmentStagingRoot: "/fixture/attachments",
      digest,
      platformTarget: "darwin-arm64" as const,
      revision: "environment-v1",
      runtimeHome: "/fixture/runtime",
      workspace: {
        allowedReadRoots: ["/fixture/workspace"],
        allowedWriteRoots: ["/fixture/workspace"],
        canonicalRoot: "/fixture/workspace",
        identity: "fixture-workspace",
      },
    };
    expect(validateProductExecutionEnvironment({
      ...posixEnvironment,
      network: { mode: "host-policy", policyRef: "network-policy-v1" },
    }).network).toEqual({ mode: "host-policy", policyRef: "network-policy-v1" });
    expect(() => validateProductExecutionEnvironment({
      ...posixEnvironment,
      network: { mode: "deny", policyRef: "must-not-exist" },
    })).toThrow("network authority is invalid");
    let networkGetterHits = 0;
    const accessorNetwork: Record<string, unknown> = { mode: "host-policy" };
    Object.defineProperty(accessorNetwork, "policyRef", {
      enumerable: true,
      get: () => { networkGetterHits += 1; return "must-not-run"; },
    });
    expect(() => validateProductExecutionEnvironment({
      ...posixEnvironment,
      network: accessorNetwork,
    })).toThrow("enumerable own data properties");
    expect(networkGetterHits).toBe(0);
    expect(() => validateProductExecutionEnvironment({
      ...processEnvironmentFields(true),
      attachmentStagingRoot: "C:\\fixture\\attachments",
      digest,
      platformTarget: "win32-x64",
      revision: "environment-v1",
      runtimeHome: "C:\\fixture\\runtime",
      workspace: {
        allowedReadRoots: ["C:\\fixture\\workspace", "c:\\fixture\\workspace"],
        allowedWriteRoots: ["C:\\fixture\\workspace"],
        canonicalRoot: "C:\\fixture\\workspace",
        identity: "fixture-workspace",
      },
    })).toThrow("unique under platform path identity");
    expect(() => validateProductExecutionEnvironment({
      ...processEnvironmentFields(true),
      attachmentStagingRoot: "\\attachments",
      digest,
      platformTarget: "win32-x64",
      revision: "environment-v1",
      runtimeHome: "\\runtime",
      workspace: {
        allowedReadRoots: ["\\workspace"],
        allowedWriteRoots: ["\\workspace"],
        canonicalRoot: "\\workspace",
        identity: "fixture-workspace",
      },
    })).toThrow("fully qualified and absolute");
    expect(() => validateProductExecutionEnvironment({
      ...processEnvironmentFields(true),
      attachmentStagingRoot: "/attachments",
      digest,
      platformTarget: "win32-x64",
      revision: "environment-v1",
      runtimeHome: "/runtime",
      workspace: {
        allowedReadRoots: ["/workspace"],
        allowedWriteRoots: ["/workspace"],
        canonicalRoot: "/workspace",
        identity: "fixture-workspace",
      },
    })).toThrow("fully qualified and absolute");
  });

  it("keeps workspace and execution-environment authority symmetric in either bind order", async () => {
    const context = new Context();
    context.provide("agents", {
      roots: () => [],
      setPublicationGuard: () => () => undefined,
    } as never);
    context.provide("sessions", {
      setPublicationGuard: () => () => undefined,
    } as never);
    const service = new ProductSessionService(context, {
      backend: backendWith(
        () => Promise.reject(new Error("create must not run")),
        () => Promise.reject(new Error("resume must not run")),
      ),
    });
    service.bindWorkspace(workspace);
    expect(() => service.bindExecutionEnvironment({
      ...processEnvironmentFields(),
      attachmentStagingRoot: "/fixture/attachments",
      digest,
      platformTarget: "darwin-arm64",
      revision: "environment-v1",
      runtimeHome: "/fixture/runtime",
      workspace: {
        allowedReadRoots: ["/fixture/other"],
        allowedWriteRoots: ["/fixture/other"],
        canonicalRoot: "/fixture/other",
        identity: "different-workspace",
      },
    })).toThrow("differs from the primary Session workspace");
    await service.retire();
    await context.fiber.dispose();
  });

  it("persists a configuration anchor before replacing an otherwise empty Session", async () => {
    const context = new Context();
    const source = fakeHandle("runtime-primary");
    const replacement = fakeHandle("runtime-primary");
    const flush = vi.fn(() => Promise.resolve(true));
    context.provide("agents", {
      roots: () => [],
      setPublicationGuard: () => () => undefined,
    } as never);
    context.provide("sessions", {
      flush,
      setPublicationGuard: () => () => undefined,
    } as never);
    const service = new ProductSessionService(context, {
      backend: backendWith(
        () => Promise.resolve(readyResult(source.handle, "runtime-primary", 0, "config-v1")),
        (request) => Promise.resolve(readyResult(
          replacement.handle,
          request.runtimeSessionId,
          1,
          request.params.configRevision,
        )),
      ),
    });
    service.bindWorkspace(workspace);
    service.bindExecutionEnvironment({
      ...processEnvironmentFields(),
      attachmentStagingRoot: "/fixture/attachments",
      digest,
      platformTarget: "darwin-arm64",
      revision: "environment-v1",
      runtimeHome: "/fixture/runtime",
      workspace: {
        allowedReadRoots: [workspace.path],
        allowedWriteRoots: [workspace.path],
        canonicalRoot: workspace.path,
        identity: workspace.identity,
      },
    });
    await service.bindCreate(createParams());
    const candidate = await service.prepareConfiguration({
      revision: "config-v2",
      provider: { ...createParams().provider, revision: "provider-v2" },
      permissionMode: "default",
      toolPolicy: { builtinTools: [], autoAllowTools: [], disallowedTools: [] },
      interactionScenario: "deterministic-headless",
      systemPrompt: "Replacement primary Session prompt.",
      executionEnvironmentRevision: "environment-v1",
      executionEnvironmentDigest: digest,
    }, new AbortController().signal);

    await service.replaceConfiguration(candidate, () => Promise.resolve());

    expect(source.handle.agent.session.events).toEqual([
      expect.objectContaining({
        type: "myagents/session/configuration",
        data: { revision: "config-v2" },
      }),
    ]);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith(source.handle.agent.session);
    expect(service.requireOperationConfigRevision()).toBe("config-v2");
    expect(service.requireOperationModelProfileRevision()).toBe("provider-v2");
    await service.retire();
    await context.fiber.dispose();
  });

  it("replays the exact prepared mutation while resume is recovery-required", async () => {
    const context = new Context();
    context.provide("agents", {
      roots: () => [],
      setPublicationGuard: () => () => undefined,
    } as never);
    context.provide("sessions", {
      list: () => [],
      setPublicationGuard: () => () => undefined,
    } as never);
    const recovery = Object.freeze({
      state: "recovery_required" as const,
      runtimeSessionId: "runtime-resume",
      persistenceRef: "persistence-primary",
      reason: "persisted_mutation_unsettled" as const,
      retryable: true,
      unsettledMutations: Object.freeze(["delete", "fork", "rewind"] as const),
    });
    const prepareRewind = vi.fn(() => Promise.resolve(Object.freeze({
      token: "rw_token",
      phase: "prepared" as const,
    })));
    const prepareDelete = vi.fn(() => Promise.resolve(Object.freeze({
      token: "del_token",
      phase: "prepared" as const,
    })));
    const prepareFork = vi.fn(() => Promise.resolve(Object.freeze({
      token: "fk_token",
      phase: "prepared" as const,
    })));
    const service = new ProductSessionService(context, {
      backend: backendWith(
        () => Promise.reject(new Error("create must not run")),
        () => Promise.resolve({ state: "recovery_required", recovery }),
      ),
      rewindStore: () => ({ prepareRewind } as never),
      deleteStore: () => ({ prepareDelete } as never),
      forkStore: () => ({ prepareFork } as never),
    });
    service.bindWorkspace(workspace);
    await expect(service.bindResume(resumeParams())).resolves.toMatchObject({
      state: "recovery_required",
      runtimeSessionId: "runtime-resume",
    });

    await expect(service.rewindPrepare({
      clientMutationId: "rewind-client",
      targetStableBoundaryId: "boundary-1",
      sourceTranscriptPostcondition: "a".repeat(64),
      targetTranscriptPostcondition: "b".repeat(64),
    })).resolves.toEqual({ token: "rw_token", state: "prepared" });
    await expect(service.deletePrepare({ clientMutationId: "delete-client" }))
      .resolves.toEqual({ token: "del_token", state: "prepared" });
    await expect(service.forkPrepare({
      clientMutationId: "fork-client",
      sourceStableBoundaryId: "boundary-1",
      targetRuntimeHome: "/fixture/fork-runtime",
      targetPersistenceRef: "persistence-fork",
      targetRuntimeSessionId: "runtime-fork",
      targetWorkspaceIdentity: workspace.identity,
    })).resolves.toEqual({ token: "fk_token", state: "prepared" });

    expect(prepareRewind).toHaveBeenCalledWith(expect.objectContaining({
      clientMutationId: "rewind-client",
      runtimeSessionId: "runtime-resume",
    }), undefined);
    expect(prepareDelete).toHaveBeenCalledWith({
      clientMutationId: "delete-client",
      runtimeSessionId: "runtime-resume",
    }, undefined);
    expect(prepareFork).toHaveBeenCalledWith(expect.objectContaining({
      clientMutationId: "fork-client",
      runtimeSessionId: "runtime-resume",
    }), undefined);

    const rewindOnlyRecovery = Object.freeze({
      ...recovery,
      unsettledMutations: Object.freeze(["rewind" as const]),
    });
    const rewindOnlyContext = new Context();
    rewindOnlyContext.provide("agents", {
      roots: () => [],
      setPublicationGuard: () => () => undefined,
    } as never);
    rewindOnlyContext.provide("sessions", {
      list: () => [],
      setPublicationGuard: () => () => undefined,
    } as never);
    const rewindOnlyService = new ProductSessionService(rewindOnlyContext, {
      backend: backendWith(
        () => Promise.reject(new Error("create must not run")),
        () => Promise.resolve({ state: "recovery_required", recovery: rewindOnlyRecovery }),
      ),
      deleteStore: () => ({ prepareDelete } as never),
    });
    rewindOnlyService.bindWorkspace(workspace);
    await rewindOnlyService.bindResume(resumeParams());
    expect(() => rewindOnlyService.deletePrepare({ clientMutationId: "new-delete-client" }))
      .toThrow(expect.objectContaining({ code: "session_idempotency_conflict" }));
    expect(prepareDelete).toHaveBeenCalledOnce();

    await rewindOnlyService.retire();
    await rewindOnlyContext.fiber.dispose();
    await service.retire();
    await context.fiber.dispose();
  });

});
