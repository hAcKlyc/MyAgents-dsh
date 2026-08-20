type LockWaiter = {
  readonly reject: (reason: unknown) => void;
  readonly resolve: (release: () => void) => void;
  readonly signal: AbortSignal;
  stopAbort?: () => void;
};

type LockState = {
  active: boolean;
  readonly waiters: LockWaiter[];
};

const abortedLockError = (signal: AbortSignal): Error => signal.reason instanceof Error
  ? signal.reason
  : new Error("product keyed lock acquisition was aborted", { cause: signal.reason });

export class ProductKeyedLocks {
  readonly #states = new Map<string, LockState>();

  acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (typeof key !== "string" || key.length === 0 || key.length > 8_192) {
      throw new TypeError("product lock key must be bounded");
    }
    signal.throwIfAborted();
    const state = this.#states.get(key) ?? { active: false, waiters: [] };
    this.#states.set(key, state);
    if (!state.active) {
      state.active = true;
      return Promise.resolve(this.#release(key, state));
    }
    return new Promise((resolve, reject) => {
      const waiter: LockWaiter = { reject, resolve, signal };
      const onAbort = (): void => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        waiter.stopAbort?.();
        reject(abortedLockError(signal));
        this.#deleteIfEmpty(key, state);
      };
      waiter.stopAbort = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      state.waiters.push(waiter);
    });
  }

  get size(): number { return this.#states.size; }

  #release(key: string, state: LockState): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (;;) {
        const next = state.waiters.shift();
        if (next === undefined) {
          state.active = false;
          this.#deleteIfEmpty(key, state);
          return;
        }
        next.stopAbort?.();
        if (next.signal.aborted) {
          next.reject(next.signal.reason);
          continue;
        }
        next.resolve(this.#release(key, state));
        return;
      }
    };
  }

  #deleteIfEmpty(key: string, state: LockState): void {
    if (!state.active && state.waiters.length === 0 && this.#states.get(key) === state) {
      this.#states.delete(key);
    }
  }
}
