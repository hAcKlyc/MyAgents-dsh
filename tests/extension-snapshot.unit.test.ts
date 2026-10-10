import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { extensionSnapshotDigest } from '@myagents-dsh/protocol';
import type { HostPortService, HostPortServiceController, HostPortRequestAuthority } from '@myagents-dsh/host-ports';
import { resolveExtensionSnapshot } from '../packages/runtime-product/src/extension-snapshot.js';

function fixture() {
  const document = '技能\\正文\n'.repeat(150_000);
  const authority = { formatVersion: 1 as const, revision: 'large-snapshot', components: [],
    resources: [{ id: 'large-skill', kind: 'skill_document' as const, mediaType: 'text/markdown' as const,
      sha256: createHash('sha256').update(document).digest('hex'), content: document }],
    skillSourcePolicy: { revision: 'skills', roots: [] } };
  const snapshot = { ...authority, digest: extensionSnapshotDigest(authority) };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const reference = { attachmentId: 'large-snapshot', mimeType: 'application/json' as const,
    sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const requestAuthority = {} as HostPortRequestAuthority;
  const acquireAttachment = vi.fn(() => Promise.resolve({ leaseId: 'lease', readOnlyPath: '/staging/object',
    mimeType: reference.mimeType, sizeBytes: reference.sizeBytes, sha256: reference.sha256 }));
  const cleanupAttachmentLease = vi.fn(() => Promise.resolve());
  const input = { params: { snapshotAttachment: reference }, signal: new AbortController().signal,
    stagingRoot: '/staging', ports: { acquireAttachment } as unknown as HostPortService,
    controller: { createRequestAuthority: vi.fn(() => requestAuthority), cleanupAttachmentLease } as unknown as HostPortServiceController,
    io: { readLease: vi.fn(() => Promise.resolve(bytes)), stage: vi.fn() } };
  return { input, snapshot, bytes, acquireAttachment, cleanupAttachmentLease };
}

describe('extension snapshot attachment transport', () => {
  it('resolves a snapshot larger than a frame without changing its declarative identity', async () => {
    const f = fixture();
    expect(f.bytes.length).toBeGreaterThan(1_048_576);
    expect(JSON.stringify(f.input.params).length).toBeLessThan(1_024);
    await expect(resolveExtensionSnapshot(f.input)).resolves.toEqual(f.snapshot);
    expect(f.cleanupAttachmentLease).toHaveBeenCalledOnce();
    expect(f.input.io.readLease).toHaveBeenCalledWith('/staging', '/staging/object', f.bytes.length, f.input.signal);
  });

  it.each(['size', 'digest', 'schema', 'cancelled'] as const)('rejects %s before admission and releases its lease', async failure => {
    const f = fixture();
    if (failure === 'size') f.input.params.snapshotAttachment.sizeBytes++;
    if (failure === 'digest') f.input.params.snapshotAttachment.sha256 = '0'.repeat(64);
    if (failure === 'schema') {
      const bytes = Buffer.from('{}');
      f.input.params.snapshotAttachment.sizeBytes = bytes.length;
      f.input.params.snapshotAttachment.sha256 = createHash('sha256').update(bytes).digest('hex');
      f.input.io.readLease.mockResolvedValue(bytes);
    }
    if (failure === 'cancelled') f.input.signal = AbortSignal.abort();
    await expect(resolveExtensionSnapshot(f.input)).rejects.toThrow();
    expect(f.cleanupAttachmentLease).toHaveBeenCalledOnce();
  });

  it('keeps inline snapshots on the same component validation path', async () => {
    const f = fixture();
    await expect(resolveExtensionSnapshot({ ...f.input, params: f.snapshot })).resolves.toEqual(f.snapshot);
    expect(f.acquireAttachment).not.toHaveBeenCalled();
  });
});
