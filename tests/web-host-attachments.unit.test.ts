import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { supportsFileSymlinks } from "./setup/symlink-capability.js";

import { HostAttachmentStore, HostEventHub } from "@myagents-dsh/web-host";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const authority = {
  requestId: "request-1",
  runtimeGeneration: "generation-1",
  productSessionId: "product-session-1",
  runtimeSessionId: "runtime-session-1",
  deadlineMs: 30_000,
} as const;

describe("Reference Web Host attachment owner", () => {
  it("stages, leases, verifies, releases, and deletes browser upload bytes", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "myagents-web-attachment-"));
    roots.push(parent);
    const store = await HostAttachmentStore.open({
      root: resolve(parent, "owned"),
      runtimeStagingRoot: resolve(parent, "runtime"),
      webSessionId: "web-session-1",
      eventHub: new HostEventHub(),
      maxUploadBytes: 128,
      maxTotalBytes: 256,
      maxLeases: 2,
    });
    const bytes = Buffer.from("hello");
    const summary = await store.putUpload({
      name: "hello.txt",
      mimeType: "text/plain",
      bytes,
      expectedSha256: sha256(bytes),
    });
    await expect(store.readPreview(summary.attachmentId)).resolves.toMatchObject({ bytes });
    const lease = await store.acquire({
      authority,
      attachmentId: summary.attachmentId,
      expectedMimeType: summary.mimeType,
      expectedSizeBytes: summary.sizeBytes,
      expectedSha256: summary.sha256,
    });
    await expect(store.releaseAttachment(summary.attachmentId)).rejects.toThrow(/still leased/u);
    await expect(store.release({ authority, leaseId: lease.leaseId })).resolves.toEqual({ ok: true });
    await store.releaseAttachment(summary.attachmentId);
    await expect(store.readPreview(summary.attachmentId)).rejects.toThrow(/unknown/u);
    await store.close();
  });

  it.skipIf(!supportsFileSymlinks)("ingests only exact regular Runtime staging bytes and rejects aliases", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "myagents-web-produced-"));
    roots.push(parent);
    const runtime = resolve(parent, "runtime");
    const store = await HostAttachmentStore.open({
      root: resolve(parent, "owned"),
      runtimeStagingRoot: runtime,
      webSessionId: "web-session-1",
      eventHub: new HostEventHub(),
    });
    const bytes = Buffer.from("produced");
    const path = resolve(runtime, "produced.txt");
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(store.put({
      authority,
      name: "produced.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      stagingPath: path,
    })).resolves.toMatchObject({ sizeBytes: bytes.byteLength, sha256: sha256(bytes) });

    const alias = resolve(runtime, "alias.txt");
    await symlink(path, alias);
    await expect(store.put({
      authority: { ...authority, requestId: "request-2" },
      name: "alias.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      stagingPath: alias,
    })).rejects.toMatchObject({ code: "host_attachment_path_denied" });
    await store.close();
  });

  it("enforces per-upload, total-byte, and declared-digest bounds", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "myagents-web-attachment-bounds-"));
    roots.push(parent);
    const store = await HostAttachmentStore.open({
      root: resolve(parent, "owned"),
      runtimeStagingRoot: resolve(parent, "runtime"),
      webSessionId: "web-session-1",
      eventHub: new HostEventHub(),
      maxUploadBytes: 4,
      maxTotalBytes: 5,
    });
    await expect(store.putUpload({
      name: "large.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("12345"),
    })).rejects.toThrow(/upload exceeds/u);
    await expect(store.putUpload({
      name: "bad.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("12"),
      expectedSha256: "a".repeat(64),
    })).rejects.toThrow(/digest differs/u);
    await store.putUpload({ name: "first.txt", mimeType: "text/plain", bytes: Buffer.from("1234") });
    await expect(store.putUpload({
      name: "second.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("12"),
    })).rejects.toThrow(/total byte/u);
    await store.close();
  });
});
