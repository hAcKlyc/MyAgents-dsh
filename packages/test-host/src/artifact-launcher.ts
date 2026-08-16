import {
  JsonRpcPeer,
  REFERENCE_PROTOCOL_LIMITS,
  type ProtocolError,
} from "@myagents-dsh/protocol";
import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { types as utilTypes } from "node:util";

import { StandardTestHost } from "./standard-test-host.js";

export interface ArtifactRuntimeExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ArtifactRuntimeLaunchOptions {
  readonly nodeExecutable: string;
  readonly artifactEntrypoint: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ArtifactCliInvocationOptions extends ArtifactRuntimeLaunchOptions {
  readonly args: readonly string[];
}

export interface ArtifactCliResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

type JsonObject = Record<string, unknown>;

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  description: string,
): JsonObject => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError(`${description} must not be a Proxy`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const object = value as JsonObject;
  const expected = new Set(required);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(object, key) : undefined;
    if (typeof key !== "string" || !expected.has(key) || descriptor === undefined
      || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${description} contains unsupported or non-data fields`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return object;
};

const exactEnvironment = (value: unknown): NodeJS.ProcessEnv => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError("artifact process environment must not be a Proxy");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("artifact process environment must be a plain object");
  }
  const environment = value as JsonObject;
  const result: NodeJS.ProcessEnv = {};
  for (const key of Reflect.ownKeys(environment)) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(environment, key)
      : undefined;
    if (typeof key !== "string" || descriptor === undefined
      || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("artifact process environment must contain enumerable own data fields");
    }
    const name = key;
    const item: unknown = descriptor.value as unknown;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)
      || typeof item !== "string" || item.includes("\0") || item.length > 32_768) {
      throw new TypeError("artifact process environment must contain bounded string entries");
    }
    result[name] = item;
  }
  return result;
};

const exactAbsolutePath = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError(`${description} must be an absolute path`);
  }
  return resolve(value);
};

const exactArguments = (value: unknown): readonly string[] => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError("artifact process arguments must not be a Proxy");
  }
  if (!Array.isArray(value)) throw new TypeError("artifact process arguments must be an array");
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError("artifact process arguments must be dense");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const item = descriptor !== undefined && "value" in descriptor ? descriptor.value as unknown : undefined;
    if (descriptor === undefined || !descriptor.enumerable || typeof item !== "string"
      || item.includes("\0") || item.length > 4_096) {
      throw new TypeError("artifact process arguments must contain bounded own data strings");
    }
    result.push(item);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= value.length) {
      throw new TypeError("artifact process arguments contain unsupported fields");
    }
  }
  return Object.freeze(result);
};

export class ArtifactRuntimeProcess {
  readonly client: GeneratedHostClient;
  readonly standardHost: StandardTestHost;
  readonly hostFatalErrors: ProtocolError[] = [];
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #hostPeer: JsonRpcPeer;
  readonly #exit: Promise<ArtifactRuntimeExit>;
  readonly #processGroupId: number | undefined;
  #terminationPromise: Promise<ArtifactRuntimeExit> | undefined;
  #stderr = "";

  constructor(options: ArtifactRuntimeLaunchOptions) {
    const value = exactOwnDataObject(
      options,
      ["nodeExecutable", "artifactEntrypoint", "cwd", "environment"],
      "artifact process launch options",
    );
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: exactAbsolutePath(value.cwd, "artifact process cwd"),
      env: exactEnvironment(value.environment),
      shell: false,
      windowsHide: true,
    };
    this.#child = spawn(
      exactAbsolutePath(value.nodeExecutable, "artifact Node executable"),
      [exactAbsolutePath(value.artifactEntrypoint, "artifact entrypoint")],
      {
        ...spawnOptions,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#processGroupId = process.platform === "win32" ? undefined : this.#child.pid;
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
      if (this.#stderr.length > 65_536) {
        void this.#terminateTree().catch(() => undefined);
      }
    });
    this.#hostPeer = new JsonRpcPeer({
      input: this.#child.stdout,
      output: this.#child.stdin,
      role: "host",
      limits: REFERENCE_PROTOCOL_LIMITS,
      onFatalError: (error) => {
        this.hostFatalErrors.push(error);
      },
    });
    this.client = new GeneratedHostClient(this.#hostPeer);
    this.standardHost = new StandardTestHost(this.client);
    this.#exit = new Promise((resolveExit, reject) => {
      this.#child.once("error", reject);
      this.#child.once("close", (code, signal) => {
        resolveExit(Object.freeze({ code, signal }));
      });
    });
  }

  get stderr(): string { return this.#stderr; }

  writeRaw(bytes: string | Uint8Array): void { this.#child.stdin.write(bytes); }

  endRuntimeInput(): void { this.#child.stdin.end(); }

  closeRuntimeOutput(): void { this.#child.stdout.destroy(); }

  signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
    this.#sendTreeSignal(signal);
  }

  whenExited(): Promise<ArtifactRuntimeExit> { return this.#exit; }

  waitForExit(timeoutMs = 10_000): Promise<ArtifactRuntimeExit> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError("artifact Runtime exit timeout must be a bounded positive integer");
    }
    return new Promise((resolveExit, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void this.#terminateTree().then(
          () => reject(new Error("artifact Runtime did not exit within its process-test bound")),
          reject,
        );
      }, timeoutMs);
      timer.unref();
      void this.#exit.then((exit) => {
        if (timedOut) return;
        clearTimeout(timer);
        resolveExit(exit);
      }, (error: unknown) => {
        if (timedOut) return;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("artifact Runtime exit observation failed"));
      });
    });
  }

  async close(): Promise<void> {
    this.standardHost.dispose();
    this.#hostPeer.close();
    await this.#terminateTree();
  }

  #sendTreeSignal(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
    if (this.#processGroupId !== undefined) {
      try {
        process.kill(-this.#processGroupId, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          if (this.#child.exitCode === null && this.#child.signalCode === null) {
            this.#child.kill(signal);
          }
          return;
        }
        throw error;
      }
    }
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    if (!this.#child.kill(signal)) throw new Error(`artifact Runtime did not accept ${signal}`);
  }

  #terminateTree(): Promise<ArtifactRuntimeExit> {
    this.#terminationPromise ??= (async () => {
      this.#sendTreeSignal("SIGKILL");
      const exit = await this.#exit;
      if (this.#processGroupId !== undefined) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            process.kill(-this.#processGroupId, 0);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // SIGKILL was already accepted above; EPERM here denotes a reused group identity.
            if (code === "ESRCH" || code === "EPERM") return exit;
            throw error;
          }
          await new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, 10);
          });
        }
        throw new Error("artifact Runtime process group remained live after SIGKILL");
      }
      return exit;
    })();
    return this.#terminationPromise;
  }
}

export const launchArtifactRuntime = (
  options: ArtifactRuntimeLaunchOptions,
): ArtifactRuntimeProcess => new ArtifactRuntimeProcess(options);

export const runArtifactCli = (
  options: ArtifactCliInvocationOptions,
): ArtifactCliResult => {
  const value = exactOwnDataObject(
    options,
    ["nodeExecutable", "artifactEntrypoint", "cwd", "environment", "args"],
    "artifact CLI invocation options",
  );
  const result = spawnSync(
    exactAbsolutePath(value.nodeExecutable, "artifact Node executable"),
    [
      exactAbsolutePath(value.artifactEntrypoint, "artifact entrypoint"),
      ...exactArguments(value.args),
    ],
    {
      cwd: exactAbsolutePath(value.cwd, "artifact process cwd"),
      encoding: "utf8",
      env: exactEnvironment(value.environment),
      maxBuffer: 65_536,
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  return Object.freeze({
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  });
};
