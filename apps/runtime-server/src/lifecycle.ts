import {
  NativeRpcServer,
  type NativeRpcProcessStop,
  type NativeRpcServerConfig,
} from "@myagents-dsh/rpc-server";
import {
  claimNativeRpcLifecycleAuthority,
  type DshRootComposition,
} from "@myagents-dsh/runtime-product";

export type NativeRpcLifecycleConfig = Omit<NativeRpcServerConfig, "compositionAuthority">;

export type RuntimeProcessStop = NativeRpcProcessStop;

export class RuntimeProcessLifecycle {
  readonly nativeRpc: NativeRpcServer;
  readonly #stopped: Promise<RuntimeProcessStop>;

  constructor(readonly composition: DshRootComposition, nativeRpc: NativeRpcServer) {
    this.nativeRpc = nativeRpc;
    this.#stopped = nativeRpc.whenStopped();
    void this.#stopped.catch(() => undefined);
  }

  whenStopped(): Promise<RuntimeProcessStop> { return this.#stopped; }
}

export const startNativeRpcLifecycle = async (
  composition: DshRootComposition,
  config: NativeRpcLifecycleConfig,
): Promise<RuntimeProcessLifecycle> => {
  try {
    composition.snapshot();
    const compositionAuthority = claimNativeRpcLifecycleAuthority(composition);
    const pluginConfig = Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(config),
        compositionAuthority: {
          configurable: false,
          enumerable: true,
          value: compositionAuthority,
          writable: false,
        },
      },
    ) as NativeRpcServerConfig;
    await composition.context.plugin(NativeRpcServer, pluginConfig);
    return new RuntimeProcessLifecycle(composition, composition.context.nativeRpc);
  } catch (error) {
    await composition.dispose();
    throw error;
  }
};
