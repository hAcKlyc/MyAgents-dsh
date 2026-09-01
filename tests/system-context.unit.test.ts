import { Context, type Plugin } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import {
  GlobalSystemContextRegistrar,
  MAX_HOST_CONTEXT_BYTES,
  normalizeSystemContext,
  registerRuntimeWorkspaceContext,
  registerRootSystemContext,
} from "@myagents-dsh/runtime-product";
import { afterEach, describe, expect, it } from "vitest";

const roots: Context[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => root.fiber.dispose()));
});

const mounted = async () => {
  const root = new Context();
  roots.push(root);
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: "" });
  return root;
};

describe("Host system context normalization", () => {
  it("maps the legacy prompt to one root persona and rejects ambiguous input", () => {
    const legacy = normalizeSystemContext({ systemPrompt: "legacy {{literal}}" });
    expect(legacy.legacySystemPrompt).toBe(true);
    expect(legacy.sections).toEqual([{
      id: "legacy-persona",
      order: 0,
      scope: "root",
      text: "legacy {{literal}}",
    }]);
    expect(() => normalizeSystemContext({
      systemPrompt: "legacy",
      systemContext: { sections: [] },
    })).toThrow(/must be empty/u);
  });

  it("preserves legacy persona shadowing while rendering the body literally", async () => {
    const root = await mounted();
    const effective = normalizeSystemContext({ systemPrompt: "legacy {{literal}}" });
    const primaryKey = Object.freeze({});
    const installPrimary: Plugin.Function<void> = (context) => {
      const primary = createScope(context, primaryKey);
      registerRootSystemContext(primary.ctx, effective);
      return () => primary.dispose();
    };
    installPrimary.inject = ["systemPrompt"];
    await root.plugin(installPrimary);
    expect((await root.systemPrompt.assemble({ scope: primaryKey })).sections)
      .toContainEqual(expect.objectContaining({
        name: "deployment:persona",
        text: "legacy {{literal}}",
      }));
  });

  it("rejects duplicate ids across audiences and the aggregate context byte bound", () => {
    expect(() => normalizeSystemContext({
      systemPrompt: "",
      systemContext: {
        sections: [
          { id: "same", order: 0, scope: "global", text: "a" },
          { id: "same", order: 1, scope: "root", text: "b" },
        ],
      },
    })).toThrow(/duplicated across scopes/u);
    const half = "x".repeat(MAX_HOST_CONTEXT_BYTES / 2 + 1);
    expect(() => normalizeSystemContext({
      systemPrompt: "",
      systemContext: {
        sections: [],
        contexts: [
          { id: "one", order: 0, scope: "global", text: half },
          { id: "two", order: 1, scope: "root", text: half },
        ],
      },
    })).toThrow(/exceed/u);
  });
});

describe("Host system context registration", () => {
  it("shares the exact Runtime workspace context with root and child scopes", async () => {
    const root = await mounted();
    const dispose = registerRuntimeWorkspaceContext(root, "/fixture/workspace");
    for (const scope of [Object.freeze({ root: true }), Object.freeze({ child: true })]) {
      const workspace = (await root.systemPrompt.assemble({ scope })).contexts
        .find(({ name }) => name === "runtime:workspace");
      expect(workspace?.text).toContain("/fixture/workspace");
    }
    dispose();
  });

  it("shares global contributions while keeping root contributions on the primary scope", async () => {
    const root = await mounted();
    const effective = normalizeSystemContext({
      systemPrompt: "",
      systemContext: {
        sections: [
          { id: "global", order: -80, scope: "global", text: "global {{literal}}" },
          { id: "root", order: 10, scope: "root", text: "root only" },
        ],
        contexts: [{ id: "supplement", order: 100, scope: "global", text: "context {{literal}}" }],
      },
    });
    const registrar = new GlobalSystemContextRegistrar(root);
    registrar.prepare(effective).commit();
    const primaryKey = Object.freeze({});
    const installPrimary: Plugin.Function<void> = (context) => {
      const primary = createScope(context, primaryKey);
      registerRootSystemContext(primary.ctx, effective);
      return () => primary.dispose();
    };
    installPrimary.inject = ["systemPrompt"];
    const primaryFiber = await root.plugin(installPrimary);
    const childKey = Object.freeze({});

    const primaryAssembly = await root.systemPrompt.assemble({ scope: primaryKey });
    const childAssembly = await root.systemPrompt.assemble({ scope: childKey });
    expect(primaryAssembly.sections.map(({ name }) => name)).toEqual([
      "host:global",
      "deployment:persona",
      "host:root",
    ]);
    expect(childAssembly.sections.map(({ name }) => name)).toEqual([
      "host:global",
      "deployment:persona",
    ]);
    expect(childAssembly.contexts).toMatchObject([{
      name: "host:supplement",
      text: "context {{literal}}",
    }]);
    await primaryFiber.dispose();
  });

  it("restores the previous global effect group when a candidate is rolled back", async () => {
    const root = await mounted();
    const registrar = new GlobalSystemContextRegistrar(root);
    registrar.prepare(normalizeSystemContext({
      systemPrompt: "",
      systemContext: {
        sections: [{ id: "stable", order: -80, scope: "global", text: "old" }],
      },
    })).commit();
    const candidate = registrar.prepare(normalizeSystemContext({
      systemPrompt: "",
      systemContext: {
        sections: [{ id: "stable", order: -80, scope: "global", text: "new" }],
      },
    }));
    candidate.rollback();
    expect((await root.systemPrompt.assemble()).sections.find(({ name }) => name === "host:stable"))
      .toMatchObject({ text: "old" });
  });
});
