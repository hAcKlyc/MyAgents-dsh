import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { getSystemErrorName } from "node:util";
import { load, errno } from "koffi";
import { SessionAlreadyOwnedError, SessionOwnershipLostError } from "@deepseek-ai/dsh-session-persistence";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { PlatformTarget } from "@myagents-dsh/product-profile";

/** A kernel claim, separate from short SQLite transactions and event serialization. */
export interface ProductSessionOwnership {
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface ProductSessionOwnershipProvider {
  acquire(path: string, id: SessionId, signal?: AbortSignal): Promise<ProductSessionOwnership>;
}

// Windows mutexes are recursive on one thread. Refuse a second local owner
// before calling the kernel; the kernel remains the cross-process authority.
const localClaims = new Set<string>();

const releaseOnce = (work: () => Promise<void>): (() => Promise<void>) => {
  let released: Promise<void> | undefined;
  return () => (released ??= work());
};

const posixProvider = (): ProductSessionOwnershipProvider => {
  const ownerUid = process.getuid?.();
  if (ownerUid === undefined) throw new Error("POSIX Session ownership requires a POSIX user identity");
  const library = load(null);
  const flock = library.func("int flock(int fd, int operation)") as (fd: number, operation: number) => number;
  return {
    async acquire(path, id, signal) {
      signal?.throwIfAborted();
      if (localClaims.has(path)) throw new SessionAlreadyOwnedError(id);
      localClaims.add(path);
      let file: FileHandle | undefined;
      try {
        file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        const identity = await file.stat({ bigint: true });
        if (!identity.isFile() || identity.nlink !== 1n || (identity.mode & 0o077n) !== 0n
          || identity.uid !== BigInt(ownerUid)) {
          throw new Error("Session ownership file has unsafe ownership, mode or link count");
        }
        // LOCK_EX | LOCK_NB: never block the Node thread or expire a live owner.
        if (flock(file.fd, 2 | 4) !== 0) {
          const code = getSystemErrorName(-errno());
          if (code === "EAGAIN" || code === "EWOULDBLOCK") throw new SessionAlreadyOwnedError(id);
          throw new Error(`Session ownership flock failed: ${code}`);
        }
        const held = file;
        let active = true;
        const assertHeld = async (): Promise<void> => {
          const current = await lstat(path, { bigint: true }).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          });
          if (!active || current?.dev !== identity.dev || current.ino !== identity.ino
            || !current.isFile() || current.nlink !== 1n || current.uid !== identity.uid
            || (current.mode & 0o077n) !== 0n) throw new SessionOwnershipLostError(id);
        };
        await assertHeld();
        signal?.throwIfAborted();
        return {
          assertHeld,
          release: releaseOnce(async () => {
            active = false;
            try { await held.close(); } finally { localClaims.delete(path); }
          }),
        };
      } catch (error) {
        try { await file?.close(); } finally { localClaims.delete(path); }
        throw error;
      }
    },
  };
};

const windowsProvider = (): ProductSessionOwnershipProvider => {
  const library = load("kernel32.dll");
  const createMutex = library.func(
    "CreateMutexW", "intptr_t", ["void *", "int", "str16"],
  ) as (security: null, initiallyOwned: number, name: string) => number;
  const wait = library.func(
    "WaitForSingleObject", "uint32", ["intptr_t", "uint32"],
  ) as (handle: number, timeoutMs: number) => number;
  const releaseMutex = library.func("ReleaseMutex", "int", ["intptr_t"]) as (handle: number) => number;
  const closeHandle = library.func("CloseHandle", "int", ["intptr_t"]) as (handle: number) => number;
  const lastError = library.func("GetLastError", "uint32", []) as () => number;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- Keep admission errors asynchronous while all mutex calls stay on this thread.
    async acquire(path, id, signal) {
      signal?.throwIfAborted();
      const key = path.toLowerCase();
      if (localClaims.has(key)) throw new SessionAlreadyOwnedError(id);
      localClaims.add(key);
      let handle = 0;
      let owned = false;
      try {
        const name = `Global\\MyAgentsDshSession_${createHash("sha256").update(key).digest("hex")}`;
        handle = createMutex(null, 0, name);
        if (handle === 0) throw new Error(`Session ownership CreateMutexW failed: ${lastError()}`);
        const result = wait(handle, 0);
        // WAIT_ABANDONED transfers ownership after process/thread death. Stored
        // history still passes the normal SQLite and Session recovery validation.
        if (result === 0x102) throw new SessionAlreadyOwnedError(id);
        if (result !== 0 && result !== 0x80) throw new Error(`Session ownership wait failed: ${lastError()}`);
        owned = true;
        signal?.throwIfAborted();
        let active = true;
        return {
          // eslint-disable-next-line @typescript-eslint/require-await -- The ownership interface reports failures asynchronously.
          assertHeld: async () => {
            if (!active) throw new SessionOwnershipLostError(id);
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- ReleaseMutex must execute synchronously on the acquiring thread.
          release: releaseOnce(async () => {
            active = false;
            const failures: Error[] = [];
            if (releaseMutex(handle) === 0) failures.push(new Error(`Session ownership release failed: ${lastError()}`));
            if (closeHandle(handle) === 0) failures.push(new Error(`Session ownership close failed: ${lastError()}`));
            localClaims.delete(key);
            if (failures.length > 0) throw new AggregateError(failures, "Session ownership release failed");
          }),
        };
      } catch (error) {
        if (owned) releaseMutex(handle);
        if (handle !== 0) closeHandle(handle);
        localClaims.delete(key);
        throw error;
      }
    },
  };
};

/** Select once at trusted Runtime composition; callers supply canonical owned paths. */
export const createProductSessionOwnershipProvider = (target: PlatformTarget): ProductSessionOwnershipProvider =>
  target === "win32-x64" ? windowsProvider() : posixProvider();
