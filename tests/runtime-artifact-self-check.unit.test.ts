import type * as ProductProfileExports from "@myagents-dsh/product-profile";
import { createHash } from "node:crypto";
import {
  assertRuntimeArtifactSelfCheckReport,
  createRuntimeArtifactSelfCheckReport,
  serializeRuntimeArtifactSelfCheckReport,
} from "@myagents-dsh/artifact-verifier/self-check";
import {
  createRuntimeArtifactManifest,
  serializeRuntimeArtifactManifest,
  verifyInstalledRuntimeArtifact,
} from "@myagents-dsh/artifact-verifier/runtime-artifact";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE,
  BATCH1_CANDIDATE_PROFILE_SHA256,
  assertRuntimeNodeVersion,
  resolveRuntimePlatformTarget,
} from "@myagents-dsh/product-profile";
import { PROTOCOL_VERSION, RUNTIME_VERSION } from "@myagents-dsh/protocol";
import {
  runRuntimeArtifactSelfCheck,
} from "@myagents-dsh/runtime-server/self-check";
import {
  OFFICIAL_EXTENSION_SNAPSHOT,
  OFFICIAL_HOST_INTERACTION_REVISION,
  OFFICIAL_STATIC_SKILL_CATALOG,
  OFFICIAL_TOOL_CATALOG,
  runtimeProcessExitCode,
  startOfficialRuntimeServerProcess,
  startRuntimeServerProcess,
} from "@myagents-dsh/runtime-server";
import { runArtifactCli } from "@myagents-dsh/test-host";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@myagents-dsh/product-profile", async (importOriginal) => {
  const actual = await importOriginal<typeof ProductProfileExports>();
  return { ...actual, assertAcceptedDshRuntimeGraph: () => undefined };
});

const outputCollector = (): { readonly output: Writable; readonly read: () => string } => {
  let bytes = "";
  return {
    output: new Writable({
      write(chunk, _encoding, callback) {
        const value: unknown = chunk;
        if (typeof value === "string") bytes += value;
        else if (Buffer.isBuffer(value)) bytes += value.toString();
        else {
          callback(new TypeError("self-check test output must be bytes"));
          return;
        }
        callback();
      },
    }),
    read: () => bytes,
  };
};

const createArtifactFixture = (): Readonly<{
  root: string;
  integrity: ReturnType<typeof verifyInstalledRuntimeArtifact>;
}> => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "myagents-dsh-self-check-unit-")));
  chmodSync(root, 0o755);
  writeFileSync(resolve(root, "runtime-server-process.artifact.mjs"), "export {};\n");
  const dshEntry = resolve(root, "node_modules/@deepseek-ai/dsh-agent/lib/index.js");
  mkdirSync(resolve(dshEntry, ".."), { recursive: true });
  writeFileSync(dshEntry, "export const patchedDshCanary = true;\n");
  const buildInputs = [{ path: "package-lock.json", sha256: "d".repeat(64) }];
  const manifest = createRuntimeArtifactManifest(root, {
    artifactKind: "myagents-dsh-w1-runtime-candidate",
    entrypoint: "runtime-server-process.artifact.mjs",
    runtimeVersion: RUNTIME_VERSION,
    activation: "workstream-evidence-only",
    build: {
      repositoryHead: "e".repeat(40),
      rootLockSha256: "d".repeat(64),
      builderAuthoritySha256: createHash("sha256")
        .update(JSON.stringify(buildInputs))
        .digest("hex"),
      toolchain: { node: "24.20.0", npm: "11.19.0", typescript: "5.9.3" },
      inputs: buildInputs,
    },
    dsh: {
      artifactVersion: ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
      artifactManifestSha256: ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
      sourceCommit: "a".repeat(40),
      patchSeriesSha256: "b".repeat(64),
      patches: [{ order: 1, path: "patches/fixture.patch", sha256: "c".repeat(64) }],
    },
    profile: {
      id: BATCH1_CANDIDATE_PROFILE.profileId,
      digest: BATCH1_CANDIDATE_PROFILE_SHA256,
    },
    protocol: {
      version: PROTOCOL_VERSION,
      schemaSha256: BATCH1_CANDIDATE_PROFILE.protocol.schemaSha256,
    },
  });
  writeFileSync(resolve(root, "runtime-artifact-v1.json"), serializeRuntimeArtifactManifest(manifest));
  return Object.freeze({ root, integrity: verifyInstalledRuntimeArtifact(root) });
};

let artifactFixture!: ReturnType<typeof createArtifactFixture>;
beforeAll(() => { artifactFixture = createArtifactFixture(); });
afterAll(() => { rmSync(artifactFixture.root, { force: true, recursive: true }); });

describe("Runtime artifact self-check", () => {
  it("builds one frozen exact authority for every declared platform target", () => {
    for (const target of ["darwin-arm64", "win32-x64", "linux-x64"] as const) {
      const report = createRuntimeArtifactSelfCheckReport(target, artifactFixture.integrity, "24.20.0");
      expect(report.platform.target).toBe(target);
      expect(report.runtime).toMatchObject({
        activation: "workstream-evidence-only",
        requiredNodeVersion: "24.20.0",
        actualNodeVersion: "24.20.0",
      });
      expect(report.profile.stage).toBe("batch-1-w4-a11");
      expect(report.dsh.packageCount).toBe(77);
      expect(report.contracts).toEqual({
        canonicalToolsSha256: "3b8eae749e9909e9d84cacf49dc6fd8c94c70a00548405adb43ae1540bc6218b",
        eventsSha256: "43d932cdf82e0859bae60c6a02af94ab7c9878973b9616e4664f227673be838d",
        sessionFormat: "dsh-session-events-v1",
        persistenceFormat: "myagents-sqlite-session-v1",
        persistenceSchemaVersion: 10,
        checkpointFormat: "root-write-edit-v1",
      });
      expect(report.protocol.availableHostMethods).toEqual([
        "initialize", "runtime/status", "runtime/shutdown", "interaction/respond",
        "session/create", "session/resume", "session/read", "session/close", "session/compact",
        "session/delete/prepare", "session/delete/commit", "session/delete/purge", "session/delete/rollback",
        "session/delete/status", "session/fork/prepare", "session/fork/commit", "session/fork/abort",
        "session/fork/status",
        "session/rewind/prepare", "session/rewind/commit", "session/rewind/rollback",
        "session/rewind/status",
        "work/list", "work/agent/resume", "work/agent/stop", "work/agent/message",
        "turn/start", "turn/get", "turn/steer", "turn/followUp", "turn/message/cancel",
        "turn/interrupt", "command/invoke", "config/apply", "plan/apply",
        "permission/rules/list", "permission/rules/add", "permission/rules/revoke", "credential/reconcile",
        "extension/replace", "extension/status", "extension/catalog", "extension/reload",
        "utility/run",
      ]);
      expect(report.deferredAuthorities).toEqual([
        "effective-tool-catalog",
      ]);
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.protocol.runtimeCapabilities)).toBe(true);
      expect(Object.isFrozen(report.contracts)).toBe(true);
      expect(serializeRuntimeArtifactSelfCheckReport(report).endsWith("\n")).toBe(true);
      expect(() => assertRuntimeArtifactSelfCheckReport(JSON.parse(
        serializeRuntimeArtifactSelfCheckReport(report),
      ) as unknown, artifactFixture.root)).not.toThrow();
    }
  });

  it("fails closed on wrong toolchain, target, tampering, Proxy, and accessor input", () => {
    expect(assertRuntimeNodeVersion("24.20.0")).toBe("24.20.0");
    expect(() => assertRuntimeNodeVersion("24.13.2")).toThrow("requires Node 24.20.0");
    expect(() => assertRuntimeNodeVersion(new String("24.20.0")))
      .toThrow("must be exact semver");
    expect(() => createRuntimeArtifactSelfCheckReport(
      "darwin-arm64",
      artifactFixture.integrity,
      "24.13.2",
    ))
      .toThrow("requires Node 24.20.0");
    expect(() => createRuntimeArtifactSelfCheckReport(
      "freebsd-x64" as never,
      artifactFixture.integrity,
      "24.20.0",
    ))
      .toThrow("unsupported platform target");
    const report = structuredClone(createRuntimeArtifactSelfCheckReport(
      "darwin-arm64",
      artifactFixture.integrity,
      "24.20.0",
    ));
    (report.profile as unknown as { digest: string }).digest = "f".repeat(64);
    expect(() => assertRuntimeArtifactSelfCheckReport(report, artifactFixture.root))
      .toThrow("differs from exact content authority");
    const contractTampered = structuredClone(createRuntimeArtifactSelfCheckReport(
      "darwin-arm64",
      artifactFixture.integrity,
      "24.20.0",
    ));
    (contractTampered.contracts as unknown as { eventsSha256: string }).eventsSha256 = "e".repeat(64);
    expect(() => assertRuntimeArtifactSelfCheckReport(contractTampered, artifactFixture.root))
      .toThrow("differs from exact content authority");
    expect(() => assertRuntimeArtifactSelfCheckReport(new Proxy({}, {}), artifactFixture.root))
      .toThrow("must contain only JSON data");
    const accessor = Object.defineProperty({}, "platform", {
      enumerable: true,
      get: () => ({ target: "darwin-arm64" }),
    });
    expect(() => assertRuntimeArtifactSelfCheckReport(accessor, artifactFixture.root))
      .toThrow("enumerable own data fields");

    const tampered = createArtifactFixture();
    writeFileSync(resolve(tampered.root, "runtime-server-process.artifact.mjs"), "export const drift = true;\n");
    expect(() => verifyInstalledRuntimeArtifact(tampered.root, tampered.integrity.manifestSha256))
      .toThrow("installed bytes differ");
    rmSync(tampered.root, { force: true, recursive: true });

    const tamperedDsh = createArtifactFixture();
    writeFileSync(
      resolve(tamperedDsh.root, "node_modules/@deepseek-ai/dsh-agent/lib/index.js"),
      "export const patchedDshCanary = false;\n",
    );
    expect(() => verifyInstalledRuntimeArtifact(tamperedDsh.root, tamperedDsh.integrity.manifestSha256))
      .toThrow("installed bytes differ");
    expect(() => verifyInstalledRuntimeArtifact(tamperedDsh.root, "f".repeat(64)))
      .toThrow("expected handoff digest");
    rmSync(tamperedDsh.root, { force: true, recursive: true });

    const modeTampered = createArtifactFixture();
    chmodSync(resolve(modeTampered.root, "runtime-server-process.artifact.mjs"), 0o755);
    expect(() => verifyInstalledRuntimeArtifact(
      modeTampered.root,
      modeTampered.integrity.manifestSha256,
    )).toThrow("installed bytes differ");
    rmSync(modeTampered.root, { force: true, recursive: true });

    const emptyDirectory = createArtifactFixture();
    mkdirSync(resolve(emptyDirectory.root, "unowned-empty"));
    expect(() => verifyInstalledRuntimeArtifact(
      emptyDirectory.root,
      emptyDirectory.integrity.manifestSha256,
    )).toThrow("unowned empty directory");
    rmSync(emptyDirectory.root, { force: true, recursive: true });

    const danglingAlias = createArtifactFixture();
    symlinkSync("missing-target", resolve(danglingAlias.root, "dangling-alias"));
    expect(() => verifyInstalledRuntimeArtifact(
      danglingAlias.root,
      danglingAlias.integrity.manifestSha256,
    )).toThrow();
    rmSync(danglingAlias.root, { force: true, recursive: true });

    const rootAliasTarget = createArtifactFixture();
    const rootAlias = `${rootAliasTarget.root}-alias`;
    symlinkSync(rootAliasTarget.root, rootAlias, "dir");
    expect(() => verifyInstalledRuntimeArtifact(
      rootAlias,
      rootAliasTarget.integrity.manifestSha256,
    )).toThrow("canonical non-symlink directory");
    rmSync(rootAlias, { force: true });
    rmSync(rootAliasTarget.root, { force: true, recursive: true });
  });

  it("allows only --self-check and emits exactly one authority line without Runtime startup", async () => {
    const valid = outputCollector();
    const report = await runRuntimeArtifactSelfCheck(
      ["--self-check"],
      artifactFixture.root,
      valid.output,
    );
    expect(valid.read()).toBe(serializeRuntimeArtifactSelfCheckReport(report));
    expect(valid.read().split("\n").filter(Boolean)).toHaveLength(1);

    const invalid = outputCollector();
    await expect(runRuntimeArtifactSelfCheck(["--diagnostic"], artifactFixture.root, invalid.output))
      .rejects.toThrow("allows only --self-check");
    expect(invalid.read()).toBe("");
    await expect(runRuntimeArtifactSelfCheck(
      new Proxy(["--self-check"], {}),
      artifactFixture.root,
      invalid.output,
    ))
      .rejects.toThrow("accepts exactly one");
  });

  it("selects one exact process platform and maps every exit cause deterministically", () => {
    expect(resolveRuntimePlatformTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(resolveRuntimePlatformTarget("win32", "x64")).toBe("win32-x64");
    expect(resolveRuntimePlatformTarget("linux", "x64")).toBe("linux-x64");
    expect(() => resolveRuntimePlatformTarget(new String("linux"), "x64"))
      .toThrow("primitive strings");
    expect(() => resolveRuntimePlatformTarget("linux", "arm64")).toThrow("unsupported Runtime platform");
    expect(runtimeProcessExitCode({ kind: "shutdown" })).toBe(0);
    expect(runtimeProcessExitCode({ kind: "disposed" })).toBe(0);
    expect(runtimeProcessExitCode({ kind: "signal", signal: "SIGINT" })).toBe(130);
    expect(runtimeProcessExitCode({ kind: "signal", signal: "SIGTERM" })).toBe(143);
    expect(runtimeProcessExitCode({
      kind: "transport_fatal",
      code: "protocol_parse_error",
      retryable: false,
    })).toBe(1);
  });

  it("publishes a credential-free official startup catalog without a bootstrap Provider", () => {
    expect(OFFICIAL_HOST_INTERACTION_REVISION).toBe("host-interaction-v1");
    expect(OFFICIAL_EXTENSION_SNAPSHOT.components).toEqual([]);
    expect(OFFICIAL_STATIC_SKILL_CATALOG.skills).toEqual([]);
    expect(OFFICIAL_TOOL_CATALOG.effectiveTools).toContain("WebFetch");
    expect(OFFICIAL_TOOL_CATALOG.effectiveTools).toContain("WebSearch");
    expect(OFFICIAL_TOOL_CATALOG.effectiveTools).toHaveLength(23);
  });

  it("rejects reflective process and Tester-launch configuration before side effects", async () => {
    await expect(startOfficialRuntimeServerProcess(new Proxy({}, {}) as never))
      .rejects.toThrow("must not be a Proxy");
    await expect(startOfficialRuntimeServerProcess({
      runtimeGeneration: "valid-generation",
      composition: {},
    } as never)).rejects.toThrow("unsupported or non-data fields");
    await expect(startRuntimeServerProcess(new Proxy({}, {}) as never))
      .rejects.toThrow("must not be a Proxy");
    await expect(startRuntimeServerProcess({
      composition: {},
      runtimeGeneration: "valid-generation",
      unexpected: true,
    } as never)).rejects.toThrow("unsupported or non-data fields");
    await expect(startRuntimeServerProcess({
      composition: {},
      runtimeGeneration: "invalid\0generation",
    })).rejects.toThrow("control characters");

    const base = {
      nodeExecutable: process.execPath,
      artifactEntrypoint: process.execPath,
      cwd: process.cwd(),
      environment: {},
    };
    expect(() => runArtifactCli(new Proxy({}, {}) as never)).toThrow("must not be a Proxy");
    expect(() => runArtifactCli({
      ...base,
      args: new Proxy([], {}),
    })).toThrow("arguments must not be a Proxy");
    expect(() => runArtifactCli({
      ...base,
      args: Array(1) as string[],
    })).toThrow("arguments must be dense");
    expect(() => runArtifactCli({
      ...base,
      environment: new Proxy({}, {}),
      args: [],
    })).toThrow("environment must not be a Proxy");
  });
});
