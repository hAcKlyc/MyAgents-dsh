<!-- myagents-dynamic-e2e-scenario-v1
{
  "schemaVersion": 1,
  "id": "web-components",
  "title": "Research through governed web and declarative components",
  "fixture": "web-components",
  "platforms": ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"],
  "prompts": ["Research the synthetic release notes, compare the two versions with citations, use the available release-audit Skill and component tools where helpful, and write a concise recommendation."],
  "experienceFocus": ["Citation quality", "Component discoverability", "Credential and attachment boundaries"],
  "capabilityCoverage": ["WebSearch", "WebFetch", "Skill", "MCP", "HostTool", "Hook", "credential", "attachment", "component"],
  "postconditions": ["Citations point to allowed results", "No credential material enters evidence", "Component connections and leases close"],
  "hostPolicy": {"interaction": "scripted", "network": "synthetic-only", "credentials": "approved-provider-only"},
  "budgets": {"wallTimeMs": 360000, "operations": 2, "turns": 24, "modelCalls": 32, "toolCalls": 96, "children": 1, "processes": 8, "networkAttempts": 16, "bytes": 33554432, "retries": 1}
}
-->
# Web and declarative components

All endpoints and component resources are synthetic or explicitly allowlisted. The harness grants no Bash/curl bypass.
