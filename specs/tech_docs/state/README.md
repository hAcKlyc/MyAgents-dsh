# Durable state domain

This domain explains the authoritative Session log, production persistence, crash recovery and explicit history/file mutations.

## Read by task

| Task | Start here | Then read |
| --- | --- | --- |
| Change create/resume/read/close or SQLite storage | [Sessions, persistence and recovery](./sessions-persistence-and-recovery.md) | [Operations, messages and turns](../runtime/operations-messages-and-turns.md) |
| Change fork, rewind, delete or checkpoints | [Mutations and checkpoints](./mutations-and-checkpoints.md) | [Sessions, persistence and recovery](./sessions-persistence-and-recovery.md) |
| Change compaction persistence | [Compaction](../execution/compaction.md) | [Sessions, persistence and recovery](./sessions-persistence-and-recovery.md) |

## Domain boundary

DSH Session events are the only durable conversation truth. SQLite is the production backend for that truth, not a shadow transcript. Product mutations publish new immutable generations or tombstones; they never rewrite an accepted source generation.
