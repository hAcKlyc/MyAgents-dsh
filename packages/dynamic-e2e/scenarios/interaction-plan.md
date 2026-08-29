<!-- myagents-dynamic-e2e-scenario-v1
{
  "schemaVersion": 1,
  "id": "interaction-plan",
  "title": "Clarify ambiguity, revise a plan, and execute after approval",
  "fixture": "interaction-plan",
  "platforms": ["darwin-arm64", "win32-x64", "linux-x64"],
  "prompts": ["This turn is planning-only. In the current workspace, inspect migration-request.md and selection.txt, ask for any decision you truly need, and stop after presenting a safe proposed migration plan. Do not modify either fixture file in this turn.", "Use the answer I provided and submit the revised plan for formal approval. A normal clarification answer is not approval. Only after formal approval, implement the selection.txt migration and verify it."],
  "experienceFocus": ["Natural clarification", "Plan approval and revision", "Resumed work after interaction"],
  "capabilityCoverage": ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "interaction", "plan", "followUp"],
  "postconditions": ["No mutation occurs before accepted plan exit", "The approved revision is the one executed", "Interaction state is settled"],
  "hostPolicy": {"interaction": "scripted", "network": "deny", "credentials": "none"},
  "budgets": {"wallTimeMs": 480000, "operations": 3, "turns": 20, "modelCalls": 40, "toolCalls": 80, "children": 0, "processes": 8, "networkAttempts": 0, "bytes": 16777216, "retries": 1}
}
-->
# Interaction and Plan Mode

The Tester follows the scripted allow/deny/revise worksheet but never discloses the hidden expected state transitions to the Root Agent.
