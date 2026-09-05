import { Context } from "@deepseek-ai/cordis";
import { NativeRpcServer } from "@myagents-dsh/rpc-server";
import type { HostPortService } from "@myagents-dsh/host-ports";
import type {
  NativeRpcLifecycleAuthority,
  ProductSessionService,
} from "@myagents-dsh/runtime-product";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

describe("native RPC engine authority", () => {
  it("refuses a bare Context without a composition-issued lifecycle authority", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const root = new Context();
    root.provide("sessions", { flush: () => Promise.resolve(true) } as never);
    root.provide("productSession", {
      bindExecutionEnvironment: (environment: unknown) => environment,
      bindWorkspace: (workspace: unknown) => workspace,
      retire: () => Promise.resolve(),
      snapshot: () => Object.freeze({ state: "unbound" as const }),
    } as ProductSessionService);
    root.provide("sdkOperations", {
      bindTerminalReservationAuthority: () => undefined,
    } as never);
    root.provide("hostPorts", {} as HostPortService);
    try {
      await expect(root.plugin(NativeRpcServer, {
        compositionAuthority: Object.freeze({}) as NativeRpcLifecycleAuthority,
        input,
        output,
        runtimeGeneration: "unverified-generation",
        platformTarget: "darwin-arm64",
      })).rejects.toThrow(/accepted patched runtime requires|native RPC requires a direct-root RuntimeProcessLifecycle authority/u);
    } finally {
      await root.fiber.dispose();
      input.destroy();
      output.destroy();
    }
  });
});
