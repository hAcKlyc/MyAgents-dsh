import type { SessionId } from "@deepseek-ai/dsh-session";

/** One package-owned serialization authority shared by backend hooks and later mutations. */
export class ProductSessionLockTable {
  readonly #tails = new Map<string, Promise<void>>();
  #accepting = true;
  #closePromise: Promise<void> | undefined;

  run<T>(id: SessionId, signal: AbortSignal | undefined, work: () => Promise<T> | T): Promise<T> {
    if (!this.#accepting) return Promise.reject(new Error("product persistence lock table is closed"));
    signal?.throwIfAborted();
    const key = String(id);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      signal?.throwIfAborted();
      const value = await work();
      signal?.throwIfAborted();
      return value;
    });
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(key, tail);
    void tail.finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  close(): Promise<void> {
    this.#accepting = false;
    this.#closePromise ??= Promise.all([...this.#tails.values()]).then(() => undefined);
    return this.#closePromise;
  }
}
