# DeepSeek Harness 0.2.2-rc.5 source refresh

MyAgents-dsh 0.1.24 adopts the official same-tree subagent lifecycle, address resolution and transport. The previous distribution was v0.1.23. Eight RC tags follow its upstream baseline through the selected tag, including RC.5.

| Authority | Previous | Candidate |
| --- | --- | --- |
| DSH tag | 0.2.1-rc.2 | 0.2.2-rc.5 |
| DSH commit | `687f282e8625c6b8d11ff58211a90524be2e4317` | `9c2670d3bce5275e0d1610272958121af87787bb` |
| DSH tree | `f127f0f96a815eac4dea336a2ae0d9cd0f2aa82d` | `6ec0fcdcaf38bdf8ffa6675e30b036dc104a1ece` |
| Ordered DSH patches | 14 | 14 |
| Ordered series SHA-256 | `e5a10cf9cb87d0c5ad9af89aba34bbd214f80cf2c289ea2f5db89edaae9b4760` | `87972f9c8ecd2a42fdeffc44337cedf9eccc773c82adc850941fb9611c862e38` |
| Cordis | 4.0.5 | 4.1.0 |
| pi-ai | 1.1.0 | 1.3.0, two patches |

The Harness activates children, resolves addresses and checks membership in a single tree. The Host records the resulting tool operation and the approved recipient. Concurrent child messages retain separate operation identities. The product TaskGraph still decides which direct child can receive a Host-issued task assignment. Native and PTC tool execution use the corresponding official executor plugin. Four Host projections use the typed handles returned by the official registry.

## Patch decisions

| Seam | Outcome on RC.5 |
| --- | --- |
| 001 | Retain wakeup of an existing durable inbox message without reinsertion. |
| 002 | Retain the awaited transformation before assistant-message commit. Host approvals and replay use the committed input. |
| 003 | Retain native JSONL validation for required product events. |
| 004 | Continue composing official persistence APIs with product coordination. No DSH patch. |
| 005 | Rebase the pre-publication checks onto the official Session-first order. The native activation manager attests the tree root. |
| 006 | Retain admission of released v5 child descriptors. Native DSH owns scheduling and recovery. |
| 007 | Native stream translation retains tool identity. Previously retired. |
| 008 | Retain capacity-aware structured compaction, including summary-call accounting. |
| 009 | Retain historical child persona restoration and permission-aware delegation text. |
| 010 | Retain first-match selection of workspace instruction candidates. |
| 011 | Retain provider-owned structured content through matching-route replay. |
| 012 | Retain public file-tool factories, edit preview and write publication controls for Host checkpoints. |
| 013 | Native prompt interpolation supports literal dynamic context. Previously retired. |
| 014 | Retain Host-neutral time context. |
| 015 | Delete the old projection-registration declaration patch. The official typed registration handle passes the strict consumer fixture. |
| 016 | Retain exact-model conversation capability declarations for the pi-ai adapter. |
| 017 | Retain completed Web search results when another query fails. |
| 018 | Add a process-local Host queue entry to the existing subagent manager. Shared-task notifications retain Host provenance when the native manager wakes their recipient. |

The [seam registry](./seam-decisions-v1.json) records source blobs, patch bytes and tests. The [pi-ai evidence](../pi-ai/seam-evidence-v1.json) records exact source identity and the two separate provider-content and deferred-parsing patches. The [accepted artifact](../../packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json) records the consumer identity used by the distribution.

## Persistence and verification

RC.5 writes version 3 child catalogs into the parent Session when it creates a child. After that write, v0.1.23 cannot reopen that parent. The distribution uses the official format. [Downgrade details](../../release-notes/v0.1.24.md)

On macOS arm64 the exact patched DSH source passed 1,810 tests across 44 files with four skipped. The separately patched pi-ai passed 54 tests. Two independent macOS builds produced 115 byte-identical files, including 111 packages and the consumer lock. The patched artifact manifest SHA-256 is `7056f16fdf30f477fdf294af8078888a96b356ee321f827bc082f9e764d209d4`. Platform release evidence belongs to each native workflow and asset.

A published v0.1.23 macOS arm64 Runtime seeded an isolated parent and child. RC.5 reopened both and continued them through native messaging, preserving the journal prefixes byte for byte. The previous release refused the same parent after RC.5 appended a version 3 catalog entry. Direct Host prompts to previously completed children reuse their frozen operation. A managed tool call on an old catalog returns `tool_catalog_stale`. A new parent turn can send a fresh dispatch to that child.
