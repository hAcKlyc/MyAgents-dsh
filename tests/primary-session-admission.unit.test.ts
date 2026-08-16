import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { MethodParams } from "@myagents-dsh/protocol";
import {
  PrimarySessionAdmission,
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
    compatibility: { beta: true, alpha: "stable" },
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
  const agent = { cancel, id: SessionId(id), whenIdle } as unknown as Agent;
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
        compatibility: { alpha: "stable", beta: true },
      },
    });
    const first = admission.bindCreate(firstParams);
    const retry = admission.bindCreate(secondParams);
    expect(retry).toBe(first);
    await first;
    expect(create).toHaveBeenCalledOnce();
    await admission.retire();
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
    const resume = vi.fn(() => Promise.resolve({ state: "recovery_required" as const }));
    const admission = new PrimarySessionAdmission(backendWith(
      () => Promise.reject(new Error("create must not run")),
      resume,
    ), workspace);
    await expect(admission.bindResume(resumeParams())).resolves.toMatchObject({
      state: "recovery_required",
      mode: "resume",
      runtimeSessionId: "runtime-resume",
    });
    expect(admission.snapshot()).toEqual({
      state: "recovery_required",
      clientOperationId: "bind-primary",
      desiredConfigRevision: "config-v1",
      mode: "resume",
      persistenceRef: "persistence-primary",
      runtimeSessionId: "runtime-resume",
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
  });
});
