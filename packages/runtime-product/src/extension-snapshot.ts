import { createHash } from 'node:crypto';
import { ProtocolError, type MethodParams } from '@myagents-dsh/protocol';
import { validateExtensionSnapshot, type ExtensionSnapshot } from '@myagents-dsh/component-runtime';
import type { HostAttachmentIoAuthority, HostPortService, HostPortServiceController } from '@myagents-dsh/host-ports';

/** Resolve transport bytes before entering the existing atomic component owner. */
export async function resolveExtensionSnapshot(input: {
  params: MethodParams<'extension/replace'>;
  signal: AbortSignal;
  stagingRoot: string;
  ports: HostPortService;
  controller: HostPortServiceController;
  io: HostAttachmentIoAuthority;
}): Promise<ExtensionSnapshot> {
  if (!('snapshotAttachment' in input.params)) return validateExtensionSnapshot(input.params);
  const reference = input.params.snapshotAttachment;
  const authority = input.controller.createRequestAuthority({
    assertCurrent: () => input.signal.throwIfAborted(), signal: input.signal,
    componentGenerationId: `extension-import:${reference.sha256}`,
    componentId: 'extension-snapshot', deadlineMs: 30_000,
  });
  const lease = await input.ports.acquireAttachment(authority, {
    attachmentId: reference.attachmentId, expectedMimeType: reference.mimeType,
    expectedSizeBytes: reference.sizeBytes, expectedSha256: reference.sha256,
  });
  try {
    const bytes = await input.io.readLease(input.stagingRoot, lease.readOnlyPath, reference.sizeBytes, input.signal);
    if (bytes.byteLength !== reference.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
      throw new ProtocolError('extension_digest_mismatch', 'extension snapshot attachment differs from its declared bytes');
    }
    input.signal.throwIfAborted();
    return validateExtensionSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } finally {
    await input.controller.cleanupAttachmentLease(authority, lease.leaseId);
  }
}
