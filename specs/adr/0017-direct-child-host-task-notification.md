# ADR 0017 — Preserve Host-authored task notifications for direct children

RC.5 removed the previous Host queue export. The native send_message operation steers a model-authored message and attributes it to the sending Agent. A shared task assignment issued by the Host must retain its existing source and queue for the assigned child.

Expose a process-local method on the native SubagentRuntime. The Product task owner checks that the recipient is a direct continuable child eligible for this assignment. The public method forwards the notification to the existing native deliverPrompt implementation with queued delivery and its Host source. Harness resolves tree ownership, restores the recipient if needed, and inserts the message under its delivery lock. The method has no RPC decorator or model tool binding. The Product task graph continues to own assignment and content. Native DSH owns materialization, delivery, cancellation and replay.

Retire DSH-SEAM-018 when the public package provides queued Host-authored delivery with the same recipient, provenance and cancellation guarantees.
