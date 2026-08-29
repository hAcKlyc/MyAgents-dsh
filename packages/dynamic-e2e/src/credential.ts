import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { validateMethodParams, type MethodParams } from "@myagents-dsh/protocol";

export class ApprovedDynamicRoute {
  readonly provider: MethodParams<"session/create">["provider"];
  readonly credentialRevision: string;
  readonly materialField: "apiKey" | "authorization" | "accessToken";
  readonly systemPrompt: string;
  readonly permissionMode: string;
  readonly interactionScenario: string;
  readonly networkPolicyRef: string;
  readonly webSearchAdapters: readonly string[];
  readonly routeConfigSha256: string;
  readonly #secret: string;

  constructor(value: Readonly<{
    provider: MethodParams<"session/create">["provider"];
    credentialRevision: string;
    materialField: "apiKey" | "authorization" | "accessToken";
    secret: string;
    systemPrompt: string;
    permissionMode: string;
    interactionScenario: string;
    networkPolicyRef: string;
    webSearchAdapters: readonly string[];
    routeConfigSha256: string;
  }>) {
    this.provider = value.provider;
    this.credentialRevision = value.credentialRevision;
    this.materialField = value.materialField;
    this.systemPrompt = value.systemPrompt;
    this.permissionMode = value.permissionMode;
    this.interactionScenario = value.interactionScenario;
    this.networkPolicyRef = value.networkPolicyRef;
    this.webSearchAdapters = value.webSearchAdapters;
    this.routeConfigSha256 = value.routeConfigSha256;
    this.#secret = value.secret;
    Object.freeze(this);
  }

  credentialMaterial(): string { return this.#secret; }
}

export class ApprovedDynamicRouteCredentialUnavailableError extends Error {
  readonly routeConfigSha256: string;
  readonly providerRouteId: string;
  readonly modelId: string;

  constructor(value: Readonly<{
    routeConfigSha256: string;
    providerRouteId: string;
    modelId: string;
  }>) {
    super("approved dynamic route credential is unavailable");
    this.name = "ApprovedDynamicRouteCredentialUnavailableError";
    this.routeConfigSha256 = value.routeConfigSha256;
    this.providerRouteId = value.providerRouteId;
    this.modelId = value.modelId;
  }
}

export const loadApprovedDynamicRoute = async (
  path: string,
  credentialEnvironmentVariable: string,
): Promise<ApprovedDynamicRoute> => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(credentialEnvironmentVariable)) {
    throw new TypeError("dynamic credential environment variable name is invalid");
  }
  const bytes = await readFile(path);
  if (bytes.length > 65_536) throw new TypeError("dynamic route config exceeds its byte bound");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("dynamic route config must be a JSON object");
  }
  const object = value as Record<string, unknown>;
  const expectedKeys = [
    "credentialRevision", "interactionScenario", "materialField", "permissionMode", "provider",
    "networkPolicyRef", "schemaVersion", "systemPrompt", "webSearchAdapters",
  ];
  if (JSON.stringify(Object.keys(object).sort()) !== JSON.stringify(expectedKeys.sort())
    || object.schemaVersion !== 1
    || (object.materialField !== "apiKey" && object.materialField !== "authorization"
      && object.materialField !== "accessToken")
    || typeof object.credentialRevision !== "string"
    || typeof object.systemPrompt !== "string"
    || typeof object.permissionMode !== "string"
    || typeof object.interactionScenario !== "string"
    || typeof object.networkPolicyRef !== "string"
    || !Array.isArray(object.webSearchAdapters)
    || object.webSearchAdapters.length > 8
    || object.webSearchAdapters.some((entry) => typeof entry !== "string")) {
    throw new TypeError("dynamic route config differs from its exact schema");
  }
  const validated = validateMethodParams("session/create", {
    clientOperationId: "dynamic-route-validation",
    runtimeSessionId: "dynamic-route-validation",
    persistenceRef: "dynamic-route-validation",
    provider: object.provider,
    configRevision: "dynamic-route-validation",
    extensionDigest: "0".repeat(64),
    systemPrompt: object.systemPrompt,
    permissionMode: object.permissionMode,
    interactionScenario: object.interactionScenario,
  });
  const isBoundedIdentifier = (candidate: string): boolean => candidate.length >= 1
    && candidate.length <= 256
    && Array.from(candidate).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    });
  if (!isBoundedIdentifier(object.credentialRevision)
    || !isBoundedIdentifier(object.permissionMode)
    || !isBoundedIdentifier(object.interactionScenario)
    || !isBoundedIdentifier(object.networkPolicyRef)
    || object.webSearchAdapters.some((entry) => !isBoundedIdentifier(entry as string))
    || new Set(object.webSearchAdapters).size !== object.webSearchAdapters.length) {
    throw new TypeError("dynamic route revisions must be bounded identifiers");
  }
  const routeConfigSha256 = createHash("sha256").update(bytes).digest("hex");
  const secret = globalThis.process.env[credentialEnvironmentVariable];
  if (secret === undefined || secret.length < 8 || secret.length > 65_536 || secret.includes("\0")) {
    throw new ApprovedDynamicRouteCredentialUnavailableError({
      routeConfigSha256,
      providerRouteId: validated.provider.providerRouteId,
      modelId: validated.provider.modelId,
    });
  }
  return new ApprovedDynamicRoute({
    provider: validated.provider,
    credentialRevision: object.credentialRevision,
    materialField: object.materialField,
    secret,
    systemPrompt: object.systemPrompt,
    permissionMode: object.permissionMode,
    interactionScenario: object.interactionScenario,
    networkPolicyRef: object.networkPolicyRef,
    webSearchAdapters: Object.freeze([...(object.webSearchAdapters as string[])]),
    routeConfigSha256,
  });
};
