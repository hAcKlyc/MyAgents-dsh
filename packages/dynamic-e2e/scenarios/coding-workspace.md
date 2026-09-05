<!-- myagents-dynamic-e2e-scenario-v1
{
  "schemaVersion": 1,
  "id": "coding-workspace",
  "title": "Discover, repair, and verify a synthetic workspace",
  "fixture": "coding-workspace",
  "platforms": ["darwin-arm64", "win32-x64", "linux-x64"],
  "prompts": ["Inspect this small project, find why its greeting test fails, make the smallest safe repair, and verify the result. Explain what changed without exposing machine paths."],
  "experienceFocus": ["Outcome-oriented discovery", "Safe mutation and verification", "Readable bounded results"],
  "capabilityCoverage": ["Read", "Write", "Edit", "Glob", "Grep", "bash", "pwsh", "job_output", "job_list", "job_kill", "ls", "checkpoint", "permission"],
  "postconditions": ["Only allowlisted workspace files changed", "Tests pass", "No retained process or checkpoint remains"],
  "hostPolicy": {"interaction": "scripted", "network": "deny", "credentials": "none"},
  "budgets": {"wallTimeMs": 300000, "operations": 2, "turns": 16, "modelCalls": 24, "toolCalls": 80, "children": 0, "processes": 12, "networkAttempts": 0, "bytes": 16777216, "retries": 1}
}
-->
# Coding workspace

The Root Agent receives only the prompt above and a synthetic repository with one failing greeting test. Hidden checks join exact file-tool calls, governed effects, terminal state, and cleanup; they do not prescribe a tool order.

Shell coverage uses the platform-selected official tool (`bash` on POSIX, `pwsh` on Windows). Exact foreground timeout, Jobs ownership/cancellation, and spill identity are additionally exercised by deterministic component and packed Runtime fixtures; this natural coding scenario does not guarantee the model chooses background execution.
