import { createHash } from "node:crypto";

import {
  BootstrapSchema,
  BrowserCommandSchema,
  CommandAcceptedSchema,
  HealthSchema,
  HostEventSchema,
  InteractionAcceptedSchema,
  InteractionResponseSchema,
  MAX_ACTIVE_RUNTIME_CHILDREN,
  MAX_BROWSER_BODY_BYTES,
  MAX_SSE_EVENT_BYTES,
  MAX_WEB_SESSIONS,
  WEB_HOST_CONTRACT_VERSION,
} from "@myagents-dsh/web-host-contract/schemas";
import {
  canonicalProtocolJsonSnapshot,
  serializeCanonicalProtocolJson,
} from "@myagents-dsh/protocol";

const outputPaths = {
  metadata: "packages/web-host-contract/generated/browser-contract-meta.json",
  schema: "packages/web-host-contract/generated/browser-contract.schema.json",
} as const;

const plainJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
const prettyJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value: unknown): string => createHash("sha256")
  .update(serializeCanonicalProtocolJson(canonicalProtocolJsonSnapshot(
    plainJson(value),
    "web_host_contract_generation_invalid",
  )))
  .digest("hex");

const literalsFromUnion = (schema: unknown, label: string): string[] => {
  const variants = (schema as { anyOf?: unknown[] }).anyOf;
  if (!Array.isArray(variants)) throw new TypeError(`${label} must be a TypeBox union`);
  return variants.map((variant) => {
    const value = (variant as {
      properties?: { kind?: { const?: unknown } };
    }).properties?.kind?.const;
    if (typeof value !== "string") throw new TypeError(`${label} variant lacks a literal kind`);
    return value;
  });
};

export const buildWebHostContractArtifacts = (): ReadonlyMap<string, string> => {
  const schema = plainJson({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:myagents-dsh:web-host-contract:1",
    title: "MyAgents DSH Reference Web Host browser contract",
    contractVersion: WEB_HOST_CONTRACT_VERSION,
    $defs: {
      bootstrap: BootstrapSchema,
      browserCommand: BrowserCommandSchema,
      commandAccepted: CommandAcceptedSchema,
      health: HealthSchema,
      hostEvent: HostEventSchema,
      interactionAccepted: InteractionAcceptedSchema,
      interactionResponse: InteractionResponseSchema,
    },
  });
  const schemaSha256 = digest(schema);
  const metadata = {
    formatVersion: 1,
    contractVersion: WEB_HOST_CONTRACT_VERSION,
    schemaSha256,
    commandKinds: literalsFromUnion(BrowserCommandSchema, "BrowserCommandSchema"),
    eventKinds: literalsFromUnion(HostEventSchema, "HostEventSchema"),
    limits: {
      maxActiveRuntimeChildren: MAX_ACTIVE_RUNTIME_CHILDREN,
      maxBodyBytes: MAX_BROWSER_BODY_BYTES,
      maxSseEventBytes: MAX_SSE_EVENT_BYTES,
      maxWebSessions: MAX_WEB_SESSIONS,
    },
  };
  return new Map([
    [outputPaths.schema, prettyJson(schema)],
    [outputPaths.metadata, prettyJson(metadata)],
  ]);
};

export const findWebHostContractDrift = async (
  artifacts: ReadonlyMap<string, string>,
  read: (relativePath: string) => Promise<string | undefined>,
): Promise<string[]> => {
  const failures: string[] = [];
  for (const [relativePath, expected] of artifacts) {
    if (await read(relativePath) !== expected) failures.push(relativePath);
  }
  return failures;
};
