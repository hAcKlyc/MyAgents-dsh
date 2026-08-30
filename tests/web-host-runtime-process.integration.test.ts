import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createRuntimeArtifactManifest,
  serializeRuntimeArtifactManifest,
  verifyInstalledRuntimeArtifact,
} from "@myagents-dsh/artifact-verifier/runtime-artifact";
import {
  RUNTIME_VERSION,
} from "@myagents-dsh/protocol";
import {
  GENERATED_PROTOCOL_VERSION,
  GENERATED_SCHEMA_SHA256,
} from "@myagents-dsh/protocol/generated/host-client";
import {
  HostEventHub,
  ReversePortRegistry,
  VerifiedRuntimeProcess,
} from "@myagents-dsh/web-host";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const createArtifact = async (): Promise<Readonly<{ root: string; manifestSha256: string }>> => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "myagents-web-runtime-process-")));
  roots.push(root);
  await chmod(root, 0o755);
  await writeFile(
    resolve(root, "runtime-server-process.artifact.mjs"),
    "setInterval(() => undefined, 1000);\n",
    { mode: 0o644 },
  );
  const inputs = [{ path: "package-lock.json", sha256: "d".repeat(64) }];
  const manifest = createRuntimeArtifactManifest(root, {
    artifactKind: "myagents-dsh-w1-runtime-candidate",
    entrypoint: "runtime-server-process.artifact.mjs",
    runtimeVersion: RUNTIME_VERSION,
    activation: "workstream-evidence-only",
    build: {
      repositoryHead: "e".repeat(40),
      rootLockSha256: "d".repeat(64),
      builderAuthoritySha256: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
      toolchain: { node: "24.14.0", npm: "11.15.0", typescript: "5.9.3" },
      inputs,
    },
    dsh: {
      artifactVersion: "fixture-dsh",
      artifactManifestSha256: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      patchSeriesSha256: "c".repeat(64),
      patches: [{ order: 1, path: "patches/fixture.patch", sha256: "f".repeat(64) }],
    },
    profile: { id: "fixture-profile", digest: "9".repeat(64) },
    protocol: { version: GENERATED_PROTOCOL_VERSION, schemaSha256: GENERATED_SCHEMA_SHA256 },
  });
  await writeFile(
    resolve(root, "runtime-artifact-v1.json"),
    serializeRuntimeArtifactManifest(manifest),
    { mode: 0o644 },
  );
  return Object.freeze({ root, manifestSha256: verifyInstalledRuntimeArtifact(root).manifestSha256 });
};

describe("Reference Web Host verified Runtime process", () => {
  it("verifies before spawn and retires the exact process group", async () => {
    const artifact = await createArtifact();
    const reversePorts = new ReversePortRegistry({
      webSessionId: "web-session-1",
      productSessionId: "product-session-1",
      eventHub: new HostEventHub(),
    });
    const processOwner = new VerifiedRuntimeProcess({
      artifactRoot: artifact.root,
      expectedManifestSha256: artifact.manifestSha256,
      nodeExecutable: process.execPath,
      environment: {},
      reversePorts,
      onFatal: () => undefined,
      onExit: () => undefined,
    });
    const pid = processOwner.pid;
    expect(pid).toBeTypeOf("number");
    const exit = await processOwner.close();
    expect(exit.signal === "SIGTERM" || exit.signal === "SIGKILL" || exit.code === 0).toBe(true);
    if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("refuses credential-bearing child environment names", async () => {
    const artifact = await createArtifact();
    const reversePorts = new ReversePortRegistry({
      webSessionId: "web-session-1",
      productSessionId: "product-session-1",
      eventHub: new HostEventHub(),
    });
    expect(() => new VerifiedRuntimeProcess({
      artifactRoot: artifact.root,
      expectedManifestSha256: artifact.manifestSha256,
      nodeExecutable: process.execPath,
      environment: { PROVIDER_KEY: "synthetic-value" },
      reversePorts,
      onFatal: () => undefined,
      onExit: () => undefined,
    })).toThrow(/secret-free/u);
    await reversePorts.close();
  });
});
