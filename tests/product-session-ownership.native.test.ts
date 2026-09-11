import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workers = Object.freeze({
  kernel: fileURLToPath(new URL("./fixtures/session-ownership-process.ts", import.meta.url)),
  persistence: fileURLToPath(new URL("./fixtures/session-persistence-process.ts", import.meta.url)),
});

interface FixtureProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  readonly firstLine: Promise<string>;
  readonly diagnostics: () => string;
}

const start = (path: string, mode: "hold" | "probe", kind: keyof typeof workers): FixtureProcess => {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), workers[kind], path, mode], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let diagnostics = "";
  child.stderr.setEncoding("utf8").on("data", (value: string) => { diagnostics += value; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const firstLine = Promise.race([
    once(lines, "line", { signal: AbortSignal.timeout(5_000) }).then(([line]: unknown[]) => String(line)),
    exited.then((code) => { throw new Error(`${kind}/${mode} exited before its receipt (${String(code)}): ${diagnostics}`); }),
  ]).catch((cause: unknown) => {
    throw new Error(`${kind}/${mode} receipt failed: ${diagnostics}`, { cause });
  });
  return { child, exited, firstLine, diagnostics: () => diagnostics };
};

const stop = async (process: FixtureProcess): Promise<void> => {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGKILL");
  await process.exited;
};

for (const kind of ["kernel", "persistence"] as const) {
for (const disposition of ["close", "crash"] as const) {
  void test(`${kind} Session ownership excludes a separate process and recovers after ${disposition}`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "myagents-session-ownership-native-"));
    const processes: FixtureProcess[] = [];
    try {
      const path = kind === "kernel" ? join(root, "session.lock") : root;
      const owner = start(path, "hold", kind);
      processes.push(owner);
      assert.equal(await owner.firstLine, "owned", owner.diagnostics());
      const contender = start(path, "probe", kind);
      processes.push(contender);
      assert.equal(await contender.firstLine, "busy", contender.diagnostics());
      assert.equal(await contender.exited, 0, contender.diagnostics());
      if (disposition === "close") owner.child.stdin.end();
      else owner.child.kill("SIGKILL");
      const ownerExit = await owner.exited;
      if (disposition === "close") assert.equal(ownerExit, 0, owner.diagnostics());
      const successor = start(path, "probe", kind);
      processes.push(successor);
      assert.equal(await successor.firstLine, "released", successor.diagnostics());
      assert.equal(await successor.exited, 0, successor.diagnostics());
    } finally {
      await Promise.all(processes.map(stop));
      await rm(root, { recursive: true, force: true });
    }
  });
}
}
