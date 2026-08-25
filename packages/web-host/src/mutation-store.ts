import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { WebHostError } from "./errors.js";

export const WEB_SESSION_MUTATION_JOURNAL_VERSION = 1 as const;
export const MAX_MUTATION_JOURNAL_BYTES = 1_048_576;

export type ReferenceWebMutationKind = "delete" | "fork" | "rewind";
export type ReferenceWebMutationRecord = Readonly<{
  sourceWebSessionId: string;
  mutation: ReferenceWebMutationKind;
  clientMutationId: string;
  operationToken: string;
  state: string;
  targetWebSessionId?: string;
}>;

const boundedString = (value: unknown, label: string, maximum = 4_096): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new WebHostError("mutation_journal_invalid", `${label} must be a bounded string`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new WebHostError("mutation_journal_invalid", `${label} contains a control character`);
    }
  }
  return value;
};

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new WebHostError("mutation_journal_invalid", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void => {
  const keys = Object.keys(value);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw new WebHostError("mutation_journal_invalid", `${label} differs from its closed schema`);
  }
};

const record = (value: unknown): ReferenceWebMutationRecord => {
  const source = object(value, "mutation journal row");
  exactKeys(source, [
    "sourceWebSessionId", "mutation", "clientMutationId", "operationToken", "state",
  ], ["targetWebSessionId"], "mutation journal row");
  if (source.mutation !== "delete" && source.mutation !== "fork" && source.mutation !== "rewind") {
    throw new WebHostError("mutation_journal_invalid", "mutation journal kind is invalid");
  }
  const targetWebSessionId = source.targetWebSessionId === undefined
    ? undefined : boundedString(source.targetWebSessionId, "target Web Session id", 256);
  if ((source.mutation === "fork") !== (targetWebSessionId !== undefined)) {
    throw new WebHostError("mutation_journal_invalid", "fork journal target is missing or unexpected");
  }
  return Object.freeze({
    sourceWebSessionId: boundedString(source.sourceWebSessionId, "source Web Session id", 256),
    mutation: source.mutation,
    clientMutationId: boundedString(source.clientMutationId, "client mutation id", 256),
    operationToken: boundedString(source.operationToken, "mutation operation token"),
    state: boundedString(source.state, "mutation state", 128),
    ...(targetWebSessionId === undefined ? {} : { targetWebSessionId }),
  });
};

const document = (value: unknown): readonly ReferenceWebMutationRecord[] => {
  const source = object(value, "mutation journal");
  exactKeys(source, ["schemaVersion", "rows"], [], "mutation journal");
  if (source.schemaVersion !== WEB_SESSION_MUTATION_JOURNAL_VERSION
    || !Array.isArray(source.rows) || source.rows.length > 128) {
    throw new WebHostError("mutation_journal_invalid", "mutation journal version or row bound is invalid");
  }
  const rows = source.rows.map(record);
  if (new Set(rows.map(({ operationToken }) => operationToken)).size !== rows.length
    || new Set(rows.map(({ sourceWebSessionId }) => sourceWebSessionId)).size !== rows.length) {
    throw new WebHostError("mutation_journal_invalid", "mutation journal operation authorities must be unique");
  }
  return Object.freeze(rows);
};

export class ReferenceWebMutationStore {
  readonly #path: string;
  #rows: readonly ReferenceWebMutationRecord[];
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(path: string, rows: readonly ReferenceWebMutationRecord[]) {
    this.#path = path;
    this.#rows = rows;
  }

  static async open(path: string): Promise<ReferenceWebMutationStore> {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MUTATION_JOURNAL_BYTES) {
        throw new WebHostError("mutation_journal_invalid", "mutation journal is not a bounded regular file");
      }
      return new ReferenceWebMutationStore(
        target,
        document(JSON.parse(await readFile(target, "utf8")) as unknown),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new ReferenceWebMutationStore(target, []);
      }
      const quarantine = resolve(dirname(target), `${basename(target)}.corrupt-${randomUUID()}`);
      await rename(target, quarantine).catch(() => undefined);
      return new ReferenceWebMutationStore(target, []);
    }
  }

  list(sourceWebSessionId: string): readonly ReferenceWebMutationRecord[] {
    return this.#rows.filter((candidate) => candidate.sourceWebSessionId === sourceWebSessionId);
  }

  get(operationToken: string): ReferenceWebMutationRecord | undefined {
    return this.#rows.find((candidate) => candidate.operationToken === operationToken);
  }

  async put(value: ReferenceWebMutationRecord): Promise<void> {
    const next = record(value);
    const conflict = this.#rows.find((candidate) =>
      candidate.sourceWebSessionId === next.sourceWebSessionId
      && candidate.operationToken !== next.operationToken);
    if (conflict !== undefined) {
      throw new WebHostError(
        "mutation_recovery_required",
        "Settle the existing Session mutation before preparing another",
        true,
      );
    }
    await this.#replace([
      ...this.#rows.filter(({ operationToken }) => operationToken !== next.operationToken),
      next,
    ].sort((left, right) => left.sourceWebSessionId.localeCompare(right.sourceWebSessionId)));
  }

  async setState(operationToken: string, state: string): Promise<void> {
    const current = this.get(operationToken);
    if (current === undefined) {
      throw new WebHostError("mutation_recovery_unknown", "Mutation recovery authority is unavailable");
    }
    await this.put({ ...current, state });
  }

  async remove(operationToken: string): Promise<void> {
    if (!this.#rows.some((candidate) => candidate.operationToken === operationToken)) return;
    await this.#replace(this.#rows.filter((candidate) => candidate.operationToken !== operationToken));
  }

  async removeSession(webSessionId: string): Promise<void> {
    if (!this.#rows.some((candidate) => candidate.sourceWebSessionId === webSessionId
      || candidate.targetWebSessionId === webSessionId)) return;
    await this.#replace(this.#rows.filter((candidate) => candidate.sourceWebSessionId !== webSessionId
      && candidate.targetWebSessionId !== webSessionId));
  }

  async #replace(rows: readonly ReferenceWebMutationRecord[]): Promise<void> {
    const validated = document({ schemaVersion: WEB_SESSION_MUTATION_JOURNAL_VERSION, rows });
    const bytes = `${JSON.stringify({
      schemaVersion: WEB_SESSION_MUTATION_JOURNAL_VERSION,
      rows: validated,
    }, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_MUTATION_JOURNAL_BYTES) {
      throw new WebHostError("mutation_journal_full", "mutation journal exceeds its byte bound");
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
