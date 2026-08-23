import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, posix, resolve, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BATCH1_CANDIDATE_PROFILE,
  BATCH1_CANDIDATE_PROFILE_SHA256,
  PLATFORM_EVIDENCE_STATES,
  PLATFORM_TARGETS,
  assertFoundationProfile,
  buildOfficialProductProfile,
  platformContractManifest,
  profileDigest,
  selectPlatformAdapter,
  type OfficialProductProfileManifest,
} from "../packages/product-profile/src/index.js";
import {
  buildProductProfileArtifacts,
  findProductProfileDrift,
} from "../scripts/product-profile-generation.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("official product profile authority", () => {
  it("regenerates the profile, platform matrix, and evidence byte-for-byte", async () => {
    const artifacts = await buildProductProfileArtifacts(repositoryRoot);
    expect(artifacts.size).toBe(5);
    expect(await findProductProfileDrift(artifacts, (relativePath) =>
      readFile(resolve(repositoryRoot, relativePath), "utf8"))).toEqual([]);

    const manifestBytes = await readFile(resolve(
      repositoryRoot,
      "packages/product-profile/manifests/official-product-profile-v1.json",
    ), "utf8");
    const evidence = JSON.parse(await readFile(resolve(
      repositoryRoot,
      "specs/contracts/product-profile-v1-evidence.json",
    ), "utf8")) as { profileDigest: string; installedPluginCount: number; activationState: string };
    const manifest = JSON.parse(manifestBytes) as OfficialProductProfileManifest;
    assertFoundationProfile(manifest);
    expect(profileDigest(manifest)).toBe(evidence.profileDigest);
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(evidence.profileDigest);
    expect(evidence).toMatchObject({
      installedPluginCount: 0,
      activationState: "forbidden-until-patched-dsh-and-batch-1-gate",
    });
    expect(BATCH1_CANDIDATE_PROFILE).toMatchObject({
      profileId: "myagents-dsh-batch-1-candidate-v1",
      stage: "batch-1-w4-a10",
      runtimeActivation: "workstream-evidence-only",
      composition: {
        maxPrimaryRootSessions: 1,
      },
      protocol: {
        availableHostMethods: [
          "initialize",
          "runtime/status",
          "runtime/shutdown",
          "interaction/respond",
          "session/create",
          "session/resume",
          "session/read",
          "session/close",
          "session/compact",
          "session/delete/prepare",
          "session/delete/commit",
          "session/delete/purge",
          "session/delete/rollback",
          "session/delete/status",
          "session/fork/prepare",
          "session/fork/commit",
          "session/fork/abort",
          "session/fork/status",
          "session/rewind/prepare",
          "session/rewind/commit",
          "session/rewind/rollback",
          "session/rewind/status",
        ],
        availableNotifications: ["initialized", "rpc/cancel"],
        availableReverseMethods: [
          "host/credential/resolve",
          "host/interaction/request",
          "host/tool/execute",
          "host/hook/execute",
          "host/attachment/put",
          "host/attachment/acquire",
          "host/attachment/release",
        ],
      },
    });
    expect(BATCH1_CANDIDATE_PROFILE.composition.installedPluginAllowlist).toEqual(expect.arrayContaining([
      "@myagents-dsh/host-ports:HostPortService",
      "@myagents-dsh/runtime-product:ProductSessionService",
      "@myagents-dsh/operation-runtime:SdkOperationService",
      "@myagents-dsh/rpc-server:NativeRpcServer",
    ]));
    const candidateBytes = await readFile(resolve(
      repositoryRoot,
      "packages/product-profile/manifests/batch-1-candidate-profile-v1.json",
    ), "utf8");
    expect(createHash("sha256").update(candidateBytes).digest("hex"))
      .toBe(BATCH1_CANDIDATE_PROFILE_SHA256);
  });

  it("fails closed on generated drift and premature Runtime activation", async () => {
    const artifacts = await buildProductProfileArtifacts(repositoryRoot);
    expect(await findProductProfileDrift(artifacts, (relativePath) => Promise.resolve(
      relativePath.endsWith("official-product-profile-v1.json") ? "edited\n" : artifacts.get(relativePath),
    ))).toEqual(["packages/product-profile/manifests/official-product-profile-v1.json"]);

    const manifest = JSON.parse(await readFile(resolve(
      repositoryRoot,
      "packages/product-profile/manifests/official-product-profile-v1.json",
    ), "utf8")) as OfficialProductProfileManifest;
    const activated = structuredClone(manifest) as unknown as {
      runtimeActivation: string;
      composition: { installedPluginAllowlist: string[] };
    };
    activated.runtimeActivation = "active";
    activated.composition.installedPluginAllowlist.push("unreviewed-plugin");
    expect(() => assertFoundationProfile(activated as unknown as OfficialProductProfileManifest))
      .toThrow("must not activate");

    const injected = structuredClone(manifest) as unknown as Record<string, unknown>;
    injected.unreviewedRuntimeEntry = "placeholder";
    expect(() => assertFoundationProfile(injected)).toThrow("keys differ");

    const wrongTarget = structuredClone(manifest) as unknown as {
      platform: { targets: string[] };
    };
    wrongTarget.platform.targets = ["darwin-arm64"];
    expect(() => assertFoundationProfile(wrongTarget)).toThrow("platform authority differs");

    const wrongOwner = structuredClone(manifest) as unknown as {
      composition: { packageAuthorities: Array<{ name: string }> };
    };
    const firstAuthority = wrongOwner.composition.packageAuthorities[0];
    expect(firstAuthority).toBeDefined();
    if (firstAuthority !== undefined) firstAuthority.name = "untrusted-package";
    expect(() => assertFoundationProfile(wrongOwner)).toThrow("identity is invalid");

    const plausibleWrongAuthority = structuredClone(manifest) as unknown as {
      protocol: { version: string; schemaSha256: string };
      dsh: { release: string; baselineSha256: string };
      composition: { packageAuthorities: unknown[] };
    };
    plausibleWrongAuthority.protocol.version = "2.0.0-draft.2";
    plausibleWrongAuthority.protocol.schemaSha256 = "a".repeat(64);
    plausibleWrongAuthority.dsh.release = "0.1.0-rc.7";
    plausibleWrongAuthority.dsh.baselineSha256 = "b".repeat(64);
    plausibleWrongAuthority.composition.packageAuthorities =
      plausibleWrongAuthority.composition.packageAuthorities.slice(0, 1);
    expect(() => assertFoundationProfile(plausibleWrongAuthority))
      .toThrow("exact generated official authority");
  });

  it("rejects imprecise or out-of-authority package identities", () => {
    const base = {
      protocolVersion: "2.0.0-draft.1",
      protocolSchemaSha256: "a".repeat(64),
      dshRelease: "0.1.0-rc.6",
      dshBaselineSha256: "b".repeat(64),
      foundationPackages: { "@myagents-dsh/product-profile": "0.0.0" },
    } as const;
    expect(() => buildOfficialProductProfile({
      ...base,
      dshPackages: { "@deepseek-ai/dsh-agent-loop": "^0.1.0-rc.6" },
    })).toThrow("exact version");
    expect(() => buildOfficialProductProfile({
      ...base,
      dshPackages: { "untrusted-agent-loop": "0.1.0" },
    })).toThrow("only @deepseek-ai");
  });
});

describe("composition-selected platform adapter contracts", () => {
  it("owns exactly three targets and a non-overclaiming evidence vocabulary", () => {
    expect(PLATFORM_TARGETS).toEqual(["darwin-arm64", "win32-x64", "linux-x64"]);
    expect(PLATFORM_EVIDENCE_STATES).toContain("implementation-complete_pending-native-validation");
    expect(platformContractManifest.targets.map(({ evidenceState }) => evidenceState))
      .toEqual([
        "contract_defined",
        "implementation-complete_pending-native-validation",
        "implementation-complete_pending-native-validation",
      ]);
    expect(platformContractManifest.targets.some(({ evidenceState }) => evidenceState === "native_verified"))
      .toBe(false);
    expect(Object.isFrozen(PLATFORM_TARGETS)).toBe(true);
    expect(Object.isFrozen(PLATFORM_EVIDENCE_STATES)).toBe(true);
    expect(Object.isFrozen(platformContractManifest.targets)).toBe(true);
    expect(() => (PLATFORM_TARGETS as unknown as string[]).push("unsupported-x64")).toThrow();
    expect(() => (PLATFORM_EVIDENCE_STATES as unknown as string[]).push("fabricated"))
      .toThrow();
    expect(() => (platformContractManifest.targets as unknown as unknown[]).push({})).toThrow();
    expect(() => selectPlatformAdapter("unsupported-x64")).toThrow("unsupported platform target");
    expect(() => selectPlatformAdapter(new String("darwin-arm64") as unknown as string)).toThrow("unsupported platform target");
    expect(() => selectPlatformAdapter({
      [Symbol.toPrimitive]: () => "linux-x64",
    } as unknown as string)).toThrow("unsupported platform target");
  });

  it.each(PLATFORM_TARGETS)("executes the shared shell/process/stdio/root/SQLite conformance for %s", async (target) => {
    const adapter = selectPlatformAdapter(target);
    const isWindows = target === "win32-x64";
    const root = isWindows ? "C:\\Fixture" : "/fixture";
    const script = isWindows ? `${root}\\bin\\run.sh` : `${root}/bin/run.sh`;
    const shell = adapter.shellLaunchPlan(script, ["--fixture", "value"]);
    expect(shell.executableRef).toBe("bundled-bash");
    expect(shell.arguments).toEqual([adapter.normalizeAbsolutePath(script), "--fixture", "value"]);
    expect(shell.utf8PreludeRef).toBe(isWindows ? "windows-utf8-v1" : undefined);

    const signals: string[] = [];
    const waits = [false, true];
    const cleanup = await adapter.cleanupProcessTree({
      signal(signal) {
        signals.push(signal);
        return Promise.resolve();
      },
      wait() {
        return Promise.resolve(waits.shift() ?? false);
      },
    }, 25);
    expect(cleanup).toEqual({ graceful: adapter.processTree.gracefulSignal, forced: true });
    expect(signals).toEqual([adapter.processTree.gracefulSignal, adapter.processTree.forceSignal]);

    const encoded = adapter.encodeStdioFrame({ jsonrpc: "2.0", id: 1 });
    expect(new TextDecoder().decode(encoded)).toBe('{"jsonrpc":"2.0","id":1}\n');
    expect(encoded.at(-1)).toBe(10);

    const roots = adapter.normalizeExplicitRoots({
      temporary: isWindows ? `${root}\\tmp` : `${root}/tmp`,
      runtimeHome: isWindows ? `${root}\\home` : `${root}/home`,
      attachmentStaging: isWindows ? `${root}\\attachments` : `${root}/attachments`,
    });
    expect(new Set(Object.values(roots)).size).toBe(3);
    expect(() => adapter.normalizeExplicitRoots({
      temporary: roots.temporary,
      runtimeHome: roots.temporary,
      attachmentStaging: roots.attachmentStaging,
    })).toThrow("non-overlapping");

    const sqlite = adapter.sqliteDurabilityPlan(isWindows ? `${root}\\state\\session.db` : `${root}/state/session.db`);
    expect(sqlite.pragmas).toEqual(["journal_mode=WAL", "synchronous=FULL"]);
    expect(sqlite.parentDirectoryFlush).toBe(adapter.sqlite.parentDirectoryFlush);
  });

  it.each(["darwin-arm64", "linux-x64"] as const)("conforms for %s POSIX paths and publication", (target) => {
    const adapter = selectPlatformAdapter(target);
    expect(adapter.normalizeAbsolutePath("/fixture/workspace/one/../two")).toBe("/fixture/workspace/two");
    expect(adapter.samePath("/fixture/workspace", "/fixture//workspace")).toBe(true);
    expect(() => adapter.normalizeAbsolutePath("relative/path")).toThrow("must be absolute");
    const plan = adapter.publicationPlan("/fixture/workspace/state.db", "nonce-1");
    expect(dirname(plan.temporary)).toBe(posix.dirname(plan.target));
    expect(plan.steps).toEqual([
      "create-exclusive-same-directory",
      "flush-file",
      "atomic-replace",
      "flush-parent-directory",
    ]);
    expect(adapter.artifactName("myagents-dsh", "0.0.0")).toBe(`myagents-dsh-0.0.0-${target}.tar.gz`);
  });

  it("conforms for Windows identity, publication, process, and packaging", () => {
    const adapter = selectPlatformAdapter("win32-x64");
    expect(adapter.normalizeAbsolutePath("C:\\Fixture\\Workspace\\one\\..\\two"))
      .toBe("C:\\Fixture\\Workspace\\two");
    expect(adapter.samePath("C:\\FIXTURE\\workspace", "c:\\fixture\\WORKSPACE")).toBe(true);
    expect(() => adapter.normalizeAbsolutePath("relative\\path")).toThrow("fully qualified and absolute");
    expect(() => adapter.normalizeAbsolutePath("\\workspace"))
      .toThrow("fully qualified and absolute");
    expect(() => adapter.normalizeAbsolutePath("/workspace"))
      .toThrow("fully qualified and absolute");
    const plan = adapter.publicationPlan("C:\\Fixture\\state.db", "nonce-1");
    expect(win32.dirname(plan.temporary)).toBe(win32.dirname(plan.target));
    expect(plan.steps).toEqual([
      "create-exclusive-same-directory",
      "flush-file",
      "atomic-replace-with-bounded-retry",
      "record-parent-flush-unavailable",
    ]);
    expect(adapter.processTree).toMatchObject({ owner: "job-object", forceSignal: "TerminateJobObject" });
    expect(adapter.artifactName("myagents-dsh", "0.0.0")).toBe("myagents-dsh-0.0.0-win32-x64.zip");
  });
});
