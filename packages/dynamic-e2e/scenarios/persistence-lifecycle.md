<!-- myagents-dynamic-e2e-scenario-v1
{
  "schemaVersion": 1,
  "id": "persistence-lifecycle",
  "title": "Resume, compact, mutate, and clean a durable Session",
  "fixture": "persistence-lifecycle",
  "platforms": ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"],
  "prompts": ["Read the fixture and respond with a concise durable checkpoint summary only. Do not modify workspace files, simulate a restart, or generate filler history.", "Before the Host compacts and restarts the Runtime, confirm the exact synthetic decision from the fixture in one concise sentence. Do not modify workspace files or use tools.", "The Host has resumed this exact Session and exercised a governed mutation from the retained stable boundary. Verify that the synthetic decision remains in context and explain the resulting Session state without inventing hidden storage facts. Do not modify workspace files."],
  "experienceFocus": ["Durable continuity", "Truthful recovery", "Mutation conflict handling"],
  "capabilityCoverage": ["session-resume", "session-read", "compact", "checkpoint", "rewind", "fork", "delete", "crash-recovery"],
  "postconditions": ["Durable head and receipt identities agree", "Mutation reaches one exact terminal", "Session writer and SQLite resources close"],
  "hostPolicy": {"interaction": "scripted", "network": "deny", "credentials": "none"},
  "budgets": {"wallTimeMs": 480000, "operations": 8, "turns": 48, "modelCalls": 64, "toolCalls": 128, "children": 0, "processes": 8, "networkAttempts": 0, "bytes": 67108864, "retries": 1}
}
-->
# Persistence and lifecycle

The Orchestrator owns the synthetic crash/restart points and never exposes SQLite or hidden durable facts during black-box execution.
