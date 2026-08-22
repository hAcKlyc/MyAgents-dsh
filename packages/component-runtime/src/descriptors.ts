import { createHash } from "node:crypto";

import {
  ProtocolError,
  extensionSnapshotDigest,
  validateMethodParams,
  validateMethodResult,
  validateNormalizedEffectiveToolCatalog,
  type EffectiveToolCatalogSnapshot,
  type MethodParams,
  type MethodResult,
} from "@myagents-dsh/protocol";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

export type ExtensionSnapshot = MethodParams<"extension/replace">;
export type ExtensionComponent = ExtensionSnapshot["components"][number];
export type ComponentStatus = MethodResult<"extension/status">["components"][number];
export type ExtensionCatalog = MethodResult<"extension/catalog">;

export type PreparedCatalogContribution =
  | Readonly<{ kind: "tool"; name: string }>
  | Readonly<{ kind: "agent"; name: string }>
  | Readonly<{ kind: "mcp"; id: string; state: ComponentStatus["state"] }>
  | Readonly<{ kind: "command"; value: ExtensionCatalog["commands"][number] }>
  | Readonly<{ kind: "skill"; value: ExtensionCatalog["skills"][number] }>;

export interface PreparedContribution {
  readonly componentId: string;
  readonly kind: ExtensionComponent["kind"];
  readonly name: string;
  readonly catalog?: PreparedCatalogContribution;
  readonly install: () => undefined | (() => void);
}

export interface PreparedComponentPlan {
  readonly status: "ready" | "degraded" | "needs_auth";
  readonly reason?: string;
  readonly contributions: readonly PreparedContribution[];
  readonly dispose: () => Promise<void>;
}

export interface ComponentPrepareAuthority {
  readonly componentGenerationId: string;
  readonly componentId: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly assertToolExecution: (toolName: string, execution: ToolRunContext) => void;
  readonly authorizeToolExecution: (
    toolName: string,
    target: string,
    execution: ToolRunContext,
  ) => Promise<void>;
}

export interface ComponentCompiler {
  readonly kind: ExtensionComponent["kind"];
  readonly prepare: (
    component: ExtensionComponent,
    snapshot: ExtensionSnapshot,
    signal: AbortSignal,
    authority: ComponentPrepareAuthority,
  ) => Promise<PreparedComponentPlan>;
}

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const validateExtensionSnapshot = (value: unknown): ExtensionSnapshot => {
  const snapshot = validateMethodParams("extension/replace", value);
  const { digest, ...authority } = snapshot;
  if (extensionSnapshotDigest(authority) !== digest) {
    throw new ProtocolError(
      "extension_digest_mismatch",
      "extension snapshot digest differs from its canonical declarative content",
    );
  }
  const componentIds = new Set<string>();
  for (const component of snapshot.components) {
    if (componentIds.has(component.id)) {
      throw new ProtocolError("extension_duplicate_component", "extension component IDs must be unique");
    }
    componentIds.add(component.id);
  }
  const resourceIds = new Set<string>();
  for (const resource of snapshot.resources) {
    if (resourceIds.has(resource.id)) {
      throw new ProtocolError("extension_duplicate_resource", "extension resource IDs must be unique");
    }
    resourceIds.add(resource.id);
    if (sha256(resource.content) !== resource.sha256) {
      throw new ProtocolError(
        "extension_resource_digest_mismatch",
        "extension resource digest differs from its declared content",
      );
    }
  }
  const resources = new Map(snapshot.resources.map((resource) => [resource.id, resource] as const));
  const componentsById = new Map(snapshot.components.map((component) => [component.id, component] as const));
  for (const component of snapshot.components) {
    if (component.kind === "command" || component.kind === "skill") {
      const resource = resources.get(component.descriptor.resourceId);
      const expectedKind = component.kind === "command" ? "command_template" : "skill_document";
      if (resource?.kind !== expectedKind) {
        throw new ProtocolError(
          "extension_resource_missing",
          `${component.kind} component references an absent or mismatched declarative resource`,
        );
      }
    }
    if (component.kind === "agent") {
      for (const skillId of component.descriptor.skills ?? []) {
        if (componentsById.get(skillId)?.kind !== "skill") {
          throw new ProtocolError(
            "extension_component_reference_missing",
            "agent component references an absent declarative Skill component",
          );
        }
      }
    }
  }
  return snapshot;
};

export const buildExtensionCatalog = (
  snapshot: ExtensionSnapshot,
  baseCatalogValue: EffectiveToolCatalogSnapshot,
  contributions: readonly PreparedContribution[],
): ExtensionCatalog => {
  const baseCatalog = validateNormalizedEffectiveToolCatalog(baseCatalogValue);
  const dynamicTools: string[] = [];
  const agents: string[] = [];
  const commands: ExtensionCatalog["commands"][number][] = [];
  const skills: ExtensionCatalog["skills"][number][] = [];
  const mcpServers: ExtensionCatalog["mcpServers"][number][] = [];
  for (const contribution of contributions) {
    const catalog = contribution.catalog;
    if (catalog === undefined) continue;
    if (catalog.kind === "tool") dynamicTools.push(catalog.name);
    else if (catalog.kind === "agent") agents.push(catalog.name);
    else if (catalog.kind === "command") commands.push(catalog.value);
    else if (catalog.kind === "skill") skills.push(catalog.value);
    else mcpServers.push({ id: catalog.id, state: catalog.state });
  }
  const tools = [...baseCatalog.effectiveTools, ...dynamicTools].sort(compareCodePoints);
  if (new Set(tools).size !== tools.length) {
    throw new ProtocolError("extension_catalog_collision", "extension tool identities must be unique");
  }
  const unique = (values: readonly string[], description: string): void => {
    if (new Set(values).size !== values.length) {
      throw new ProtocolError("extension_catalog_collision", `${description} identities must be unique`);
    }
  };
  unique(agents, "extension agent");
  unique(commands.flatMap(({ name, aliases = [] }) => [name, ...aliases]), "extension command");
  unique(skills.map(({ name }) => name), "extension Skill");
  unique(mcpServers.map(({ id }) => id), "extension MCP server");
  const authority = {
    revision: snapshot.revision,
    tools,
    commands: [...commands].sort((left, right) => compareCodePoints(left.name, right.name)),
    skills: [...skills].sort((left, right) => compareCodePoints(left.name, right.name)),
    agents: [...agents].sort(compareCodePoints),
    mcpServers: [...mcpServers].sort((left, right) => compareCodePoints(left.id, right.id)),
  };
  return validateMethodResult("extension/catalog", Object.freeze({
    ...authority,
    digest: sha256(stableJson(authority)),
  }));
};
