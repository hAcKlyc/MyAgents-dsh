import type {
  ComponentPrepareAuthority,
  ExtensionComponent,
  ExtensionSnapshot,
} from "@myagents-dsh/component-runtime";
import {
  createAgentComponentCompiler,
} from "@myagents-dsh/components-agents";
import {
  ProductCommandService,
  createCommandComponentCompiler,
  expandCommandTemplate,
  type DynamicCommandRegistration,
  type ProductDynamicCommandController,
} from "@myagents-dsh/components-commands";
import {
  createSkillComponentCompiler,
} from "@myagents-dsh/components-skills";
import type {
  DynamicAgentRegistration,
  DynamicSkillRegistration,
} from "@myagents-dsh/tools-agent";
import {
  PRODUCT_SKILL_DESCRIPTION_MAX_CHARACTERS,
  projectProductSkillDescription,
} from "@myagents-dsh/tools-agent";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { CommandRuntime } from "@deepseek-ai/dsh-commands";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const authority = (componentId: string): ComponentPrepareAuthority => Object.freeze({
  assertCurrent: vi.fn(),
  assertToolExecution: vi.fn(),
  authorizeToolExecution: vi.fn(() => Promise.resolve()),
  componentGenerationId: `extension-v1:${"a".repeat(64)}`,
  componentId,
  signal: new AbortController().signal,
});

const snapshot = (
  components: readonly ExtensionComponent[],
  resources: ExtensionSnapshot["resources"],
  roots: ExtensionSnapshot["skillSourcePolicy"]["roots"] = [],
): ExtensionSnapshot => Object.freeze({
  components: [...components],
  digest: "a".repeat(64),
  formatVersion: 1,
  resources: [...resources],
  revision: "extension-v1",
  skillSourcePolicy: { revision: "skills-v1", roots },
  mcpLaunchPolicy: { revision: "mcp-launch-v1", profiles: [] },
});

describe("declarative Skill, Agent, and Command component compilers", () => {
  it("stages a generation-owned Skill without publication and retains it until plan disposal", async () => {
    const effects: string[] = [];
    let observed: DynamicSkillRegistration | undefined;
    const compiler = createSkillComponentCompiler({
      controller: Object.freeze({
        prepare: (registration: DynamicSkillRegistration) => {
          observed = registration;
          effects.push("prepare");
          return Object.freeze({
            dispose: () => { effects.push("dispose"); },
            install: () => {
              effects.push("install");
              return () => { effects.push("unpublish"); };
            },
          });
        },
      }),
    });
    const content = "Use this Skill only for release inspection.";
    const component: ExtensionComponent = Object.freeze({
      descriptor: Object.freeze({
        description: "Release inspection",
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        rank: 7,
        resourceId: "release-skill-document",
        whenToUse: "When a release needs inspection",
      }),
      enabled: true,
      id: "release-skill",
      kind: "skill",
    });
    const source = snapshot([component], [Object.freeze({
      content,
      id: "release-skill-document",
      kind: "skill_document",
      mediaType: "text/markdown",
      sha256: sha256(content),
    })]);
    const plan = await compiler.prepare(component, source, new AbortController().signal, authority(component.id));
    expect(effects).toEqual(["prepare"]);
    expect(observed).toMatchObject({
      componentId: "release-skill",
      content,
      generation: { digest: "a".repeat(64), revision: "extension-v1" },
      name: "release-skill",
      rank: 7,
    });
    const unpublish = plan.contributions[0]?.install();
    expect(effects).toEqual(["prepare", "install"]);
    unpublish?.();
    expect(effects).toEqual(["prepare", "install", "unpublish"]);
    await plan.dispose();
    expect(effects).toEqual(["prepare", "install", "unpublish", "dispose"]);
  });

  it("projects multiline or oversized Skill descriptions into one portable 1024-character catalog value", async () => {
    let observed: DynamicSkillRegistration | undefined;
    const compiler = createSkillComponentCompiler({
      controller: Object.freeze({
        prepare: (registration: DynamicSkillRegistration) => {
          observed = registration;
          return Object.freeze({ dispose: vi.fn(), install: () => vi.fn() });
        },
      }),
    });
    const description = `  First line\r\nSecond\tline\u0000 ${"界".repeat(1_100)}  `;
    const expected = projectProductSkillDescription(description, "portable-skill");
    const content = "Use the portable Skill.";
    const component: ExtensionComponent = Object.freeze({
      descriptor: Object.freeze({
        description,
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        resourceId: "portable-skill-document",
      }),
      enabled: true,
      id: "portable-skill",
      kind: "skill",
    });
    const source = snapshot([component], [Object.freeze({
      content,
      id: "portable-skill-document",
      kind: "skill_document",
      mediaType: "text/markdown",
      sha256: sha256(content),
    })]);

    const plan = await compiler.prepare(component, source, new AbortController().signal, authority(component.id));

    expect(Array.from(expected)).toHaveLength(PRODUCT_SKILL_DESCRIPTION_MAX_CHARACTERS);
    expect(expected.startsWith("First line Second line ")).toBe(true);
    expect(Array.from(expected).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })).toBe(false);
    expect(observed?.description).toBe(expected);
    expect(plan.contributions[0]?.catalog).toMatchObject({
      kind: "skill",
      value: { name: "portable-skill", description: expected },
    });
  });

  it("links a workspace Skill component to its approved package directory", async () => {
    let observed: DynamicSkillRegistration | undefined;
    const compiler = createSkillComponentCompiler({
      controller: Object.freeze({
        prepare: (registration: DynamicSkillRegistration) => {
          observed = registration;
          return Object.freeze({ dispose: vi.fn(), install: () => vi.fn() });
        },
      }),
    });
    const content = [
      "---",
      "name: package-skill",
      "description: Uses package resources.",
      "---",
      "",
      "Read references/checklist.md only when needed.",
    ].join("\n");
    const component: ExtensionComponent = Object.freeze({
      descriptor: Object.freeze({
        description: "Uses package resources.",
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        resourceId: "package-skill-document",
      }),
      enabled: true,
      id: "package-skill",
      kind: "skill",
    });
    const resourceRoot = resolve("workspace-fixture", ".agents", "skills", "package-skill");
    const source = snapshot([component], [Object.freeze({
      content,
      id: "package-skill-document",
      kind: "skill_document",
      mediaType: "text/markdown",
      sha256: sha256(content),
    })], [Object.freeze({
      sourceId: component.id,
      root: resourceRoot,
      enabledPaths: ["SKILL.md"],
    })]);

    await compiler.prepare(component, source, new AbortController().signal, authority(component.id));

    expect(observed).toMatchObject({
      resourceRoot,
      sourcePath: join(resourceRoot, "SKILL.md"),
    });
  });

  it("rejects a Skill source policy that does not name the package SKILL.md", () => {
    const compiler = createSkillComponentCompiler({
      controller: Object.freeze({
        prepare: vi.fn(() => Object.freeze({ dispose: vi.fn(), install: () => vi.fn() })),
      }),
    });
    const content = "Use the package Skill.";
    const component: ExtensionComponent = Object.freeze({
      descriptor: Object.freeze({
        description: "Uses package resources.",
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        resourceId: "package-skill-document",
      }),
      enabled: true,
      id: "package-skill",
      kind: "skill",
    });
    const source = snapshot([component], [Object.freeze({
      content,
      id: "package-skill-document",
      kind: "skill_document",
      mediaType: "text/markdown",
      sha256: sha256(content),
    })], [Object.freeze({
      sourceId: component.id,
      root: resolve("workspace-fixture", ".agents", "skills", "package-skill"),
      enabledPaths: ["docs/instructions.md"],
    })]);

    expect(() => compiler.prepare(
      component,
      source,
      new AbortController().signal,
      authority(component.id),
    )).toThrow(/must enable SKILL\.md/u);
  });

  it("compiles one immutable Agent birth template from its prompt and referenced Skills", async () => {
    let observed: DynamicAgentRegistration | undefined;
    const compiler = createAgentComponentCompiler({
      controller: Object.freeze({
        prepare: (registration: DynamicAgentRegistration) => {
          observed = registration;
          return Object.freeze({ dispose: vi.fn(), install: () => vi.fn() });
        },
      }),
    });
    const skillContent = "Inspect the changelog before reporting.";
    const skill: ExtensionComponent = Object.freeze({
      descriptor: Object.freeze({
        description: "Changelog inspection",
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        resourceId: "review-document",
      }),
      enabled: true,
      id: "review-skill",
      kind: "skill",
    });
    const agent: ExtensionComponent = Object.freeze({
      descriptor: Object.freeze({
        description: "Reviews releases",
        maxTurns: 3,
        prompt: "You are a bounded release reviewer.",
        skills: ["review-skill"],
        tools: ["Read", "Bash", "SendMessage"],
        disallowedTools: ["Bash"],
      }),
      enabled: true,
      id: "release-reviewer",
      kind: "agent",
    });
    const source = snapshot([skill, agent], [Object.freeze({
      content: skillContent,
      id: "review-document",
      kind: "skill_document",
      mediaType: "text/markdown",
      sha256: sha256(skillContent),
    })]);
    const plan = await compiler.prepare(agent, source, new AbortController().signal, authority(agent.id));
    expect(observed).toMatchObject({
      componentId: "release-reviewer",
      disallowedTools: ["Bash"],
      maxTurns: 3,
      tools: ["Read", "Bash", "SendMessage"],
      type: "release-reviewer",
    });
    expect(observed?.persona).toContain("bounded release reviewer");
    expect(observed?.persona).toContain(skillContent);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.tools)).toBe(true);
    expect(Object.isFrozen(observed?.disallowedTools)).toBe(true);
    expect(plan.contributions[0]?.catalog).toEqual({ kind: "agent", name: "release-reviewer" });
  });

  it("compiles DSH command definitions and performs only bounded positional template expansion", async () => {
    let observed: DynamicCommandRegistration | undefined;
    const compiler = createCommandComponentCompiler({
      controller: Object.freeze({
        prepare: (registration: DynamicCommandRegistration) => {
          observed = registration;
          return Object.freeze({ dispose: vi.fn(), install: () => vi.fn() });
        },
      }),
    });
    const content = "Review $1 against $2. Context: $ARGUMENTS";
    const component: ExtensionComponent = Object.freeze({
      descriptor: Object.freeze({
        aliases: ["rr"],
        argumentHint: "<base> <head>",
        description: "Review a revision range",
        resourceId: "review-range-template",
      }),
      enabled: true,
      id: "review-range",
      kind: "command",
    });
    const source = snapshot([component], [Object.freeze({
      content,
      id: "review-range-template",
      kind: "command_template",
      mediaType: "text/markdown",
      sha256: sha256(content),
    })]);
    const plan = await compiler.prepare(component, source, new AbortController().signal, authority(component.id));
    expect(observed).toEqual({
      aliases: ["rr"],
      argumentHint: "<base> <head>",
      componentId: "review-range",
      description: "Review a revision range",
      generation: { digest: "a".repeat(64), revision: "extension-v1" },
      name: "review-range",
      template: content,
    });
    expect(plan.contributions[0]?.catalog).toMatchObject({
      kind: "command",
      value: { name: "review-range", aliases: ["rr"], source: "command" },
    });
    expect(expandCommandTemplate(content, ["main", "feature"])).toBe(
      "Review main against feature. Context: main feature",
    );
    expect(() => expandCommandTemplate("", [])).toThrow(/must not be empty/u);
    expect(() => expandCommandTemplate("x".repeat(1_000_001), [])).toThrow(/exceeds/u);
  });

  it("registers command aliases in the public DSH runtime and admits one normal product operation", async () => {
    const root = new Context();
    let controller: ProductDynamicCommandController | undefined;
    const starts: unknown[] = [];
    const events: unknown[] = [];
    const agent = Object.freeze({
      ctx: root,
      id: "command-agent",
      session: Object.freeze({
        append: (type: string, data: unknown) => {
          events.push(Object.freeze({ type, data }));
          return events.length - 1;
        },
      }),
    }) as unknown as Agent;
    try {
      await root.plugin(CommandRuntime);
      await root.plugin(ProductCommandService, {
        registerController: (value) => { controller = value; },
        resolveAuthority: () => Object.freeze({
          agent,
          assertCurrent: vi.fn(),
          configRevision: "config-v1",
          executionEnvironmentDigest: "e".repeat(64),
          executionEnvironmentRevision: "environment-v1",
          extensionCatalogDigest: "b".repeat(64),
        }),
        startOperation: (params, control) => {
          starts.push(params);
          control.signal.throwIfAborted();
          control.commit();
          return Promise.resolve(Object.freeze({
            clientOperationId: params.clientOperationId,
            state: "accepted" as const,
          }));
        },
      });
      if (controller === undefined) throw new Error("Command controller was not registered");
      const prepared = controller.prepare(Object.freeze({
        aliases: Object.freeze(["rr"]),
        argumentHint: "<base> <head>",
        componentId: "review-range",
        description: "Review a revision range",
        generation: Object.freeze({ digest: "a".repeat(64), revision: "extension-v1" }),
        name: "review-range",
        template: "Review $1 against $2. Context: $ARGUMENTS",
      }));
      expect(root.commands.list(agent)).toEqual([]);
      const unpublish = prepared.install();
      expect(root.commands.list(agent).map(({ name }) => name)).toEqual(["review-range", "rr"]);
      const execution = await root.commands.execute(
        agent,
        "/rr 'main branch' feature",
        [],
        new AbortController().signal,
      );
      expect(execution?.result).toMatchObject({ kind: "success" });
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        configRevision: "config-v1",
        executionEnvironmentRevision: "environment-v1",
        extensionDigest: "b".repeat(64),
        input: { parts: [{ kind: "text", text: "Review main branch against feature. Context: main branch feature" }] },
        origin: { kind: "desktop" },
      });
      expect(events).toHaveLength(2);
      let commits = 0;
      await expect(root.productCommands.invoke({
        clientOperationId: "host-command-operation",
        clientUserMessageId: "host-command-message",
        commandId: "rr",
        arguments: ["main branch", "feature"],
        configRevision: "config-v1",
        extensionDigest: "b".repeat(64),
        executionEnvironmentRevision: "environment-v1",
        executionEnvironmentDigest: "e".repeat(64),
        limits: { maxTurns: 2 },
        origin: { kind: "desktop" },
      }, Object.freeze({
        signal: new AbortController().signal,
        commit: () => { commits += 1; },
      }))).resolves.toEqual({
        clientOperationId: "host-command-operation",
        state: "accepted",
      });
      expect(commits).toBe(1);
      expect(starts[1]).toMatchObject({
        clientOperationId: "host-command-operation",
        clientUserMessageId: "host-command-message",
        input: { parts: [{ kind: "text", text: "Review main branch against feature. Context: main branch feature" }] },
      });
      unpublish();
      expect(root.commands.list(agent)).toEqual([]);
      prepared.dispose();
    } finally {
      await root.fiber.dispose();
    }
  });
});
