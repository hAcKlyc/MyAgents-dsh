import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as ToolCallTimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { resolveRuntimePlatformTarget, selectPlatformAdapter } from "@myagents-dsh/product-profile";
import {
  PRODUCT_STATIC_SKILL_PROVIDER,
  ProductSkillService,
  staticSkillCatalogDigest,
  validateStaticSkillCatalog,
  type ProductDynamicSkillController,
  type StaticSkillCatalog,
  type StaticSkillDescriptor,
} from "@myagents-dsh/tools-agent";
import { LocalWorkspaceFileSystem } from "@myagents-dsh/tools-fs";
import { ProductPermissionError, type ProductToolContext } from "@myagents-dsh/tool-runtime-product";
import { afterEach, describe, expect, it } from "vitest";
import { supportsFileSymlinks } from "./setup/symlink-capability.js";

import { readAtMostFromHandle } from "../packages/tools-fs/src/local-filesystem.js";

const contexts: Context[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.allSettled(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

interface SkillFixture {
  readonly description?: string;
  readonly id: string;
  readonly invocation?: Readonly<{ modelInvocable: boolean; userInvocable: boolean }>;
  readonly name: string;
  readonly outsideWorkspace?: boolean;
  readonly rank?: number;
  readonly resourceId?: string;
  readonly source?: string;
  readonly sourceFile?: string;
  readonly whenToUse?: string;
}

const defaultDescription = "Audits a synthetic project change and returns bounded evidence.";
const defaultSource = [
  "---",
  "name: fixture-audit",
  `description: ${defaultDescription}`,
  "argument-hint: \"[focus]\"",
  "arguments: focus",
  "---",
  "",
  "Inspect $ARGUMENTS; named=$focus; first=$0.",
].join("\n");

const catalog = (skills: readonly StaticSkillDescriptor[]): StaticSkillCatalog => {
  const authority = Object.freeze({
    formatVersion: 1 as const,
    revision: "static-skills-v1",
    skills: Object.freeze([...skills]),
  });
  return validateStaticSkillCatalog(Object.freeze({
    ...authority,
    digest: staticSkillCatalogDigest(authority),
  }));
};

const mounted = async (fixtures: readonly SkillFixture[] = [{ id: "winner", name: "fixture-audit" }], authorizationError?: Error) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-static-skills-")));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const descriptors: StaticSkillDescriptor[] = [];
  const sourcePaths = new Map<string, string>();
  for (const fixture of fixtures) {
    const resourceRoot = join(
      fixture.outsideWorkspace === true ? join(root, "outside") : workspace,
      fixture.resourceId ?? fixture.id,
    );
    await mkdir(resourceRoot, { recursive: true });
    const sourcePath = join(resourceRoot, fixture.sourceFile ?? "SKILL.md");
    const source = fixture.source ?? defaultSource
      .replace("name: fixture-audit", `name: ${fixture.name}`)
      .replace(`description: ${defaultDescription}`, `description: ${fixture.description ?? defaultDescription}`);
    await writeFile(sourcePath, source, "utf8");
    sourcePaths.set(fixture.id, sourcePath);
    descriptors.push(Object.freeze({
      name: fixture.name,
      description: fixture.description ?? defaultDescription,
      ...(fixture.whenToUse === undefined ? {} : { whenToUse: fixture.whenToUse }),
      invocation: Object.freeze(fixture.invocation ?? { modelInvocable: true, userInvocable: true }),
      rank: fixture.rank ?? 600,
      resourceRoot,
      sourcePath,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
    }));
  }

  const context = new Context();
  contexts.push(context);
  await context.plugin(SessionStore);
  await context.plugin(AgentRegistry);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(ToolCallTimeoutPolicy);
  context.provide("sandboxPolicy", { defaultMode: "danger-full-access", resolve: () => ({ mode: "danger-full-access", workspaceRoot: process.cwd() }) } as never);
  await context.plugin(LocalWorkspaceFileSystem, {
    platform: selectPlatformAdapter(resolveRuntimePlatformTarget(process.platform, process.arch)),
  });
  await context.plugin(SkillRegistry);
  const session = context.sessions.create(SessionId("skill-session"));
  const agent = Object.freeze({ ctx: context, id: "skill-session", session }) as unknown as Agent;
  context.agents.enter(agent, undefined);
  const permissions: unknown[] = [];
  let current = true;
  context.provide("productTools", Object.freeze({
    resolve: (exec: Readonly<{ agent?: Agent; callId: unknown; signal: AbortSignal }>) => {
      if (exec.agent !== agent) throw new Error("Skill execution lacks primary Agent authority");
      return Object.freeze({
        agent,
        birth: Object.freeze({
          componentDigest: "d".repeat(64),
          componentRevision: "dynamic-skills-v1",
        }),
        callId: String(exec.callId),
        catalog: Object.freeze({ digest: "c".repeat(64), revision: "tool-catalog-v1" }),
        clientOperationId: "skill-operation",
        dshTurn: 1,
        environment: Object.freeze({
          workspace: Object.freeze({
            canonicalRoot: workspace,
          }),
        }),
        origin: "root" as const,
        productTurnId: "skill-product-turn",
        rootCallId: String(exec.callId),
        signal: exec.signal,
      }) as ProductToolContext;
    },
    authorize: (product: ProductToolContext, request: unknown) => {
      permissions.push(request);
      if (authorizationError) throw authorizationError;
      product.signal.throwIfAborted();
      if (!current) throw new Error("operation changed while permission was pending");
      return Promise.resolve();
    },
    assertCurrent: (product: ProductToolContext) => {
      product.signal.throwIfAborted();
      if (!current) throw new Error("operation is stale");
    },
  }) as never);
  const skillCatalog = catalog(descriptors);
  let dynamicController: ProductDynamicSkillController | undefined;
  await context.plugin(ProductSkillService, {
    catalog: skillCatalog,
    registerDynamicController: (controller) => { dynamicController = controller; },
  });
  let callNumber = 0;
  const execute = (input: unknown, signal = new AbortController().signal) => {
    callNumber += 1;
    const callId = ToolCallId(`skill-call-${String(callNumber)}`);
    return context.tools.execute({
      agent,
      arguments: input,
      callId,
      name: "Skill",
      rootCallId: callId,
      signal,
    });
  };
  return Object.freeze({
    agent,
    catalog: skillCatalog,
    context,
    descriptors: Object.freeze(descriptors),
    dynamicController: () => dynamicController,
    execute,
    permissions,
    setCurrent: (value: boolean) => { current = value; },
    sourcePaths,
    workspace,
  });
};

describe("static declarative Skill tool", () => {
  it.each([true, false])("preserves trusted permission errors and sanitizes unknown errors (trusted=%s)", async (trusted) => {
    const privateCause = new Error("synthetic-private-cause https://example.test/?key=fixture-secret");
    const failure = trusted ? new ProductPermissionError("permission_revision_stale", "Permission revision changed", { cause: privateCause }) : privateCause;
    const state = await mounted(undefined, failure);
    const result = await state.execute({ skill: "fixture-audit" });
    expect(result).toMatchObject({ isError: true, error: { info: { code: trusted ? "permission_revision_stale" : "skill_invalid" } } });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-cause");
  });

  it("accepts an empty trusted catalog when a distribution ships no built-in Skills", () => {
    expect(catalog([])).toMatchObject({ skills: [] });
  });

  it("bounds a source that grows while its open handle is read", async () => {
    const payload = new TextEncoder().encode("123456789");
    const requestedLengths: number[] = [];
    const growingHandle = Object.freeze({
      read: (
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ): Promise<Readonly<{ bytesRead: number }>> => {
        requestedLengths.push(length);
        const bytesRead = Math.min(length, payload.length - position);
        buffer.set(payload.subarray(position, position + bytesRead), offset);
        return Promise.resolve(Object.freeze({ bytesRead }));
      },
    });
    await expect(readAtMostFromHandle(growingHandle, 4, undefined)).rejects.toMatchObject({
      code: "FS_TOO_LARGE",
    });
    expect(requestedLengths).toEqual([5]);
  });

  it("loads the visible winner, strips frontmatter, expands arguments, and uses DSH rendering", async () => {
    const state = await mounted();
    const result = await state.execute({ skill: "fixture-audit", args: "src/runtime.ts" });
    expect(result).toMatchObject({
      isError: false,
      value: {
        skill: "fixture-audit",
        argumentsExpanded: true,
        content: "Inspect src/runtime.ts; named=src/runtime.ts; first=src/runtime.ts.",
        source: state.sourcePaths.get("winner"),
        sourceSha256: state.descriptors[0]?.sourceSha256,
      },
    });
    expect(result.content).toEqual([{
      type: "text",
      text: [
        '<skill_content name="fixture-audit">',
        "<skill_resources>",
        `Base directory for this skill: ${join(state.workspace, "winner")}`,
        "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
        "</skill_resources>",
        "",
        "<skill_instructions>",
        "Inspect src/runtime.ts; named=src/runtime.ts; first=src/runtime.ts.",
        "</skill_instructions>",
        "</skill_content>",
      ].join("\n"),
    }]);
    expect(state.permissions).toMatchObject([{
      permissionClass: "skill.load",
      target: "skill:fixture-audit",
      tool: "Skill",
      review: { kind: "generic", action: "Skill", target: "fixture-audit" },
    }]);
    expect(state.context.productSkills.catalog()).toEqual(state.catalog);
  });

  it.each([false, true])("loads a workspace package and preserves tool guidance without granting authority (%s)", async (withGuidance) => {
    const state = await mounted([]);
    const resourceRoot = join(state.workspace, ".agents", "skills", "package-skill");
    await mkdir(join(resourceRoot, "references"), { recursive: true });
    const sourcePath = join(resourceRoot, "SKILL.md");
    const source = [
      "---",
      "name: package-skill",
      "description: Uses package resources.",
      "arguments: focus",
      ...(withGuidance ? ["allowed-tools: Bash(example:*)"] : []),
      "metadata:",
      "  author: fixture",
      "---",
      "",
      "Inspect ${CLAUDE_SKILL_DIR}/references/checklist.md for $focus.",
    ].join("\n");
    await writeFile(sourcePath, source, "utf8");
    const prepared = state.dynamicController()?.prepare(Object.freeze({
      componentId: "package-skill",
      content: source,
      description: "Uses package resources.",
      generation: Object.freeze({ digest: "d".repeat(64), revision: "dynamic-skills-v1" }),
      invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
      name: "package-skill",
      rank: 300,
      resourceRoot,
      sourcePath,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
    }));
    const unpublish = prepared?.install();

    const result = await state.execute({ skill: "package-skill", args: "runtime" });
    const rendered = withGuidance
      ? source.replaceAll("${CLAUDE_SKILL_DIR}", resourceRoot).replaceAll("$focus", "runtime")
      : `Inspect ${resourceRoot}/references/checklist.md for runtime.`;

    expect(result).toMatchObject({
      isError: false,
      value: {
        skill: "package-skill",
        argumentsExpanded: true,
        content: rendered,
        source: sourcePath,
      },
    });
    expect(result.content).toEqual([{
      type: "text",
      text: [
        '<skill_content name="package-skill">',
        "<skill_resources>",
        `Base directory for this skill: ${resourceRoot}`,
        "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
        "</skill_resources>",
        "",
        "<skill_instructions>",
        rendered,
        "</skill_instructions>",
        "</skill_content>",
      ].join("\n"),
    }]);
    unpublish?.();
    prepared?.dispose();
  });

  it("rejects unknown and non-model-invocable skills before reading content", async () => {
    const state = await mounted([
      { id: "visible", name: "fixture-audit" },
      {
        id: "disabled",
        name: "disabled-skill",
        invocation: { modelInvocable: false, userInvocable: true },
      },
    ]);
    await expect(state.execute({ skill: "missing-skill" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "skill_not_found" } },
    });
    await expect(state.execute({ skill: "disabled-skill" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "skill_invocation_disabled" } },
    });
    expect(state.permissions).toHaveLength(0);
  });

  it("uses the DSH rank winner for duplicate names", async () => {
    const loser = defaultSource.replace("Inspect $ARGUMENTS; named=$focus; first=$0.", "loser $ARGUMENTS");
    const winner = defaultSource.replace("Inspect $ARGUMENTS; named=$focus; first=$0.", "winner $ARGUMENTS");
    const state = await mounted([
      {
        id: "loser",
        name: "fixture-audit",
        rank: 700,
        resourceId: "shared",
        source: loser,
        sourceFile: "loser.md",
      },
      {
        id: "winner",
        name: "fixture-audit",
        rank: 500,
        resourceId: "shared",
        source: winner,
        sourceFile: "winner.md",
      },
    ]);
    await expect(state.execute({ skill: "fixture-audit", args: "focus" })).resolves.toMatchObject({
      isError: false,
      value: {
        content: "winner focus",
        source: state.sourcePaths.get("winner"),
      },
    });
  });

  it("accepts the fixed YAML argument array and readable skill roots outside the workspace", async () => {
    const arraySource = defaultSource
      .replace("arguments: focus", "arguments: [person, target]")
      .replace(
        "Inspect $ARGUMENTS; named=$focus; first=$0.",
        "Hello $0 / $ARGUMENTS[1] / $person / $target / $ARGUMENTS.",
      );
    const compatible = await mounted([{
      id: "winner",
      name: "fixture-audit",
      source: arraySource,
    }]);
    await expect(compatible.execute({
      skill: "fixture-audit",
      args: '"Hello World" Runtime',
    })).resolves.toMatchObject({
      isError: false,
      value: {
        content: "Hello Hello World / Runtime / Hello World / Runtime / \"Hello World\" Runtime.",
      },
    });

    const outside = await mounted([{
      id: "winner",
      name: "fixture-audit",
      outsideWorkspace: true,
    }]);
    await expect(outside.execute({ skill: "fixture-audit" })).resolves.toMatchObject({ isError: false });
    expect(outside.permissions).toHaveLength(1);
  });

  it.skipIf(!supportsFileSymlinks)("fails closed on source drift, symbolic sources, and executable frontmatter", async () => {
    const drifted = await mounted();
    const driftedSource = drifted.sourcePaths.get("winner");
    if (driftedSource === undefined) throw new Error("drift fixture source is missing");
    await writeFile(driftedSource, `${defaultSource}\nchanged`, "utf8");
    await expect(drifted.execute({ skill: "fixture-audit" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "skill_invalid" } },
    });

    const symbolic = await mounted();
    const sourcePath = symbolic.sourcePaths.get("winner");
    if (sourcePath === undefined) throw new Error("symbolic fixture source is missing");
    const target = join(symbolic.workspace, "target.md");
    await writeFile(target, defaultSource, "utf8");
    await rm(sourcePath);
    await symlink(target, sourcePath);
    await expect(symbolic.execute({ skill: "fixture-audit" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "skill_invalid" } },
    });

    const shared = await mounted();
    const sharedSource = shared.sourcePaths.get("winner");
    if (sharedSource === undefined) throw new Error("hardlink fixture source is missing");
    const sharedTarget = join(shared.workspace, "shared-skill.md");
    await writeFile(sharedTarget, defaultSource, "utf8");
    await rm(sharedSource);
    await link(sharedTarget, sharedSource);
    await expect(shared.execute({ skill: "fixture-audit" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "skill_invalid" } },
    });

    const executable = await mounted([{
      id: "winner",
      name: "fixture-audit",
      source: defaultSource.replace("argument-hint: \"[focus]\"", "script: ./run.js"),
    }]);
    await expect(executable.execute({ skill: "fixture-audit" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "skill_invalid" } },
    });
  });

  it("rejects foreign catalog winners and stale or cancelled operations", async () => {
    const state = await mounted();
    const stop = state.context.skills.registerProvider(() => Object.freeze({
      name: "foreign-provider",
      list: () => Promise.resolve([Object.freeze({
        name: "fixture-audit",
        description: defaultDescription,
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        source: "custom",
        provider: "foreign-provider",
        rank: 0,
        locator: Object.freeze({}),
      })]),
      get: () => Promise.resolve(undefined),
    }));
    await expect(state.execute({ skill: "fixture-audit" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "skill_invalid" } },
    });
    stop();

    const descriptor = state.descriptors[0];
    if (descriptor === undefined) throw new Error("static Skill descriptor is missing");
    const stopSpoof = state.context.skills.register({
      name: descriptor.name,
      description: descriptor.description,
      invocation: descriptor.invocation,
      source: "bundled",
      provider: PRODUCT_STATIC_SKILL_PROVIDER,
      resourceBase: { kind: "directory", path: descriptor.resourceRoot },
      content: "forged runtime Skill body",
      path: descriptor.sourcePath,
      metadata: {
        argumentNames: ["focus"],
        sourceSha256: descriptor.sourceSha256,
      },
    } as never);
    await expect(state.execute({ skill: "fixture-audit" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "skill_invalid" } },
    });
    stopSpoof();
    state.setCurrent(false);
    await expect(state.execute({ skill: "fixture-audit" })).resolves.toMatchObject({ isError: true });
    const aborted = new AbortController();
    aborted.abort(new Error("cancel Skill"));
    await expect(state.execute({ skill: "fixture-audit" }, aborted.signal)).resolves.toMatchObject({ isError: true });
  });

  it("validates the catalog trap-safely and keeps exact descriptor authority immutable", async () => {
    const state = await mounted();
    expect(Object.isFrozen(state.catalog)).toBe(true);
    expect(Object.isFrozen(state.catalog.skills)).toBe(true);
    expect(Object.isFrozen(state.catalog.skills[0])).toBe(true);
    expect(Object.isFrozen(state.catalog.skills[0]?.invocation)).toBe(true);
    expect(() => (state.catalog.skills as StaticSkillDescriptor[]).pop()).toThrow(TypeError);

    let traps = 0;
    const proxied = new Proxy({
      formatVersion: 1,
      revision: "forged",
      digest: "f".repeat(64),
      skills: [],
    }, {
      get() { traps += 1; return undefined; },
      getOwnPropertyDescriptor() { traps += 1; return undefined; },
      ownKeys() { traps += 1; return []; },
    });
    expect(() => validateStaticSkillCatalog(proxied)).toThrow("must not be a Proxy");
    expect(traps).toBe(0);

    const forged = structuredClone(state.catalog);
    (forged.skills[0] as { description: string }).description = "forged";
    expect(() => validateStaticSkillCatalog(forged)).toThrow("digest differs");
    expect(PRODUCT_STATIC_SKILL_PROVIDER).toBe("myagents-static-skills");
  });
});
