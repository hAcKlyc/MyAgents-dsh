import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { WebSessionLifecycle, WebSessionSummary } from "@myagents-dsh/web-host-contract";

import { WebHostError } from "./errors.js";

export const WEB_SESSION_CATALOG_VERSION = 1 as const;
export const MAX_CATALOG_BYTES = 1_048_576;
export const MAX_CATALOG_ROWS = 128;

export type WebSessionCatalogRow = Readonly<{
  webSessionId: string;
  runtimeSessionId?: string;
  persistenceRef: string;
  workspaceIdentity: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  desiredProfileRef: string;
  desiredComponentRef: string;
  lifecycle: WebSessionLifecycle;
  failureCode?: string;
}>;
export type WebSessionCatalogPatch = Partial<Omit<
  WebSessionCatalogRow,
  "webSessionId" | "createdAt" | "failureCode"
>> & Readonly<{ failureCode?: string | null }>;

type CatalogDocument = Readonly<{
  schemaVersion: 1;
  rows: readonly WebSessionCatalogRow[];
}>;

const hasAsciiControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};
const identifier = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || hasAsciiControl(value)) {
    throw new WebHostError("catalog_invalid", `${name} must be a bounded identifier`);
  }
  return value;
};
const timestamp = (value: unknown, name: string): string => {
  const text = identifier(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new WebHostError("catalog_invalid", `${name} must be a timestamp`);
  return text;
};
const optionalIdentifier = (value: unknown, name: string): string | undefined =>
  value === undefined ? undefined : identifier(value, name);
const rowKeys = [
  "createdAt", "desiredComponentRef", "desiredProfileRef", "failureCode", "lastOpenedAt",
  "lifecycle", "persistenceRef", "runtimeSessionId", "title", "updatedAt", "webSessionId",
  "workspaceIdentity",
] as const;
const lifecycleStates = new Set<WebSessionLifecycle>([
  "cold", "starting", "initializing", "ready", "stopping", "recovery_required", "fatal",
]);
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void => {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw new WebHostError("catalog_invalid", "Catalog object keys differ from the closed schema");
  }
};
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new WebHostError("catalog_invalid", "Catalog value must be a plain object");
  }
  return value as Record<string, unknown>;
};
const parseRow = (value: unknown): WebSessionCatalogRow => {
  const source = object(value);
  exactKeys(source, rowKeys, rowKeys.filter((key) => key !== "runtimeSessionId" && key !== "failureCode"));
  const lifecycle = identifier(source.lifecycle, "catalog lifecycle") as WebSessionLifecycle;
  if (!lifecycleStates.has(lifecycle)) throw new WebHostError("catalog_invalid", "Catalog lifecycle is invalid");
  const title = identifier(source.title, "catalog title");
  if (title.length > 160) throw new WebHostError("catalog_invalid", "Catalog title exceeds its limit");
  const runtimeSessionId = optionalIdentifier(source.runtimeSessionId, "Runtime Session id");
  const failureCode = optionalIdentifier(source.failureCode, "failure code");
  return Object.freeze({
    webSessionId: identifier(source.webSessionId, "web Session id"),
    ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
    persistenceRef: identifier(source.persistenceRef, "persistence ref"),
    workspaceIdentity: identifier(source.workspaceIdentity, "workspace identity"),
    title,
    createdAt: timestamp(source.createdAt, "createdAt"),
    updatedAt: timestamp(source.updatedAt, "updatedAt"),
    lastOpenedAt: timestamp(source.lastOpenedAt, "lastOpenedAt"),
    desiredProfileRef: identifier(source.desiredProfileRef, "profile ref"),
    desiredComponentRef: identifier(source.desiredComponentRef, "component ref"),
    lifecycle,
    ...(failureCode === undefined ? {} : { failureCode }),
  });
};
const parseDocument = (value: unknown): CatalogDocument => {
  const source = object(value);
  exactKeys(source, ["rows", "schemaVersion"], ["rows", "schemaVersion"]);
  if (source.schemaVersion !== WEB_SESSION_CATALOG_VERSION || !Array.isArray(source.rows)
    || source.rows.length > MAX_CATALOG_ROWS) {
    throw new WebHostError("catalog_invalid", "Catalog version or row bound is invalid");
  }
  const rows = source.rows.map(parseRow);
  const ids = rows.map(({ webSessionId }) => webSessionId);
  if (new Set(ids).size !== ids.length) throw new WebHostError("catalog_invalid", "Catalog Session ids must be unique");
  return Object.freeze({ schemaVersion: WEB_SESSION_CATALOG_VERSION, rows: Object.freeze(rows) });
};
const serialize = (rows: readonly WebSessionCatalogRow[]): string =>
  `${JSON.stringify({ schemaVersion: WEB_SESSION_CATALOG_VERSION, rows }, null, 2)}\n`;
const toSummary = (row: WebSessionCatalogRow): WebSessionSummary => Object.freeze({
  webSessionId: row.webSessionId,
  title: row.title,
  lifecycle: row.lifecycle,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastOpenedAt: row.lastOpenedAt,
  ...(row.runtimeSessionId === undefined ? {} : { runtimeSessionId: row.runtimeSessionId }),
  ...(row.failureCode === undefined ? {} : { failureCode: row.failureCode }),
});

export class WebSessionCatalog {
  readonly #path: string;
  #rows: readonly WebSessionCatalogRow[];
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(path: string, rows: readonly WebSessionCatalogRow[]) {
    this.#path = path;
    this.#rows = rows;
  }

  static async open(path: string): Promise<WebSessionCatalog> {
    const catalogPath = resolve(path);
    await mkdir(dirname(catalogPath), { recursive: true, mode: 0o700 });
    let bytes: string;
    try {
      const metadata = await lstat(catalogPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CATALOG_BYTES) {
        throw new WebHostError("catalog_invalid", "Catalog file type or byte bound is invalid");
      }
      bytes = await readFile(catalogPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new WebSessionCatalog(catalogPath, []);
      if (error instanceof WebHostError) {
        await WebSessionCatalog.#quarantine(catalogPath);
        return new WebSessionCatalog(catalogPath, []);
      }
      throw error;
    }
    try {
      const document = parseDocument(JSON.parse(bytes) as unknown);
      return new WebSessionCatalog(catalogPath, document.rows);
    } catch {
      await WebSessionCatalog.#quarantine(catalogPath);
      return new WebSessionCatalog(catalogPath, []);
    }
  }

  static async #quarantine(path: string): Promise<void> {
    const target = resolve(dirname(path), `${basename(path)}.corrupt-${randomUUID()}`);
    try {
      await rename(path, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): readonly WebSessionCatalogRow[] { return this.#rows; }
  summaries(): readonly WebSessionSummary[] { return Object.freeze(this.#rows.map(toSummary)); }
  get(webSessionId: string): WebSessionCatalogRow | undefined {
    return this.#rows.find((row) => row.webSessionId === webSessionId);
  }

  async create(input: Readonly<{
    workspaceIdentity: string;
    title?: string;
    desiredProfileRef: string;
    desiredComponentRef: string;
    now?: string;
  }>): Promise<WebSessionCatalogRow> {
    if (this.#rows.length >= MAX_CATALOG_ROWS) throw new WebHostError("catalog_full", "Session catalog is full");
    const webSessionId = randomUUID();
    const now = input.now ?? new Date().toISOString();
    const row = parseRow({
      webSessionId,
      persistenceRef: `web-session:${webSessionId}`,
      workspaceIdentity: input.workspaceIdentity,
      title: input.title ?? "New session",
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      desiredProfileRef: input.desiredProfileRef,
      desiredComponentRef: input.desiredComponentRef,
      lifecycle: "cold",
    });
    await this.#replace([...this.#rows, row]);
    return row;
  }

  async update(webSessionId: string, patch: WebSessionCatalogPatch): Promise<WebSessionCatalogRow> {
    const index = this.#rows.findIndex((row) => row.webSessionId === webSessionId);
    const current = this.#rows[index];
    if (index < 0 || current === undefined) throw new WebHostError("session_unknown", "Web Session is unknown");
    const merged: Record<string, unknown> = { ...current, ...patch, webSessionId, createdAt: current.createdAt };
    if (patch.failureCode === null) delete merged.failureCode;
    const updated = parseRow(merged);
    const rows = [...this.#rows];
    rows[index] = updated;
    await this.#replace(rows);
    return updated;
  }

  async remove(webSessionId: string): Promise<void> {
    const rows = this.#rows.filter((row) => row.webSessionId !== webSessionId);
    if (rows.length === this.#rows.length) throw new WebHostError("session_unknown", "Web Session is unknown");
    await this.#replace(rows);
  }

  async #replace(rows: readonly WebSessionCatalogRow[]): Promise<void> {
    const document = parseDocument({ schemaVersion: WEB_SESSION_CATALOG_VERSION, rows });
    const bytes = serialize(document.rows);
    if (Buffer.byteLength(bytes) > MAX_CATALOG_BYTES) throw new WebHostError("catalog_full", "Session catalog exceeds its byte bound");
    const operation = this.#writeTail.then(async () => {
      const temporary = resolve(dirname(this.#path), `.${basename(this.#path)}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes, "utf8");
        await handle.sync();
        await handle.close();
        await rename(temporary, this.#path);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.#rows = document.rows;
    });
    this.#writeTail = operation.catch(() => undefined);
    await operation;
  }
}
