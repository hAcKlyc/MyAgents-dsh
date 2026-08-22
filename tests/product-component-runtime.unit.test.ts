import { Context } from "@deepseek-ai/cordis";
import {
  ProductComponentService,
  validateExtensionSnapshot,
  type ComponentCompiler,
  type ExtensionComponent,
  type ProductComponentServiceController,
} from "@myagents-dsh/component-runtime";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
  extensionSnapshotDigest,
  type EffectiveToolCatalogSnapshot,
  type MethodParams,
} from "@myagents-dsh/protocol";
import { afterEach, describe, expect, it } from "vitest";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
});

const catalog = (): EffectiveToolCatalogSnapshot => {
  const authority = Object.freeze({
    formatVersion: 1 as const,
    contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
    implementationCatalog: CANONICAL_TOOL_NAMES,
    effectiveTools: CANONICAL_TOOL_NAMES,
    revision: "canonical-tools-v1",
    diagnostics: Object.freeze(CANONICAL_TOOL_NAMES.map((tool) => Object.freeze({
      tool,
      available: true,
    }))),
  });
  return Object.freeze({ ...authority, digest: effectiveToolCatalogDigest(authority) });
};

type SnapshotAuthority = Omit<MethodParams<"extension/replace">, "digest">;

const snapshot = (
  revision: string,
  components: SnapshotAuthority["components"] = [],
  resources: SnapshotAuthority["resources"] = [],
): MethodParams<"extension/replace"> => {
  const authority: SnapshotAuthority = {
    formatVersion: 1,
    revision,
    components: [...components],
    resources: [...resources],
    skillSourcePolicy: { revision: "skills-v1", roots: [] },
  };
  return Object.freeze({ ...authority, digest: extensionSnapshotDigest(authority) });
};

const agentComponent = (id: string): SnapshotAuthority["components"][number] => Object.freeze({
  id,
  enabled: true,
  kind: "agent",
  descriptor: Object.freeze({
    description: `Agent ${id}`,
    prompt: `Synthetic prompt for ${id}`,
  }),
});

type Harness = Readonly<{
  controller: ProductComponentServiceController;
  root: Context;
  service: ProductComponentService;
}>;

const mount = async (options: Readonly<{
  boundary?: (signal: AbortSignal, commit: () => void) => Promise<boolean>;
  compilers?: readonly ComponentCompiler[];
  initial?: MethodParams<"extension/replace">;
  whenUnused?: (identity: Readonly<{ revision: string; digest: string }>) => Promise<void>;
}> = {}): Promise<Harness> => {
  const root = new Context();
  contexts.push(root);
  let controller: ProductComponentServiceController | undefined;
  await root.plugin(ProductComponentService, {
    authorizeToolExecution: () => Promise.resolve(),
    assertToolExecution: () => undefined,
    registerController: (value) => { controller = value; },
    runAtCommitBoundary: options.boundary ?? ((_signal, commit) => {
      commit();
      return Promise.resolve(true);
    }),
    whenGenerationUnused: options.whenUnused ?? (() => Promise.resolve()),
  });
  if (controller === undefined) throw new Error("component controller was not registered");
  await controller.configure({
    catalog: catalog(),
    compilers: options.compilers ?? [],
    initialSnapshot: options.initial ?? snapshot("extension-empty-v1"),
  });
  return Object.freeze({ controller, root, service: root.productComponents });
};

describe("transactional product component generations", () => {
  it("validates canonical immutable snapshots and resource ownership", () => {
    const valid = snapshot("extension-resource-v1", [Object.freeze({
      id: "command-one",
      enabled: true,
      kind: "command",
      descriptor: Object.freeze({
        description: "Command one",
        resourceId: "command-resource-one",
      }),
    })], [Object.freeze({
      id: "command-resource-one",
      kind: "command_template",
      mediaType: "text/markdown",
      content: "Run this command",
      sha256: "8fa66c22c5eed6f4c64c90977b7064594e0ce4992883817cfd2c7e5c811940fd",
    })]);
    expect(validateExtensionSnapshot(valid)).toEqual(valid);
    expect(() => validateExtensionSnapshot({ ...valid, digest: "0".repeat(64) })).toThrow(
      /digest differs/u,
    );
    expect(() => validateExtensionSnapshot(snapshot(
      "extension-missing-resource-v1",
      [Object.freeze({
        id: "command-one",
        enabled: true,
        kind: "command",
        descriptor: Object.freeze({ description: "Missing", resourceId: "absent" }),
      })],
    ))).toThrow(/absent declarative resource/u);
    const proxy = new Proxy(valid, {});
    expect(() => validateExtensionSnapshot(proxy)).toThrow();
  });

  it("prepares invisibly and publishes one deterministic catalog only at the quiescent boundary", async () => {
    const effects: string[] = [];
    let allowCommit = true;
    let releasePrepare!: (plan: Awaited<ReturnType<ComponentCompiler["prepare"]>>) => void;
    const pendingPrepare = new Promise<Awaited<ReturnType<ComponentCompiler["prepare"]>>>(
      (resolve) => { releasePrepare = resolve; },
    );
    const compiler: ComponentCompiler = Object.freeze({
      kind: "agent",
      prepare: (component: ExtensionComponent) => pendingPrepare.then(() => Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([Object.freeze({
          componentId: component.id,
          kind: component.kind,
          name: `agent-${component.id}`,
          catalog: Object.freeze({ kind: "agent" as const, name: `agent-${component.id}` }),
          install: () => {
            effects.push(`install:${component.id}`);
            return () => { effects.push(`uninstall:${component.id}`); };
          },
        })]),
        dispose: () => {
          effects.push(`dispose-plan:${component.id}`);
          return Promise.resolve();
        },
      })),
    });
    const harness = await mount({
      boundary: (_signal, commit) => {
        if (!allowCommit) return Promise.resolve(false);
        commit();
        return Promise.resolve(true);
      },
      compilers: [compiler],
    });
    allowCommit = false;

    const pending = snapshot("extension-agent-v1", [agentComponent("one")]);
    const replacement = harness.controller.replace(pending);
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.service.status()).toMatchObject({
      desiredRevision: "extension-agent-v1",
      effectiveRevision: "extension-empty-v1",
      state: "queued",
    });
    expect(effects).toEqual([]);
    expect(harness.service.catalog().agents).toEqual([]);
    releasePrepare(Object.freeze({
      status: "ready",
      contributions: Object.freeze([]),
      dispose: () => Promise.resolve(),
    }));
    await expect(replacement).resolves.toMatchObject({
      desiredRevision: "extension-agent-v1",
      effectiveRevision: "extension-empty-v1",
      state: "queued",
    });
    expect(effects).toEqual([]);
    expect(harness.service.catalog().agents).toEqual([]);

    allowCommit = true;
    await expect(harness.controller.reconcile()).resolves.toMatchObject({
      desiredRevision: "extension-agent-v1",
      effectiveRevision: "extension-agent-v1",
      state: "applied",
    });
    expect(effects).toEqual(["install:one"]);
    expect(harness.service.catalog().agents).toEqual(["agent-one"]);
  });

  it("switches registrations atomically while retaining old generation resources until owners drain", async () => {
    const effects: string[] = [];
    let releaseOld!: () => void;
    const oldUnused = new Promise<void>((resolve) => { releaseOld = resolve; });
    const compiler: ComponentCompiler = Object.freeze({
      kind: "agent",
      prepare: (component: ExtensionComponent) => Promise.resolve(Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([Object.freeze({
          componentId: component.id,
          kind: component.kind,
          name: component.id,
          catalog: Object.freeze({ kind: "agent" as const, name: component.id }),
          install: () => {
            effects.push(`install:${component.id}`);
            return () => { effects.push(`uninstall:${component.id}`); };
          },
        })]),
        dispose: () => {
          effects.push(`dispose:${component.id}`);
          return Promise.resolve();
        },
      })),
    });
    const harness = await mount({
      compilers: [compiler],
      whenUnused: ({ revision }) => revision === "extension-old-v1" ? oldUnused : Promise.resolve(),
    });
    await harness.controller.replace(snapshot("extension-old-v1", [agentComponent("old")]));
    const newSnapshot = snapshot("extension-new-v1", [agentComponent("new")]);
    await harness.controller.replace(newSnapshot);
    expect(effects).toEqual(["install:old", "uninstall:old", "install:new"]);
    expect(harness.service.catalog().agents).toEqual(["new"]);
    releaseOld();
    await oldUnused;
    await new Promise((resolve) => setImmediate(resolve));
    expect(effects).toEqual(["install:old", "uninstall:old", "install:new", "dispose:old"]);
    await harness.controller.close();
    expect(effects).toEqual([
      "install:old",
      "uninstall:old",
      "install:new",
      "dispose:old",
      "uninstall:new",
      "dispose:new",
    ]);
    expect(() => harness.service.catalog()).toThrow(/closed/u);
    expect(() => harness.service.assertSessionExtension(newSnapshot.digest))
      .toThrow(/closed/u);
  });

  it("rejects revision reuse and leaves the prior effective generation intact on prepare failure", async () => {
    const compiler: ComponentCompiler = Object.freeze({
      kind: "agent",
      prepare: (component: ExtensionComponent) => component.id === "throws"
        ? Promise.reject(new Error("synthetic prepare failure"))
        : Promise.resolve(Object.freeze({
        status: component.id === "bad" ? "degraded" as const : "ready" as const,
        ...(component.id === "bad" ? { reason: "synthetic_unavailable" } : {}),
        contributions: Object.freeze([]),
        dispose: () => Promise.resolve(),
      })),
    });
    const harness = await mount({ compilers: [compiler] });
    const good = snapshot("extension-one-v1", [agentComponent("good")]);
    await harness.controller.replace(good);
    await expect(harness.controller.replace(snapshot(
      "extension-one-v1",
      [agentComponent("different")],
    ))).rejects.toMatchObject({ code: "extension_revision_conflict" });
    await expect(harness.controller.replace(snapshot(
      "extension-bad-v1",
      [agentComponent("bad")],
    ))).resolves.toMatchObject({
      desiredRevision: "extension-bad-v1",
      effectiveRevision: "extension-one-v1",
      state: "failed",
    });
    expect(harness.service.catalog().revision).toBe("extension-one-v1");
    await expect(harness.controller.replace(snapshot(
      "extension-throws-v1",
      [agentComponent("prepared"), agentComponent("throws"), agentComponent("not-visited")],
    ))).resolves.toMatchObject({
      desiredRevision: "extension-throws-v1",
      effectiveRevision: "extension-one-v1",
      state: "failed",
      components: [
        { key: "agent:prepared", state: "ready" },
        { key: "agent:throws", state: "failed", reason: "component_prepare_failed" },
        { key: "agent:not-visited", state: "failed", reason: "component_prepare_failed" },
      ],
    });
  });

  it("rolls back partial commits and enters recovery when rollback itself fails", async () => {
    const effects: string[] = [];
    const compiler = (rollbackFails: boolean): ComponentCompiler => Object.freeze({
      kind: "agent",
      prepare: (component: ExtensionComponent) => Promise.resolve(Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([
          Object.freeze({
            componentId: component.id,
            kind: component.kind,
            name: "a-installed",
            install: () => {
              effects.push("install:a");
              return () => {
                effects.push("rollback:a");
                if (rollbackFails) throw new Error("synthetic rollback failure");
              };
            },
          }),
          Object.freeze({
            componentId: component.id,
            kind: component.kind,
            name: "b-fails",
            install: () => {
              effects.push("install:b");
              throw new Error("synthetic commit failure");
            },
          }),
        ]),
        dispose: () => {
          effects.push("dispose:plan");
          return Promise.resolve();
        },
      })),
    });

    const recoverable = await mount({ compilers: [compiler(false)] });
    await expect(recoverable.controller.replace(snapshot(
      "extension-commit-fails-v1",
      [agentComponent("recoverable")],
    ))).resolves.toMatchObject({
      desiredRevision: "extension-commit-fails-v1",
      effectiveRevision: "extension-empty-v1",
      state: "failed",
    });
    expect(effects).toEqual(["install:a", "install:b", "rollback:a", "dispose:plan"]);
    expect(recoverable.service.catalog().revision).toBe("extension-empty-v1");

    effects.length = 0;
    const unrecoverable = await mount({ compilers: [compiler(true)] });
    await expect(unrecoverable.controller.replace(snapshot(
      "extension-rollback-fails-v1",
      [agentComponent("unrecoverable")],
    ))).rejects.toThrow(/rollback/u);
    expect(effects).toEqual(["install:a", "install:b", "rollback:a", "dispose:plan"]);
    expect(unrecoverable.service.status()).toMatchObject({
      effectiveRevision: "extension-empty-v1",
      state: "failed",
      components: [{
        key: "agent:unrecoverable",
        state: "failed",
        reason: "component_commit_failed",
      }],
    });
    await expect(unrecoverable.controller.replace(snapshot("extension-after-recovery-v1")))
      .rejects.toMatchObject({ code: "extension_recovery_required" });
  });
});
