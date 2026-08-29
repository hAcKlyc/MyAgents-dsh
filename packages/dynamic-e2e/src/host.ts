import {
  JsonRpcPeer,
  REFERENCE_PROTOCOL_LIMITS,
  type ProtocolError,
} from "@myagents-dsh/protocol";
import {
  GeneratedHostClient,
  type GeneratedHostRequestHandlers,
} from "@myagents-dsh/protocol/generated/host-client";
import { StandardTestHost } from "@myagents-dsh/test-host";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { DynamicArtifactIdentity } from "./artifact.js";
import { SecretCanaryByteScanner } from "./redaction.js";

export class DynamicArtifactHostProcess {
  readonly client: GeneratedHostClient;
  readonly standardHost: StandardTestHost;
  readonly fatalErrors: ProtocolError[] = [];
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #peer: JsonRpcPeer;
  readonly #exit: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
  readonly #processGroupId: number | undefined;
  readonly #secretCanaries: readonly string[];
  readonly #stdoutSecretScanner: SecretCanaryByteScanner;
  #closePromise: Promise<void> | undefined;
  #stderr = "";

  constructor(options: Readonly<{
    artifact: DynamicArtifactIdentity;
    cwd: string;
    temporaryRoot: string;
    secretCanaries?: readonly string[];
    createHandlers(client: GeneratedHostClient): Partial<GeneratedHostRequestHandlers>;
  }>) {
    this.#secretCanaries = Object.freeze([...(options.secretCanaries ?? [])]);
    this.#stdoutSecretScanner = new SecretCanaryByteScanner(this.#secretCanaries);
    this.#child = spawn(globalThis.process.execPath, [
      "--disable-warning=ExperimentalWarning",
      options.artifact.entrypoint,
    ], {
      cwd: options.cwd,
      env: {
        PATH: globalThis.process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: options.temporaryRoot,
      },
      detached: globalThis.process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#processGroupId = globalThis.process.platform === "win32" ? undefined : this.#child.pid;
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#stdoutSecretScanner.observe(chunk);
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
      if (this.#stderr.length > 65_536) void this.close();
    });
    this.#peer = new JsonRpcPeer({
      input: this.#child.stdout,
      output: this.#child.stdin,
      role: "host",
      limits: REFERENCE_PROTOCOL_LIMITS,
      onFatalError: (error) => { this.fatalErrors.push(error); },
    });
    this.client = new GeneratedHostClient(this.#peer);
    this.standardHost = new StandardTestHost(this.client, options.createHandlers(this.client));
    this.#exit = new Promise((resolveExit, reject) => {
      this.#child.once("error", reject);
      this.#child.once("close", (code, signal) => resolveExit(Object.freeze({ code, signal })));
    });
  }

  get stderr(): string { return this.#stderr; }

  async waitForExit(timeoutMs: number): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError("dynamic Runtime exit timeout is invalid");
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#exit,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("dynamic Runtime did not exit within its bound")), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.standardHost.dispose();
      this.#peer.close();
      this.#kill("SIGKILL");
      await this.#exit;
      if (this.#processGroupId !== undefined) {
        let settled = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            globalThis.process.kill(-this.#processGroupId, 0);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ESRCH" || code === "EPERM") {
              settled = true;
              break;
            }
            throw error;
          }
          await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 10); });
        }
        if (!settled) throw new Error("dynamic Runtime process group remained live after close");
      }
      if (this.#stdoutSecretScanner.observed || this.#secretCanaries.some((canary) => this.#stderr.includes(canary))) {
        throw new Error("secret canary crossed a dynamic Runtime output boundary");
      }
    })();
    return this.#closePromise;
  }

  #kill(signal: "SIGKILL"): void {
    if (this.#processGroupId !== undefined) {
      try {
        globalThis.process.kill(-this.#processGroupId, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill(signal);
  }
}
