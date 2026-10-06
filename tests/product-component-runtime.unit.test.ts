import { modelToolNames } from "@myagents-dsh/protocol";
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
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
});

const catalog = (): EffectiveToolCatalogSnapshot => {
  const authority = Object.freeze({
    formatVersion: 1 as const,
    contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
    implementationCatalog: modelToolNames(CANONICAL_TOOL_NAMES),
    effectiveTools: modelToolNames(CANONICAL_TOOL_NAMES),
    revision: "canonical-tools-v1",
    diagnostics: Object.freeze(modelToolNames(CANONICAL_TOOL_NAMES).map((tool) => Object.freeze({
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
  mcpLaunchPolicy: { revision: "mcp-launch-v1", profiles: [] },
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

const skillFixture = (id: string): Readonly<{
  component: SnapshotAuthority["components"][number];
  resource: SnapshotAuthority["resources"][number];
}> => {
  const content = `# ${id}\n\nSynthetic Skill instructions.`;
  const resourceId = `${id}-document`;
  return Object.freeze({
    component: Object.freeze({
      id,
      enabled: true,
      kind: "skill",
      descriptor: Object.freeze({
        description: `Skill ${id}`,
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        resourceId,
      }),
    }),
    resource: Object.freeze({
      id: resourceId,
      kind: "skill_document",
      mediaType: "text/markdown",
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    }),
  });
};

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
  it("binds Host session and turn admission to the public effective catalog digest", async () => {
    const initial = snapshot("extension-catalog-admission-v1");
    const harness = await mount({ initial });
    expect(() => harness.service.assertSessionExtension(initial.digest)).not.toThrow();
    expect(() => harness.service.assertSessionExtensionCatalog(harness.service.catalog().digest)).not.toThrow();
    expect(() => harness.service.assertSessionExtensionCatalog(initial.digest)).toThrow(
      /requested extension catalog is not the effective generation/u,
    );
  });

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
    ))).toThrow(/absent or mismatched declarative resource/u);
    const proxy = new Proxy(valid, {});
    expect(() => validateExtensionSnapshot(proxy)).toThrow();
  });

  it("scopes component identities and Skill references by kind while rejecting same-kind duplicates", () => {
    const skill = skillFixture("review");
    const command: ExtensionComponent = {
      id: "review", enabled: true, kind: "command",
      descriptor: { description: "Review command", resourceId: "review-template" },
    };
    const content = "Review the fixture.";
    const agent: ExtensionComponent = {
      ...agentComponent("review"), kind: "agent",
      descriptor: { description: "Review agent", prompt: "Review", skills: ["review"] },
    };
    const components: ExtensionComponent[] = [skill.component, command, agent, {
      id: "review", enabled: true, kind: "mcp",
      descriptor: { transport: "stdio", launchProfileRef: "review-launch" },
    }];
    const valid = snapshot("cross-kind-v1", components, [skill.resource, {
      id: "review-template", kind: "command_template", mediaType: "text/markdown",
      content, sha256: createHash("sha256").update(content).digest("hex"),
    }]);
    expect(validateExtensionSnapshot(valid)).toEqual(valid);
    expect(() => validateExtensionSnapshot(snapshot("same-kind-v1", [agent, structuredClone(agent)])))
      .toThrow(/component IDs must be unique/u);
    const commandResource = valid.resources[1];
    if (commandResource === undefined) throw new Error("command fixture resource is missing");
    expect(() => validateExtensionSnapshot(snapshot("wrong-kind-reference-v1", [command, agent], [commandResource])))
      .toThrow(/absent declarative Skill/u);
  });

  it("preserves each kind's source order and catalog when different kinds share names", async () => {
    const effects: string[] = [];
    const compiler = (kind: "agent" | "skill"): ComponentCompiler => ({
      kind,
      prepare: (component) => Promise.resolve({
        status: "ready", dispose: () => Promise.resolve(),
        contributions: [{ componentId: component.id, kind, name: component.id,
          catalog: kind === "agent" ? { kind: "agent", name: component.id }
            : { kind: "skill", value: { name: component.id, description: "Fixture", disableModelInvocation: false } },
          install: () => { effects.push(`${kind}:${component.id}`); return () => { effects.push(`remove:${kind}:${component.id}`); }; },
        }],
      }),
    });
    const first = skillFixture("first");
    const second = skillFixture("second");
    const initial = snapshot("cross-kind-install-v1", [agentComponent("first"), agentComponent("second"), second.component, first.component], [first.resource, second.resource]);
    const harness = await mount({ initial, compilers: [compiler("skill"), compiler("agent")] });
    expect(harness.service.status()).toMatchObject({ state: "applied", components: [
      { key: "agent:first", state: "ready" }, { key: "agent:second", state: "ready" },
      { key: "skill:second", state: "ready" }, { key: "skill:first", state: "ready" },
    ] });
    expect(effects).toEqual(["skill:second", "skill:first", "agent:first", "agent:second"]);
    expect(harness.service.catalog()).toMatchObject({ agents: ["first", "second"], skills: [{ name: "first" }, { name: "second" }] });
    await harness.controller.replace(snapshot("cross-kind-remove-v1", [first.component], [first.resource]));
    expect(harness.service.catalog()).toMatchObject({ agents: [], skills: [{ name: "first" }] });
    expect(harness.service.catalog().tools).toContain("read");
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

  it("completes prepared component disposal serially in reverse ownership order", async () => {
    const effects: string[] = [];
    let releaseSecond!: () => void;
    const secondCanFinish = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const compiler: ComponentCompiler = Object.freeze({
      kind: "agent",
      prepare: (component: ExtensionComponent) => Promise.resolve(Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([]),
        dispose: async () => {
          effects.push(`dispose-start:${component.id}`);
          if (component.id === "second") await secondCanFinish;
          effects.push(`dispose-end:${component.id}`);
        },
      })),
    });
    const harness = await mount({ compilers: [compiler] });
    await harness.controller.replace(snapshot(
      "extension-reverse-disposal-v1",
      [agentComponent("first"), agentComponent("second")],
    ));

    const closing = harness.controller.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(effects).toEqual(["dispose-start:second"]);

    releaseSecond();
    await closing;
    expect(effects).toEqual([
      "dispose-start:second",
      "dispose-end:second",
      "dispose-start:first",
      "dispose-end:first",
    ]);
  });

  it("rejects revision reuse while isolating component-local prepare failures", async () => {
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
      effectiveRevision: "extension-bad-v1",
      state: "applied",
      components: [
        { key: "agent:bad", state: "degraded", reason: "synthetic_unavailable" },
      ],
    });
    expect(harness.service.catalog().revision).toBe("extension-bad-v1");
    await expect(harness.controller.replace(snapshot(
      "extension-throws-v1",
      [agentComponent("prepared"), agentComponent("throws"), agentComponent("not-visited")],
    ))).resolves.toMatchObject({
      desiredRevision: "extension-throws-v1",
      effectiveRevision: "extension-throws-v1",
      state: "applied",
      components: [
        { key: "agent:prepared", state: "ready" },
        { key: "agent:throws", state: "degraded", reason: "agent_prepare_failed" },
        { key: "agent:not-visited", state: "ready" },
      ],
    });
  });

  it("degrades only a Skill that fails preparation and publishes the remaining catalog", async () => {
    const broken = skillFixture("broken-skill");
    const healthy = skillFixture("healthy-skill");
    const prepared: string[] = [];
    const compiler: ComponentCompiler = Object.freeze({
      kind: "skill",
      prepare: (component: ExtensionComponent) => {
        prepared.push(component.id);
        if (component.id === "broken-skill") return Promise.reject(new Error("synthetic Skill failure"));
        return Promise.resolve(Object.freeze({
          status: "ready" as const,
          contributions: Object.freeze([Object.freeze({
            componentId: component.id,
            kind: component.kind,
            name: component.id,
            catalog: Object.freeze({
              kind: "skill" as const,
              value: Object.freeze({
                name: component.id,
                description: `Skill ${component.id}`,
                disableModelInvocation: false,
              }),
            }),
            install: () => undefined,
          })]),
          dispose: () => Promise.resolve(),
        }));
      },
    });
    const harness = await mount({ compilers: [compiler] });

    await expect(harness.controller.replace(snapshot(
      "extension-isolated-skill-prepare-v1",
      [broken.component, healthy.component],
      [broken.resource, healthy.resource],
    ))).resolves.toMatchObject({
      desiredRevision: "extension-isolated-skill-prepare-v1",
      effectiveRevision: "extension-isolated-skill-prepare-v1",
      state: "applied",
      components: [
        { key: "skill:broken-skill", state: "degraded", reason: "skill_prepare_failed" },
        { key: "skill:healthy-skill", state: "ready" },
      ],
    });
    expect(prepared).toEqual(["broken-skill", "healthy-skill"]);
    expect(harness.service.catalog().skills).toEqual([{
      name: "healthy-skill",
      description: "Skill healthy-skill",
      disableModelInvocation: false,
    }]);
  });

  it("degrades only a Skill whose prepared contribution fails installation", async () => {
    const broken = skillFixture("broken-install");
    const healthy = skillFixture("healthy-install");
    const installed: string[] = [];
    const compiler: ComponentCompiler = Object.freeze({
      kind: "skill",
      prepare: (component: ExtensionComponent) => Promise.resolve(Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([Object.freeze({
          componentId: component.id,
          kind: component.kind,
          name: component.id,
          catalog: Object.freeze({
            kind: "skill" as const,
            value: Object.freeze({
              name: component.id,
              description: `Skill ${component.id}`,
              disableModelInvocation: false,
            }),
          }),
          install: () => {
            installed.push(component.id);
            if (component.id === "broken-install") throw new Error("synthetic Skill install failure");
            return () => undefined;
          },
        })]),
        dispose: () => Promise.resolve(),
      })),
    });
    const harness = await mount({ compilers: [compiler] });

    await expect(harness.controller.replace(snapshot(
      "extension-isolated-skill-install-v1",
      [broken.component, healthy.component],
      [broken.resource, healthy.resource],
    ))).resolves.toMatchObject({
      effectiveRevision: "extension-isolated-skill-install-v1",
      state: "applied",
      components: [
        { key: "skill:broken-install", state: "degraded", reason: "skill_install_failed" },
        { key: "skill:healthy-install", state: "ready" },
      ],
    });
    expect(installed).toEqual(["broken-install", "healthy-install"]);
    expect(harness.service.catalog().skills.map(({ name }) => name)).toEqual(["healthy-install"]);
  });

  it("isolates the later component when catalog identities collide", async () => {
    const disposed: string[] = [];
    const compiler: ComponentCompiler = Object.freeze({
      kind: "agent",
      prepare: (component: ExtensionComponent) => Promise.resolve(Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([Object.freeze({
          componentId: component.id,
          kind: component.kind,
          name: "shared-agent",
          catalog: Object.freeze({ kind: "agent" as const, name: "shared-agent" }),
          install: () => undefined,
        })]),
        dispose: () => {
          disposed.push(component.id);
          return Promise.resolve();
        },
      })),
    });
    const harness = await mount({ compilers: [compiler] });

    await expect(harness.controller.replace(snapshot(
      "extension-isolated-catalog-conflict-v1",
      [agentComponent("first"), agentComponent("second")],
    ))).resolves.toMatchObject({
      effectiveRevision: "extension-isolated-catalog-conflict-v1",
      state: "applied",
      components: [
        { key: "agent:first", state: "ready" },
        { key: "agent:second", state: "degraded", reason: "component_catalog_conflict" },
      ],
    });
    expect(harness.service.catalog().agents).toEqual(["shared-agent"]);
    expect(disposed).toEqual(["second"]);
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
      effectiveRevision: "extension-commit-fails-v1",
      state: "applied",
      components: [{
        key: "agent:recoverable",
        state: "degraded",
        reason: "agent_install_failed",
      }],
    });
    expect(effects).toEqual(["install:a", "install:b", "rollback:a"]);
    expect(recoverable.service.catalog().revision).toBe("extension-commit-fails-v1");

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
