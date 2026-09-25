import type { DshToolStrategy } from "@myagents-dsh/protocol";

/**
 * Build-time switch: change this value, then rebuild and re-ingest the Runtime handoff.
 * ma_first: keep MyAgents file/search/web tool names, schemas, and results.
 * dsh_first: use DSH's native file/search/web definitions and results, plus read_image.
 * Both keep MyAgents permissions, workspace limits, checkpoints, and Host network routing.
 * ExitPlanMode stays MyAgents-owned; DSH's exit_plan_mode is never exposed.
 */
export const BUILD_TOOL_STRATEGY: DshToolStrategy = "dsh_first";
