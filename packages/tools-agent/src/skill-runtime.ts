import { throwIfProductToolAborted } from "@myagents-dsh/tool-runtime-product";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import { Service, type Context } from "@deepseek-ai/cordis";
import type { FsInfo, FsPathInfo, FsTarget } from "@deepseek-ai/dsh-fs";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import {
  isModelInvocable,
  isSkillName,
  renderSkillContent,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
  type SkillSummary,
} from "@deepseek-ai/dsh-skill";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { AssembleContext } from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  CANONICAL_TOOL_CONTRACTS,
  canonicalInputSchemaForDsh,
  canonicalOutputSchemaForDsh,
  normalizeCanonicalJson,
  stableJson,
  validateCanonicalToolInput,
  validateCanonicalToolOutput,
} from "@myagents-dsh/tool-contracts";
import {
  ProductToolError,
  runWithProductToolExecutionDeadline,
  type ProductToolContext,
  type ProductToolOperationAuthority,
} from "@myagents-dsh/tool-runtime-product";
import { LocalWorkspaceFileSystem } from "@myagents-dsh/tools-fs";

export const PRODUCT_STATIC_SKILL_PROVIDER = "myagents-static-skills";
export const PRODUCT_COMPONENT_SKILL_PROVIDER = "myagents-component-skills";
export const PRODUCT_SKILL_DESCRIPTION_MAX_CHARACTERS = 1_024;

const MAX_SKILLS = 128;
const MAX_SKILL_SOURCE_BYTES = 240_000;
const MAX_EXPANDED_SKILL_BYTES = 240_000;
const MAX_ARGUMENT_NAMES = 32;

export interface StaticSkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: SkillInvocationPolicy;
  readonly rank: number;
  readonly resourceRoot: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
}

export interface StaticSkillCatalog {
  readonly formatVersion: 1;
  readonly revision: string;
  readonly digest: string;
  readonly skills: readonly StaticSkillDescriptor[];
}

export interface ProductSkillServiceConfig {
  readonly catalog: StaticSkillCatalog;
  readonly registerDynamicController?: (controller: ProductDynamicSkillController) => void;
  readonly resolveOperation?: (agent: Agent) => ProductToolOperationAuthority;
}

export interface DynamicSkillGenerationIdentity {
  readonly digest: string;
  readonly revision: string;
}

export interface DynamicSkillRegistration {
  readonly componentId: string;
  readonly content: string;
  readonly description: string;
  readonly generation: DynamicSkillGenerationIdentity;
  readonly invocation: SkillInvocationPolicy;
  readonly name: string;
  readonly rank: number;
  readonly resourceRoot?: string;
  readonly sourcePath?: string;
  readonly sourceSha256: string;
  readonly whenToUse?: string;
}

export interface ProductDynamicSkillController {
  readonly prepare: (registration: DynamicSkillRegistration) => Readonly<{
    readonly dispose: () => void;
    readonly install: () => () => void;
  }>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    productSkills: ProductSkillService;
  }
}


type JsonObject = Record<string, unknown>;

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || hasControlCharacter(value)) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  return value;
};

const boundedText = (value: unknown, maximum: number, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || hasControlCharacter(value)) {
    throw new TypeError(`${description} must be bounded text`);
  }
  return value;
};

const projectSkillText = (
  value: unknown,
  maximum: number,
  fallback: string,
  description: string,
): string => {
  if (typeof value !== "string") throw new TypeError(`${description} must be text`);
  const characters: string[] = [];
  let pendingSpace = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      if (characters.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace && characters.length + 1 < maximum) characters.push(" ");
    pendingSpace = false;
    if (characters.length >= maximum) break;
    characters.push(character);
    if (characters.length >= maximum) break;
  }
  const projected = characters.length === 0
    ? Array.from(fallback).slice(0, maximum).join("")
    : characters.join("");
  if (projected.length === 0) throw new TypeError(`${description} must not be empty`);
  return projected;
};

export const projectProductSkillDescription = (
  value: unknown,
  skillName: string,
): string => projectSkillText(
  value,
  PRODUCT_SKILL_DESCRIPTION_MAX_CHARACTERS,
  `Skill ${skillName}`,
  "Skill description",
);

const boundedDocument = (value: unknown, maximumBytes: number, description: string): string => {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new TypeError(`${description} must be a bounded document`);
  }
  return value;
};

const exactObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const record = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)
    || descriptors[key] === undefined || !descriptors[key].enumerable || !("value" in descriptors[key]))) {
    throw new TypeError(`${description} contains an unsupported field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return record;
};

const freezeInvocation = (value: unknown, description: string): SkillInvocationPolicy => {
  const invocation = exactObject(value, ["modelInvocable", "userInvocable"], [], description);
  if (typeof invocation.modelInvocable !== "boolean" || typeof invocation.userInvocable !== "boolean") {
    throw new TypeError(`${description} flags must be boolean`);
  }
  return Object.freeze({
    modelInvocable: invocation.modelInvocable,
    userInvocable: invocation.userInvocable,
  });
};

const descriptorAuthority = (descriptor: StaticSkillDescriptor): JsonObject => ({
  name: descriptor.name,
  description: descriptor.description,
  ...(descriptor.whenToUse === undefined ? {} : { whenToUse: descriptor.whenToUse }),
  invocation: descriptor.invocation,
  rank: descriptor.rank,
  resourceRoot: descriptor.resourceRoot,
  sourcePath: descriptor.sourcePath,
  sourceSha256: descriptor.sourceSha256,
});

export const staticSkillCatalogDigest = (
  catalog: Pick<StaticSkillCatalog, "formatVersion" | "revision" | "skills">,
): string => sha256(stableJson({
  formatVersion: catalog.formatVersion,
  revision: catalog.revision,
  skills: catalog.skills.map(descriptorAuthority),
}));

export const validateStaticSkillCatalog = (value: unknown): StaticSkillCatalog => {
  const normalized = normalizeCanonicalJson(value, "static Skill catalog");
  const catalog = exactObject(
    normalized,
    ["formatVersion", "revision", "digest", "skills"],
    [],
    "static Skill catalog",
  );
  if (catalog.formatVersion !== 1) throw new TypeError("static Skill catalog formatVersion must be 1");
  const revision = boundedIdentifier(catalog.revision, "static Skill catalog revision");
  if (typeof catalog.digest !== "string" || !/^[a-f0-9]{64}$/u.test(catalog.digest)) {
    throw new TypeError("static Skill catalog digest must be lowercase SHA-256");
  }
  if (!Array.isArray(catalog.skills) || catalog.skills.length > MAX_SKILLS) {
    throw new TypeError("static Skill catalog must contain zero to 128 descriptors");
  }
  const observedSources = new Set<string>();
  const skills = catalog.skills.map((candidate, index): StaticSkillDescriptor => {
    const descriptor = exactObject(
      candidate,
      ["name", "description", "invocation", "rank", "resourceRoot", "sourcePath", "sourceSha256"],
      ["whenToUse"],
      `static Skill descriptor[${String(index)}]`,
    );
    const name = boundedIdentifier(descriptor.name, `static Skill descriptor[${String(index)}].name`);
    if (!isSkillName(name)) throw new TypeError(`static Skill descriptor[${String(index)}].name is invalid`);
    const description = boundedText(
      descriptor.description,
      2_048,
      `static Skill descriptor[${String(index)}].description`,
    );
    const whenToUse = descriptor.whenToUse === undefined
      ? undefined
      : boundedText(descriptor.whenToUse, 4_096, `static Skill descriptor[${String(index)}].whenToUse`);
    if (!Number.isSafeInteger(descriptor.rank) || (descriptor.rank as number) < 0
      || (descriptor.rank as number) > 100_000) {
      throw new TypeError(`static Skill descriptor[${String(index)}].rank is invalid`);
    }
    const resourceRoot = boundedText(
      descriptor.resourceRoot,
      8_192,
      `static Skill descriptor[${String(index)}].resourceRoot`,
    );
    const sourcePath = boundedText(
      descriptor.sourcePath,
      8_192,
      `static Skill descriptor[${String(index)}].sourcePath`,
    );
    if (observedSources.has(sourcePath)) {
      throw new TypeError(`static Skill descriptor[${String(index)}].sourcePath is duplicated`);
    }
    observedSources.add(sourcePath);
    if (typeof descriptor.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.sourceSha256)) {
      throw new TypeError(`static Skill descriptor[${String(index)}].sourceSha256 is invalid`);
    }
    return Object.freeze({
      name,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      invocation: freezeInvocation(
        descriptor.invocation,
        `static Skill descriptor[${String(index)}].invocation`,
      ),
      rank: descriptor.rank as number,
      resourceRoot,
      sourcePath,
      sourceSha256: descriptor.sourceSha256,
    });
  });
  const result = Object.freeze({
    formatVersion: 1 as const,
    revision,
    digest: catalog.digest,
    skills: Object.freeze(skills),
  });
  if (staticSkillCatalogDigest(result) !== result.digest) {
    throw new TypeError("static Skill catalog digest differs from its exact descriptors");
  }
  return result;
};

interface ParsedSkillDocument {
  readonly argumentNames: readonly string[];
  readonly body: string;
}

interface StaticSkillRootAuthority {
  readonly allowedRoot: FsTarget;
  readonly allowedRootPathVersion: string;
  readonly allowedRootVersion: string;
  readonly resourceRoot: FsTarget;
  readonly resourceRootPathVersion: string;
  readonly resourceRootVersion: string;
}

interface StaticSkillLoadPermit {
  readonly root: StaticSkillRootAuthority;
}

type DynamicSkillRecord = Readonly<Omit<DynamicSkillRegistration, "content"> & {
  readonly argumentNames: readonly string[];
  readonly content: string;
  readonly locator: object;
  readonly source: string;
}>;

const parseScalar = (value: string, description: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${description} must not be empty`);
  let result = trimmed;
  if (trimmed.startsWith('"') || trimmed.endsWith('"')) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch (error) {
      throw new TypeError(`${description} contains invalid quoted text`, { cause: error });
    }
    if (typeof parsed !== "string") throw new TypeError(`${description} must be a string`);
    result = parsed;
  } else if (trimmed.startsWith("'") || trimmed.endsWith("'")) {
    if (!(trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
      throw new TypeError(`${description} contains invalid quoted text`);
    }
    result = trimmed.slice(1, -1);
  }
  if (result.length === 0 || result.length > 4_096 || hasControlCharacter(result)) {
    throw new TypeError(`${description} is invalid`);
  }
  return result;
};

const parseFlowArguments = (value: string): readonly string[] => {
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) return Object.freeze([]);
  const entries: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of inner) {
    if (quote !== undefined) {
      current += character;
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if (character === ",") {
      entries.push(parseScalar(current, "Skill frontmatter arguments entry"));
      current = "";
    } else {
      current += character;
    }
  }
  if (quote !== undefined || escaped) throw new TypeError("Skill frontmatter arguments array is invalid");
  entries.push(parseScalar(current, "Skill frontmatter arguments entry"));
  return Object.freeze(entries);
};

const parseArgumentNames = (value: string | undefined): readonly string[] => {
  if (value === undefined) return Object.freeze([]);
  const trimmed = value.trim();
  const names = trimmed.startsWith("[") || trimmed.endsWith("]")
    ? (() => {
      if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        throw new TypeError("Skill frontmatter arguments array is invalid");
      }
      return parseFlowArguments(trimmed);
    })()
    : Object.freeze(parseScalar(trimmed, "Skill frontmatter arguments").split(/\s+/u).filter(Boolean));
  if (names.length > MAX_ARGUMENT_NAMES
    || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
    || new Set(names).size !== names.length) {
    throw new TypeError("Skill argument-name metadata is invalid");
  }
  return names;
};

const parseSkillDocument = (
  source: string,
  descriptor: StaticSkillDescriptor,
): ParsedSkillDocument => {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new TypeError("Skill source lacks exact frontmatter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new TypeError("Skill source frontmatter is unterminated");
  const frontmatter = normalized.slice(4, end);
  const allowed = new Set(["name", "description", "when-to-use", "argument-hint", "arguments"]);
  const fields = new Map<string, string>();
  for (const [index, line] of frontmatter.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new TypeError(`Skill frontmatter line ${String(index + 1)} is invalid`);
    const key = line.slice(0, separator).trim();
    if (!allowed.has(key) || fields.has(key)) {
      throw new TypeError(`Skill frontmatter field ${key} is unsupported or duplicated`);
    }
    const rawValue = line.slice(separator + 1);
    fields.set(key, key === "arguments"
      ? rawValue.trim()
      : parseScalar(rawValue, `Skill frontmatter ${key}`));
  }
  if (fields.get("name") !== descriptor.name || fields.get("description") !== descriptor.description) {
    throw new TypeError("Skill frontmatter differs from its static descriptor");
  }
  if (fields.get("when-to-use") !== descriptor.whenToUse) {
    throw new TypeError("Skill when-to-use metadata differs from its static descriptor");
  }
  const argumentNames = parseArgumentNames(fields.get("arguments"));
  const body = normalized.slice(end + 5).trim();
  if (body.length === 0 || Buffer.byteLength(body, "utf8") > MAX_SKILL_SOURCE_BYTES) {
    throw new TypeError("Skill instruction body is empty or too large");
  }
  return Object.freeze({ argumentNames, body });
};

const parseWorkspaceSkillDocument = (source: string): ParsedSkillDocument => {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return Object.freeze({ argumentNames: Object.freeze([]), body: normalized.trim() });
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new TypeError("workspace Skill frontmatter is unterminated");
  const frontmatter = normalized.slice(4, end);
  const argumentsLine = frontmatter.split("\n")
    .find((line) => /^arguments\s*:/u.test(line));
  const argumentNames = argumentsLine === undefined
    ? Object.freeze([])
    : parseArgumentNames(argumentsLine.slice(argumentsLine.indexOf(":") + 1));
  const body = normalized.slice(end + 5).trim();
  if (body.length === 0 || Buffer.byteLength(body, "utf8") > MAX_SKILL_SOURCE_BYTES) {
    throw new TypeError("workspace Skill instruction body is empty or too large");
  }
  // Workspace metadata is guidance, never a permission grant. Preserve the
  // authored allowed-tools declaration when rendering instead of silently
  // dropping it while stripping ordinary frontmatter.
  return Object.freeze({ argumentNames, body: /^allowed-tools\s*:/mu.test(frontmatter) ? normalized.trim() : body });
};

const matchingVersion = (left: FsInfo | FsPathInfo, right: FsInfo | FsPathInfo): boolean =>
  left.type === right.type && left.size === right.size && String(left.version) === String(right.version);

const combinedSignal = (lookup: AbortSignal | undefined, lifecycle: AbortSignal): AbortSignal =>
  lookup === undefined ? lifecycle : AbortSignal.any([lookup, lifecycle]);

const exactTarget = (target: FsTarget, expectedPath: string, description: string): void => {
  if (target.displayPath !== expectedPath || typeof target.targetKey !== "string"
    || target.targetKey.length === 0) {
    throw new TypeError(`${description} is not its canonical filesystem identity`);
  }
};

const captureDirectoryIdentity = async (
  ctx: Context,
  path: string,
  signal: AbortSignal,
  description: string,
): Promise<Readonly<{ target: FsTarget; pathVersion: string; version: string }>> => {
  signal.throwIfAborted();
  const pathInfo = await ctx.fs.lstat(path, undefined, signal);
  if (pathInfo?.type !== "directory") {
    throw new TypeError(`${description} must be a direct non-symbolic directory`);
  }
  const target = await ctx.fs.resolve(path, { signal });
  exactTarget(target, path, description);
  const info = await ctx.fs.stat(target, signal);
  if (info?.type !== "directory") throw new TypeError(`${description} is not a directory`);
  return Object.freeze({
    target,
    pathVersion: String(pathInfo.version),
    version: String(info.version),
  });
};

const captureApprovedSkillRoot = async (
  ctx: Context,
  product: ProductToolContext,
  resourceRoot: string,
): Promise<StaticSkillRootAuthority> => {
  const resource = await captureDirectoryIdentity(
    ctx,
    resourceRoot,
    product.signal,
    "Skill resource root",
  );
  for (const allowedPath of product.environment.workspace.allowedReadRoots) {
    const allowed = await captureDirectoryIdentity(
      ctx,
      allowedPath,
      product.signal,
      "Skill allowed read root",
    );
    if (ctx.fs.contains(allowed.target, resource.target)) {
      return Object.freeze({
        allowedRoot: allowed.target,
        allowedRootPathVersion: allowed.pathVersion,
        allowedRootVersion: allowed.version,
        resourceRoot: resource.target,
        resourceRootPathVersion: resource.pathVersion,
        resourceRootVersion: resource.version,
      });
    }
  }
  throw new TypeError("Skill resource root is outside operation-frozen allowed read roots");
};

const sameRootAuthority = (
  left: StaticSkillRootAuthority,
  right: StaticSkillRootAuthority,
): boolean => left.allowedRoot.displayPath === right.allowedRoot.displayPath
  && left.allowedRoot.targetKey === right.allowedRoot.targetKey
  && left.allowedRootPathVersion === right.allowedRootPathVersion
  && left.allowedRootVersion === right.allowedRootVersion
  && left.resourceRoot.displayPath === right.resourceRoot.displayPath
  && left.resourceRoot.targetKey === right.resourceRoot.targetKey
  && left.resourceRootPathVersion === right.resourceRootPathVersion
  && left.resourceRootVersion === right.resourceRootVersion;

const revalidateSkillRoot = async (
  ctx: Context,
  expected: StaticSkillRootAuthority,
  signal: AbortSignal,
): Promise<void> => {
  const [allowed, resource] = await Promise.all([
    captureDirectoryIdentity(ctx, expected.allowedRoot.displayPath, signal, "Skill allowed read root"),
    captureDirectoryIdentity(ctx, expected.resourceRoot.displayPath, signal, "Skill resource root"),
  ]);
  const observed = Object.freeze({
    allowedRoot: allowed.target,
    allowedRootPathVersion: allowed.pathVersion,
    allowedRootVersion: allowed.version,
    resourceRoot: resource.target,
    resourceRootPathVersion: resource.pathVersion,
    resourceRootVersion: resource.version,
  });
  if (!ctx.fs.contains(allowed.target, resource.target) || !sameRootAuthority(expected, observed)) {
    throw new TypeError("Skill resource-root authority changed during execution");
  }
};

const loadStaticSkill = async (
  ctx: Context,
  descriptor: StaticSkillDescriptor,
  rootAuthority: StaticSkillRootAuthority,
  signal: AbortSignal,
): Promise<SkillDefinition> => {
  signal.throwIfAborted();
  if (descriptor.resourceRoot !== rootAuthority.resourceRoot.displayPath) {
    throw new TypeError("Skill descriptor differs from its operation-frozen root authority");
  }
  await revalidateSkillRoot(ctx, rootAuthority, signal);
  const sourcePathBefore = await ctx.fs.lstat(descriptor.sourcePath, undefined, signal);
  if (sourcePathBefore?.type !== "file") {
    throw new TypeError("Skill source must be a direct non-symbolic filesystem entry");
  }
  const source = await ctx.fs.resolve(descriptor.sourcePath, { signal });
  exactTarget(source, descriptor.sourcePath, "Skill source");
  if (!ctx.fs.contains(rootAuthority.resourceRoot, source)
    || rootAuthority.resourceRoot.targetKey === source.targetKey) {
    throw new TypeError("Skill source is outside its approved resource root");
  }
  const sourceBefore = await ctx.fs.stat(source, signal);
  if (sourceBefore?.type !== "file"
    || (sourceBefore.size !== undefined && sourceBefore.size > MAX_SKILL_SOURCE_BYTES)) {
    throw new TypeError("Skill source authority is not a bounded regular file");
  }
  if (!(ctx.fs instanceof LocalWorkspaceFileSystem)) {
    throw new TypeError("Skill source requires the composition-selected local filesystem Provider");
  }
  const bytes = await ctx.fs.readUnsharedBytes(source, signal, MAX_SKILL_SOURCE_BYTES);
  const [sourcePathAfter, sourceAfter] = await Promise.all([
    ctx.fs.lstat(descriptor.sourcePath, undefined, signal),
    ctx.fs.stat(source, signal),
  ]);
  if (sourcePathAfter === undefined || sourceAfter === undefined
    || !matchingVersion(sourcePathBefore, sourcePathAfter)
    || !matchingVersion(sourceBefore, sourceAfter)) {
    throw new TypeError("Skill source identity changed while it was read");
  }
  await revalidateSkillRoot(ctx, rootAuthority, signal);
  if (sha256(bytes) !== descriptor.sourceSha256) {
    throw new TypeError("Skill source digest differs from its static descriptor");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (error) {
    throw new TypeError("Skill source is not valid UTF-8", { cause: error });
  }
  const parsed = parseSkillDocument(text, descriptor);
  return Object.freeze({
    name: descriptor.name,
    description: descriptor.description,
    ...(descriptor.whenToUse === undefined ? {} : { whenToUse: descriptor.whenToUse }),
    invocation: descriptor.invocation,
    source: "bundled",
    provider: PRODUCT_STATIC_SKILL_PROVIDER,
    resourceBase: Object.freeze({ kind: "directory" as const, path: descriptor.resourceRoot }),
    content: parsed.body,
    path: descriptor.sourcePath,
    metadata: Object.freeze({
      argumentNames: parsed.argumentNames,
      sourceSha256: descriptor.sourceSha256,
    }),
  });
};

const parseArguments = (input: string): readonly string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const character of input) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current.length > 0) { tokens.push(current); current = ""; }
    } else {
      current += character;
    }
  }
  if (quote !== undefined) throw new TypeError("Skill arguments contain an unmatched quote");
  if (current.length > 0) tokens.push(current);
  return Object.freeze(tokens);
};

const expandSkillArguments = (
  body: string,
  input: string,
  argumentNames: readonly string[],
  resourceRoot?: string,
): Readonly<{ content: string; expanded: boolean }> => {
  const withSkillDirectory = resourceRoot === undefined
    ? body
    : body.replaceAll("${CLAUDE_SKILL_DIR}", resourceRoot);
  const positional = parseArguments(input);
  const named = new Map(argumentNames.map((name, index) => [name, positional[index] ?? ""] as const));
  let substituted = false;
  let bytes = 0;
  let cursor = 0;
  const pieces: string[] = [];
  const pattern = /\$ARGUMENTS(?:\[([0-9]+)\])?|\$([0-9]+)|\$([A-Za-z_][A-Za-z0-9_]*)/gu;
  for (let match = pattern.exec(withSkillDirectory); match !== null; match = pattern.exec(withSkillDirectory)) {
    const unchanged = withSkillDirectory.slice(cursor, match.index);
    const [whole, indexed, shortIndex, namedArgument] = match;
    let replacement = whole;
    if (whole.startsWith("$ARGUMENTS")) {
      replacement = indexed === undefined ? input : positional[Number(indexed)] ?? "";
      substituted = true;
    } else if (shortIndex !== undefined) {
      replacement = positional[Number(shortIndex)] ?? "";
      substituted = true;
    } else if (namedArgument !== undefined && named.has(namedArgument)) {
      replacement = named.get(namedArgument) ?? "";
      substituted = true;
    }
    bytes += Buffer.byteLength(unchanged, "utf8") + Buffer.byteLength(replacement, "utf8");
    if (bytes > MAX_EXPANDED_SKILL_BYTES) throw new TypeError("expanded Skill instructions exceed the byte bound");
    pieces.push(unchanged, replacement);
    cursor = match.index + whole.length;
  }
  const tail = withSkillDirectory.slice(cursor);
  bytes += Buffer.byteLength(tail, "utf8");
  if (bytes > MAX_EXPANDED_SKILL_BYTES) throw new TypeError("expanded Skill instructions exceed the byte bound");
  pieces.push(tail);
  let content = pieces.join("");
  if (input.length > 0 && !substituted) {
    const suffix = `\n\nARGUMENTS: ${input}`;
    if (Buffer.byteLength(content, "utf8") + Buffer.byteLength(suffix, "utf8")
      > MAX_EXPANDED_SKILL_BYTES) {
      throw new TypeError("expanded Skill instructions exceed the byte bound");
    }
    content += suffix;
  }
  return Object.freeze({ content, expanded: input.length > 0 && content !== withSkillDirectory });
};

const exactArgumentNames = (definition: SkillDefinition): readonly string[] => {
  const metadata = exactObject(
    normalizeCanonicalJson(definition.metadata, "loaded Skill metadata"),
    ["argumentNames", "sourceSha256"],
    [],
    "loaded Skill metadata",
  );
  if (!Array.isArray(metadata.argumentNames) || metadata.argumentNames.length > MAX_ARGUMENT_NAMES
    || metadata.argumentNames.some((name) => typeof name !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
    || new Set(metadata.argumentNames).size !== metadata.argumentNames.length) {
    throw new TypeError("loaded Skill argument names are invalid");
  }
  return metadata.argumentNames as readonly string[];
};

const summaryMatches = (
  summary: SkillSummary,
  descriptor: StaticSkillDescriptor,
): boolean => summary.name === descriptor.name
  && summary.description === descriptor.description
  && summary.whenToUse === descriptor.whenToUse
  && summary.provider === PRODUCT_STATIC_SKILL_PROVIDER
  && summary.source === "bundled"
  && summary.invocation.modelInvocable === descriptor.invocation.modelInvocable
  && summary.invocation.userInvocable === descriptor.invocation.userInvocable
  && summary.resourceBase?.kind === "directory"
  && summary.resourceBase.path === descriptor.resourceRoot;

const normalizeObservedSkillCatalog = (
  value: unknown,
): Readonly<{ complete: boolean; skills: readonly SkillSummary[] }> => {
  const catalog = exactObject(
    normalizeCanonicalJson(value, "operation-visible Skill catalog"),
    ["complete", "skills"],
    [],
    "operation-visible Skill catalog",
  );
  if (typeof catalog.complete !== "boolean" || !Array.isArray(catalog.skills)
    || catalog.skills.length > MAX_SKILLS) {
    throw new TypeError("operation-visible Skill catalog has an invalid bounded shape");
  }
  const skills = catalog.skills.map((value, index): SkillSummary => {
    const summary = exactObject(
      value,
      ["name", "description", "invocation", "source", "provider"],
      ["whenToUse", "resourceBase"],
      `operation-visible Skill summary[${String(index)}]`,
    );
    const resource = summary.resourceBase === undefined
      ? undefined
      : exactObject(
        summary.resourceBase,
        ["kind", "path"],
        [],
        `operation-visible Skill summary[${String(index)}].resourceBase`,
      );
    if (resource !== undefined && resource.kind !== "directory") {
      throw new TypeError("operation-visible static Skill resource base must be a directory");
    }
    const name = boundedIdentifier(summary.name, `operation-visible Skill summary[${String(index)}].name`);
    return Object.freeze({
      name,
      description: projectProductSkillDescription(summary.description, name),
      ...(summary.whenToUse === undefined ? {} : {
        whenToUse: projectSkillText(
          summary.whenToUse,
          4_096,
          `Use ${name} when its workflow matches the request.`,
          `operation-visible Skill summary[${String(index)}].whenToUse`,
        ),
      }),
      invocation: freezeInvocation(
        summary.invocation,
        `operation-visible Skill summary[${String(index)}].invocation`,
      ),
      source: boundedIdentifier(summary.source, `operation-visible Skill summary[${String(index)}].source`),
      provider: boundedIdentifier(summary.provider, `operation-visible Skill summary[${String(index)}].provider`),
      ...(resource === undefined ? {} : {
        resourceBase: Object.freeze({
          kind: "directory" as const,
          path: boundedText(
            resource.path,
            8_192,
            `operation-visible Skill summary[${String(index)}].resourceBase.path`,
          ),
        }),
      }),
    });
  });
  return Object.freeze({ complete: catalog.complete, skills: Object.freeze(skills) });
};

const definitionMatches = (
  definition: SkillDefinition,
  summary: SkillSummary,
  descriptor: StaticSkillDescriptor,
): boolean => summaryMatches(definition, descriptor)
  && definition.name === summary.name
  && definition.description === summary.description
  && definition.whenToUse === summary.whenToUse
  && definition.path === descriptor.sourcePath
  && typeof definition.content === "string"
  && definition.content.length > 0
  && (definition.metadata as Readonly<{ sourceSha256?: unknown }> | undefined)?.sourceSha256
    === descriptor.sourceSha256;

const renderSkill = (
  descriptorsBySource: ReadonlyMap<string, StaticSkillDescriptor>,
  value: unknown,
): ContentBlock[] => {
  const output = value as Readonly<{ skill: string; content: string; source: string }>;
  const descriptor = descriptorsBySource.get(output.source);
  if (descriptor?.name !== output.skill) throw new TypeError("Skill render projection lacks its static descriptor");
  return [{
    type: "text",
    text: renderSkillContent({
      name: output.skill,
      provider: PRODUCT_STATIC_SKILL_PROVIDER,
      resourceBase: { kind: "directory", path: descriptor.resourceRoot },
      content: output.content,
    }),
  }];
};

export class ProductSkillService extends Service {
  static inject = ["fs", "productTools", "skills", "systemPrompt", "tools"];

  private readonly catalogValue: StaticSkillCatalog;
  private readonly candidatesValue: readonly SkillCandidate[];
  private readonly descriptorsByDefinition = new WeakMap<object, StaticSkillDescriptor>();
  private readonly descriptorsByLocator = new WeakMap<object, StaticSkillDescriptor>();
  private readonly descriptorsBySource: ReadonlyMap<string, StaticSkillDescriptor>;
  private readonly loadPermits = new WeakMap<AbortSignal, StaticSkillLoadPermit>();
  readonly #dynamicByGeneration = new Map<string, Map<string, DynamicSkillRecord>>();
  readonly #dynamicByLocator = new WeakMap<object, DynamicSkillRecord>();
  readonly #dynamicByDefinition = new WeakMap<object, DynamicSkillRecord>();
  readonly #dynamicViewPermits = new WeakMap<AbortSignal, string>();
  readonly #installedDynamic = new WeakSet<object>();
  readonly #catalogProjectionByGeneration = new Map<string, string>();
  readonly #resolveOperation: ((agent: Agent) => ProductToolOperationAuthority) | undefined;
  #invalidateDynamic: (() => void) | undefined;

  public constructor(ctx: Context, config: ProductSkillServiceConfig) {
    super(ctx, "productSkills");
    const normalized = exactObject(
      config,
      ["catalog"],
      ["registerDynamicController", "resolveOperation"],
      "ProductSkillService config",
    );
    this.catalogValue = validateStaticSkillCatalog(normalized.catalog);
    const resolveOperation = normalized.resolveOperation;
    if (resolveOperation !== undefined
      && (typeof resolveOperation !== "function" || isProxy(resolveOperation))) {
      throw new TypeError("ProductSkillService operation resolver must be a non-proxy function");
    }
    this.#resolveOperation = resolveOperation as ((agent: Agent) => ProductToolOperationAuthority) | undefined;
    const registerDynamicController = normalized.registerDynamicController;
    if (registerDynamicController !== undefined
      && (typeof registerDynamicController !== "function" || isProxy(registerDynamicController))) {
      throw new TypeError("ProductSkillService dynamic controller registrar must be a non-proxy function");
    }
    const candidates: SkillCandidate[] = [];
    const bySource = new Map<string, StaticSkillDescriptor>();
    for (const descriptor of this.catalogValue.skills) {
      const locator = Object.freeze({});
      this.descriptorsByLocator.set(locator, descriptor);
      bySource.set(descriptor.sourcePath, descriptor);
      candidates.push(Object.freeze({
        name: descriptor.name,
        description: descriptor.description,
        ...(descriptor.whenToUse === undefined ? {} : { whenToUse: descriptor.whenToUse }),
        invocation: descriptor.invocation,
        source: "bundled",
        provider: PRODUCT_STATIC_SKILL_PROVIDER,
        resourceBase: Object.freeze({ kind: "directory" as const, path: descriptor.resourceRoot }),
        rank: descriptor.rank,
        locator,
        path: descriptor.sourcePath,
        metadata: Object.freeze({ sourceSha256: descriptor.sourceSha256 }),
      }));
    }
    this.candidatesValue = Object.freeze(candidates);
    this.descriptorsBySource = bySource;
    ctx.effect(() => {
      const disposeCatalogContext = ctx.systemPrompt.context({
        interpolate: false,
        name: "capability:skills",
        order: 105,
        text: (context) => this.#catalogContext(ctx, context),
      });
      const disposeProvider = ctx.skills.registerProvider((control) => this.provider(ctx, control));
      const disposeDynamicProvider = ctx.skills.registerProvider((control) => {
        this.#invalidateDynamic = control.invalidate;
        return this.#dynamicProvider(control);
      });
      try {
        const disposeTool = ctx.tools.register(this.definition(ctx));
        return () => {
          disposeTool();
          disposeDynamicProvider();
          disposeProvider();
          disposeCatalogContext();
        };
      } catch (error) {
        disposeDynamicProvider();
        disposeProvider();
        disposeCatalogContext();
        throw error;
      }
    }, "product-static-skills-and-tool");
    if (registerDynamicController !== undefined) {
      Reflect.apply(registerDynamicController, config, [Object.freeze({
        prepare: (registration: DynamicSkillRegistration) => this.#prepareDynamic(registration),
      })]);
    }
  }

  public catalog(): StaticSkillCatalog { return this.catalogValue; }

  #catalogContext(ctx: Context, context: AssembleContext): string {
    const agent = context.agent;
    if (agent === undefined || this.#resolveOperation === undefined
      || ctx.tools.get("Skill", context.scope) === undefined) return "";
    let authority: ProductToolOperationAuthority;
    try {
      authority = this.#resolveOperation(agent);
    } catch {
      return "";
    }
    if (authority.allowedTools !== undefined && !authority.allowedTools.includes("Skill")) return "";
    const catalogMethod = (ctx.productTools as unknown as { catalog?: () => {
      digest: string;
      effectiveTools: readonly string[];
    } }).catalog;
    if (typeof catalogMethod !== "function") return "";
    const toolCatalog = Reflect.apply(catalogMethod, ctx.productTools, []);
    if (toolCatalog.digest !== authority.operation.birth.toolCatalogDigest
      || !toolCatalog.effectiveTools.includes("Skill")) return "";
    return this.#catalogProjection(Object.freeze({
      digest: authority.operation.birth.componentDigest,
      revision: authority.operation.birth.componentRevision,
    }));
  }

  #catalogProjection(identity: DynamicSkillGenerationIdentity): string {
    const key = this.#generationKey(identity);
    const cached = this.#catalogProjectionByGeneration.get(key);
    if (cached !== undefined) return cached;
    const candidates = [
      ...this.catalogValue.skills.map((skill, index) => ({
        description: projectProductSkillDescription(skill.description, skill.name),
        invocation: skill.invocation,
        name: skill.name,
        providerOrder: 0,
        localOrder: index,
        rank: skill.rank,
      })),
      ...[...(this.#dynamicByGeneration.get(key)?.values() ?? [])]
        .filter((skill) => this.#installedDynamic.has(skill))
        .map((skill, index) => ({
          description: skill.description,
          invocation: skill.invocation,
          name: skill.name,
          providerOrder: 1,
          localOrder: index,
          rank: skill.rank,
        })),
    ].sort((left, right) => left.rank - right.rank
      || left.providerOrder - right.providerOrder
      || left.localOrder - right.localOrder);
    const winners = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      if (!winners.has(candidate.name)) winners.set(candidate.name, candidate);
    }
    const visible = [...winners.values()]
      .filter(({ invocation }) => invocation.modelInvocable)
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const text = visible.length === 0 ? "" : [
      "Available Skills:",
      ...visible.map(({ name, description }) => `- ${name} — ${description}`),
      "",
      "Call Skill with `skill: <name>` to load the full instructions only when needed.",
    ].join("\n");
    this.#catalogProjectionByGeneration.set(key, text);
    return text;
  }

  private provider(ctx: Context, control: SkillProviderControl): SkillProvider {
    return Object.freeze({
      name: PRODUCT_STATIC_SKILL_PROVIDER,
      list: (options: SkillLookupOptions) => {
        combinedSignal(options.signal, control.signal).throwIfAborted();
        return Promise.resolve(this.candidatesValue);
      },
      get: async (candidate: SkillCandidate, options: SkillLookupOptions) => {
        const locator = candidate.locator;
        if (locator === null || typeof locator !== "object") return undefined;
        const descriptor = this.descriptorsByLocator.get(locator);
        if (descriptor?.name !== candidate.name || descriptor.sourcePath !== candidate.path) return undefined;
        const permit = options.signal === undefined ? undefined : this.loadPermits.get(options.signal);
        if (permit === undefined) throw new TypeError("static Skill load lacks operation-frozen authority");
        const definition = await loadStaticSkill(
          ctx,
          descriptor,
          permit.root,
          combinedSignal(options.signal, control.signal),
        );
        this.descriptorsByDefinition.set(definition, descriptor);
        return definition;
      },
    });
  }

  #dynamicProvider(control: SkillProviderControl): SkillProvider {
    return Object.freeze({
      name: PRODUCT_COMPONENT_SKILL_PROVIDER,
      list: (options: SkillLookupOptions) => {
        combinedSignal(options.signal, control.signal).throwIfAborted();
        const key = options.signal === undefined ? undefined : this.#dynamicViewPermits.get(options.signal);
        const records = key === undefined ? undefined : this.#dynamicByGeneration.get(key);
        return Promise.resolve(Object.freeze([...(records?.values() ?? [])].map((record) => Object.freeze({
          name: record.name,
          description: record.description,
          ...(record.whenToUse === undefined ? {} : { whenToUse: record.whenToUse }),
          invocation: record.invocation,
          source: "runtime" as const,
          provider: PRODUCT_COMPONENT_SKILL_PROVIDER,
          ...(record.resourceRoot === undefined ? {} : {
            resourceBase: Object.freeze({ kind: "directory" as const, path: record.resourceRoot }),
          }),
          rank: record.rank,
          locator: record.locator,
          ...(record.sourcePath === undefined ? {} : { path: record.sourcePath }),
          metadata: Object.freeze({ sourceSha256: record.sourceSha256 }),
        }))));
      },
      get: (candidate: SkillCandidate, options: SkillLookupOptions) => {
        combinedSignal(options.signal, control.signal).throwIfAborted();
        const key = options.signal === undefined ? undefined : this.#dynamicViewPermits.get(options.signal);
        const record = candidate.locator !== null && typeof candidate.locator === "object"
          ? this.#dynamicByLocator.get(candidate.locator)
          : undefined;
        if (record === undefined || key !== this.#generationKey(record.generation)
          || candidate.name !== record.name) return Promise.resolve(undefined);
        const definition = Object.freeze({
          name: record.name,
          description: record.description,
          ...(record.whenToUse === undefined ? {} : { whenToUse: record.whenToUse }),
          invocation: record.invocation,
          source: "runtime" as const,
          provider: PRODUCT_COMPONENT_SKILL_PROVIDER,
          ...(record.resourceRoot === undefined ? {} : {
            resourceBase: Object.freeze({ kind: "directory" as const, path: record.resourceRoot }),
          }),
          content: record.content,
          ...(record.sourcePath === undefined ? {} : { path: record.sourcePath }),
          metadata: Object.freeze({ argumentNames: record.argumentNames, sourceSha256: record.sourceSha256 }),
        });
        this.#dynamicByDefinition.set(definition, record);
        return Promise.resolve(definition);
      },
    });
  }

  #generationKey(identity: DynamicSkillGenerationIdentity): string {
    return `${identity.revision}:${identity.digest}`;
  }

  #prepareDynamic(value: DynamicSkillRegistration): Readonly<{
    readonly dispose: () => void;
    readonly install: () => () => void;
  }> {
    const registration = exactObject(value, [
      "componentId", "content", "description", "generation", "invocation", "name", "rank", "sourceSha256",
    ], ["resourceRoot", "sourcePath", "whenToUse"], "dynamic Skill registration");
    const generation = exactObject(registration.generation, ["digest", "revision"], [], "dynamic Skill generation");
    const identity = Object.freeze({
      digest: boundedIdentifier(generation.digest, "dynamic Skill generation digest"),
      revision: boundedIdentifier(generation.revision, "dynamic Skill generation revision"),
    });
    if (!/^[a-f0-9]{64}$/u.test(identity.digest)) throw new TypeError("dynamic Skill generation digest is invalid");
    const name = boundedIdentifier(registration.name, "dynamic Skill name");
    if (!isSkillName(name)) throw new TypeError("dynamic Skill name is invalid");
    const content = boundedDocument(
      registration.content,
      MAX_SKILL_SOURCE_BYTES,
      "dynamic Skill content",
    );
    if (!Number.isSafeInteger(registration.rank) || (registration.rank as number) < 0
      || (registration.rank as number) > 100_000) throw new TypeError("dynamic Skill rank is invalid");
    if (typeof registration.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(registration.sourceSha256)) {
      throw new TypeError("dynamic Skill source digest is invalid");
    }
    if (sha256(content) !== registration.sourceSha256) throw new TypeError("dynamic Skill content digest differs");
    const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(content.replaceAll("\r\n", "\n"))?.[1];
    if (frontmatter !== undefined && /^(?:context|agent)\s*:\s*\S/mu.test(frontmatter)) {
      throw new TypeError("Skill execution context/agent metadata is not supported by this Runtime");
    }
    const resourceRoot = registration.resourceRoot === undefined
      ? undefined
      : boundedText(registration.resourceRoot, 8_192, "dynamic Skill resource root");
    const sourcePath = registration.sourcePath === undefined
      ? undefined
      : boundedText(registration.sourcePath, 8_192, "dynamic Skill source path");
    if ((resourceRoot === undefined) !== (sourcePath === undefined)) {
      throw new TypeError("dynamic Skill filesystem source must include both root and path");
    }
    const parsed = resourceRoot === undefined
      ? Object.freeze({ argumentNames: Object.freeze([]), body: content })
      : parseWorkspaceSkillDocument(content);
    const key = this.#generationKey(identity);
    const records = this.#dynamicByGeneration.get(key) ?? new Map<string, DynamicSkillRecord>();
    if (records.has(name)) throw new TypeError("dynamic Skill names must be unique within one generation");
    const locator = Object.freeze({});
    const record: DynamicSkillRecord = Object.freeze({
      componentId: boundedIdentifier(registration.componentId, "dynamic Skill component"),
      argumentNames: parsed.argumentNames,
      content: parsed.body,
      description: projectProductSkillDescription(registration.description, name),
      generation: identity,
      invocation: freezeInvocation(registration.invocation, "dynamic Skill invocation"),
      locator,
      name,
      rank: registration.rank as number,
      ...(resourceRoot === undefined ? {} : { resourceRoot }),
      source: sourcePath ?? `extension:${identity.digest}:${name}`,
      ...(sourcePath === undefined ? {} : { sourcePath }),
      sourceSha256: registration.sourceSha256,
      ...(registration.whenToUse === undefined ? {} : {
        whenToUse: projectSkillText(
          registration.whenToUse,
          4_096,
          `Use ${name} when its workflow matches the request.`,
          "dynamic Skill when-to-use",
        ),
      }),
    });
    records.set(name, record);
    this.#dynamicByGeneration.set(key, records);
    this.#dynamicByLocator.set(locator, record);
    let disposed = false;
    let installed = false;
    return Object.freeze({
      dispose: () => {
        if (installed) throw new Error("dynamic Skill must be unpublished before disposal");
        if (disposed) return;
        disposed = true;
        if (records.get(name) === record) records.delete(name);
        if (records.size === 0) this.#dynamicByGeneration.delete(key);
        this.#catalogProjectionByGeneration.delete(key);
        this.#invalidateDynamic?.();
      },
      install: () => {
        if (disposed || installed) throw new Error("dynamic Skill is disposed or already published");
        installed = true;
        this.#installedDynamic.add(record);
        this.#catalogProjectionByGeneration.delete(key);
        this.#invalidateDynamic?.();
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          installed = false;
          this.#installedDynamic.delete(record);
          this.#catalogProjectionByGeneration.delete(key);
          this.#invalidateDynamic?.();
        };
      },
    });
  }

  private definition(ctx: Context): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS.Skill;
    return Object.freeze({
      name: "Skill",
      description: contract.description,
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
      output: Object.freeze({
        schema: canonicalOutputSchemaForDsh(contract.outputSchema),
        render: (_args: unknown, value: unknown) => this.#render(value),
      }),
      isConcurrencySafe: () => false,
      execute: async (value: unknown, exec: ToolRunContext) => {
        const input = validateCanonicalToolInput("Skill", value) as Readonly<{ skill: string; args?: string }>;
        const product = ctx.productTools.resolve(exec);
        const generationKey = this.#generationKey({
            digest: product.birth.componentDigest,
            revision: product.birth.componentRevision,
        });
        let lookupSignal = AbortSignal.any([product.signal]);
        this.#dynamicViewPermits.set(lookupSignal, generationKey);
        try {
          const view = Object.freeze({
            cwd: product.environment.workspace.canonicalRoot,
            scope: scopeOf(product.agent.ctx),
          });
          let observed: ReturnType<typeof normalizeObservedSkillCatalog>;
          try {
            observed = normalizeObservedSkillCatalog(await ctx.skills.snapshot(Object.freeze({
              ...view,
              signal: lookupSignal,
            })));
          } catch (error) {
            this.#dynamicViewPermits.delete(lookupSignal);
            throw error;
          }
          throwIfProductToolAborted(product.signal);
          if (!observed.complete) {
            throw new ProductToolError("skill_invalid", "Skill catalog observation is incomplete");
          }
          const summary = observed.skills.find(({ name }) => name === input.skill);
          if (summary === undefined) {
            throw new ProductToolError("skill_not_found", `Skill is absent from the operation-visible catalog: ${input.skill}`);
          }
          if (!isModelInvocable(summary)) {
            throw new ProductToolError("skill_invocation_disabled", `Skill is not model-invocable: ${input.skill}`);
          }
          const staticAuthority = this.catalogValue.skills.find((candidate) =>
            candidate.name === input.skill && summaryMatches(summary, candidate));
          const dynamicAuthority = this.#dynamicByGeneration.get(generationKey)?.get(input.skill);
          if (staticAuthority === undefined && dynamicAuthority === undefined) {
            throw new ProductToolError("skill_invalid", "Skill catalog winner lacks product authority");
          }
          const resourceRoot = staticAuthority?.resourceRoot ?? dynamicAuthority?.resourceRoot;
          const rootAuthority = resourceRoot === undefined
            ? undefined
            : await captureApprovedSkillRoot(ctx, product, resourceRoot);
          await ctx.productTools.authorize(product, {
            permissionClass: contract.permissionClass,
            target: `skill:${input.skill}`,
            tool: "Skill",
            review: { kind: "generic", action: "Skill", target: input.skill, arguments: input },
          });
          return await runWithProductToolExecutionDeadline(
            product,
            contract.timeoutMs,
            async (product) => {
          this.#dynamicViewPermits.delete(lookupSignal);
          lookupSignal = AbortSignal.any([product.signal]);
          this.#dynamicViewPermits.set(lookupSignal, generationKey);
          ctx.productTools.assertCurrent(product, "Skill");
          if (dynamicAuthority?.resourceRoot !== undefined && rootAuthority !== undefined) {
            await revalidateSkillRoot(ctx, rootAuthority, product.signal);
          }
          if (rootAuthority !== undefined) this.loadPermits.set(lookupSignal, Object.freeze({ root: rootAuthority }));
          let definition: SkillDefinition | undefined;
          try {
            definition = await ctx.skills.get(input.skill, Object.freeze({ ...view, signal: lookupSignal }));
          } finally {
            this.loadPermits.delete(lookupSignal);
            this.#dynamicViewPermits.delete(lookupSignal);
          }
          throwIfProductToolAborted(product.signal);
          ctx.productTools.assertCurrent(product, "Skill");
          if (definition === undefined) {
            throw new ProductToolError("skill_invalid", "Skill disappeared after its authorized catalog snapshot");
          }
          const descriptor = this.descriptorsByDefinition.get(definition);
          const dynamic = this.#dynamicByDefinition.get(definition);
          if (descriptor === undefined && dynamic === undefined) {
            throw new ProductToolError("skill_invalid", "loaded Skill lacks product provider ownership");
          }
          const matches = descriptor === undefined
            ? definition.name === dynamic?.name
              && definition.description === dynamic.description
              && definition.whenToUse === dynamic.whenToUse
              && definition.provider === PRODUCT_COMPONENT_SKILL_PROVIDER
              && definition.content === dynamic.content
              && definition.path === dynamic.sourcePath
              && definition.resourceBase?.kind === (dynamic.resourceRoot === undefined ? undefined : "directory")
              && definition.resourceBase?.path === dynamic.resourceRoot
              && (definition.metadata as Readonly<{ sourceSha256?: unknown }> | undefined)?.sourceSha256
                === dynamic.sourceSha256
            : definitionMatches(definition, summary, descriptor);
          if (!matches) {
            throw new ProductToolError("skill_invalid", "loaded Skill differs from its authorized catalog winner");
          }
          const expanded = expandSkillArguments(
            definition.content,
            input.args ?? "",
            exactArgumentNames(definition),
            descriptor?.resourceRoot ?? dynamic?.resourceRoot,
          );
          const output = Object.freeze({
            skill: descriptor?.name ?? dynamic?.name,
            content: expanded.content,
            source: descriptor?.sourcePath ?? dynamic?.source,
            sourceSha256: descriptor?.sourceSha256 ?? dynamic?.sourceSha256,
            argumentsExpanded: expanded.expanded,
          });
          try { return validateCanonicalToolOutput("Skill", output); } catch (error) {
            throw new ProductToolError("skill_invalid", "expanded Skill exceeds its canonical result bounds", { cause: error });
          }
            },
          );
        } catch (error) {
          throwIfProductToolAborted(product.signal);
          if (error instanceof ProductToolError) throw error;
          throw new ProductToolError("skill_invalid", "Skill could not be validated and loaded", { cause: error });
        } finally {
          this.loadPermits.delete(lookupSignal);
          this.#dynamicViewPermits.delete(lookupSignal);
        }
      },
    });
  }

  #render(value: unknown): ContentBlock[] {
    const output = value as Readonly<{ skill: string; content: string; source: string }>;
    const descriptor = this.descriptorsBySource.get(output.source);
    if (descriptor !== undefined) return renderSkill(this.descriptorsBySource, value);
    const dynamic = [...this.#dynamicByGeneration.values()]
      .flatMap((records) => [...records.values()])
      .find((record) => record.source === output.source && record.name === output.skill);
    if (dynamic === undefined) throw new TypeError("Skill render projection lacks its product descriptor");
    return [{
      type: "text",
      text: renderSkillContent({
        name: output.skill,
        provider: PRODUCT_COMPONENT_SKILL_PROVIDER,
        ...(dynamic.resourceRoot === undefined ? {} : {
          resourceBase: { kind: "directory" as const, path: dynamic.resourceRoot },
        }),
        content: output.content,
      }),
    }];
  }
}
