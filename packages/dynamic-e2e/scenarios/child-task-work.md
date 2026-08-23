<!-- myagents-dynamic-e2e-scenario-v1
{
  "schemaVersion": 1,
  "id": "child-task-work",
  "title": "Coordinate dependent tasks and useful child work",
  "fixture": "child-task-work",
  "platforms": ["darwin-arm64", "win32-x64", "linux-x64"],
  "prompts": ["Audit the three independent fixture areas, track dependencies explicitly, delegate where useful, combine the findings, and stop any work that is no longer needed."],
  "experienceFocus": ["Discoverable delegation", "Dependency-aware progress", "Bounded child cleanup"],
  "capabilityCoverage": ["Agent", "SendMessage", "TaskStop", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "child", "mailbox", "jobs"],
  "postconditions": ["Task dependencies are coherent", "Child results correlate to the parent", "No child or background job remains"],
  "hostPolicy": {"interaction": "allow", "network": "deny", "credentials": "none"},
  "budgets": {"wallTimeMs": 420000, "operations": 2, "turns": 32, "modelCalls": 48, "toolCalls": 160, "children": 4, "processes": 8, "networkAttempts": 0, "bytes": 33554432, "retries": 1}
}
-->
# Child and TaskGraph work

The task creates a natural opportunity to delegate but does not require one exact child topology or tool sequence.
