import { Context } from "@deepseek-ai/cordis";
import {
  HostAttachmentStore,
  HostPortService,
  type HostAttachmentIoAuthority,
  type HostAttachmentStoreController,
  type HostPortServiceController,
} from "@myagents-dsh/host-ports";
import { resolveRuntimePlatformTarget, selectPlatformAdapter } from "@myagents-dsh/product-profile";
import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import { createInMemoryPeerPair, StandardTestHost } from "@myagents-dsh/test-host";
import { LocalWorkspaceFileSystem } from "@myagents-dsh/tools-fs";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex");

const stageImage = (data: Uint8Array) => Promise.resolve(Object.freeze({
  discard: () => Promise.resolve(),
  path: "/fixture/staging/normalized-image",
  sha256: createHash("sha256").update(data).digest("hex"),
  sizeBytes: data.byteLength,
}));

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
};

type Harness = Readonly<{
  attachments: HostAttachmentStoreController;
  close(): Promise<void>;
  host: StandardTestHost;
  pair: ReturnType<typeof createInMemoryPeerPair>;
  root: Context;
}>;

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

const createHarness = async (
  io: HostAttachmentIoAuthority,
  overrides: ConstructorParameters<typeof StandardTestHost>[1] = {},
): Promise<Harness> => {
  const pair = createInMemoryPeerPair();
  const root = new Context();
  let hostPorts: HostPortServiceController | undefined;
  let attachments: HostAttachmentStoreController | undefined;
  await root.plugin(HostPortService, {
    registerController: (value) => { hostPorts = value; },
  });
  if (hostPorts === undefined) throw new Error("Host port controller was not registered");
  await root.plugin(HostAttachmentStore, {
    hostPorts: Object.freeze({
      cleanupAttachmentLease: hostPorts.cleanupAttachmentLease,
      createRequestAuthority: hostPorts.createRequestAuthority,
    }),
    io,
    registerController: (value) => { attachments = value; },
  });
  if (attachments === undefined) throw new Error("Host attachment controller was not registered");
  hostPorts.bindTransport(pair.runtime, "runtime-generation-1");
  hostPorts.bindProductSession("product-session-1");
  hostPorts.activate();
  const host = new StandardTestHost(new GeneratedHostClient(pair.host), {
    "host/attachment/put": (params) => ({
      attachmentId: `sha256:${params.sha256}`,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      sha256: params.sha256,
    }),
    ...overrides,
  });
  const harness = Object.freeze({
    attachments,
    close: async () => {
      await root.fiber.dispose();
      host.dispose();
      pair.close();
    },
    host,
    pair,
    root,
  });
  harnesses.push(harness);
  return harness;
};

const requestScope = (harness: Harness, assertCurrent: () => void = () => undefined) =>
  harness.attachments.createRequestScope(Object.freeze({
    assertCurrent,
    deadlineMs: 30_000,
    runtimeSessionId: "runtime-session-1",
    signal: new AbortController().signal,
    stagingRoot: "/fixture/staging",
  }));

describe("HostAttachmentStore", () => {
  it("reports an empty image as invalid before publishing an attachment", async () => {
    const harness = await createHarness(Object.freeze({
      readLease: () => { throw new Error("empty image must not acquire a lease"); },
      stage: () => { throw new Error("empty image must not be published"); },
    }));
    await expect(harness.attachments.runWithRequestScope(requestScope(harness), () =>
      harness.root.attachments.saveImage({ data: new Uint8Array(), mediaType: "image/png" })))
      .rejects.toMatchObject({ code: "INVALID_IMAGE", message: "Image is empty." });
  });

  it("validates before publication and releases every verified read lease", async () => {
    let discarded = 0;
    let reads = 0;
    let publishedBytes: Uint8Array | undefined;
    const releases: string[] = [];
    const harness = await createHarness(Object.freeze({
      readLease: () => {
        reads += 1;
        if (publishedBytes === undefined) throw new Error("normalized image was not staged");
        return Promise.resolve(Uint8Array.from(publishedBytes));
      },
      stage: (_root: string, data: Uint8Array) => {
        publishedBytes = Uint8Array.from(data);
        return Promise.resolve(Object.freeze({
          discard: () => { discarded += 1; return Promise.resolve(); },
          path: "/fixture/staging/put-1",
          sha256: createHash("sha256").update(data).digest("hex"),
          sizeBytes: data.byteLength,
        }));
      },
    }), {
      "host/attachment/put": (params) => {
        const normalizedBytes = publishedBytes;
        if (normalizedBytes === undefined) throw new Error("normalized image bytes were not staged");
        expect(params).toMatchObject({
          mimeType: "image/webp",
          name: "pixel.png",
          stagingPath: "/fixture/staging/put-1",
        });
        expect(params.sha256).toBe(createHash("sha256").update(normalizedBytes).digest("hex"));
        expect(params.sizeBytes).toBe(normalizedBytes.byteLength);
        return {
          attachmentId: `sha256:${params.sha256}`,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
          sha256: params.sha256,
        };
      },
      "host/attachment/acquire": (params) => ({
        leaseId: "lease-1",
        readOnlyPath: "/fixture/staging/lease-1",
        mimeType: params.expectedMimeType,
        sizeBytes: params.expectedSizeBytes,
        sha256: params.expectedSha256,
      }),
      "host/attachment/release": (params) => {
        releases.push(params.leaseId);
        return { ok: true };
      },
    });
    harness.attachments.bindLeaseLimit(2);
    const scope = requestScope(harness);
    const ref = await harness.attachments.runWithRequestScope(scope, () =>
      harness.root.attachments.saveImage({
        data: PNG,
        mediaType: "image/png",
        name: "/private/local/pixel.png",
      }));
    expect(ref).toMatchObject({
      mediaType: "image/webp",
      width: 1,
      height: 1,
      name: "pixel.png",
    });
    const normalizedBytes = publishedBytes;
    if (normalizedBytes === undefined) throw new Error("normalized image bytes were not published");
    expect(ref.attachmentId).toBe(`sha256:${createHash("sha256").update(normalizedBytes).digest("hex")}`);
    expect(ref.bytes).toBe(normalizedBytes.byteLength);
    const stored = await harness.attachments.runWithRequestScope(scope, () =>
      harness.root.attachments.readImage(ref));
    expect(stored.ref).toEqual(ref);
    expect(stored.data).toEqual(publishedBytes);
    expect({ discarded, reads, releases }).toEqual({ discarded: 1, reads: 1, releases: ["lease-1"] });
  });

  it("strips Host-local path information from input image display names", async () => {
    const releases: string[] = [];
    const harness = await createHarness(Object.freeze({
      readLease: () => Promise.resolve(Uint8Array.from(PNG)),
      stage: (_root: string, data: Uint8Array) => stageImage(data),
    }), {
      "host/attachment/acquire": (params) => ({
        leaseId: "lease-sanitized-name",
        readOnlyPath: "/fixture/staging/lease-sanitized-name",
        mimeType: params.expectedMimeType,
        sizeBytes: params.expectedSizeBytes,
        sha256: params.expectedSha256,
      }),
      "host/attachment/release": (params) => {
        releases.push(params.leaseId);
        return { ok: true };
      },
    });
    harness.attachments.bindLeaseLimit(1);
    const scope = requestScope(harness);
    await expect(harness.attachments.resolveInputImage(scope, Object.freeze({
      attachmentId: `sha256:${PNG_SHA256}`,
      mediaType: "image/png",
      name: "C:\\Users\\private-user\\pixel.png",
      sha256: PNG_SHA256,
      sizeBytes: PNG.byteLength,
    }))).resolves.toMatchObject({ name: "pixel.png" });
    expect(releases).toEqual(["lease-sanitized-name"]);
  });

  it("cleans malformed staging results without publishing anything", async () => {
    let discarded = 0;
    let puts = 0;
    const harness = await createHarness(Object.freeze({
      readLease: () => Promise.resolve(Uint8Array.from(PNG)),
      stage: () => Promise.resolve(Object.freeze({
        discard: () => { discarded += 1; return Promise.resolve(); },
        sha256: PNG_SHA256,
        sizeBytes: PNG.byteLength,
      }) as never),
    }), {
      "host/attachment/put": () => {
        puts += 1;
        throw new Error("put must not run");
      },
    });
    const scope = requestScope(harness);
    await expect(harness.attachments.publish(scope, Object.freeze({
      bytes: PNG,
      mediaType: "image/png",
      name: "pixel.png",
    }))).rejects.toThrow(/missing path/u);
    expect({ discarded, puts }).toEqual({ discarded: 1, puts: 0 });
  });

  it("bounds concurrent leases and releases corrupt Host bytes", async () => {
    const firstAcquire = deferred<Readonly<{
      leaseId: string;
      readOnlyPath: string;
      mimeType: "image/png";
      sizeBytes: number;
      sha256: string;
    }>>();
    let acquireHits = 0;
    const releases: string[] = [];
    const harness = await createHarness(Object.freeze({
      readLease: () => {
        const corrupted = Uint8Array.from(PNG);
        corrupted.set([(corrupted.at(-1) ?? 0) ^ 1], corrupted.length - 1);
        return Promise.resolve(corrupted);
      },
      stage: (_root: string, data: Uint8Array) => stageImage(data),
    }), {
      "host/attachment/acquire": () => {
        acquireHits += 1;
        return firstAcquire.promise;
      },
      "host/attachment/release": (params) => {
        releases.push(params.leaseId);
        return { ok: true };
      },
    });
    harness.attachments.bindLeaseLimit(1);
    const scope = requestScope(harness);
    const input = Object.freeze({
      attachmentId: `sha256:${PNG_SHA256}`,
      mediaType: "image/png" as const,
      name: "pixel.png",
      sha256: PNG_SHA256,
      sizeBytes: PNG.byteLength,
    });
    const first = harness.attachments.resolveInputImage(scope, input);
    await Promise.resolve();
    await expect(harness.attachments.resolveInputImage(scope, input)).rejects.toMatchObject({
      code: "ATTACHMENT_LEASE_LIMIT",
    });
    firstAcquire.resolve(Object.freeze({
      leaseId: "lease-corrupt",
      readOnlyPath: "/fixture/staging/lease-corrupt",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
      sha256: PNG_SHA256,
    }));
    await expect(first).rejects.toMatchObject({ code: "ATTACHMENT_CORRUPT" });
    expect({ acquireHits, releases }).toEqual({ acquireHits: 1, releases: ["lease-corrupt"] });
  });

  it("admits exactly the configured number of concurrent live leases", async () => {
    const reads = [deferred<Uint8Array>(), deferred<Uint8Array>()];
    const bothReads = deferred<undefined>();
    let acquireHits = 0;
    let readHits = 0;
    const releases: string[] = [];
    const harness = await createHarness(Object.freeze({
      readLease: () => {
        const pending = reads[readHits];
        readHits += 1;
        if (pending === undefined) throw new Error("unexpected third lease read");
        if (readHits === 2) bothReads.resolve(undefined);
        return pending.promise;
      },
      stage: (_root: string, data: Uint8Array) => stageImage(data),
    }), {
      "host/attachment/acquire": (params) => {
        acquireHits += 1;
        return {
          leaseId: `lease-concurrent-${acquireHits}`,
          readOnlyPath: `/fixture/staging/lease-concurrent-${acquireHits}`,
          mimeType: params.expectedMimeType,
          sizeBytes: params.expectedSizeBytes,
          sha256: params.expectedSha256,
        };
      },
      "host/attachment/release": (params) => {
        releases.push(params.leaseId);
        return { ok: true };
      },
    });
    harness.attachments.bindLeaseLimit(2);
    const scope = requestScope(harness);
    const input = Object.freeze({
      attachmentId: `sha256:${PNG_SHA256}`,
      mediaType: "image/png" as const,
      name: "pixel.png",
      sha256: PNG_SHA256,
      sizeBytes: PNG.byteLength,
    });
    const first = harness.attachments.resolveInputImage(scope, input);
    const second = harness.attachments.resolveInputImage(scope, input);
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    try {
      await bothReads.promise;
      await expect(harness.attachments.resolveInputImage(scope, input)).rejects.toMatchObject({
        code: "ATTACHMENT_LEASE_LIMIT",
      });
      expect({ acquireHits, readHits }).toEqual({ acquireHits: 2, readHits: 2 });
    } finally {
      reads[0]?.resolve(Uint8Array.from(PNG));
      reads[1]?.resolve(Uint8Array.from(PNG));
    }
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(releases.toSorted()).toEqual(["lease-concurrent-1", "lease-concurrent-2"]);
  });

  it("rejects forged references before crossing the Host boundary", async () => {
    let acquires = 0;
    const harness = await createHarness(Object.freeze({
      readLease: () => Promise.resolve(Uint8Array.from(PNG)),
      stage: () => Promise.reject(new Error("unused")),
    }), {
      "host/attachment/acquire": () => {
        acquires += 1;
        throw new Error("acquire must not run");
      },
    });
    const scope = requestScope(harness);
    expect(() => harness.attachments.resolveInputImage(scope, {
      attachmentId: `sha256:${"b".repeat(64)}`,
      mediaType: "image/png",
      name: "pixel.png",
      sha256: PNG_SHA256,
      sizeBytes: PNG.byteLength,
    })).toThrow(expect.objectContaining({ code: "INVALID_ATTACHMENT_REF" }));
    expect(acquires).toBe(0);
  });

  it("rejects a proxy lease reader promise without executing its traps and still releases the lease", async () => {
    let proxyTraps = 0;
    const releases: string[] = [];
    const proxiedPromise = new Proxy(Promise.resolve(Uint8Array.from(PNG)), {
      get: () => {
        proxyTraps += 1;
        throw new Error("proxy lease promise trap must not execute");
      },
    });
    const harness = await createHarness(Object.freeze({
      readLease: () => proxiedPromise,
      stage: () => Promise.reject(new Error("unused")),
    }), {
      "host/attachment/acquire": (params) => ({
        leaseId: "lease-proxy-promise",
        readOnlyPath: "/fixture/staging/lease-proxy-promise",
        mimeType: params.expectedMimeType,
        sizeBytes: params.expectedSizeBytes,
        sha256: params.expectedSha256,
      }),
      "host/attachment/release": (params) => {
        releases.push(params.leaseId);
        return { ok: true };
      },
    });
    harness.attachments.bindLeaseLimit(1);
    const scope = requestScope(harness);
    await expect(harness.attachments.resolveInputImage(scope, Object.freeze({
      attachmentId: `sha256:${PNG_SHA256}`,
      mediaType: "image/png",
      name: "pixel.png",
      sha256: PNG_SHA256,
      sizeBytes: PNG.byteLength,
    }))).rejects.toThrow("Host attachment lease reader must return a native Promise");
    expect({ proxyTraps, releases }).toEqual({
      proxyTraps: 0,
      releases: ["lease-proxy-promise"],
    });
  });

  it("retries one failed lease release during generation-owned shutdown", async () => {
    let releaseHits = 0;
    const harness = await createHarness(Object.freeze({
      readLease: () => Promise.resolve(Uint8Array.from(PNG)),
      stage: (_root: string, data: Uint8Array) => stageImage(data),
    }), {
      "host/attachment/acquire": (params) => ({
        leaseId: "lease-retry",
        readOnlyPath: "/fixture/staging/lease-retry",
        mimeType: params.expectedMimeType,
        sizeBytes: params.expectedSizeBytes,
        sha256: params.expectedSha256,
      }),
      "host/attachment/release": () => {
        releaseHits += 1;
        if (releaseHits === 1) throw new Error("synthetic first release failure");
        return { ok: true };
      },
    });
    harness.attachments.bindLeaseLimit(1);
    const scope = requestScope(harness);
    await expect(harness.attachments.resolveInputImage(scope, Object.freeze({
      attachmentId: `sha256:${PNG_SHA256}`,
      mediaType: "image/png",
      name: "pixel.png",
      sha256: PNG_SHA256,
      sizeBytes: PNG.byteLength,
    }))).rejects.toMatchObject({ code: "host_attachment_release_failed" });
    expect(releaseHits).toBe(1);
    await expect(harness.root.fiber.dispose()).resolves.toBeUndefined();
    expect(releaseHits).toBe(2);
  });
});

describe("Local attachment staging authority", () => {
  it("creates singly-linked private staging files and removes only the exact inode", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "myagents-attachment-io-")));
    const stagingRoot = join(temporary, "staging");
    await mkdir(stagingRoot);
    const context = new Context();
    try {
      context.provide("sandboxPolicy", { defaultMode: "danger-full-access", resolve: () => ({ mode: "danger-full-access", workspaceRoot: process.cwd() }) } as never);
      await context.plugin(LocalWorkspaceFileSystem, { platform: selectPlatformAdapter(resolveRuntimePlatformTarget(process.platform, process.arch)) });
      const io = (context.fs as LocalWorkspaceFileSystem).createAttachmentIoAuthority();
      const staged = await io.stage(stagingRoot, PNG, new AbortController().signal);
      const info = await stat(staged.path);
      expect({
        bytes: await readFile(staged.path),
        nlink: info.nlink,
        sha256: staged.sha256,
        sizeBytes: staged.sizeBytes,
      }).toEqual({
        bytes: Buffer.from(PNG),
        nlink: 1,
        sha256: PNG_SHA256,
        sizeBytes: PNG.byteLength,
      });
      if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);
      await staged.discard();
      await staged.discard();
      await expect(stat(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await context.fiber.dispose();
      await rm(temporary, { force: true, recursive: true });
    }
  });

  it("reads only bounded read-only files under the unchanged staging root", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "myagents-attachment-read-")));
    const stagingRoot = join(temporary, "staging");
    await mkdir(stagingRoot);
    const context = new Context();
    try {
      context.provide("sandboxPolicy", { defaultMode: "danger-full-access", resolve: () => ({ mode: "danger-full-access", workspaceRoot: process.cwd() }) } as never);
      await context.plugin(LocalWorkspaceFileSystem, { platform: selectPlatformAdapter(resolveRuntimePlatformTarget(process.platform, process.arch)) });
      const io = (context.fs as LocalWorkspaceFileSystem).createAttachmentIoAuthority();
      const valid = join(stagingRoot, "valid.png");
      await writeFile(valid, PNG, { mode: 0o400 });
      await chmod(valid, 0o400);
      await expect(io.readLease(stagingRoot, valid, PNG.byteLength, new AbortController().signal))
        .resolves.toEqual(PNG);

      const outside = join(temporary, "outside.png");
      await writeFile(outside, PNG, { mode: 0o400 });
      await chmod(outside, 0o400);
      await expect(io.readLease(stagingRoot, outside, PNG.byteLength, new AbortController().signal))
        .rejects.toMatchObject({ code: "FS_SANDBOX_DENIED" });

      const writable = join(stagingRoot, "writable.png");
      await writeFile(writable, PNG, { mode: 0o600 });
      if (process.platform !== "win32") {
        await expect(io.readLease(stagingRoot, writable, PNG.byteLength, new AbortController().signal))
          .rejects.toMatchObject({ code: "FS_PERMISSION_DENIED" });
      }

      const hardlink = join(stagingRoot, "hardlink.png");
      await link(outside, hardlink);
      await expect(io.readLease(stagingRoot, hardlink, PNG.byteLength, new AbortController().signal))
        .rejects.toMatchObject({ code: "FS_NOT_REGULAR_FILE" });

      if (process.platform !== "win32") {
        const symbolic = join(stagingRoot, "symbolic.png");
        await symlink(outside, symbolic);
        await expect(io.readLease(stagingRoot, symbolic, PNG.byteLength, new AbortController().signal))
          .rejects.toMatchObject({ code: "FS_NOT_REGULAR_FILE" });
      }

      const previousRoot = join(temporary, "previous-staging");
      await rename(stagingRoot, previousRoot);
      await mkdir(stagingRoot);
      const substituted = join(stagingRoot, "substituted.png");
      await writeFile(substituted, PNG, { mode: 0o400 });
      await chmod(substituted, 0o400);
      await expect(io.readLease(stagingRoot, substituted, PNG.byteLength, new AbortController().signal))
        .rejects.toMatchObject({ code: "FS_STALE_VERSION" });
    } finally {
      await context.fiber.dispose();
      await rm(temporary, { force: true, recursive: true });
    }
  });
});
