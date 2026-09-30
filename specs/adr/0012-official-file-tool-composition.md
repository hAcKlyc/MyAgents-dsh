# Official file tools with product mutation authority

Current DSH `0.2.0-rc.2` disposition: retained as patch 0011; official file tools use guarded Product publication. The [seam registry](../dsh/seam-decisions-v1.json) owns exact current patch identity; dated evidence below is historical.

Accepted 2026-09-08 for UPG-W16.

Read/Write/Edit keep their MyAgents names and permission/checkpoint contract. The installed
official tool-fs definitions own argument semantics, bounded text windows, image capability
checks, image result blocks and file execution. The product calls those executors inside the
existing tool execution; it does not dispatch a nested tool call or create another ToolRuntime.

LocalWorkspaceFileSystem extends the official LocalFileSystem. Product code retains canonical
capability identities and the existing checkpoint/plan/attachment/retained-output I/O authorities.
The upstream provider owns UTF-8 streaming, literal edit semantics, CRLF preservation, locks,
atomic publication and platform-specific file security preservation.

The fixed upstream version lacks definition factories and an exact stored-content preview for
checkpoint preparation. Patch 0011 exposes its existing definitions as public factories, exposes
prepareTextEdit using the same internal algorithm as editText, and adds a protected pre-publication
policy guard. The default plugin and provider preserve their existing behavior. The guard runs
after staging and before publication, so product path/version checks remain effective while the
official code owns staging and cleanup. Test-only fsio internals are not used as production hooks.
The provider's `createParents: false` option prevents an implicit mkdir from recreating parents
outside the existing checkpoint directory journal. Stock deployments retain automatic parent creation.

Image reads run inside the existing Host attachment request scope. Their calling Agent's actual
model decides whether image input is supported. Text-only models receive a recoverable tool error
before an image is added to history. PDF attachment publication is not text extraction: Read rejects
PDF with guidance to the existing document-conversion flow. Notebooks are ordinary UTF-8 JSON;
this work does not retain a second notebook parser or add a PDF process/protocol.

Removal: drop the patch when the installed upstream release provides equivalent public factories,
stored-edit preparation and publication policy hook. Keep permission/checkpoint/attachment bridges.

An unsandboxed deployment can still reject a path through its product filesystem policy. Preserve
that structured error when no official sandbox policy exists; do not dereference an absent mode and
replace the denial with a TypeError. The regression runs the stock Write executor against a denying
product provider and verifies both the original error and unchanged bytes/checkpoint abort.
