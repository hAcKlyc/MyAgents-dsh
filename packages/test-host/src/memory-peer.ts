import { PassThrough } from "node:stream";

import {
  JsonRpcPeer,
  REFERENCE_PROTOCOL_LIMITS,
  type ProtocolError,
  type ProtocolLimits,
} from "@myagents-dsh/protocol";

export type InMemoryPeerPair = {
  host: JsonRpcPeer;
  runtime: JsonRpcPeer;
  hostFatalErrors: ProtocolError[];
  runtimeFatalErrors: ProtocolError[];
  writeRawToHost(bytes: string | Uint8Array): void;
  writeRawToRuntime(bytes: string | Uint8Array): void;
  endHostInput(): void;
  endRuntimeInput(): void;
  close(): void;
};

export type InMemoryPeerPairOptions = {
  hostLimits?: ProtocolLimits;
  runtimeLimits?: ProtocolLimits;
  highWaterMark?: number;
};

export const createInMemoryPeerPair = (options: InMemoryPeerPairOptions = {}): InMemoryPeerPair => {
  const hostInput = new PassThrough({ highWaterMark: options.highWaterMark });
  const runtimeInput = new PassThrough({ highWaterMark: options.highWaterMark });
  const hostFatalErrors: ProtocolError[] = [];
  const runtimeFatalErrors: ProtocolError[] = [];
  const host = new JsonRpcPeer({
    input: hostInput,
    output: runtimeInput,
    role: "host",
    limits: options.hostLimits ?? REFERENCE_PROTOCOL_LIMITS,
    onFatalError: (error) => hostFatalErrors.push(error),
  });
  const runtime = new JsonRpcPeer({
    input: runtimeInput,
    output: hostInput,
    role: "runtime",
    limits: options.runtimeLimits ?? REFERENCE_PROTOCOL_LIMITS,
    onFatalError: (error) => runtimeFatalErrors.push(error),
  });
  return {
    host,
    runtime,
    hostFatalErrors,
    runtimeFatalErrors,
    writeRawToHost: (bytes) => { hostInput.write(bytes); },
    writeRawToRuntime: (bytes) => { runtimeInput.write(bytes); },
    endHostInput: () => { hostInput.end(); },
    endRuntimeInput: () => { runtimeInput.end(); },
    close: () => {
      host.close();
      runtime.close();
      hostInput.destroy();
      runtimeInput.destroy();
    },
  };
};
