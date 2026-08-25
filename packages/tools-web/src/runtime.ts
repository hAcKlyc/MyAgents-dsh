import { AsyncLocalStorage } from "node:async_hooks";
import { isPromise, isProxy } from "node:util/types";

import { Service, type Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from "@deepseek-ai/dsh-web";
import {
  CANONICAL_TOOL_CONTRACTS,
  canonicalInputSchemaForDsh,
  canonicalOutputSchemaForDsh,
  normalizeCanonicalJson,
  validateCanonicalToolInput,
  validateCanonicalToolOutput,
} from "@myagents-dsh/tool-contracts";
import {
  ProductToolError,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import { ProductSafeHttpClient, type ProductSafeHttpResult } from "./safe-http.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    canonicalWebTools: CanonicalWebTools;
  }
}

type JsonObject = Record<string, unknown>;

export interface ProductWebContentRequest {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly signal: AbortSignal;
  readonly statusCode: number;
}

export interface ProductWebUtilityRequest {
  readonly context: ProductToolContext;
  readonly finalUrl: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly source: string;
  readonly statusCode: number;
}

export interface ProductWebSearchRequest {
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly context: ProductToolContext;
  readonly credentialRef: string;
  readonly providerId: string;
  readonly query: string;
  readonly signal: AbortSignal;
}

export interface CanonicalWebFetchToolsConfig {
  readonly client: ProductSafeHttpClient;
  readonly content: Readonly<{
    /** Reject only after abort has made conversion work quiescent. */
    convert(request: ProductWebContentRequest): Promise<Readonly<{
      readonly content: string;
      readonly kind: "html" | "text";
      readonly truncated: boolean;
    }>>;
  }>;
  readonly utility: Readonly<{
    /** Reject only after abort has made the utility call quiescent. */
    run(request: ProductWebUtilityRequest): Promise<Readonly<{
      readonly answer: string;
      readonly citations: readonly Readonly<{ readonly title: string; readonly url: string }>[];
      readonly truncated: boolean;
      readonly usage: Readonly<{
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cacheReadTokens: number;
        readonly cacheWriteTokens: number;
        readonly totalTokens: number;
      }>;
    }>>;
  }>;
}

export interface CanonicalWebSearchToolsConfig {
  readonly available: () => boolean;
  readonly credentialRef: string;
  readonly policyRef: string;
  readonly providerId: string;
  /** Reject only after abort has made Provider work quiescent. */
  readonly run: (request: ProductWebSearchRequest) => Promise<Readonly<{
    readonly citations: readonly Readonly<{ readonly title: string; readonly url: string }>[];
    readonly durationMs: number;
    readonly results: readonly Readonly<{
      readonly snippet: string;
      readonly title: string;
      readonly url: string;
    }>[];
    readonly searchCount: number;
    readonly truncated: boolean;
    readonly usage: Readonly<{
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
      readonly totalTokens: number;
    }>;
  }>>;
}

export interface CanonicalWebToolsConfig {
  readonly fetch?: CanonicalWebFetchToolsConfig;
  readonly search?: CanonicalWebSearchToolsConfig;
}

type FetchExecutionStore = {
  readonly context: ProductToolContext;
  fetched?: ProductSafeHttpResult;
};

type SearchExecutionStore = {
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly context: ProductToolContext;
  detail?: ProductSearchDetail;
};

interface ProductSearchDetail {
  readonly citations: readonly Readonly<{ readonly title: string; readonly url: string }>[];
  readonly durationMs: number;
  readonly results: readonly Readonly<{ readonly snippet: string; readonly title: string; readonly url: string }>[];
  readonly searchCount: number;
  readonly truncated: boolean;
  readonly usage: Readonly<{
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly totalTokens: number;
  }>;
}

const MAX_CONCURRENT_SEARCHES = 4;
const MAX_QUEUED_SEARCHES = 32;
const MAX_SEARCH_USES = 8;

const textBlocks = (text: string): ContentBlock[] => [{ type: "text", text }];

const asObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductToolError("utility_model_failed", `${description} must be an object`);
  }
  return value as JsonObject;
};

const exactOwnDataObject = (
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
  const keys = Reflect.ownKeys(record);
  if (required.some((key) => !Object.hasOwn(record, key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${description} has an invalid exact shape`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be enumerable own-data properties`);
    }
  }
  return record;
};

export const validateCanonicalWebToolsConfig = (value: unknown): CanonicalWebToolsConfig => {
  const candidate = exactOwnDataObject(value, [], ["fetch", "search"], "canonical Web tools config");
  if (!Object.hasOwn(candidate, "fetch") && !Object.hasOwn(candidate, "search")) {
    throw new TypeError("canonical Web tools config must enable WebFetch or WebSearch");
  }
  const fetch = Object.hasOwn(candidate, "fetch")
    ? exactOwnDataObject(
        candidate.fetch,
        ["client", "content", "utility"],
        [],
        "canonical WebFetch config",
      )
    : undefined;
  let search: JsonObject | undefined;
  if (Object.hasOwn(candidate, "search")) {
    search = exactOwnDataObject(
      candidate.search,
      ["available", "credentialRef", "policyRef", "providerId", "run"],
      [],
      "canonical WebSearch config",
    );
  }
  return Object.freeze({
    ...(fetch === undefined ? {} : { fetch: Object.freeze({
      client: fetch.client as ProductSafeHttpClient,
      content: fetch.content as CanonicalWebFetchToolsConfig["content"],
      utility: fetch.utility as CanonicalWebFetchToolsConfig["utility"],
    }) }),
    ...(search === undefined ? {} : {
      search: Object.freeze({
        available: search.available as () => boolean,
        credentialRef: search.credentialRef as string,
        policyRef: search.policyRef as string,
        providerId: search.providerId as string,
        run: search.run as NonNullable<CanonicalWebToolsConfig["search"]>["run"],
      }),
    }),
  });
};

const boundedIdentifier = (value: unknown, description: string): string => {
  let containsControl = false;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x1f || code === 0x7f) { containsControl = true; break; }
    }
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || containsControl) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  return value;
};

const dataMethod = (
  value: unknown,
  method: string,
  description: string,
): Readonly<{ owner: JsonObject; invoke: (...args: never[]) => unknown }> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== 1) {
    throw new TypeError(`${description} must be an exact plain capability`);
  }
  const owner = value as JsonObject;
  const descriptor = Object.getOwnPropertyDescriptor(owner, method);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
    throw new TypeError(`${description} must expose one enumerable own-data method`);
  }
  return Object.freeze({ owner, invoke: descriptor.value as (...args: never[]) => unknown });
};

const nativePromise = async <T>(value: unknown, description: string): Promise<T> => {
  if (value !== null && typeof value === "object" && isProxy(value)) {
    throw new ProductToolError("utility_model_failed", `${description} returned a Proxy thenable`);
  }
  if (!isPromise(value)) {
    throw new ProductToolError("utility_model_failed", `${description} did not return a native Promise`);
  }
  return value as Promise<T>;
};

const normalizeDomain = (value: string): string => {
  if (value.includes("*") || value.includes("/") || value.includes(":") || value.includes("@")) {
    throw new ProductToolError("domain_policy_invalid", "WebSearch domains must be plain hostnames");
  }
  let hostname: string;
  try {
    const parsed = new URL(`https://${value}`);
    hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    if (parsed.pathname !== "/" || parsed.port !== "") throw new Error();
  } catch {
    throw new ProductToolError("domain_policy_invalid", "WebSearch domain is invalid");
  }
  if (hostname.length === 0 || hostname !== value.toLowerCase().replace(/\.$/u, "")
    || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new ProductToolError("domain_policy_invalid", "WebSearch domain is invalid");
  }
  return hostname;
};

const domainMatches = (hostname: string, rule: string): boolean =>
  hostname === rule || hostname.endsWith(`.${rule}`);

const normalizeDomains = (value: unknown): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) {
    throw new ProductToolError("domain_policy_invalid", "WebSearch domain policy exceeds its bound");
  }
  const result = value.map((item) => normalizeDomain(item as string)).sort();
  if (new Set(result).size !== result.length) {
    throw new ProductToolError("domain_policy_invalid", "WebSearch domain policy contains aliases or duplicates");
  }
  return Object.freeze(result);
};

const redactUrl = (raw: string): string => {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
};

const assertHttpCitations = (value: unknown, description: string): readonly string[] => {
  if (!Array.isArray(value)) throw new ProductToolError("provider_search_failed", `${description} citations are invalid`);
  const urls: string[] = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ProductToolError("provider_search_failed", `${description} citation is invalid`);
    }
    const urlValue = (candidate as JsonObject).url;
    if (typeof urlValue !== "string") {
      throw new ProductToolError("provider_search_failed", `${description} citation URL is invalid`);
    }
    let url: URL;
    try { url = new URL(urlValue); } catch {
      throw new ProductToolError("provider_search_failed", `${description} citation URL is invalid`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:")
      || url.username !== "" || url.password !== "") {
      throw new ProductToolError("provider_search_failed", `${description} citation URL is unsafe`);
    }
    urls.push(url.toString());
  }
  return Object.freeze(urls);
};

const assertSearchDomainPolicy = (
  value: unknown,
  allowedDomains: readonly string[] | undefined,
  blockedDomains: readonly string[] | undefined,
  description: string,
): void => {
  if (!Array.isArray(value)) {
    throw new ProductToolError("provider_search_failed", `${description} entries are invalid`);
  }
  for (const candidate of value) {
    const normalized = candidate as JsonObject;
    const rawUrl = normalized.url;
    if (typeof rawUrl !== "string") {
      throw new ProductToolError("provider_search_failed", `${description} URL is invalid`);
    }
    let hostname: string;
    try {
      const url = new URL(rawUrl);
      hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    } catch {
      throw new ProductToolError("provider_search_failed", `${description} URL is invalid`);
    }
    if ((allowedDomains !== undefined && !allowedDomains.some((rule) => domainMatches(hostname, rule)))
      || blockedDomains?.some((rule) => domainMatches(hostname, rule)) === true) {
      throw new ProductToolError("provider_search_failed", `${description} violates the requested domain policy`);
    }
  }
};

const truncateUtf8 = (value: string, maxBytes: number): Readonly<{ text: string; truncated: boolean }> => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return Object.freeze({ text: value, truncated: false });
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return Object.freeze({ text: bytes.subarray(0, end).toString("utf8"), truncated: true });
};

const renderJson = (_args: unknown, value: unknown): ContentBlock[] =>
  textBlocks(JSON.stringify(value, undefined, 2));

class ProductFetchProvider implements WebFetchProvider {
  readonly id = "myagents-safe-fetch";

  constructor(
    private readonly client: ProductSafeHttpClient,
    private readonly context: Context,
    private readonly storage: AsyncLocalStorage<FetchExecutionStore>,
    private readonly convert: (request: ProductWebContentRequest) => Promise<Readonly<{
      content: string;
      kind: "html" | "text";
      truncated: boolean;
    }>>,
  ) {}

  available(): boolean { return true; }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const store = this.storage.getStore();
    if (store === undefined || signal !== store.context.signal) {
      throw new ProductToolError("network_policy_denied", "WebFetch requires exact product execution authority");
    }
    const fetched = await this.client.fetch(request.url, store.context, async (url, product) => {
      await this.context.productTools.authorize(product, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.WebFetch.permissionClass,
        target: url.origin,
        tool: "WebFetch",
      });
    });
    if (fetched.contentType !== "text/html" && fetched.contentType !== "text/plain"
      && fetched.contentType !== "application/json" && !fetched.contentType.endsWith("+json")
      && fetched.contentType !== "application/pdf") {
      throw new ProductToolError("unsupported_content", "WebFetch response content type is unsupported");
    }
    let normalized: JsonObject;
    try {
      const pending = this.convert(Object.freeze({
        bytes: Uint8Array.from(fetched.bytes),
        contentType: fetched.contentType,
        finalUrl: redactUrl(fetched.finalUrl),
        signal: store.context.signal,
        statusCode: fetched.statusCode,
      }));
      const converted = await nativePromise<Readonly<{ content: string; kind: "html" | "text"; truncated: boolean }>>(
        pending,
        "WebFetch content converter",
      );
      normalized = normalizeCanonicalJson(converted, "WebFetch converted content") as JsonObject;
      if (Reflect.ownKeys(normalized).length !== 3 || typeof normalized.content !== "string"
        || (normalized.kind !== "html" && normalized.kind !== "text") || typeof normalized.truncated !== "boolean") {
        throw new TypeError("WebFetch content converter returned an invalid result");
      }
    } catch (error) {
      if (store.context.signal.aborted) throw store.context.signal.reason;
      throw new ProductToolError("unsupported_content", "WebFetch content conversion failed", { cause: error });
    }
    store.fetched = fetched;
    return Object.freeze({
      body: Object.freeze({ kind: normalized.kind, content: normalized.content }),
      statusCode: fetched.statusCode,
      truncated: normalized.truncated,
      url: fetched.finalUrl,
    });
  }
}

class ProductSearchProvider implements WebSearchProvider {
  #active = 0;
  readonly #waiters: Array<(release: () => void) => void> = [];

  constructor(
    readonly id: string,
    private readonly credentialRef: string,
    readonly policyRef: string,
    private readonly storage: AsyncLocalStorage<SearchExecutionStore>,
    private readonly runSearch: (request: ProductWebSearchRequest) => Promise<unknown>,
  ) {}

  available(): boolean { return true; }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const store = this.storage.getStore();
    if (store === undefined || signal !== store.context.signal || !this.available()
      || store.context.environment.network.mode !== "host-policy"
      || store.context.environment.network.policyRef !== this.policyRef) {
      throw new ProductToolError("web_search_unavailable", "WebSearch Provider is unavailable");
    }
    const release = await this.#acquire(store.context.signal);
    let detail: ProductSearchDetail;
    try {
      const pending = this.runSearch(Object.freeze({
        ...(store.allowedDomains === undefined ? {} : { allowedDomains: store.allowedDomains }),
        ...(store.blockedDomains === undefined ? {} : { blockedDomains: store.blockedDomains }),
        context: store.context,
        credentialRef: this.credentialRef,
        providerId: this.id,
        query: request.query,
        signal: store.context.signal,
      }));
      detail = normalizeCanonicalJson(
        await nativePromise<unknown>(pending, "WebSearch Provider"),
        "WebSearch Provider result",
      ) as ProductSearchDetail;
      store.context.signal.throwIfAborted();
      const detailKeys = ["citations", "durationMs", "results", "searchCount", "truncated", "usage"];
      if (Reflect.ownKeys(detail).length !== detailKeys.length
        || detailKeys.some((key) => !Object.hasOwn(detail, key))) {
        throw new TypeError("WebSearch Provider result has an invalid exact shape");
      }
      const checked = validateCanonicalToolOutput("WebSearch", { query: request.query, ...detail }) as JsonObject;
      if (!Number.isSafeInteger(checked.searchCount)
        || (checked.searchCount as number) > MAX_SEARCH_USES) {
        throw new ProductToolError("provider_search_failed", "WebSearch Provider exceeded the max-use contract");
      }
      const citationUrls = assertHttpCitations(checked.citations, "WebSearch");
      const results = checked.results;
      if (!Array.isArray(results)) throw new ProductToolError("provider_search_failed", "WebSearch results are invalid");
      const resultUrls = new Set<string>();
      for (const result of results) {
        for (const url of assertHttpCitations([result], "WebSearch result")) resultUrls.add(url);
      }
      if (citationUrls.some((url) => !resultUrls.has(url))) {
        throw new ProductToolError("provider_search_failed", "WebSearch citations lack result provenance");
      }
      assertSearchDomainPolicy(checked.citations, store.allowedDomains, store.blockedDomains, "WebSearch citation");
      assertSearchDomainPolicy(results, store.allowedDomains, store.blockedDomains, "WebSearch result");
    } catch (error) {
      if (store.context.signal.aborted) throw store.context.signal.reason;
      if (error instanceof ProductToolError && error.code === "web_search_unavailable") throw error;
      throw new ProductToolError("provider_search_failed", "WebSearch Provider returned an invalid result", { cause: error });
    } finally {
      release();
    }
    store.detail = detail;
    return Object.freeze({
      sources: Object.freeze(detail.results.map((result) => Object.freeze({
        snippet: result.snippet,
        title: result.title,
        url: result.url,
      }))),
      truncated: detail.truncated,
    });
  }

  async #acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.#active < MAX_CONCURRENT_SEARCHES) {
      this.#active += 1;
      return this.#releaseToken();
    }
    if (this.#waiters.length >= MAX_QUEUED_SEARCHES) {
      throw new ProductToolError("provider_search_failed", "WebSearch queue reached its bounded limit");
    }
    const token = await new Promise<() => void>((resolve, reject) => {
      const ready = (release: () => void) => {
        signal.removeEventListener("abort", abort);
        resolve(release);
      };
      const abort = () => {
        const index = this.#waiters.indexOf(ready);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error("WebSearch queue aborted"));
      };
      this.#waiters.push(ready);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      signal.throwIfAborted();
      return token;
    } catch (error) {
      token();
      throw error;
    }
  }

  #releaseToken(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next === undefined) this.#active -= 1;
      else next(this.#releaseToken());
    };
  }
}

export class CanonicalWebTools extends Service {
  static inject = ["productTools", "tools", "web"];
  readonly #fetchStorage = new AsyncLocalStorage<FetchExecutionStore>();
  readonly #searchStorage = new AsyncLocalStorage<SearchExecutionStore>();
  readonly #utility: ((request: ProductWebUtilityRequest) => Promise<unknown>) | undefined;
  readonly #searchConfigured: boolean;

  constructor(ctx: Context, config: CanonicalWebToolsConfig) {
    super(ctx, "canonicalWebTools");
    const normalized = validateCanonicalWebToolsConfig(config);
    const fetch = normalized.fetch;
    const disposers: Array<() => void> = [];
    if (fetch !== undefined) {
      if (!(fetch.client instanceof ProductSafeHttpClient)) {
        throw new TypeError("canonical WebFetch requires a ProductSafeHttpClient");
      }
      const content = dataMethod(fetch.content, "convert", "WebFetch content converter");
      const utility = dataMethod(fetch.utility, "run", "WebFetch utility model");
      this.#utility = (request) => Reflect.apply(utility.invoke, utility.owner, [request]) as Promise<unknown>;
      const fetchProvider = new ProductFetchProvider(
        fetch.client,
        ctx,
        this.#fetchStorage,
        (request) => Reflect.apply(content.invoke, content.owner, [request]) as Promise<Readonly<{
          content: string;
          kind: "html" | "text";
          truncated: boolean;
        }>>,
      );
      disposers.push(ctx.web.registerFetchProvider(fetchProvider));
    }
    let searchProvider: ProductSearchProvider | undefined;
    if (normalized.search !== undefined) {
      const search = normalized.search;
      const availableDescriptor = Object.getOwnPropertyDescriptor(search, "available");
      const runDescriptor = Object.getOwnPropertyDescriptor(search, "run");
      if (availableDescriptor === undefined || !("value" in availableDescriptor)
        || typeof availableDescriptor.value !== "function" || isProxy(availableDescriptor.value)
        || runDescriptor === undefined || !("value" in runDescriptor)
        || typeof runDescriptor.value !== "function" || isProxy(runDescriptor.value)) {
        throw new TypeError("canonical WebSearch capabilities must be own-data functions");
      }
      const owner = search;
      const providerId = boundedIdentifier(search.providerId, "WebSearch Provider id");
      const credentialRef = boundedIdentifier(search.credentialRef, "WebSearch credential reference");
      const policyRef = boundedIdentifier(search.policyRef, "WebSearch network policy reference");
      const available = Reflect.apply(availableDescriptor.value as () => unknown, owner, []);
      if (typeof available !== "boolean") {
        throw new TypeError("canonical WebSearch availability must return a boolean");
      }
      if (available) {
        searchProvider = new ProductSearchProvider(
          providerId,
          credentialRef,
          policyRef,
          this.#searchStorage,
          (request) => Reflect.apply(runDescriptor.value as (request: ProductWebSearchRequest) => unknown, owner, [request]) as Promise<unknown>,
        );
        disposers.push(ctx.web.registerSearchProvider(searchProvider));
      }
    }
    this.#searchConfigured = searchProvider !== undefined;
    if (fetch !== undefined) disposers.push(ctx.tools.register(this.#fetchDefinition(ctx)));
    if (searchProvider !== undefined) disposers.push(ctx.tools.register(this.#searchDefinition(ctx, searchProvider)));
    ctx.effect(() => () => { for (const dispose of disposers.reverse()) dispose(); }, "canonical-web-tools");
  }

  #fetchDefinition(ctx: Context): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS.WebFetch;
    const runUtility = this.#utility;
    if (runUtility === undefined) throw new Error("WebFetch utility authority is unavailable");
    return Object.freeze({
      description: contract.description,
      execute: async (raw: unknown, exec: ToolRunContext) => {
        const args = asObject(validateCanonicalToolInput("WebFetch", raw), "WebFetch input");
        const product = ctx.productTools.resolve(exec);
        if (product.environment.network.mode !== "host-policy") {
          throw new ProductToolError("network_policy_denied", "operation-frozen network policy denies WebFetch");
        }
        const store: FetchExecutionStore = { context: product };
        const fetched = await this.#fetchStorage.run(store, () => ctx.web.fetch({ url: args.url as string }, product.signal));
        product.signal.throwIfAborted();
        if (fetched.url !== store.fetched?.finalUrl) {
          throw new ProductToolError("unsupported_content", "WebFetch Provider omitted exact retrieval provenance");
        }
        const source = truncateUtf8(fetched.body.content, 1_000_000);
        try {
          product.signal.throwIfAborted();
          const utilityResult = await nativePromise<unknown>(runUtility(Object.freeze({
            context: product,
            finalUrl: redactUrl(fetched.url),
            prompt: args.prompt as string,
            signal: product.signal,
            source: source.text,
            statusCode: fetched.statusCode,
          })), "WebFetch utility model");
          product.signal.throwIfAborted();
          const utility = normalizeCanonicalJson(utilityResult, "WebFetch utility result") as JsonObject;
          const output = validateCanonicalToolOutput("WebFetch", {
            answer: utility.answer,
            citations: utility.citations,
            finalUrl: redactUrl(fetched.url),
            truncated: fetched.truncated || source.truncated || utility.truncated === true,
            url: redactUrl(args.url as string),
            usage: utility.usage,
          }) as JsonObject;
          const finalUrl = redactUrl(fetched.url);
          const citationUrls = assertHttpCitations(output.citations, "WebFetch");
          if (citationUrls.some((url) => redactUrl(url) !== finalUrl)) {
            throw new ProductToolError("utility_model_failed", "WebFetch citations lack fetched-content provenance");
          }
          return output;
        } catch (error) {
          if (product.signal.aborted) throw product.signal.reason;
          throw new ProductToolError("utility_model_failed", "WebFetch utility model returned an invalid result", { cause: error });
        }
      },
      isConcurrencySafe: () => true,
      name: "WebFetch",
      output: Object.freeze({
        render: renderJson,
        schema: canonicalOutputSchemaForDsh(contract.outputSchema),
      }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
      ...(contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
    });
  }

  #searchDefinition(ctx: Context, provider: ProductSearchProvider): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS.WebSearch;
    return Object.freeze({
      description: contract.description,
      execute: async (raw: unknown, exec: ToolRunContext) => {
        const args = asObject(validateCanonicalToolInput("WebSearch", raw), "WebSearch input");
        const product = ctx.productTools.resolve(exec);
        if (!this.#searchConfigured || !provider.available() || product.environment.network.mode !== "host-policy"
          || product.environment.network.policyRef !== provider.policyRef) {
          throw new ProductToolError("web_search_unavailable", "operation-frozen Provider has no approved WebSearch adapter");
        }
        const allowedDomains = normalizeDomains(args.allowed_domains);
        const blockedDomains = normalizeDomains(args.blocked_domains);
        if (allowedDomains !== undefined && blockedDomains !== undefined) {
          throw new ProductToolError("domain_policy_invalid", "allowed_domains and blocked_domains are mutually exclusive");
        }
        await ctx.productTools.authorize(product, {
          permissionClass: contract.permissionClass,
          target: `provider:${provider.id}`,
          tool: "WebSearch",
        });
        const store: SearchExecutionStore = {
          ...(allowedDomains === undefined ? {} : { allowedDomains }),
          ...(blockedDomains === undefined ? {} : { blockedDomains }),
          context: product,
        };
        await this.#searchStorage.run(store, () => ctx.web.search({
          maxResults: 100,
          query: args.query as string,
        }, product.signal));
        if (store.detail === undefined) {
          throw new ProductToolError("provider_search_failed", "WebSearch Provider omitted exact result evidence");
        }
        return validateCanonicalToolOutput("WebSearch", {
          query: args.query,
          ...store.detail,
        });
      },
      isConcurrencySafe: () => true,
      name: "WebSearch",
      output: Object.freeze({
        render: renderJson,
        schema: canonicalOutputSchemaForDsh(contract.outputSchema),
      }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
      ...(contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
    });
  }
}
