import {
  RuntimeProcessLifecycle,
  type RuntimeProcessBoundary,
  type RuntimeProcessLifecycleOptions,
  type RuntimeTerminationSignal,
} from "@myagents-dsh/runtime-server";
import type {
  NativeRpcExitRequest,
  NativeRpcProcessStop,
  NativeRpcServer,
} from "@myagents-dsh/rpc-server";
import type { DshRootComposition } from "@myagents-dsh/runtime-product";
import { describe, expect, it, vi } from "vitest";

describe("Runtime process lifecycle", () => {
  it("converges SIGINT and SIGTERM on one bounded Native RPC stop", async () => {
    const termination = Promise.withResolvers<NativeRpcExitRequest>();
    const stopped = Promise.withResolvers<NativeRpcProcessStop>();
    const requestProcessSignal = vi.fn();
    const nativeRpc = {
      requestProcessSignal,
      whenTerminationCommitted: () => termination.promise,
      whenStopped: () => stopped.promise,
    } as unknown as NativeRpcServer;
    let listener: ((signal: RuntimeTerminationSignal) => void) | undefined;
    const unsubscribe = vi.fn();
    const cancelForceExit = vi.fn();
    const scheduleForceExit = vi.fn(() => cancelForceExit);
    const boundary: RuntimeProcessBoundary = {
      subscribe: (candidate) => {
        listener = candidate;
        return unsubscribe;
      },
      scheduleForceExit,
    };
    const lifecycle = new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      nativeRpc,
      { processBoundary: boundary, shutdownGraceMs: 2_500 },
    );

    listener?.("SIGINT");
    listener?.("SIGTERM");
    expect(requestProcessSignal.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
    termination.resolve(Object.freeze({ kind: "signal", signal: "SIGINT" }));
    await vi.waitFor(() => expect(scheduleForceExit).toHaveBeenCalledWith(130, 2_500));
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(cancelForceExit).not.toHaveBeenCalled();

    const result = Object.freeze({
      exit: Object.freeze({ kind: "signal" as const, signal: "SIGINT" as const }),
      disposed: true as const,
    });
    stopped.resolve(result);
    await expect(lifecycle.whenStopped()).resolves.toBe(result);
    expect(cancelForceExit).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects an unbounded shutdown grace before subscribing process signals", () => {
    const subscribe = vi.fn(() => () => undefined);
    const nativeRpc = {
      whenTerminationCommitted: () => new Promise<NativeRpcExitRequest>(() => undefined),
      whenStopped: () => new Promise<NativeRpcProcessStop>(() => undefined),
    } as unknown as NativeRpcServer;
    expect(() => new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      nativeRpc,
      {
        processBoundary: { subscribe, scheduleForceExit: () => () => undefined },
        shutdownGraceMs: 0,
      },
    )).toThrow("bounded positive integer");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("keeps the forced-exit deadline armed when quiescent disposal fails", async () => {
    const termination = Promise.withResolvers<NativeRpcExitRequest>();
    const stopped = Promise.withResolvers<NativeRpcProcessStop>();
    const cancelForceExit = vi.fn();
    const unsubscribe = vi.fn();
    const scheduleForceExit = vi.fn(() => cancelForceExit);
    const lifecycle = new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      {
        requestProcessSignal: () => undefined,
        whenTerminationCommitted: () => termination.promise,
        whenStopped: () => stopped.promise,
      } as unknown as NativeRpcServer,
      {
        processBoundary: {
          subscribe: () => unsubscribe,
          scheduleForceExit,
        },
        shutdownGraceMs: 1_000,
      },
    );
    termination.resolve(Object.freeze({ kind: "transport_fatal", code: "synthetic", retryable: false }));
    await vi.waitFor(() => expect(scheduleForceExit).toHaveBeenCalledWith(1, 1_000));
    stopped.reject(new Error("synthetic quiescence failure"));
    await expect(lifecycle.whenStopped()).rejects.toThrow("synthetic quiescence failure");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cancelForceExit).not.toHaveBeenCalled();
  });

  it("rejects Proxy, accessor, unknown, and missing-cleanup process boundaries without reflection", () => {
    const nativeRpc = {
      whenTerminationCommitted: () => new Promise<NativeRpcExitRequest>(() => undefined),
      whenStopped: () => new Promise<NativeRpcProcessStop>(() => undefined),
    } as unknown as NativeRpcServer;
    let proxyTrapHits = 0;
    const proxy = new Proxy({}, {
      getPrototypeOf: (target) => {
        proxyTrapHits += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        proxyTrapHits += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      nativeRpc,
      { processBoundary: proxy as RuntimeProcessBoundary },
    )).toThrow("must not be a Proxy");
    expect(proxyTrapHits).toBe(0);

    let getterHits = 0;
    const accessorOptions = Object.defineProperty({}, "processBoundary", {
      enumerable: true,
      get: () => {
        getterHits += 1;
        return {};
      },
    });
    expect(() => new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      nativeRpc,
      accessorOptions as RuntimeProcessLifecycleOptions,
    )).toThrow("non-data fields");
    expect(getterHits).toBe(0);

    expect(() => new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      nativeRpc,
      { unknown: true } as unknown as RuntimeProcessLifecycleOptions,
    )).toThrow("unsupported");
    expect(() => new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      nativeRpc,
      {
        processBoundary: {
          subscribe: () => undefined,
          scheduleForceExit: () => () => undefined,
        } as unknown as RuntimeProcessBoundary,
      },
    )).toThrow("subscription must return a cleanup function");
  });

  it("surfaces scheduler failure and still unsubscribes signal ownership", async () => {
    const termination = Promise.withResolvers<NativeRpcExitRequest>();
    const unsubscribe = vi.fn();
    const lifecycle = new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      {
        requestProcessSignal: () => undefined,
        whenTerminationCommitted: () => termination.promise,
        whenStopped: () => new Promise<NativeRpcProcessStop>(() => undefined),
      } as unknown as NativeRpcServer,
      {
        processBoundary: {
          subscribe: () => unsubscribe,
          scheduleForceExit: () => { throw new Error("synthetic scheduler failure"); },
        },
      },
    );
    termination.resolve(Object.freeze({ kind: "shutdown" }));
    await expect(lifecycle.whenStopped()).rejects.toThrow("synthetic scheduler failure");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("runs forced-exit and signal cleanup independently after quiescence", async () => {
    const termination = Promise.withResolvers<NativeRpcExitRequest>();
    const stopped = Promise.withResolvers<NativeRpcProcessStop>();
    const cancelForceExit = vi.fn(() => { throw new Error("synthetic deadline cleanup failure"); });
    const unsubscribe = vi.fn(() => { throw new Error("synthetic unsubscribe failure"); });
    const lifecycle = new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      {
        requestProcessSignal: () => undefined,
        whenTerminationCommitted: () => termination.promise,
        whenStopped: () => stopped.promise,
      } as unknown as NativeRpcServer,
      {
        processBoundary: {
          subscribe: () => unsubscribe,
          scheduleForceExit: () => cancelForceExit,
        },
      },
    );
    termination.resolve(Object.freeze({ kind: "shutdown" }));
    stopped.resolve(Object.freeze({ exit: Object.freeze({ kind: "shutdown" }), disposed: true }));
    await expect(lifecycle.whenStopped()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "synthetic deadline cleanup failure" }),
        expect.objectContaining({ message: "synthetic unsubscribe failure" }),
      ],
    });
    expect(cancelForceExit).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
