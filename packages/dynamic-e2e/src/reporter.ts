export const TESTER_REPORT_SECTIONS = Object.freeze([
  "Role confirmation",
  "Black-box task usability",
  "Observed public path",
  "Tool and child behavior",
  "Host interactions",
  "Candidate risks",
  "Likely layer and reproduction",
  "Evidence and uncertainty",
  "Cleanup confirmation",
  "Next diagnostic action",
] as const);

export const createBlankExperienceReport = (runId: string, scenarioId: string): string => [
  "# Independent Tester Agent experience report",
  "",
  `- Run: \`${runId}\``,
  `- Scenario: \`${scenarioId}\``,
  "- Artifact: see `run.json` and sealed `manifest.json`",
  "- This worksheet records observations only. It is not a Batch Go/No-Go decision.",
  "",
  ...TESTER_REPORT_SECTIONS.flatMap((section) => [
    `## ${section}`,
    "",
    "_Complete after the Orchestrator seals machine facts._",
    "",
  ]),
].join("\n");
