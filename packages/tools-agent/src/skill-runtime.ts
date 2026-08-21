import { createHash } from "node:crypto";

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
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
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
} from "@myagents-dsh/tool-runtime-product";

export const PRODUCT_STATIC_SKILL_PROVIDER = "myagents-static-skills";

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

const exactObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const record = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
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
  if (!Array.isArray(catalog.skills) || catalog.skills.length === 0 || catalog.skills.length > MAX_SKILLS) {
    throw new TypeError("static Skill catalog must contain one to 128 descriptors");
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
    fields.set(key, parseScalar(line.slice(separator + 1), `Skill frontmatter ${key}`));
  }
  if (fields.get("name") !== descriptor.name || fields.get("description") !== descriptor.description) {
    throw new TypeError("Skill frontmatter differs from its static descriptor");
  }
  if (fields.get("when-to-use") !== descriptor.whenToUse) {
    throw new TypeError("Skill when-to-use metadata differs from its static descriptor");
  }
  const argumentNames = (fields.get("arguments") ?? "")
    .split(/\s+/u)
    .filter(Boolean);
  if (argumentNames.length > MAX_ARGUMENT_NAMES
    || argumentNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
    || new Set(argumentNames).size !== argumentNames.length) {
    throw new TypeError("Skill argument-name metadata is invalid");
  }
  const body = normalized.slice(end + 5).trim();
  if (body.length === 0 || Buffer.byteLength(body, "utf8") > MAX_SKILL_SOURCE_BYTES) {
    throw new TypeError("Skill instruction body is empty or too large");
  }
  return Object.freeze({ argumentNames: Object.freeze(argumentNames), body });
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

const loadStaticSkill = async (
  ctx: Context,
  descriptor: StaticSkillDescriptor,
  signal: AbortSignal,
): Promise<SkillDefinition> => {
  signal.throwIfAborted();
  const [rootPathBefore, sourcePathBefore] = await Promise.all([
    ctx.fs.lstat(descriptor.resourceRoot, undefined, signal),
    ctx.fs.lstat(descriptor.sourcePath, undefined, signal),
  ]);
  if (rootPathBefore?.type !== "directory" || sourcePathBefore?.type !== "file") {
    throw new TypeError("Skill source and resource root must be direct non-symbolic filesystem entries");
  }
  const [root, source] = await Promise.all([
    ctx.fs.resolve(descriptor.resourceRoot, { signal }),
    ctx.fs.resolve(descriptor.sourcePath, { signal }),
  ]);
  exactTarget(root, descriptor.resourceRoot, "Skill resource root");
  exactTarget(source, descriptor.sourcePath, "Skill source");
  if (!ctx.fs.contains(root, source) || root.targetKey === source.targetKey) {
    throw new TypeError("Skill source is outside its approved resource root");
  }
  const [rootBefore, sourceBefore] = await Promise.all([
    ctx.fs.stat(root, signal),
    ctx.fs.stat(source, signal),
  ]);
  if (rootBefore?.type !== "directory" || sourceBefore?.type !== "file"
    || (sourceBefore.size !== undefined && sourceBefore.size > MAX_SKILL_SOURCE_BYTES)) {
    throw new TypeError("Skill source authority is not a bounded regular file");
  }
  const bytes = await ctx.fs.readBytes(source, signal, MAX_SKILL_SOURCE_BYTES);
  const [rootPathAfter, sourcePathAfter, rootAfter, sourceAfter] = await Promise.all([
    ctx.fs.lstat(descriptor.resourceRoot, undefined, signal),
    ctx.fs.lstat(descriptor.sourcePath, undefined, signal),
    ctx.fs.stat(root, signal),
    ctx.fs.stat(source, signal),
  ]);
  if (rootPathAfter === undefined || sourcePathAfter === undefined
    || rootAfter === undefined || sourceAfter === undefined
    || !matchingVersion(rootPathBefore, rootPathAfter)
    || !matchingVersion(sourcePathBefore, sourcePathAfter)
    || !matchingVersion(rootBefore, rootAfter)
    || !matchingVersion(sourceBefore, sourceAfter)) {
    throw new TypeError("Skill source identity changed while it was read");
  }
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
): Readonly<{ content: string; expanded: boolean }> => {
  const positional = parseArguments(input);
  const named = new Map(argumentNames.map((name, index) => [name, positional[index] ?? ""] as const));
  let substituted = false;
  let bytes = 0;
  let cursor = 0;
  const pieces: string[] = [];
  const pattern = /\$ARGUMENTS(?:\[([0-9]+)\])?|\$([0-9]+)|\$([A-Za-z_][A-Za-z0-9_]*)/gu;
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const unchanged = body.slice(cursor, match.index);
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
  const tail = body.slice(cursor);
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
  return Object.freeze({ content, expanded: input.length > 0 && content !== body });
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
    return Object.freeze({
      name: boundedIdentifier(summary.name, `operation-visible Skill summary[${String(index)}].name`),
      description: boundedText(
        summary.description,
        2_048,
        `operation-visible Skill summary[${String(index)}].description`,
      ),
      ...(summary.whenToUse === undefined ? {} : {
        whenToUse: boundedText(
          summary.whenToUse,
          4_096,
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
  static inject = ["fs", "productTools", "skills", "tools"];

  private readonly catalogValue: StaticSkillCatalog;
  private readonly candidatesValue: readonly SkillCandidate[];
  private readonly descriptorsByLocator = new WeakMap<object, StaticSkillDescriptor>();
  private readonly descriptorsBySource: ReadonlyMap<string, StaticSkillDescriptor>;

  public constructor(ctx: Context, config: ProductSkillServiceConfig) {
    super(ctx, "productSkills");
    const normalized = exactObject(
      normalizeCanonicalJson(config, "ProductSkillService config"),
      ["catalog"],
      [],
      "ProductSkillService config",
    );
    this.catalogValue = validateStaticSkillCatalog(normalized.catalog);
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
      const disposeProvider = ctx.skills.registerProvider((control) => this.provider(ctx, control));
      try {
        const disposeTool = ctx.tools.register(this.definition(ctx));
        return () => {
          disposeTool();
          disposeProvider();
        };
      } catch (error) {
        disposeProvider();
        throw error;
      }
    }, "product-static-skills-and-tool");
  }

  public catalog(): StaticSkillCatalog { return this.catalogValue; }

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
        return loadStaticSkill(ctx, descriptor, combinedSignal(options.signal, control.signal));
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
        render: (_args: unknown, value: unknown) => renderSkill(this.descriptorsBySource, value),
      }),
      ...(contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
      isConcurrencySafe: () => false,
      execute: async (value: unknown, exec: ToolRunContext) => {
        const input = validateCanonicalToolInput("Skill", value) as Readonly<{ skill: string; args?: string }>;
        const product = ctx.productTools.resolve(exec);
        try {
          const options = Object.freeze({
            cwd: product.environment.workspace.canonicalRoot,
            scope: scopeOf(product.agent.ctx),
            signal: product.signal,
          });
          const observed = normalizeObservedSkillCatalog(await ctx.skills.snapshot(options));
          product.signal.throwIfAborted();
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
          const descriptor = this.catalogValue.skills.find((candidate) =>
            candidate.name === input.skill && summaryMatches(summary, candidate));
          if (descriptor === undefined) {
            throw new ProductToolError("skill_invalid", "Skill catalog winner lacks static product authority");
          }
          await ctx.productTools.authorize(product, {
            permissionClass: contract.permissionClass,
            target: `skill:${input.skill}`,
            tool: "Skill",
          });
          ctx.productTools.assertCurrent(product, "Skill");
          const definition = await ctx.skills.get(input.skill, options);
          product.signal.throwIfAborted();
          ctx.productTools.assertCurrent(product, "Skill");
          if (definition === undefined) {
            throw new ProductToolError("skill_invalid", "Skill disappeared after its authorized catalog snapshot");
          }
          if (!definitionMatches(definition, summary, descriptor)) {
            throw new ProductToolError("skill_invalid", "loaded Skill differs from its authorized catalog winner");
          }
          const expanded = expandSkillArguments(
            definition.content,
            input.args ?? "",
            exactArgumentNames(definition),
          );
          const output = Object.freeze({
            skill: descriptor.name,
            content: expanded.content,
            source: descriptor.sourcePath,
            sourceSha256: descriptor.sourceSha256,
            argumentsExpanded: expanded.expanded,
          });
          try { return validateCanonicalToolOutput("Skill", output); } catch (error) {
            throw new ProductToolError("skill_invalid", "expanded Skill exceeds its canonical result bounds", { cause: error });
          }
        } catch (error) {
          product.signal.throwIfAborted();
          if (error instanceof ProductToolError) throw error;
          throw new ProductToolError("skill_invalid", "Skill could not be validated and loaded", { cause: error });
        }
      },
    });
  }
}
