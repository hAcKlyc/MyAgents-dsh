<!-- myagents-dynamic-e2e-scenario-v1
{
  "schemaVersion": 1,
  "id": "persistence-lifecycle",
  "title": "Resume, compact, mutate, and clean a durable Session",
  "fixture": "persistence-lifecycle",
  "platforms": ["darwin-arm64", "win32-x64", "linux-x64"],
  "prompts": ["Build enough synthetic history to exercise compaction, then resume after the instructed restart and verify the important context remains.", "Use the supplied stable boundary to demonstrate one governed mutation and explain the resulting Session state."],
  "experienceFocus": ["Durable continuity", "Truthful recovery", "Mutation conflict handling"],
  "capabilityCoverage": ["session-resume", "session-read", "compact", "checkpoint", "rewind", "fork", "delete", "crash-recovery"],
  "postconditions": ["Durable head and receipt identities agree", "Mutation reaches one exact terminal", "Session writer and SQLite resources close"],
  "hostPolicy": {"interaction": "scripted", "network": "deny", "credentials": "none"},
  "budgets": {"wallTimeMs": 480000, "operations": 8, "turns": 48, "modelCalls": 64, "toolCalls": 128, "children": 0, "processes": 8, "networkAttempts": 0, "bytes": 67108864, "retries": 1}
}
-->
# Persistence and lifecycle

The Orchestrator owns the synthetic crash/restart points and never exposes SQLite or hidden durable facts during black-box execution.
