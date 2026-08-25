import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  validateBrowserCommand,
  type BrowserComponentSnapshot,
  type SessionConfiguration,
} from "@myagents-dsh/web-host-contract";

import { WebHostError } from "./errors.js";

export const WEB_SESSION_CONFIGURATION_VERSION = 1 as const;
export const MAX_CONFIGURATION_BYTES = 8 * 1_048_576;

export type ReferenceSessionControls = Readonly<{
  configuration: SessionConfiguration;
  components: BrowserComponentSnapshot;
}>;

type StoredRow = Readonly<{
  webSessionId: string;
  configuration: SessionConfiguration;
  components: BrowserComponentSnapshot;
}>;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new WebHostError("configuration_invalid", `${label} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new WebHostError("configuration_invalid", `${label} contains a control character`);
    }
  }
  return value;
};
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new WebHostError("configuration_invalid", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))
    || allowed.some((key) => !Object.hasOwn(value, key))) {
    throw new WebHostError("configuration_invalid", `${label} differs from its closed schema`);
  }
};
const forbiddenSecretKeys = new Set([
  "apikey", "api_key", "authorization", "cookie", "credentialmaterial", "password", "secret", "token",
]);
const assertNoSecretFields = (value: unknown, depth = 0): void => {
  if (depth > 64 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretFields(item, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (forbiddenSecretKeys.has(key.replaceAll("-", "").toLowerCase())) {
      throw new WebHostError("configuration_secret_forbidden", "configuration store cannot contain secret material");
    }
    assertNoSecretFields(item, depth + 1);
  }
};
const configuration = (value: unknown, webSessionId: string): SessionConfiguration => {
  const validated = validateBrowserCommand({
    commandId: "configuration-store-validation",
    kind: "config.apply",
    webSessionId,
    payload: value,
  });
  if (validated.kind !== "config.apply") throw new Error("configuration validation selected the wrong command");
  return Object.freeze(validated.payload);
};
const components = (value: unknown, webSessionId: string): BrowserComponentSnapshot => {
  assertNoSecretFields(value);
  const source = object(value, "component snapshot");
  exactKeys(source, ["revision", "digest", "components"], "component snapshot");
  if (typeof source.digest !== "string" || !sha256Pattern.test(source.digest)) {
    throw new WebHostError("configuration_invalid", "component snapshot digest is invalid");
  }
  const validated = validateBrowserCommand({
    commandId: "component-store-validation",
    kind: "components.replace",
    webSessionId,
    payload: {
      revision: source.revision,
      components: source.components,
    },
  });
  if (validated.kind !== "components.replace") throw new Error("component validation selected the wrong command");
  return Object.freeze({
    revision: validated.payload.revision,
    digest: source.digest,
    components: [...validated.payload.components],
  });
};
const row = (value: unknown): StoredRow => {
  const source = object(value, "configuration row");
  exactKeys(source, ["webSessionId", "configuration", "components"], "configuration row");
  const webSessionId = identifier(source.webSessionId, "web Session id");
  return Object.freeze({
    webSessionId,
    configuration: configuration(source.configuration, webSessionId),
    components: components(source.components, webSessionId),
  });
};
const document = (value: unknown): readonly StoredRow[] => {
  const source = object(value, "configuration document");
  exactKeys(source, ["schemaVersion", "rows"], "configuration document");
  if (source.schemaVersion !== WEB_SESSION_CONFIGURATION_VERSION || !Array.isArray(source.rows)
    || source.rows.length > 128) {
    throw new WebHostError("configuration_invalid", "configuration document version or row bound is invalid");
  }
  const rows = source.rows.map(row);
  if (new Set(rows.map(({ webSessionId }) => webSessionId)).size !== rows.length) {
    throw new WebHostError("configuration_invalid", "configuration row ids must be unique");
  }
  return Object.freeze(rows);
};

export class ReferenceWebConfigurationStore {
  readonly #path: string;
  readonly #defaults: ReferenceSessionControls;
  #rows: readonly StoredRow[];
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(path: string, defaults: ReferenceSessionControls, rows: readonly StoredRow[]) {
    this.#path = path;
    this.#defaults = defaults;
    this.#rows = rows;
  }

  static async open(path: string, defaults: ReferenceSessionControls): Promise<ReferenceWebConfigurationStore> {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CONFIGURATION_BYTES) {
        throw new WebHostError("configuration_invalid", "configuration file is not a bounded regular file");
      }
      const parsed = document(JSON.parse(await readFile(target, "utf8")) as unknown);
      return new ReferenceWebConfigurationStore(target, defaults, parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new ReferenceWebConfigurationStore(target, defaults, []);
      }
      const quarantine = resolve(dirname(target), `${basename(target)}.corrupt-${randomUUID()}`);
      await rename(target, quarantine).catch(() => undefined);
      return new ReferenceWebConfigurationStore(target, defaults, []);
    }
  }

  get(webSessionId: string): ReferenceSessionControls {
    const known = this.#rows.find((candidate) => candidate.webSessionId === webSessionId);
    return known === undefined ? this.#defaults : Object.freeze({
      configuration: known.configuration,
      components: known.components,
    });
  }

  async setConfiguration(webSessionId: string, next: SessionConfiguration): Promise<void> {
    const current = this.get(webSessionId);
    await this.#set(row({ webSessionId, configuration: next, components: current.components }));
  }

  async setComponents(webSessionId: string, next: BrowserComponentSnapshot): Promise<void> {
    const current = this.get(webSessionId);
    await this.#set(row({ webSessionId, configuration: current.configuration, components: next }));
  }

  async clone(sourceWebSessionId: string, targetWebSessionId: string): Promise<void> {
    const source = this.get(sourceWebSessionId);
    await this.#set(row({ webSessionId: targetWebSessionId, ...source }));
  }

  async remove(webSessionId: string): Promise<void> {
    if (!this.#rows.some((candidate) => candidate.webSessionId === webSessionId)) return;
    await this.#replace(this.#rows.filter((candidate) => candidate.webSessionId !== webSessionId));
  }

  async #set(next: StoredRow): Promise<void> {
    const rows = this.#rows.filter(({ webSessionId }) => webSessionId !== next.webSessionId);
    await this.#replace([...rows, next].sort((left, right) => left.webSessionId.localeCompare(right.webSessionId)));
  }

  async #replace(rows: readonly StoredRow[]): Promise<void> {
    const validated = document({ schemaVersion: WEB_SESSION_CONFIGURATION_VERSION, rows });
    const bytes = `${JSON.stringify({ schemaVersion: WEB_SESSION_CONFIGURATION_VERSION, rows: validated }, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_CONFIGURATION_BYTES) {
      throw new WebHostError("configuration_full", "configuration store exceeds its byte bound");
    }
    const operation = this.#writeTail.then(async () => {
      const temporary = resolve(dirname(this.#path), `.${basename(this.#path)}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes, "utf8");
        await handle.sync();
        await handle.close();
        await rename(temporary, this.#path);
        this.#rows = validated;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.#writeTail = operation.catch(() => undefined);
    await operation;
  }
}
