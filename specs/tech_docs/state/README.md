# Durable state domain

This domain explains the authoritative Session log, production persistence, crash recovery and explicit history/file mutations.

## Read by task

| Task | Start here | Then read |
| --- | --- | --- |
| Change create/resume/read/close or persistence | [Sessions, persistence and recovery](./sessions-persistence-and-recovery.md) | [Operations, messages and turns](../runtime/operations-messages-and-turns.md) |
| Change fork, rewind, delete or checkpoints | [Mutations and checkpoints](./mutations-and-checkpoints.md) | [Sessions, persistence and recovery](./sessions-persistence-and-recovery.md) |
| Change compaction persistence | [Compaction](../execution/compaction.md) | [Sessions, persistence and recovery](./sessions-persistence-and-recovery.md) |

## Domain boundary

Official DSH JSONL is the durable Session event store. Product SQLite holds generation locators, mutation journals and checkpoint records/preimages; the official SQLite query index is in-memory and disposable. Product mutations publish new generations or tombstones without rewriting an accepted source log.
