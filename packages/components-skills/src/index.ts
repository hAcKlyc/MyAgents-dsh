import type {
  ComponentCompiler,
  ComponentPrepareAuthority,
  ExtensionComponent,
  ExtensionSnapshot,
  PreparedComponentPlan,
} from "@myagents-dsh/component-runtime";
import type {
  DynamicSkillRegistration,
  ProductDynamicSkillController,
} from "@myagents-dsh/tools-agent";
import { projectProductSkillDescription } from "@myagents-dsh/tools-agent";
import { isProxy } from "node:util/types";

export interface SkillComponentCompilerConfig {
  readonly controller: ProductDynamicSkillController;
}

const exactController = (value: unknown): ProductDynamicSkillController => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 1) {
    throw new TypeError("Skill component compiler controller is invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "prepare");
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
    throw new TypeError("Skill component compiler controller prepare capability is invalid");
  }
  const prepare = descriptor.value as ProductDynamicSkillController["prepare"];
  return Object.freeze({
    prepare: (registration: DynamicSkillRegistration) => Reflect.apply(prepare, value, [registration]),
  });
};

export const createSkillComponentCompiler = (
  config: SkillComponentCompilerConfig,
): ComponentCompiler => {
  const controller = exactController(config.controller);
  return Object.freeze({
    kind: "skill" as const,
    prepare: (
      componentValue: ExtensionComponent,
      snapshot: ExtensionSnapshot,
      signal: AbortSignal,
      authority: ComponentPrepareAuthority,
    ): Promise<PreparedComponentPlan> => {
      signal.throwIfAborted();
      authority.assertCurrent();
      if (componentValue.kind !== "skill" || componentValue.id !== authority.componentId) {
        throw new TypeError("Skill compiler received a mismatched component authority");
      }
      const component = componentValue;
      const resource = snapshot.resources.find(({ id }) => id === component.descriptor.resourceId);
      if (resource?.kind !== "skill_document") {
        throw new TypeError("Skill component lacks its exact declarative document");
      }
      const description = projectProductSkillDescription(component.descriptor.description, component.id);
      const registration: DynamicSkillRegistration = Object.freeze({
        componentId: component.id,
        content: resource.content,
        description,
        generation: Object.freeze({ digest: snapshot.digest, revision: snapshot.revision }),
        invocation: Object.freeze({ ...component.descriptor.invocation }),
        name: component.id,
        rank: component.descriptor.rank ?? 100,
        sourceSha256: resource.sha256,
        ...(component.descriptor.whenToUse === undefined
          ? {}
          : { whenToUse: component.descriptor.whenToUse }),
      });
      const prepared = controller.prepare(registration);
      const contribution = Object.freeze({
        componentId: component.id,
        kind: "skill" as const,
        name: component.id,
        catalog: Object.freeze({
          kind: "skill" as const,
          value: Object.freeze({
            name: component.id,
            description,
            disableModelInvocation: !component.descriptor.invocation.modelInvocable,
          }),
        }),
        install: prepared.install,
      });
      return Promise.resolve(Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([contribution]),
        dispose: () => {
          prepared.dispose();
          return Promise.resolve();
        },
      }));
    },
  });
};
