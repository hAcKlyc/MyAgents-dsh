import type { DshToolStrategy } from "@myagents-dsh/protocol";

/**
 * Build-time switch: change this value, then rebuild and re-ingest the Runtime handoff.
 * ma_first: keep MyAgents file/search/web tool names, schemas, and results,
 *   plus the legacy ProductWork Agent tools for existing deployments.
 * dsh_first: use DSH's native file/search/web and subagent definitions,
 *   including fresh/fork delegation and native continuation controls.
 * Both keep MyAgents permissions, workspace limits, checkpoints, and Host network routing.
 * ExitPlanMode stays MyAgents-owned; DSH's exit_plan_mode is never exposed.
 */
export const BUILD_TOOL_STRATEGY: DshToolStrategy = "dsh_first";
