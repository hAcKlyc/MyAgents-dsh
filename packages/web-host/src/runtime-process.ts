import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import {
  verifyInstalledRuntimeArtifact,
  type VerifiedRuntimeArtifact,
} from "@myagents-dsh/artifact-verifier/runtime-artifact";
import { JsonRpcPeer, ProtocolError, REFERENCE_PROTOCOL_LIMITS } from "@myagents-dsh/protocol";
import {
  GeneratedHostClient,
  GENERATED_PROTOCOL_VERSION,
  GENERATED_SCHEMA_SHA256,
} from "@myagents-dsh/protocol/generated/host-client";

import type { ReversePortRegistry } from "./reverse-ports.js";
import { WebHostError } from "./errors.js";

export type RuntimeProcessExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
export type RuntimeProcessOptions = Readonly<{
  artifactRoot: string;
  expectedManifestSha256: string;
  nodeExecutable: string;
  environment: Readonly<Record<string, string>>;
  reversePorts: ReversePortRegistry;
  onFatal: (code: string) => void;
  onExit: (exit: RuntimeProcessExit) => void;
}>;

const credentialName = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|(?:^|_)KEY(?:_|$)|(?:^|_)PAT(?:_|$)|(?:^|_)JWT(?:_|$)|(?:^|_)AUTH(?:_|$))/iu;
const exactEnvironment = (source: Readonly<Record<string, string>>): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || credentialName.test(name)
      || typeof value !== "string" || value.includes("\0") || value.length > 32_768) {
      throw new WebHostError("runtime_environment_invalid", "Runtime child environment is not secret-free and bounded");
    }
    environment[name] = value;
  }
  return environment;
};
const exactAbsolutePath = (value: string, name: string): string => {
  if (!isAbsolute(value) || value.includes("\0")) throw new TypeError(`${name} must be an absolute path`);
  return resolve(value);
};
const delay = (milliseconds: number): Promise<void> => new Promise((resolveDelay) => {
  const timer = setTimeout(resolveDelay, milliseconds);
  timer.unref();
});

export class VerifiedRuntimeProcess {
  readonly artifact: VerifiedRuntimeArtifact;
  readonly client: GeneratedHostClient;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #peer: JsonRpcPeer;
  readonly #reversePorts: ReversePortRegistry;
  readonly #exit: Promise<RuntimeProcessExit>;
  readonly #processGroupId: number | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  #disposeHandlers: (() => void) | undefined;
  #disposeNotifications: (() => void) | undefined;
  #closePromise: Promise<RuntimeProcessExit> | undefined;
  #stderrBytes = 0;

  constructor(options: RuntimeProcessOptions) {
    const artifactRoot = exactAbsolutePath(options.artifactRoot, "Runtime artifact root");
    this.artifact = verifyInstalledRuntimeArtifact(artifactRoot, options.expectedManifestSha256);
    if (this.artifact.manifest.protocol.version !== GENERATED_PROTOCOL_VERSION
      || this.artifact.manifest.protocol.schemaSha256 !== GENERATED_SCHEMA_SHA256) {
      throw new WebHostError("runtime_artifact_protocol_mismatch", "Runtime artifact protocol differs from the Host client");
    }
    const entrypoint = resolve(artifactRoot, this.artifact.manifest.entrypoint);
    this.#environment = exactEnvironment(options.environment);
    this.#child = spawn(exactAbsolutePath(options.nodeExecutable, "Runtime Node executable"), [
      "--disable-warning=ExperimentalWarning",
      entrypoint,
    ], {
      cwd: artifactRoot,
      detached: process.platform !== "win32",
      env: this.#environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#processGroupId = process.platform === "win32" ? undefined : this.#child.pid;
    this.#reversePorts = options.reversePorts;
    this.#peer = new JsonRpcPeer({
      input: this.#child.stdout,
      output: this.#child.stdin,
      role: "host",
      limits: REFERENCE_PROTOCOL_LIMITS,
      onFatalError: (error) => {
        options.onFatal(error.code);
        void this.close().catch(() => undefined);
      },
    });
    this.client = new GeneratedHostClient(this.#peer);
    this.#disposeHandlers = this.client.registerHostHandlers(options.reversePorts.handlers);
    this.#disposeNotifications = this.client.registerRuntimeNotificationHandlers(options.reversePorts.notifications);
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > 65_536) {
        options.onFatal("runtime_stderr_limit");
        void this.close().catch(() => undefined);
      }
    });
    this.#exit = new Promise((resolveExit, reject) => {
      this.#child.once("error", reject);
      this.#child.once("close", (code, signal) => {
        const exit = Object.freeze({ code, signal });
        options.onExit(exit);
        resolveExit(exit);
      });
    });
  }

  get pid(): number | undefined { return this.#child.pid; }
  whenExited(): Promise<RuntimeProcessExit> { return this.#exit; }

  async close(): Promise<RuntimeProcessExit> {
    this.#closePromise ??= this.#closeOwned();
    return this.#closePromise;
  }

  async #closeOwned(): Promise<RuntimeProcessExit> {
    this.#disposeNotifications?.();
    this.#disposeNotifications = undefined;
    this.#disposeHandlers?.();
    this.#disposeHandlers = undefined;
    this.#peer.close(new ProtocolError("host_runtime_retired", "Runtime process retired", true));
    await this.#reversePorts.close();
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return this.#exit;
    this.#signalTree("SIGTERM");
    const graceful = await Promise.race([
      this.#exit.then((exit) => ({ exit })),
      delay(2_000).then(() => ({})),
    ]);
    if ("exit" in graceful) return graceful.exit;
    await this.#killTree();
    return this.#exit;
  }

  #signalTree(signal: "SIGTERM" | "SIGKILL"): void {
    if (this.#processGroupId !== undefined) {
      try {
        process.kill(-this.#processGroupId, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      return;
    }
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill(signal);
  }

  async #killTree(): Promise<void> {
    if (process.platform !== "win32") {
      this.#signalTree("SIGKILL");
      return;
    }
    const pid = this.#child.pid;
    if (pid === undefined) return;
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined || !isAbsolute(systemRoot)) {
      throw new WebHostError("windows_process_tree_unavailable", "Windows SystemRoot is unavailable");
    }
    const taskkill = spawn(resolve(systemRoot, "System32", "taskkill.exe"), [
      "/PID", String(pid), "/T", "/F",
    ], {
      env: this.#environment,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolveExit, reject) => {
      taskkill.once("error", reject);
      taskkill.once("close", (code) => {
        if (code === 0 || this.#child.exitCode !== null || this.#child.signalCode !== null) resolveExit();
        else reject(new WebHostError("windows_process_tree_kill_failed", "taskkill failed to retire the Runtime tree"));
      });
    });
  }
}
