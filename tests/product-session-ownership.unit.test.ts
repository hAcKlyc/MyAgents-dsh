import { chmod, link, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SessionAlreadyOwnedError, SessionOwnershipLostError } from "@deepseek-ai/dsh-session-persistence";
import { resolveRuntimePlatformTarget } from "../packages/product-profile/src/platform-contract.js";
import {
  createProductSessionOwnershipProvider,
  type ProductSessionOwnership,
} from "../packages/persistence-product/src/session-ownership.js";

const target = resolveRuntimePlatformTarget(process.platform, process.arch);
const roots: string[] = [];
const held: ProductSessionOwnership[] = [];
const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "myagents-session-ownership-"));
  roots.push(root);
  return join(root, "session.lock");
};
afterEach(async () => {
  await Promise.all(held.splice(0).map((lease) => lease.release()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Session write ownership", () => {
  it("excludes a second Provider instance and permits ownership only after release", async () => {
    const path = await fixture();
    const id = SessionId("shared");
    const first = createProductSessionOwnershipProvider(target);
    const second = createProductSessionOwnershipProvider(target);
    const owner = await first.acquire(path, id);
    held.push(owner);
    await expect(second.acquire(path, id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    await owner.assertHeld();
    await Promise.all([owner.release(), owner.release()]);
    await expect(owner.assertHeld()).rejects.toBeInstanceOf(SessionOwnershipLostError);
    const successor = await second.acquire(path, id);
    held.push(successor);
    await successor.assertHeld();
  });

  it("refuses pre-aborted admission without reserving the identity", async () => {
    const path = await fixture();
    const id = SessionId("cancelled");
    const provider = createProductSessionOwnershipProvider(target);
    const failure = new Error("synthetic caller cancellation");
    await expect(provider.acquire(path, id, AbortSignal.abort(failure))).rejects.toBe(failure);
    held.push(await provider.acquire(path, id));
  });

  it("does not serialize unrelated Session identities", async () => {
    const path = await fixture();
    const provider = createProductSessionOwnershipProvider(target);
    const owners = await Promise.all([
      provider.acquire(path, SessionId("first")),
      provider.acquire(`${path}.second`, SessionId("second")),
    ]);
    held.push(...owners);
    await Promise.all(owners.map((owner) => owner.assertHeld()));
  });
});

describe.skipIf(target === "win32-x64")("POSIX ownership inode safety", () => {
  it("releases an admission cancelled while the lock file opens", async () => {
    const path = await fixture();
    const provider = createProductSessionOwnershipProvider(target);
    const controller = new AbortController();
    const pending = provider.acquire(path, SessionId("cancel-opening"), controller.signal);
    controller.abort(new Error("cancel while opening"));
    await expect(pending).rejects.toThrow("cancel while opening");
    held.push(await provider.acquire(path, SessionId("cancel-opening")));
  });

  it("refuses a replaced lock inode before the owner may write again", async () => {
    const path = await fixture();
    const owner = await createProductSessionOwnershipProvider(target).acquire(path, SessionId("replaced"));
    held.push(owner);
    await rename(path, `${path}.original`);
    await writeFile(path, "", { mode: 0o600 });
    await expect(owner.assertHeld()).rejects.toBeInstanceOf(SessionOwnershipLostError);
  });

  it("refuses symlink and hardlink lock aliases", async () => {
    const path = await fixture();
    await writeFile(`${path}.target`, "unchanged", { mode: 0o600 });
    await symlink(`${path}.target`, path);
    const provider = createProductSessionOwnershipProvider(target);
    await expect(provider.acquire(path, SessionId("symlink"))).rejects.toThrow();
    await rm(path);
    await link(`${path}.target`, path);
    await expect(provider.acquire(path, SessionId("hardlink"))).rejects.toThrow("unsafe ownership");
  });

  it("refuses a group-readable lock without changing its permissions", async () => {
    const path = await fixture();
    await writeFile(path, "", { mode: 0o600 });
    await chmod(path, 0o640);
    await expect(createProductSessionOwnershipProvider(target).acquire(path, SessionId("mode")))
      .rejects.toThrow("unsafe ownership");
  });
});
