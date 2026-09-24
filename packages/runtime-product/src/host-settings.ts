import { Service, symbols, type Context, type Fiber } from "@deepseek-ai/cordis";

/**
 * The Host owns the writable pi-ai route snapshot. The current DSH settings
 * plugin edits a Loader profile and requires a separate configuration store,
 * so this service projects the Host snapshot into the mounted plugin Fiber.
 */
export class HostSettingsProvider extends Service {
  readonly #documents = new Map<string, Record<string, unknown>>();
  #piAiFiber: Fiber | undefined;
  #pending: Promise<void> = Promise.resolve();

  constructor(ctx: Context) {
    super(ctx, "settings");
    if (ctx.fiber.parent !== ctx.root) {
      throw new Error("Host settings Provider must be installed directly on the Runtime root");
    }
  }

  bindPiAiFiber(fiber: Fiber): void {
    const owner = originalHostSettingsProvider(this);
    if (owner.#piAiFiber !== undefined) throw new Error("pi-ai configuration may bind exactly once");
    owner.#piAiFiber = fiber;
  }

  /** The product does not expose a DSH settings form. */
  configure(_presentation: { auto?: boolean }, _owner?: Fiber): () => void {
    void _presentation;
    void _owner;
    return () => undefined;
  }

  describe(): readonly { ns: string }[] {
    return Object.freeze([{ ns: "llm-pi-ai" }]);
  }

  replace(namespace: string, section: object): Promise<void> {
    const owner = originalHostSettingsProvider(this);
    if (namespace !== "llm-pi-ai") throw new Error("Host settings accepts only the pi-ai route namespace");
    const fiber = owner.#piAiFiber;
    if (fiber === undefined) throw new Error("pi-ai plugin is not mounted");
    const next = structuredClone(section) as Record<string, unknown>;
    const apply = async (): Promise<void> => {
      const previous = owner.#documents.get(namespace) ?? { providers: {} };
      try {
        fiber.update(next, true);
        await fiber.await();
      } catch (error) {
        fiber.update(previous, true);
        await fiber.await();
        throw error;
      }
      owner.#documents.set(namespace, next);
    };
    owner.#pending = owner.#pending.then(apply, apply);
    return owner.#pending;
  }
}

const originalHostSettingsProvider = (service: HostSettingsProvider): HostSettingsProvider => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original instanceof HostSettingsProvider ? original : service;
};

Object.freeze(HostSettingsProvider.prototype);
Object.freeze(HostSettingsProvider);
