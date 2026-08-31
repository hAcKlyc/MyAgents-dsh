import type {
  ComponentCompiler,
  ComponentPrepareAuthority,
  ExtensionComponent,
  ExtensionSnapshot,
  PreparedComponentPlan,
} from "@myagents-dsh/component-runtime";
import type {
  DynamicAgentRegistration,
  ProductDynamicAgentController,
} from "@myagents-dsh/tools-agent";
import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";

const MAX_PERSONA_BYTES = 1_000_000;

export interface AgentComponentCompilerConfig {
  readonly controller: ProductDynamicAgentController;
}

const controllerCapability = (value: unknown): ProductDynamicAgentController => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 1) {
    throw new TypeError("Agent component compiler controller is invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "prepare");
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
    throw new TypeError("Agent component compiler prepare capability is invalid");
  }
  const prepare = descriptor.value as ProductDynamicAgentController["prepare"];
  return Object.freeze({
    prepare: (registration: DynamicAgentRegistration) => Reflect.apply(prepare, value, [registration]),
  });
};

const agentPersona = (
  component: Extract<ExtensionComponent, { kind: "agent" }>,
  snapshot: ExtensionSnapshot,
): string => {
  const sections = [component.descriptor.prompt];
  for (const skillId of component.descriptor.skills ?? []) {
    const skill = snapshot.components.find((candidate) => candidate.id === skillId);
    if (skill?.kind !== "skill") throw new TypeError("Agent references an absent Skill component");
    const resource = snapshot.resources.find(({ id }) => id === skill.descriptor.resourceId);
    if (resource?.kind !== "skill_document") throw new TypeError("Agent Skill reference lacks its document");
    sections.push(`<skill_content name=${JSON.stringify(skill.id)}>\n${resource.content}\n</skill_content>`);
  }
  const persona = sections.join("\n\n");
  if (Buffer.byteLength(persona, "utf8") > MAX_PERSONA_BYTES) {
    throw new TypeError("Agent persona and referenced Skills exceed the bounded child prompt");
  }
  return persona;
};

export const createAgentComponentCompiler = (
  config: AgentComponentCompilerConfig,
): ComponentCompiler => {
  const controller = controllerCapability(config.controller);
  return Object.freeze({
    kind: "agent" as const,
    prepare: (
      componentValue: ExtensionComponent,
      snapshot: ExtensionSnapshot,
      signal: AbortSignal,
      authority: ComponentPrepareAuthority,
    ): Promise<PreparedComponentPlan> => {
      signal.throwIfAborted();
      authority.assertCurrent();
      if (componentValue.kind !== "agent" || componentValue.id !== authority.componentId
        || componentValue.id === "general" || componentValue.id === "Explore") {
        throw new TypeError("Agent compiler received an invalid or reserved component authority");
      }
      const component = componentValue;
      const registration: DynamicAgentRegistration = Object.freeze({
        componentId: component.id,
        description: component.descriptor.description,
        generation: Object.freeze({ digest: snapshot.digest, revision: snapshot.revision }),
        maxTurns: component.descriptor.maxTurns ?? 10_000,
        ...(component.descriptor.disallowedTools === undefined
          ? {}
          : { disallowedTools: Object.freeze([...component.descriptor.disallowedTools]) }),
        ...(component.descriptor.modelProfileRef === undefined
          ? {}
          : { modelProfileRef: component.descriptor.modelProfileRef }),
        persona: agentPersona(component, snapshot),
        ...(component.descriptor.tools === undefined
          ? {}
          : { tools: Object.freeze([...component.descriptor.tools]) }),
        type: component.id,
      });
      const prepared = controller.prepare(registration);
      return Promise.resolve(Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([Object.freeze({
          componentId: component.id,
          kind: "agent" as const,
          name: component.id,
          catalog: Object.freeze({ kind: "agent" as const, name: component.id }),
          install: prepared.install,
        })]),
        dispose: () => {
          prepared.dispose();
          return Promise.resolve();
        },
      }));
    },
  });
};
