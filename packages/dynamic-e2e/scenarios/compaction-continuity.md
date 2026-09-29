<!-- myagents-dynamic-e2e-scenario-v1
{
  "schemaVersion": 1,
  "id": "compaction-continuity",
  "title": "Preserve the latest task truth across repeated automatic compaction",
  "fixture": "compaction-continuity",
  "platforms": ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"],
  "prompts": [
    "Start a conversational continuity audit. Do not call tools or create, edit, or read workspace files during this audit. The current goal is finish-compaction-continuity-audit. Confirm only the current goal.",
    "Remember working path specs/continuity-target.md and identifier COMPACTION_SENTINEL_42. The path is a memory fact, not a request to open or create a file. Confirm both exactly without using tools.",
    "The initial priority is speed-first. This is provisional and may be corrected later. Confirm the current priority.",
    "Verified state: the synthetic fixture was read by the Host; no file edit or test run has occurred. Distinguish verified facts from unperformed work.",
    "Correction: replace the old priority speed-first with integrity-first. The old priority is now stale. Confirm only the corrected priority.",
    "Known failure: SUMMARY_CAPACITY_PRECHECK was observed synthetically; no Provider request was made for that failed preflight. Preserve this short error fact.",
    "Decision: DSH remains the sole compaction and durable conversation authority. Confirm the decision without adding a second memory owner.",
    "In-progress state: repeated automatic compaction acceptance is underway; it is not yet verified complete. Confirm the state accurately.",
    "Correction: the known failure is now resolved by bounded balanced-range fitting. Preserve both the earlier failure and this correction without calling it a product test pass.",
    "Current active operations are none. Do not retain invented child, background, interaction, or approval work.",
    "The exact immediate next action is inspect-compaction-evidence. Confirm exactly one next action.",
    "Verified state update: at least one automatic compaction boundary is expected from the Host campaign, but do not claim its count until the Host verifies durable events.",
    "Correction: replace the next action inspect-compaction-evidence with report-terminal-evidence. The earlier next action is stale.",
    "Restate the latest goal, corrected priority, working path, identifier, and current next action concisely. Exclude both superseded values.",
    "Final status remains in progress until the Host inspects durable compaction events. Do not fabricate completion, edits, tests, user approval, or hidden storage facts.",
    "Return one terse terminal continuity line containing exactly these current facts: finish-compaction-continuity-audit; integrity-first; specs/continuity-target.md; COMPACTION_SENTINEL_42; report-terminal-evidence. Do not include speed-first or inspect-compaction-evidence."
  ],
  "experienceFocus": ["Repeated automatic compaction", "Latest-correction precedence", "Truthful planned/applied/verified state", "Exact continuity facts"],
  "capabilityCoverage": ["automatic-compaction", "structured-checkpoint", "continuity", "model-capacity", "secret-canary"],
  "postconditions": ["At least three automatic compactions complete durably", "The terminal answer retains every current exact fact", "Superseded values are absent from the terminal answer", "The fixture input remains unchanged", "No prohibited content enters evidence"],
  "hostPolicy": {"interaction": "deny", "network": "deny", "credentials": "approved-provider-only"},
  "budgets": {"wallTimeMs": 900000, "operations": 16, "turns": 96, "modelCalls": 64, "toolCalls": 0, "children": 0, "processes": 0, "networkAttempts": 0, "bytes": 8388608, "retries": 1}
}
-->
# Repeated automatic compaction continuity

The Host adds deterministic synthetic, non-secret context pressure to each natural prompt. The Root Agent is evaluated on latest-truth continuity and durable compaction facts, not on a prescribed hidden tool order.
