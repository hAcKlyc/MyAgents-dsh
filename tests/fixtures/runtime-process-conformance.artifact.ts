import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import type { RuntimeArtifactSelfCheckReport } from "@myagents-dsh/artifact-verifier/self-check";
import { verifyInstalledRuntimeArtifact } from "@myagents-dsh/artifact-verifier/runtime-artifact";
import {
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  type InitializeParams,
} from "@myagents-dsh/protocol";
import protocolFixturesJson from "@myagents-dsh/protocol/protocol-fixtures.json" with { type: "json" };
import {
  launchArtifactRuntime,
  runArtifactCli,
  type ArtifactRuntimeProcess,
} from "@myagents-dsh/test-host";

type JsonObject = Record<string, unknown>;

const entrypoint = resolve(process.argv[2] ?? "");
assert.equal(process.argv.length, 3, "process conformance accepts exactly one artifact entrypoint");

const processTestRoot = realpathSync(mkdtempSync(resolve(tmpdir(), "myagents-dsh-process-conformance-")));
const processHome = resolve(processTestRoot, "home");
const processTemporary = resolve(processTestRoot, "temporary");
const runtimeHome = resolve(processTestRoot, "runtime-home");
const workspace = resolve(processTestRoot, "workspace");
const attachmentStagingRoot = resolve(processTestRoot, "attachments");
for (const path of [processHome, processTemporary, runtimeHome, workspace, attachmentStagingRoot]) {
  mkdirSync(path);
}
const cleanupProcessTestRoot = (): void => rmSync(processTestRoot, { force: true, recursive: true });
process.once("exit", cleanupProcessTestRoot);

const environment = Object.freeze({
  ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
  ...Object.fromEntries([
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "TZ",
  ].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  })),
  HOME: processHome,
  TEMP: processTemporary,
  TMP: processTemporary,
  TMPDIR: processTemporary,
  USERPROFILE: processHome,
});

const waitForExit = async (
  runtime: ArtifactRuntimeProcess,
  scenario: string,
  timeoutMs?: number,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> => {
  try {
    return await runtime.waitForExit(timeoutMs);
  } catch (error) {
    throw new Error(`Runtime process scenario did not converge: ${scenario}`, { cause: error });
  }
};

const assertTransportClosed = (
  runtime: ArtifactRuntimeProcess,
  scenario: string,
): string => {
  const codes = runtime.hostFatalErrors.map(({ code }) => code);
  assert.equal(codes.length, 1, `${scenario} must preserve one raw Host transport-close observation`);
  const [code] = codes;
  if (scenario === "writer-failure") {
    assert.equal(code, "protocol_input_closed");
  } else {
    assert(code === "protocol_eof" || code === "protocol_output_closed", `${scenario} closed as ${String(code)}`);
  }
  return code;
};

const transportClosures: Record<string, string> = {};

const initializeParams = (): InitializeParams => {
  const fixtures = protocolFixturesJson as unknown as {
    readonly valid: readonly { readonly name: string; readonly frame: JsonObject }[];
  };
  const initialize = fixtures.valid.find(({ name }) => name === "initialize-request");
  assert(initialize !== undefined);
  const params = structuredClone(initialize.frame.params) as InitializeParams;
  params.protocol.minVersion = PROTOCOL_VERSION;
  params.protocol.maxVersion = PROTOCOL_VERSION;
  params.host.nodeVersion = process.versions.node;
  params.runtimeHome = runtimeHome;
  params.workspace.path = workspace;
  params.executionEnvironment.workspace.canonicalRoot = workspace;
  params.executionEnvironment.workspace.allowedReadRoots = [workspace];
  params.executionEnvironment.workspace.allowedWriteRoots = [workspace];
  params.executionEnvironment.attachmentStagingRoot = attachmentStagingRoot;
  params.executionEnvironment.environment.allowedKeys = Object.keys(environment).sort();
  params.executionEnvironment.executables = {
    shellRef: "runtime-shell", bundledNodeRef: "bundled-node", ripgrepRef: "bundled-ripgrep",
    shellDialect: process.platform === "win32" ? "pwsh" : "bash", pathPolicy: "sealed",
    allowedCommandRefs: ["runtime-shell", "bundled-node", "bundled-ripgrep"],
  };
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    params.host.platform = "darwin";
    params.host.arch = process.arch;
  } else if (process.platform === "linux" && process.arch === "x64") {
    params.host.platform = "linux";
    params.host.arch = "x64";
  } else if (process.platform === "win32" && process.arch === "x64") {
    params.host.platform = "win32";
    params.host.arch = "x64";
  } else {
    throw new Error(`unsupported native process-test target ${process.platform}-${process.arch}`);
  }
  return params;
};

const selfCheck = runArtifactCli({
  nodeExecutable: process.execPath,
  artifactEntrypoint: entrypoint,
  cwd: dirname(entrypoint),
  environment,
  args: ["--self-check"],
});
assert.equal(selfCheck.status, 0);
assert.equal(selfCheck.signal, null);
assert.equal(selfCheck.stderr, "");
assert.equal(selfCheck.stdout.split("\n").filter(Boolean).length, 1);
const selfCheckReport = JSON.parse(selfCheck.stdout) as RuntimeArtifactSelfCheckReport;
const independentlyVerifiedArtifact = verifyInstalledRuntimeArtifact(
  dirname(entrypoint),
  selfCheckReport.runtime.artifactManifestSha256,
);
assert.equal(independentlyVerifiedArtifact.fileCount, selfCheckReport.runtime.artifactFileCount);
const expectedRuntimeManifestSha256 = selfCheckReport.runtime.artifactManifestSha256;
const launch = (): ArtifactRuntimeProcess => {
  verifyInstalledRuntimeArtifact(dirname(entrypoint), expectedRuntimeManifestSha256);
  return launchArtifactRuntime({
    nodeExecutable: process.execPath,
    artifactEntrypoint: entrypoint,
    cwd: dirname(entrypoint),
    environment,
  });
};

const invalidCli = runArtifactCli({
  nodeExecutable: process.execPath,
  artifactEntrypoint: entrypoint,
  cwd: dirname(entrypoint),
  environment,
  args: ["--diagnostic-escape"],
});
assert.equal(invalidCli.status, 1);
assert.equal(invalidCli.stdout, "");
assert.match(invalidCli.stderr, /allows only --self-check/u);

const normal = launch();
const initialized = await normal.client.initialize(initializeParams());
assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
assert.equal(initialized.profileDigest, selfCheckReport.profile.digest);
assert.equal(initialized.schemaSha256, selfCheckReport.protocol.schemaSha256);
assert.equal(initialized.runtimeEngine.version, selfCheckReport.dsh.artifactVersion);
await normal.client.initialized();
assert.deepEqual(await normal.client.runtimeStatus({}), {
  runtimeGeneration: "artifact-process-generation",
  initialized: true,
  primarySessionState: "unbound",
  active: {
    rootTurns: 0,
    queuedInputs: 0,
    childAgents: 0,
    toolCalls: 0,
    mcpCalls: 0,
    interactions: 0,
    compactions: 0,
    mutations: 0,
    extensionReconciles: 0,
    utilityRuns: 0,
  },
});
assert.deepEqual(await normal.client.runtimeShutdown({ reason: "process-conformance" }), { ok: true });
assert.deepEqual(await waitForExit(normal, "normal-shutdown"), { code: 0, signal: null });
assert.equal(normal.stderr, "");
transportClosures.normal = assertTransportClosed(normal, "normal-shutdown");
await normal.close();

const eof = launch();
eof.endRuntimeInput();
assert.deepEqual(await waitForExit(eof, "stdin-eof"), { code: 1, signal: null });
assert.equal(eof.stderr, "");
transportClosures.eof = assertTransportClosed(eof, "stdin-eof");
await eof.close();

const malformed = launch();
malformed.writeRaw("{not-json}\n");
assert.deepEqual(await waitForExit(malformed, "malformed-frame"), { code: 1, signal: null });
assert.equal(malformed.stderr, "");
transportClosures.malformed = assertTransportClosed(malformed, "malformed-frame");
await malformed.close();

const invalidUtf8 = launch();
invalidUtf8.writeRaw(Uint8Array.from([0xff, 0x0a]));
assert.deepEqual(await waitForExit(invalidUtf8, "invalid-utf8"), { code: 1, signal: null });
assert.equal(invalidUtf8.stderr, "");
transportClosures.invalidUtf8 = assertTransportClosed(invalidUtf8, "invalid-utf8");
await invalidUtf8.close();

const oversized = launch();
oversized.writeRaw(`{${"a".repeat(REFERENCE_PROTOCOL_LIMITS.maxFrameBytes + 1)}}\n`);
assert.deepEqual(await waitForExit(oversized, "oversized-frame"), { code: 1, signal: null });
assert.equal(oversized.stderr, "");
transportClosures.oversized = assertTransportClosed(oversized, "oversized-frame");
await oversized.close();

const preStartSignal = launch();
preStartSignal.signal("SIGTERM");
assert.deepEqual(await waitForExit(preStartSignal, "pre-start-signal"), {
  code: null,
  signal: "SIGTERM",
});
assert.equal(preStartSignal.stderr, "");
transportClosures.preStartSignal = assertTransportClosed(preStartSignal, "pre-start-signal");
await preStartSignal.close();

const signalResults: Array<Readonly<{ signal: "SIGINT" | "SIGTERM"; code: number | null }>> = [];
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  const runtime = launch();
  await runtime.client.initialize(initializeParams());
  runtime.signal(signal);
  const exit = await waitForExit(runtime, signal);
  assert.deepEqual(exit, process.platform === "win32"
    ? { code: null, signal }
    : { code, signal: null });
  assert.equal(runtime.stderr, "");
  transportClosures[signal] = assertTransportClosed(runtime, signal);
  signalResults.push(Object.freeze({ signal, code: exit.code }));
  await runtime.close();
}

const forcedKill = launch();
await forcedKill.client.initialize(initializeParams());
forcedKill.signal("SIGKILL");
assert.deepEqual(await waitForExit(forcedKill, "forced-kill"), { code: null, signal: "SIGKILL" });
assert.equal(forcedKill.stderr, "");
transportClosures.forcedKill = assertTransportClosed(forcedKill, "forced-kill");
await forcedKill.close();

const restarted = launch();
const restartedInitialize = await restarted.client.initialize(initializeParams());
assert.equal(restartedInitialize.profileDigest, selfCheckReport.profile.digest);
await restarted.client.initialized();
assert.deepEqual(await restarted.client.runtimeShutdown({ reason: "restart-conformance" }), { ok: true });
assert.deepEqual(await waitForExit(restarted, "restart-after-force-kill"), { code: 0, signal: null });
assert.equal(restarted.stderr, "");
transportClosures.restart = assertTransportClosed(restarted, "restart-after-force-kill");
await restarted.close();

const timedOut = launch();
await assert.rejects(
  waitForExit(timedOut, "timeout-cleanup", 100),
  /did not converge: timeout-cleanup/u,
);
assert.deepEqual(await timedOut.whenExited(), { code: null, signal: "SIGKILL" });
assert.equal(timedOut.stderr, "");
transportClosures.timeout = assertTransportClosed(timedOut, "timeout-cleanup");
await timedOut.close();

const writerFailure = launch();
writerFailure.closeRuntimeOutput();
writerFailure.writeRaw(`${JSON.stringify({
  jsonrpc: "2.0",
  id: "writer-failure-initialize",
  method: "initialize",
  params: initializeParams(),
})}\n`);
assert.deepEqual(await waitForExit(writerFailure, "writer-failure"), { code: 1, signal: null });
assert.equal(writerFailure.stderr, "");
transportClosures.writerFailure = assertTransportClosed(writerFailure, "writer-failure");
await writerFailure.close();

let detachedDescendantCleanup: true | "not-applicable" = "not-applicable";
if (process.platform !== "win32") {
  const waitForProcessAbsent = async (pid: number, scenario: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, 10);
      });
    }
    assert.fail(`${scenario} descendant remained observable after its bounded reap interval`);
  };
  const runDescendantScenario = async (
    name: "parent-exit" | "stderr-overflow",
  ): Promise<void> => {
    const pidPath = resolve(processTestRoot, `${name}.pid`);
    const scriptPath = resolve(processTestRoot, `${name}.mjs`);
    const source = [
      "import { writeFileSync } from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.env.PID_PATH, String(descendant.pid));",
      "descendant.unref();",
      name === "stderr-overflow"
        ? "process.stderr.write('x'.repeat(70_000)); setInterval(() => {}, 1000);"
        : "void 0;",
    ].join("\n");
    writeFileSync(scriptPath, source);
    const runtime = launchArtifactRuntime({
      nodeExecutable: process.execPath,
      artifactEntrypoint: scriptPath,
      cwd: processTestRoot,
      environment: Object.freeze({ ...environment, PID_PATH: pidPath }),
    });
    const exit = await waitForExit(runtime, `detached-${name}`);
    if (name === "parent-exit") {
      assert.deepEqual(exit, { code: 0, signal: null });
    } else {
      assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
      assert(runtime.stderr.length > 65_536);
    }
    const descendantPid = Number(readFileSync(pidPath, "utf8"));
    assert(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    if (name === "parent-exit") assert.doesNotThrow(() => process.kill(descendantPid, 0));
    await runtime.close();
    await waitForProcessAbsent(descendantPid, name);
  };
  await runDescendantScenario("parent-exit");
  await runDescendantScenario("stderr-overflow");
  detachedDescendantCleanup = true;
}

verifyInstalledRuntimeArtifact(dirname(entrypoint), selfCheckReport.runtime.artifactManifestSha256);

process.removeListener("exit", cleanupProcessTestRoot);
cleanupProcessTestRoot();
process.stdout.write(`${JSON.stringify({
  selfCheck: selfCheckReport,
  invalidCliRejected: true,
  lifecycle: Object.freeze({ initialize: true, initialized: true, status: true, shutdown: true }),
  faults: Object.freeze({
    eof: 1,
    forcedKill: "SIGKILL",
    invalidUtf8: 1,
    malformed: 1,
    oversized: 1,
    preStartSignal: "SIGTERM",
    restart: 0,
    timeoutCleanup: "SIGKILL",
    writerFailure: 1,
    detachedDescendantCleanup,
    signals: signalResults,
  }),
  transportClosures,
  stdoutProtocolOnly: true,
  stderrClean: true,
})}\n`);
