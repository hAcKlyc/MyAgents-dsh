import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { readRegularFileNoFollow } from "@myagents-dsh/artifact-verifier";
import { ProtocolError, type MethodParams, type MethodResult } from "@myagents-dsh/protocol";
import type { AttachmentSummary } from "@myagents-dsh/web-host-contract";

import type { HostEventHub } from "./event-hub.js";
import { WebHostError } from "./errors.js";
import type { AttachmentPorts } from "./reverse-ports.js";

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1_048_576;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1_048_576;
export const DEFAULT_MAX_ATTACHMENT_LEASES = 128;

type AttachmentRecord = Readonly<{
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  path: string;
  state: "staged" | "leased";
}>;
type LeaseRecord = Readonly<{ leaseId: string; attachmentId: string }>;

export type AttachmentStoreOptions = Readonly<{
  root: string;
  runtimeStagingRoot: string;
  webSessionId: string;
  eventHub: HostEventHub;
  maxUploadBytes?: number;
  maxTotalBytes?: number;
  maxLeases?: number;
}>;

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const boundedText = (value: string, name: string, maximum: number): string => {
  if (value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new WebHostError("attachment_metadata_invalid", `${name} is invalid`);
  }
  return value;
};
const exactDigest = (value: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new WebHostError("attachment_digest_invalid", "Attachment digest is invalid");
  return value;
};
const contained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const toSummary = (record: AttachmentRecord, state: AttachmentSummary["state"] = record.state): AttachmentSummary => Object.freeze({
  attachmentId: record.attachmentId,
  name: record.name,
  mimeType: record.mimeType,
  sizeBytes: record.sizeBytes,
  sha256: record.sha256,
  state,
});

export class HostAttachmentStore implements AttachmentPorts {
  readonly #root: string;
  readonly #runtimeStagingRoot: string;
  readonly #runtimeStagingLexicalRoot: string;
  readonly #webSessionId: string;
  readonly #eventHub: HostEventHub;
  readonly #maxUploadBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxLeases: number;
  readonly #records = new Map<string, AttachmentRecord>();
  readonly #leases = new Map<string, LeaseRecord>();
  #totalBytes = 0;
  #closed = false;

  private constructor(
    options: AttachmentStoreOptions,
    root: string,
    runtimeStagingRoot: string,
    runtimeStagingLexicalRoot: string,
  ) {
    this.#root = root;
    this.#runtimeStagingRoot = runtimeStagingRoot;
    this.#runtimeStagingLexicalRoot = runtimeStagingLexicalRoot;
    this.#webSessionId = options.webSessionId;
    this.#eventHub = options.eventHub;
    this.#maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.#maxLeases = options.maxLeases ?? DEFAULT_MAX_ATTACHMENT_LEASES;
    if (!Number.isSafeInteger(this.#maxUploadBytes) || this.#maxUploadBytes < 1
      || !Number.isSafeInteger(this.#maxTotalBytes) || this.#maxTotalBytes < this.#maxUploadBytes
      || !Number.isSafeInteger(this.#maxLeases) || this.#maxLeases < 1 || this.#maxLeases > 1_024) {
      throw new TypeError("Attachment store bounds are invalid");
    }
  }

  static async open(options: AttachmentStoreOptions): Promise<HostAttachmentStore> {
    await Promise.all([
      mkdir(resolve(options.root), { recursive: true, mode: 0o700 }),
      mkdir(resolve(options.runtimeStagingRoot), { recursive: true, mode: 0o700 }),
    ]);
    const [root, runtimeStagingRoot] = await Promise.all([
      realpath(resolve(options.root)),
      realpath(resolve(options.runtimeStagingRoot)),
    ]);
    return new HostAttachmentStore(options, root, runtimeStagingRoot, resolve(options.runtimeStagingRoot));
  }

  list(): readonly AttachmentSummary[] {
    return Object.freeze([...this.#records.values()].map((record) => toSummary(record)));
  }

  async putUpload(input: Readonly<{
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    expectedSha256?: string;
  }>): Promise<AttachmentSummary> {
    this.#assertOpen();
    if (input.bytes.byteLength > this.#maxUploadBytes) {
      throw new WebHostError("attachment_upload_limit", "Attachment upload exceeds its byte limit");
    }
    const sha256 = digest(input.bytes);
    if (input.expectedSha256 !== undefined && exactDigest(input.expectedSha256) !== sha256) {
      throw new WebHostError("attachment_digest_mismatch", "Attachment upload digest differs");
    }
    return this.#store({
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.bytes,
      sha256,
    });
  }

  async put(params: MethodParams<"host/attachment/put">): Promise<MethodResult<"host/attachment/put">> {
    this.#assertOpen();
    const lexicalPath = resolve(params.stagingPath);
    if (!contained(this.#runtimeStagingLexicalRoot, lexicalPath)) {
      throw new ProtocolError("host_attachment_path_denied", "Runtime attachment path escapes its staging root");
    }
    const lexicalEntry = await lstat(lexicalPath).catch(() => undefined);
    if (lexicalEntry?.isSymbolicLink() === true) {
      throw new ProtocolError("host_attachment_path_denied", "Runtime attachment path must not be an alias");
    }
    if (lexicalEntry?.isFile() !== true) {
      throw new ProtocolError("host_attachment_unavailable", "Runtime attachment is not a regular file", true);
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch (error) {
      throw new ProtocolError("host_attachment_unavailable", "Runtime attachment is unavailable", true, { cause: error });
    }
    if (!contained(this.#runtimeStagingRoot, canonicalPath)) {
      throw new ProtocolError("host_attachment_path_denied", "Runtime attachment resolves outside its staging root");
    }
    const bytes = await readRegularFileNoFollow(canonicalPath);
    if (bytes.byteLength !== params.sizeBytes || digest(bytes) !== params.sha256) {
      throw new ProtocolError("host_attachment_digest_mismatch", "Runtime attachment bytes differ from metadata");
    }
    const summary = await this.#store({
      name: params.name,
      mimeType: params.mimeType,
      bytes,
      sha256: params.sha256,
    });
    return {
      attachmentId: summary.attachmentId,
      mimeType: summary.mimeType,
      sizeBytes: summary.sizeBytes,
      sha256: summary.sha256,
    };
  }

  acquire(params: MethodParams<"host/attachment/acquire">): Promise<MethodResult<"host/attachment/acquire">> {
    this.#assertOpen();
    const record = this.#records.get(params.attachmentId);
    if (record?.mimeType !== params.expectedMimeType
      || record.sizeBytes !== params.expectedSizeBytes || record.sha256 !== params.expectedSha256) {
      throw new ProtocolError("host_attachment_unavailable", "Attachment identity or metadata is unavailable", true);
    }
    if (this.#leases.size >= this.#maxLeases) {
      throw new ProtocolError("host_attachment_overloaded", "Attachment lease limit reached", true);
    }
    const leaseId = randomUUID();
    this.#leases.set(leaseId, Object.freeze({ leaseId, attachmentId: record.attachmentId }));
    const leased = Object.freeze({ ...record, state: "leased" as const });
    this.#records.set(record.attachmentId, leased);
    this.#publish(leased);
    return Promise.resolve(Object.freeze({
      leaseId,
      readOnlyPath: record.path,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
    }));
  }

  release(params: MethodParams<"host/attachment/release">): Promise<MethodResult<"host/attachment/release">> {
    this.#assertOpen();
    const lease = this.#leases.get(params.leaseId);
    if (lease === undefined) throw new ProtocolError("host_attachment_lease_unknown", "Attachment lease is unknown", true);
    this.#leases.delete(params.leaseId);
    const record = this.#records.get(lease.attachmentId);
    if (record !== undefined && ![...this.#leases.values()].some(({ attachmentId }) => attachmentId === record.attachmentId)) {
      const staged = Object.freeze({ ...record, state: "staged" as const });
      this.#records.set(record.attachmentId, staged);
      this.#publish(staged);
    }
    return Promise.resolve({ ok: true });
  }

  async readPreview(attachmentId: string): Promise<Readonly<{ summary: AttachmentSummary; bytes: Buffer }>> {
    this.#assertOpen();
    const record = this.#records.get(attachmentId);
    if (record === undefined) throw new WebHostError("attachment_unknown", "Attachment is unknown");
    const bytes = await readRegularFileNoFollow(record.path);
    if (bytes.byteLength !== record.sizeBytes || digest(bytes) !== record.sha256) {
      throw new WebHostError("attachment_digest_mismatch", "Stored attachment integrity failed");
    }
    return Object.freeze({ summary: toSummary(record), bytes });
  }

  async releaseAttachment(attachmentId: string): Promise<void> {
    this.#assertOpen();
    const record = this.#records.get(attachmentId);
    if (record === undefined) throw new WebHostError("attachment_unknown", "Attachment is unknown");
    if ([...this.#leases.values()].some((lease) => lease.attachmentId === attachmentId)) {
      throw new WebHostError("attachment_leased", "Attachment is still leased", true);
    }
    this.#records.delete(attachmentId);
    this.#totalBytes -= record.sizeBytes;
    await rm(record.path, { force: true });
    this.#publish(record, "released");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#leases.clear();
    this.#records.clear();
    this.#totalBytes = 0;
    await rm(this.#root, { force: true, recursive: true });
  }

  async #store(input: Readonly<{
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    sha256: string;
  }>): Promise<AttachmentSummary> {
    const name = boundedText(input.name, "Attachment name", 512);
    const mimeType = boundedText(input.mimeType, "Attachment MIME type", 256);
    const sha256 = exactDigest(input.sha256);
    if (this.#totalBytes + input.bytes.byteLength > this.#maxTotalBytes) {
      throw new WebHostError("attachment_total_limit", "Attachment store exceeds its total byte limit");
    }
    const attachmentId = randomUUID();
    const path = resolve(this.#root, attachmentId);
    const temporary = resolve(this.#root, `.${attachmentId}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
      await handle.close();
      await rename(temporary, path);
      await chmod(path, 0o400);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    const record = Object.freeze({
      attachmentId,
      name,
      mimeType,
      sizeBytes: input.bytes.byteLength,
      sha256,
      path,
      state: "staged" as const,
    });
    this.#records.set(attachmentId, record);
    this.#totalBytes += record.sizeBytes;
    const summary = toSummary(record);
    this.#publish(record);
    return summary;
  }

  #publish(record: AttachmentRecord, state?: AttachmentSummary["state"]): void {
    this.#eventHub.publish({
      kind: "host.attachmentChanged",
      payload: { webSessionId: this.#webSessionId, attachment: toSummary(record, state) },
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new WebHostError("attachment_store_closed", "Attachment store is closed");
  }
}
