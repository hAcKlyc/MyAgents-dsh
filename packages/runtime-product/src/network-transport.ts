import { installProxyFromEnvironment, proxyRouteFor } from "@deepseek-ai/dsh-http-proxy";
import { Agent, Dispatcher, EnvHttpProxyAgent, getGlobalDispatcher, request, setGlobalDispatcher } from "undici";
import { finished } from "node:stream/promises";
import type { HostProviderNetworkScope } from "@myagents-dsh/host-ports";
import { ProtocolError, type ProviderNetworkPolicy } from "@myagents-dsh/protocol";
import type { ProductHttpProxyTransport } from "@myagents-dsh/tools-web";

const firstNonEmpty = (...values: readonly (string | undefined)[]): string | undefined =>
  values.find(value => value !== undefined && value !== "");

const proxyUrl = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new ProtocolError("network_proxy_unsupported", "Network proxy URL is invalid"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname
    || (url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new ProtocolError("network_proxy_unsupported", "Network requests require an HTTP(S) proxy endpoint");
  }
  return url.toString();
};

const loopback = (url: URL): boolean => url.hostname === "localhost"
  || url.hostname.endsWith(".localhost") || url.hostname === "[::1]"
  || url.hostname.startsWith("127.") || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(url.hostname);

/** A single process dispatcher; request routing follows the existing credential ALS scope. */
class ScopedModelDispatcher extends Dispatcher {
  readonly #direct = new Agent();
  readonly #scopes = new WeakMap<HostProviderNetworkScope, Map<string, EnvHttpProxyAgent>>();
  readonly #active = new Set<EnvHttpProxyAgent>();
  #closed = false;

  constructor(
    readonly general: Dispatcher,
    readonly currentScope: () => HostProviderNetworkScope | undefined,
  ) { super(); }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (this.#closed) throw new ProtocolError("network_transport_closed", "Runtime network transport is closed");
    const scope = this.currentScope();
    if (scope === undefined) return this.general.dispatch(options, handler);
    const url = new URL(String(options.origin));
    const configured = url.protocol === "https:" ? scope.policy.httpsProxy : scope.policy.httpProxy;
    const endpoint = proxyUrl(configured);
    if (endpoint === undefined || loopback(url)) return this.#direct.dispatch(options, handler);
    let pools = this.#scopes.get(scope);
    if (pools === undefined) {
      pools = new Map();
      this.#scopes.set(scope, pools);
      const owned = pools;
      scope.registerDisposer(async () => {
        this.#scopes.delete(scope);
        const retiring = [...owned.values()];
        owned.clear();
        try { await Promise.all(retiring.map((pool) => pool.close())); }
        finally { for (const pool of retiring) this.#active.delete(pool); }
      });
    }
    let pool = pools.get(endpoint);
    if (pool === undefined) {
      // Both schemes are explicit: an omitted Provider scheme never falls back
      // to the general process environment or another Provider's proxy.
      pool = new EnvHttpProxyAgent({ httpProxy: endpoint, httpsProxy: endpoint, noProxy: scope.policy.noProxy });
      pools.set(endpoint, pool);
      this.#active.add(pool);
    }
    return pool.dispatch(options, handler);
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    const results = await Promise.allSettled([this.#direct.destroy(), this.general.destroy(), ...[...this.#active].map((pool) => pool.destroy())]);
    this.#active.clear();
    if (results.some((result) => result.status === "rejected")) {
      throw new ProtocolError("network_transport_cleanup_failed", "Runtime network transport cleanup failed");
    }
  }
}

export interface ProductNetworkTransport {
  readonly proxyTransportFor: (url: URL) => ProductHttpProxyTransport | undefined;
  readonly dispose: () => Promise<void>;
}

let installedOwner: object | undefined;

/** Install once at trusted composition, before admission; never swap globals per request. */
export const installProductNetworkTransport = async (
  environment: Readonly<Record<string, string | undefined>>,
  currentScope: () => HostProviderNetworkScope | undefined,
): Promise<ProductNetworkTransport> => {
  if (installedOwner !== undefined) throw new Error("Runtime network transport already has an owner");
  const owner = {};
  installedOwner = owner;
  let restoreGeneral: (() => Promise<void>) | undefined;
  try {
    // Host has already selected general scope. Normalize only that snapshot,
    // preserving its inherited fallback; reject unusable selected proxy schemes.
    const all = firstNonEmpty(environment.all_proxy, environment.ALL_PROXY);
    const http = proxyUrl(firstNonEmpty(environment.http_proxy, environment.HTTP_PROXY, all));
    const https = proxyUrl(firstNonEmpty(environment.https_proxy, environment.HTTPS_PROXY, http, all));
    const policy: ProviderNetworkPolicy = { noProxy: firstNonEmpty(environment.no_proxy, environment.NO_PROXY) ?? "",
      ...(http === undefined ? {} : { httpProxy: http }), ...(https === undefined ? {} : { httpsProxy: https }) };
    const selected: Record<string, string | undefined> = { HTTP_PROXY: policy.httpProxy, HTTPS_PROXY: policy.httpsProxy, NO_PROXY: policy.noProxy };
    const previousDispatcher = getGlobalDispatcher();
    restoreGeneral = await installProxyFromEnvironment({ get: (name) => selected[name] === undefined ? undefined : { value: selected[name] } }, () => {
      throw new ProtocolError("network_proxy_unsupported", "Runtime general network proxy policy is unsupported");
    });
    // With no configured proxy the official installer may retain the caller's
    // dispatcher. Create a generation-owned direct pool before wrapping it.
    const retainedPrevious = getGlobalDispatcher() === previousDispatcher;
    const general = retainedPrevious ? new Agent() : getGlobalDispatcher();
    const router = new ScopedModelDispatcher(general, currentScope);
    setGlobalDispatcher(router);
    const restoreInstalled = restoreGeneral;
    const restore = async (destroyed: boolean): Promise<void> => {
      try { await restoreInstalled(); }
      catch (error) {
        // undici rejects close-after-destroy; the official disposer has already
        // restored its global policy/environment before closing the owned pool.
        if (!destroyed || !(error instanceof Error) || !("code" in error) || error.code !== "UND_ERR_DESTROYED") throw error;
      }
      finally { if (retainedPrevious) setGlobalDispatcher(previousDispatcher); }
    };
    let disposal: Promise<void> | undefined;
    return Object.freeze({
      proxyTransportFor: (url: URL): ProductHttpProxyTransport | undefined => {
        const route = proxyRouteFor(url);
        if (!route.proxied) return undefined;
        return Object.freeze<ProductHttpProxyTransport>({ dispatch: async (target, signal, input) => {
          if (target.href !== url.href) throw new ProtocolError("network_policy_denied", "Proxy route changed its validated target");
          const controller = new AbortController();
          const response = await request(target, { dispatcher: route.dispatcher,
            signal: AbortSignal.any([signal, controller.signal]), method: input?.method ?? "GET",
            ...(input?.headers === undefined ? {} : { headers: { ...input.headers } }),
            ...(input?.body === undefined ? {} : { body: Buffer.from(input.body) }),
          });
          return { body: response.body, headers: response.headers, statusCode: response.statusCode,
            dispose: async () => {
              const closed = finished(response.body, { cleanup: true }).catch(() => undefined);
              controller.abort();
              response.body.destroy();
              await closed;
            } };
        } });
      },
      dispose: () => disposal ??= Promise.resolve().then(async () => {
        setGlobalDispatcher(general);
        // Destroy before close: Agent.close removes its child-pool inventory,
        // so a later destroy could no longer terminate a stalled request.
        const results = await Promise.allSettled([router.dispose()]);
        results.push(...await Promise.allSettled([restore(results[0].status === "fulfilled")]));
        if (installedOwner === owner) installedOwner = undefined;
        if (results.some((result) => result.status === "rejected")) {
          throw new ProtocolError("network_transport_cleanup_failed", "Runtime network transport cleanup failed");
        }
      }),
    });
  } catch (error) {
    try { await restoreGeneral?.(); } finally { if (installedOwner === owner) installedOwner = undefined; }
    throw error;
  }
};
