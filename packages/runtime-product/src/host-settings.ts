import { symbols, type Context } from "@deepseek-ai/cordis";
import {
  SettingsProvider,
  type SettingsNamespace,
} from "@deepseek-ai/dsh-settings";

/**
 * Process-local settings authority for the integrated Runtime profile.
 *
 * The Host sends the complete non-secret Provider profile through native RPC.
 * Keeping the DSH settings document in memory prevents a second user-editable
 * configuration source while still using the official plugin's public dynamic
 * settings seam.
 */
export class HostSettingsProvider extends SettingsProvider {
  readonly writable = true;

  constructor(ctx: Context) {
    super(ctx);
    if (ctx.fiber.parent !== ctx.root) {
      throw new Error("Host settings Provider must be installed directly on the Runtime root");
    }
    hostSettingsDocuments.set(this, Object.create(null) as Record<string, unknown>);
  }

  override get documentPath(): undefined { return undefined; }

  override prepareDocument(): Promise<undefined> { return Promise.resolve(undefined); }

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(hostSettingsDocument(this)));
  }

  protected override persist(
    namespace: SettingsNamespace,
    section: Record<string, unknown>,
  ): Promise<void> {
    const owner = hostSettingsOwner(this);
    hostSettingsDocuments.set(owner, Object.assign(
      Object.create(null) as Record<string, unknown>,
      hostSettingsDocument(owner),
      {
      [namespace]: structuredClone(section),
      },
    ));
    return Promise.resolve();
  }
}

const hostSettingsDocuments = new WeakMap<HostSettingsProvider, Record<string, unknown>>();

const hostSettingsOwner = (service: HostSettingsProvider): HostSettingsProvider => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original instanceof HostSettingsProvider ? original : service;
};

const hostSettingsDocument = (service: HostSettingsProvider): Record<string, unknown> => {
  const document = hostSettingsDocuments.get(hostSettingsOwner(service));
  if (document === undefined) throw new Error("Host settings Provider lost its in-memory document authority");
  return document;
};

Object.freeze(HostSettingsProvider.prototype);
Object.freeze(HostSettingsProvider);
