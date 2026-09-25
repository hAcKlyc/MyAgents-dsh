import { Type, type Static, type TSchema } from "typebox";
import officialShellTools from "../generated/official-shell-tools-v1.json" with { type: "json" };

import {
  CANONICAL_JSON_LIMITS,
  TOOL_CONTRACT_LIMITS,
  boundedIdentifier,
  boundedTaskMetadata,
  boundedPath,
  boundedText,
  checkpointReceipt,
  deepFreeze,
  emptyStrictObject,
  nonNegativeInteger,
  positiveInteger,
  revision,
  sha256,
  strictObject,
  taskNode,
  tokenUsage,
} from "./schema.js";

const CANONICAL_TOOL_NAME_VALUES = [
  "Read", "Write", "Edit", "Glob", "Grep", "bash", "pwsh", "job_output", "job_list", "job_kill", "ls",
  "WebFetch", "WebSearch", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
  "Skill", "Agent", "TaskStop", "SendMessage",
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
] as const;
export const CANONICAL_TOOL_NAMES = Object.freeze(CANONICAL_TOOL_NAME_VALUES);

export const TOOL_CONTRACT_SOURCE = deepFreeze({
  repository: "myagents-runtime",
  commit: "b7bbcadb172254defc0ea86229dd5de043fbb5f3",
  sourceTreeSnapshotSha256: "405aeeba942c46029c6cbac568e909bd149774d0b9f1547ebc9e7a3d6239bebc",
  inventoryDecision: "canonical-tool-contracts",
  migratedAuthorities: [
    "packages/runtime-core/src/tools/contracts.ts",
    "packages/runtime-core/src/tools/golden-contracts.ts",
    "packages/runtime-core/src/tools/profile.ts",
  ],
  migratedTests: [
    "packages/runtime-core/src/tools/contracts.unit.test.ts",
  ],
  engineAdaptation: "Pi registration and lifecycle glue replaced by public DSH service seams",
} as const);

export type CanonicalToolName = (typeof CANONICAL_TOOL_NAMES)[number];
export type ToolConcurrency = "parallel" | "session_serial" | "canonical_path";
export type ToolSideEffect = "read" | "workspace" | "process" | "network" |
  "interaction" | "delegation" | "session_state";
export type ToolCheckpoint = "none" | "root_managed_file";
export type PermissionClass =
  | "workspace.read" | "workspace.write" | "workspace.search"
  | "process.execute" | "network.fetch" | "network.search"
  | "interaction.ask" | "session.plan.enter" | "session.plan.exit"
  | "skill.load" | "agent.spawn" | "work.stop" | "agent.message"
  | "task_graph.read" | "task_graph.mutate";

export interface ToolOutputLimits {
  readonly maxInlineBytes: number;
  readonly maxStructuredItems: number;
  readonly maxAttachmentBytes?: number;
  readonly maxRetainedOutputBytes?: number;
}

export interface CanonicalToolError {
  readonly code: string;
  readonly retryable: boolean;
  readonly when: string;
}

export interface CanonicalToolLifecycle {
  readonly cancellation: "abort_signal_exactly_one_terminal";
  readonly durableResult: "dsh_tool_result_before_runtime_visibility";
  readonly timeout: "bounded_executor" | "host_policy" | "work_registry";
  readonly headless: "allowed" | "policy_required";
}

export interface CanonicalToolPlanPolicy {
  readonly mode: "allowed" | "managed-plan-file-only" | "plan-safe-child-only" | "denied";
  readonly denialCode?: "plan_mode_side_effect_forbidden" | "plan_mode_tool_forbidden" | "plan_safe_agent_unavailable";
  readonly revision: "operation-birth-and-durable-session";
}

export interface CanonicalToolOriginPolicy {
  readonly mode: "all" | "root-only" | "no-background-child";
  readonly denialCode?: "background_interaction_forbidden" | "child_agent_nesting_forbidden" | "child_plan_entry_forbidden";
  readonly revision: "operation-birth";
}

export interface CanonicalToolContract<
  Name extends CanonicalToolName = CanonicalToolName,
  InputSchema extends TSchema = TSchema,
  OutputSchema extends TSchema = TSchema,
> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly executionInputSchema: TSchema;
  readonly outputSchema: OutputSchema;
  readonly concurrency: ToolConcurrency;
  readonly sideEffect: ToolSideEffect;
  readonly timeoutMs?: number;
  readonly outputLimits: ToolOutputLimits;
  readonly permissionClass: PermissionClass;
  readonly originPolicy: CanonicalToolOriginPolicy;
  readonly planPolicy: CanonicalToolPlanPolicy;
  readonly checkpoint: ToolCheckpoint;
  readonly behaviorFixtureIds: readonly string[];
  readonly resultSemantics: string;
  readonly errorCodes: readonly CanonicalToolError[];
  readonly lifecycle: CanonicalToolLifecycle;
}

export interface DshReuseSeam {
  readonly id: string;
  readonly importPath: string;
  readonly classification: "direct" | "provider" | "helper" | "product-plugin";
  readonly symbols: readonly string[];
}

export interface CanonicalToolReuseDecision {
  readonly tool: CanonicalToolName;
  readonly modelDefinition: "compat-tool" | "official-tool";
  readonly dshPublicReuse: readonly DshReuseSeam[];
  readonly productOwner: string;
  readonly stockModelDefinition: "excluded" | "enabled";
}

const outputLimits = (
  maxInlineBytes: number,
  maxStructuredItems: number,
  optional: Pick<ToolOutputLimits, "maxAttachmentBytes" | "maxRetainedOutputBytes"> = {},
): ToolOutputLimits => ({ maxInlineBytes, maxStructuredItems, ...optional });

const lifecycle = (
  timeout: CanonicalToolLifecycle["timeout"],
  headless: CanonicalToolLifecycle["headless"],
): CanonicalToolLifecycle => ({
  cancellation: "abort_signal_exactly_one_terminal",
  durableResult: "dsh_tool_result_before_runtime_visibility",
  timeout,
  headless,
});

const errors = (...values: ReadonlyArray<readonly [string, boolean, string]>): readonly CanonicalToolError[] =>
  values.map(([code, retryable, when]) => ({ code, retryable, when }));

const PLAN_POLICIES = Object.freeze({
  Read: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  Write: { mode: "managed-plan-file-only", denialCode: "plan_mode_side_effect_forbidden", revision: "operation-birth-and-durable-session" },
  Edit: { mode: "managed-plan-file-only", denialCode: "plan_mode_side_effect_forbidden", revision: "operation-birth-and-durable-session" },
  Glob: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  Grep: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  bash: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  pwsh: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  job_output: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  job_list: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  job_kill: { mode: "denied", denialCode: "plan_mode_side_effect_forbidden", revision: "operation-birth-and-durable-session" },
  ls: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  WebFetch: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  WebSearch: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  AskUserQuestion: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  EnterPlanMode: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  ExitPlanMode: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  Skill: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  Agent: { mode: "plan-safe-child-only", denialCode: "plan_safe_agent_unavailable", revision: "operation-birth-and-durable-session" },
  TaskStop: { mode: "denied", denialCode: "plan_mode_tool_forbidden", revision: "operation-birth-and-durable-session" },
  SendMessage: { mode: "denied", denialCode: "plan_mode_tool_forbidden", revision: "operation-birth-and-durable-session" },
  TaskCreate: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  TaskGet: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  TaskList: { mode: "allowed", revision: "operation-birth-and-durable-session" },
  TaskUpdate: { mode: "allowed", revision: "operation-birth-and-durable-session" },
} as const satisfies Record<CanonicalToolName, CanonicalToolPlanPolicy>);

const defaultOriginPolicy = Object.freeze({ mode: "all", revision: "operation-birth" } as const);
const ORIGIN_POLICIES = Object.freeze({
  ...Object.fromEntries(CANONICAL_TOOL_NAMES.map((name) => [name, defaultOriginPolicy])),
  AskUserQuestion: { mode: "no-background-child", denialCode: "background_interaction_forbidden", revision: "operation-birth" },
  EnterPlanMode: { mode: "root-only", denialCode: "child_plan_entry_forbidden", revision: "operation-birth" },
  ExitPlanMode: { mode: "no-background-child", denialCode: "background_interaction_forbidden", revision: "operation-birth" },
  Agent: { mode: "all", revision: "operation-birth" },
} as const) as Readonly<Record<CanonicalToolName, CanonicalToolOriginPolicy>>;

const contract = <Name extends CanonicalToolName, Input extends TSchema, Output extends TSchema>(
  value: Omit<CanonicalToolContract<Name, Input, Output>, "executionInputSchema" | "originPolicy" | "planPolicy"> & {
    readonly executionInputSchema?: TSchema;
  },
): CanonicalToolContract<Name, Input, Output> => ({
  ...value,
  executionInputSchema: value.executionInputSchema ?? value.inputSchema,
  originPolicy: ORIGIN_POLICIES[value.name],
  planPolicy: PLAN_POLICIES[value.name],
});

export const OFFICIAL_SHELL_TOOL_NAMES = Object.freeze(["bash", "pwsh", "job_output", "job_list", "job_kill"] as const);
export type OfficialShellToolName = (typeof OFFICIAL_SHELL_TOOL_NAMES)[number];
export const isOfficialShellTool = (name: string): name is OfficialShellToolName =>
  OFFICIAL_SHELL_TOOL_NAMES.some((candidate) => candidate === name);

const officialShellContract = <Name extends OfficialShellToolName>(name: Name): CanonicalToolContract<Name> => {
  const definition = officialShellTools[name];
  const read = name === "job_output" || name === "job_list";
  return contract({
    name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    concurrency: "parallel",
    sideEffect: read ? "read" : "process",
    outputLimits: outputLimits(262_144, 1_024),
    permissionClass: read ? "workspace.read" : name === "job_kill" ? "work.stop" : "process.execute",
    checkpoint: "none",
    behaviorFixtureIds: ["official_definition", "permission_and_origin", "output_and_exit", "cancellation", "owner_scoped_jobs"],
    resultSemantics: "Pinned official DSH tool output, rendering and Jobs lifecycle.",
    errorCodes: errors(["permission_denied", false, "Product execution policy denies the call."]),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  });
};

const officialShellReuse = (tool: OfficialShellToolName): CanonicalToolReuseDecision => ({
  tool, modelDefinition: "official-tool", stockModelDefinition: "enabled",
  productOwner: "@myagents-dsh/tools-process",
  dshPublicReuse: [{
    id: tool.startsWith("job_") ? "tool-jobs" : `tool-${tool}`,
    importPath: tool.startsWith("job_") ? "@deepseek-ai/dsh-tool-jobs" : `@deepseek-ai/dsh-tool-${tool}`,
    classification: "direct", symbols: ["apply"],
  }],
});

const citation = strictObject({
  title: Type.String({ minLength: 1, maxLength: 512 }),
  url: Type.String({ minLength: 1, maxLength: 2_048, format: "uri" }),
});

const readOutput = Type.Union([
  strictObject({
    path: boundedPath,
    kind: Type.Literal("text"),
    mimeType: Type.String({ minLength: 1, maxLength: 256 }),
    offset: positiveInteger,
    lineCount: nonNegativeInteger,
    truncated: Type.Boolean(),
    content: Type.String({ maxLength: TOOL_CONTRACT_LIMITS.maxInlineOutputBytes }),
  }),
  strictObject({
    path: boundedPath,
    kind: Type.Literal("image"),
    image: strictObject({
      attachmentId: boundedIdentifier,
      mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp"), Type.Literal("image/gif")]),
      bytes: positiveInteger,
      width: positiveInteger,
      height: positiveInteger,
      name: Type.Optional(Type.String({ maxLength: 512 })),
      originalDimensions: Type.Optional(strictObject({ width: positiveInteger, height: positiveInteger })),
    }),
  }),
]);

const writeOutput = strictObject({
  path: boundedPath,
  bytes: nonNegativeInteger,
  sha256,
  created: Type.Boolean(),
  checkpointReceipt: Type.Optional(checkpointReceipt),
});

const editOutput = strictObject({
  path: boundedPath,
  replacements: positiveInteger,
  sha256,
  externalChangesRetained: Type.Boolean(),
  checkpointReceipt: Type.Optional(checkpointReceipt),
});

const grepContentRecord = strictObject({
  path: boundedPath,
  line: Type.Optional(positiveInteger),
  text: Type.String({ maxLength: 65_536 }),
});
const grepCountRecord = strictObject({ path: boundedPath, count: nonNegativeInteger });
const grepFileRecord = strictObject({ path: boundedPath });

const planExitOutput = Type.Union([
  strictObject({
    disposition: Type.Literal("approved"),
    plan: Type.String({ maxLength: TOOL_CONTRACT_LIMITS.maxInlineOutputBytes }),
    revision,
    feedback: Type.Optional(Type.String({ maxLength: 65_536 })),
    mode: Type.Literal("normal"),
  }),
  strictObject({
    disposition: Type.Union([Type.Literal("rejected"), Type.Literal("cancelled")]),
    plan: Type.String({ maxLength: TOOL_CONTRACT_LIMITS.maxInlineOutputBytes }),
    revision,
    feedback: Type.Optional(Type.String({ maxLength: 65_536 })),
    mode: Type.Literal("plan"),
  }),
]);

const taskChangedField = Type.Union([
  Type.Literal("status"),
  Type.Literal("subject"),
  Type.Literal("description"),
  Type.Literal("activeForm"),
  Type.Literal("owner"),
  Type.Literal("addBlocks"),
  Type.Literal("addBlockedBy"),
  Type.Literal("metadata"),
]);

const agentOutput = Type.Union([
  strictObject({
    taskId: boundedIdentifier,
    agentId: boundedIdentifier,
    state: Type.Literal("background"),
    outputPath: boundedPath,
    model: boundedIdentifier,
  }),
  strictObject({
    taskId: boundedIdentifier,
    agentId: boundedIdentifier,
    state: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("aborted")]),
    result: Type.String({ maxLength: TOOL_CONTRACT_LIMITS.maxInlineOutputBytes }),
    resultTruncated: Type.Boolean(),
    usage: Type.Optional(tokenUsage),
    model: boundedIdentifier,
  }),
]);

export const CANONICAL_TOOL_CONTRACTS = deepFreeze({
  Read: contract({
    name: "Read",
    description: "Reads UTF-8 text with bounded line ranges, including notebook JSON, using the official DSH reader. PNG/JPEG/WebP/GIF images return image content only when the calling model supports image input. PDF requires document conversion to text/Markdown first. Read an existing file completely before overwriting it.",
    inputSchema: strictObject({
      file_path: boundedPath,
      offset: Type.Optional(positiveInteger),
      limit: Type.Optional(positiveInteger),
      pages: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    }),
    outputSchema: readOutput,
    concurrency: "parallel",
    sideEffect: "read",
    timeoutMs: 30_000,
    outputLimits: outputLimits(262_144, 2_048, { maxAttachmentBytes: 20 * 1_024 * 1_024 }),
    permissionClass: "workspace.read",
    checkpoint: "none",
    behaviorFixtureIds: ["text_range_and_read_receipt", "image_attachment_projection", "text_model_image_refusal", "pdf_conversion_guidance", "notebook_json_text", "symlink_and_size_rejection"],
    resultSemantics: "Return the official bounded UTF-8 text view or validated image content for an image-capable calling model. PDF conversion belongs to document processing.",
    errorCodes: errors(
      ["path_denied", false, "The canonical target is outside an allowed read root or crosses a forbidden symlink."],
      ["file_not_found", false, "The canonical target is absent or not a regular readable file."],
      ["unsupported_format", false, "The requested projection is unsupported."],
      ["read_limit_exceeded", false, "The requested or decoded content exceeds a declared bound."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
  Write: contract({
    name: "Write",
    description: "Creates missing parent directories and a new file, or atomically replaces a previously read file, inside an allowed workspace. Existing files require a current complete Read receipt.",
    inputSchema: strictObject({ file_path: boundedPath, content: boundedText }),
    outputSchema: writeOutput,
    concurrency: "canonical_path",
    sideEffect: "workspace",
    timeoutMs: 30_000,
    outputLimits: outputLimits(16_384, 16),
    permissionClass: "workspace.write",
    checkpoint: "root_managed_file",
    behaviorFixtureIds: ["new_file_absent_precondition", "existing_file_requires_complete_read", "atomic_replace_and_checkpoint_receipt", "external_change_conflict", "abort_before_commit", "journaled_parent_creation_and_rewind"],
    resultSemantics: "Create missing parents through the checkpoint journal, atomically publish one managed file, and return its identity and eligible root checkpoint receipt. Rollback removes only recorded, unchanged, empty directories.",
    errorCodes: errors(
      ["read_required", false, "An existing target has no current complete Read receipt."],
      ["stale_read", true, "The target changed after its qualifying Read."],
      ["path_denied", false, "The target is outside an allowed write root or changes identity."],
      ["mutation_conflict", true, "The atomic commit precondition no longer matches."],
    ),
    lifecycle: lifecycle("bounded_executor", "policy_required"),
  }),
  Edit: contract({
    name: "Edit",
    description: "Performs an exact string replacement in a UTF-8 text file using official DSH edit semantics, including CRLF preservation. By default old_string must occur exactly once; replace_all replaces every non-overlapping occurrence.",
    inputSchema: strictObject({
      file_path: boundedPath,
      old_string: boundedText,
      new_string: boundedText,
      replace_all: Type.Optional(Type.Boolean()),
    }),
    outputSchema: editOutput,
    concurrency: "canonical_path",
    sideEffect: "workspace",
    timeoutMs: 30_000,
    outputLimits: outputLimits(16_384, 16),
    permissionClass: "workspace.write",
    checkpoint: "root_managed_file",
    behaviorFixtureIds: ["single_exact_replacement", "replace_all_non_overlapping", "zero_and_ambiguous_match_errors", "safe_external_change_retention", "notebook_rejected"],
    resultSemantics: "Commit exact non-fuzzy replacement and return count, new identity, retained-change notice, and eligible checkpoint receipt.",
    errorCodes: errors(
      ["read_required", false, "The target has no qualifying Read receipt."],
      ["match_not_found", false, "old_string has no exact occurrence."],
      ["ambiguous_match", false, "old_string is ambiguous while replace_all is false."],
      ["mutation_conflict", true, "The target or publication precondition changed."],
    ),
    lifecycle: lifecycle("bounded_executor", "policy_required"),
  }),
  Glob: contract({
    name: "Glob",
    description: "Finds files by glob pattern under an allowed directory. Results include ignored files, are ordered by modification time, and are capped at 100 paths.",
    inputSchema: strictObject({
      pattern: Type.String({ minLength: 1, maxLength: 4_096 }),
      path: Type.Optional(boundedPath),
    }),
    outputSchema: strictObject({
      durationMs: nonNegativeInteger,
      numFiles: nonNegativeInteger,
      filenames: Type.Array(boundedPath, { maxItems: 100, uniqueItems: true }),
      truncated: Type.Boolean(),
      hint: Type.Optional(Type.String({ maxLength: 160 })),
    }),
    concurrency: "parallel",
    sideEffect: "read",
    timeoutMs: 30_000,
    outputLimits: outputLimits(65_536, 100),
    permissionClass: "workspace.search",
    checkpoint: "none",
    behaviorFixtureIds: ["mtime_order_and_100_cap", "ignored_files_included", "workspace_relative_projection", "invalid_pattern", "abort_search"],
    resultSemantics: "Return at most 100 canonical paths ordered by modification time with explicit truncation.",
    errorCodes: errors(
      ["path_denied", false, "The search root is outside an allowed workspace."],
      ["invalid_pattern", false, "The glob pattern is invalid or over limit."],
      ["search_failed", true, "The bounded search failed after validation."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
  Grep: contract({
    name: "Grep",
    description: "Searches file content with the artifact-pinned ripgrep executable. The optional path may name a file or directory. Supports content, file-name, and count modes without invoking a shell.",
    inputSchema: strictObject({
      pattern: Type.String({ minLength: 1, maxLength: 65_536 }),
      path: Type.Optional(boundedPath),
      glob: Type.Optional(Type.String({ maxLength: 4_096 })),
      output_mode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")])),
      "-A": Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
      "-B": Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
      "-C": Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
      "-n": Type.Optional(Type.Boolean()),
      "-i": Type.Optional(Type.Boolean()),
      "-o": Type.Optional(Type.Boolean()),
      type: Type.Optional(Type.String({ maxLength: 128 })),
      head_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
      multiline: Type.Optional(Type.Boolean()),
    }),
    outputSchema: Type.Union([
      strictObject({
        mode: Type.Literal("content"),
        records: Type.Array(grepContentRecord, { maxItems: 10_000 }),
        offset: nonNegativeInteger,
        limit: nonNegativeInteger,
        truncated: Type.Boolean(),
        durationMs: nonNegativeInteger,
      }),
      strictObject({
        mode: Type.Literal("files_with_matches"),
        records: Type.Array(grepFileRecord, { maxItems: 10_000 }),
        offset: nonNegativeInteger,
        limit: nonNegativeInteger,
        truncated: Type.Boolean(),
        durationMs: nonNegativeInteger,
      }),
      strictObject({
        mode: Type.Literal("count"),
        records: Type.Array(grepCountRecord, { maxItems: 10_000 }),
        offset: nonNegativeInteger,
        limit: nonNegativeInteger,
        truncated: Type.Boolean(),
        durationMs: nonNegativeInteger,
      }),
    ]),
    concurrency: "parallel",
    sideEffect: "read",
    timeoutMs: 30_000,
    outputLimits: outputLimits(262_144, 10_000),
    permissionClass: "workspace.search",
    checkpoint: "none",
    behaviorFixtureIds: ["content_mode_context", "files_with_matches_mode", "count_mode", "head_limit_and_offset", "multiline_and_abort"],
    resultSemantics: "Return bounded content, file-name, or count records with stable pagination and truncation metadata.",
    errorCodes: errors(
      ["path_denied", false, "The search root is outside an allowed read root."],
      ["invalid_pattern", false, "The expression or option combination is invalid."],
      ["search_dependency_missing", false, "The pinned ripgrep executable is unavailable."],
      ["search_failed", true, "The bounded search process fails."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
  bash: officialShellContract("bash"),
  pwsh: officialShellContract("pwsh"),
  job_output: officialShellContract("job_output"),
  job_list: officialShellContract("job_list"),
  job_kill: officialShellContract("job_kill"),
  ls: contract({
    name: "ls",
    description: "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
    inputSchema: strictObject({
      path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
    }),
    outputSchema: Type.String({ maxLength: 52 * 1_024 }),
    concurrency: "parallel",
    sideEffect: "read",
    timeoutMs: 30_000,
    outputLimits: outputLimits(52 * 1_024, 500),
    permissionClass: "workspace.read",
    checkpoint: "none",
    behaviorFixtureIds: ["exact_pi_description_and_schema", "alphabetical_directory_suffix", "dotfiles", "500_entry_or_50kb_truncation", "runtime_path_gate"],
    resultSemantics: "Return the retained lowercase ls textual result with alphabetical entries, directory suffixes, dotfiles, and exact truncation bounds.",
    errorCodes: errors(
      ["path_denied", false, "The target directory is outside the allowed workspace."],
      ["directory_not_found", false, "The target is absent or not a readable directory."],
      ["list_failed", true, "The bounded provider enumeration fails."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
  WebFetch: contract({
    name: "WebFetch",
    description: "Fetches an HTTP or HTTPS URL under the Runtime network policy, converts supported content, and answers the supplied prompt with a tool-free utility model call.",
    inputSchema: strictObject({
      url: Type.String({ format: "uri", maxLength: 2_048 }),
      prompt: Type.String({ minLength: 1, maxLength: 65_536 }),
    }),
    outputSchema: strictObject({
      url: Type.String({ format: "uri", maxLength: 2_048 }),
      finalUrl: Type.String({ format: "uri", maxLength: 2_048 }),
      answer: Type.String({ maxLength: 262_144 }),
      citations: Type.Array(citation, { maxItems: 256 }),
      usage: Type.Optional(tokenUsage),
      truncated: Type.Boolean(),
    }),
    concurrency: "parallel",
    sideEffect: "network",
    timeoutMs: 120_000,
    outputLimits: outputLimits(262_144, 256, { maxAttachmentBytes: 20 * 1_024 * 1_024 }),
    permissionClass: "network.fetch",
    checkpoint: "none",
    behaviorFixtureIds: ["http_html_to_markdown_answer", "pdf_or_text_fetch", "dns_pin_and_redirect_revalidation", "response_and_usage_bounds", "cancel_fetch_and_utility_call"],
    resultSemantics: "Return a bounded utility-model answer with final URL, citations, converted-content provenance, and separately metered usage.",
    errorCodes: errors(
      ["network_policy_denied", false, "The operation network policy denies the request or redirect."],
      ["unsafe_destination", false, "Scheme, credentials, DNS, IP, redirect, or rebinding checks reject the destination."],
      ["unsupported_content", false, "The response cannot be converted safely."],
      ["utility_model_failed", true, "The isolated tool-free utility call fails."],
    ),
    lifecycle: lifecycle("bounded_executor", "policy_required"),
  }),
  WebSearch: contract({
    name: "WebSearch",
    description: "Searches the web through a supported Provider server-side adapter and returns cited results and available service text. Warnings identify unverified results or domain filtering; do not present unverified text as confirmed sources. This tool is absent when the operation-frozen Provider has no compatible adapter.",
    inputSchema: strictObject({
      query: Type.String({ minLength: 1, maxLength: 8_192 }),
      allowed_domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 64, uniqueItems: true })),
      blocked_domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 64, uniqueItems: true })),
    }),
    outputSchema: strictObject({
      query: Type.String({ minLength: 1, maxLength: 8_192 }),
      answer: Type.Optional(Type.String({ maxLength: 65_536 })),
      warnings: Type.Optional(Type.Array(Type.Union([
        Type.Literal("unverified_search_results"),
        Type.Literal("unverified_domain_filter"),
      ]), { maxItems: 2, uniqueItems: true })),
      results: Type.Array(strictObject({
        title: Type.String({ minLength: 1, maxLength: 512 }),
        url: Type.String({ format: "uri", maxLength: 2_048 }),
        snippet: Type.String({ maxLength: 8_192 }),
      }), { maxItems: 100 }),
      citations: Type.Array(citation, { maxItems: 256 }),
      usage: Type.Optional(tokenUsage),
      truncated: Type.Boolean(),
      searchCount: nonNegativeInteger,
      durationMs: nonNegativeInteger,
    }),
    concurrency: "parallel",
    sideEffect: "network",
    timeoutMs: 120_000,
    outputLimits: outputLimits(262_144, 256),
    permissionClass: "network.search",
    checkpoint: "none",
    behaviorFixtureIds: ["provider_adapter_gating", "allowed_and_blocked_domains", "citations_and_usage", "max_uses_and_rate_limit", "cancel_provider_search"],
    resultSemantics: "Return bounded Provider-native cited results, available service text and separately attributable usage. Empty matches are valid; incomplete result formats retain text with explicit uncertainty. HTML scraping fallback is forbidden.",
    errorCodes: errors(
      ["web_search_unavailable", false, "The frozen Provider has no approved server-side search adapter."],
      ["domain_policy_invalid", false, "Domain constraints conflict or exceed bounds."],
      ["provider_search_failed", true, "The Provider returns a failure, rate limit, or invalid result."],
    ),
    lifecycle: lifecycle("bounded_executor", "policy_required"),
  }),
  AskUserQuestion: contract({
    name: "AskUserQuestion",
    description: "Asks one to four structured questions and waits without a human-decision timeout for the single registered response to this tool call. Use only when the interaction owner is available; the wait ends on an answer, explicit cancellation, or authoritative operation/Session termination.",
    inputSchema: strictObject({
      questions: Type.Array(strictObject({
        question: Type.String({ minLength: 1, maxLength: 2_048 }),
        header: Type.String({ minLength: 1, maxLength: 12 }),
        options: Type.Array(strictObject({
          label: Type.String({ minLength: 1, maxLength: 80, pattern: "^(?:\\S+)(?:\\s+\\S+){0,4}$" }),
          description: Type.String({ minLength: 1, maxLength: 512 }),
          preview: Type.Optional(Type.String({ maxLength: 4_096 })),
        }), { minItems: 2, maxItems: 4 }),
        multiSelect: Type.Boolean(),
      }), { minItems: 1, maxItems: 4 }),
    }),
    outputSchema: strictObject({
      interactionId: boundedIdentifier,
      answers: Type.Array(strictObject({
        questionIndex: Type.Integer({ minimum: 0, maximum: 3 }),
        selectedLabels: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 4, uniqueItems: true }),
        otherText: Type.Optional(Type.String({ maxLength: 4_096 })),
      }), { minItems: 1, maxItems: 4 }),
      policyRevision: revision,
    }),
    concurrency: "session_serial",
    sideEffect: "interaction",
    outputLimits: outputLimits(65_536, 32),
    permissionClass: "interaction.ask",
    checkpoint: "none",
    behaviorFixtureIds: ["single_and_multi_select", "other_free_text", "answer_cancel_race", "deterministic_headless_policy", "background_child_unavailable"],
    resultSemantics: "Return the one registered answer set, including explicit free text when Other is selected.",
    errorCodes: errors(
      ["interaction_unavailable", false, "No interactive or deterministic headless provider can answer."],
      ["interaction_rejected", false, "The interaction owner rejects or expires the request."],
      ["stale_interaction", false, "A late or duplicate response loses exactly-one settlement."],
    ),
    lifecycle: lifecycle("host_policy", "policy_required"),
  }),
  EnterPlanMode: contract({
    name: "EnterPlanMode",
    description: "Enters persisted plan mode and allocates or resumes its managed plan artifact. Plan mode immediately restricts execution to plan-safe actions.",
    inputSchema: emptyStrictObject,
    outputSchema: strictObject({ mode: Type.Literal("plan"), planPath: boundedPath, revision }),
    concurrency: "session_serial",
    sideEffect: "session_state",
    timeoutMs: 30_000,
    outputLimits: outputLimits(16_384, 16),
    permissionClass: "session.plan.enter",
    checkpoint: "none",
    behaviorFixtureIds: ["root_enters_and_catalog_restricts", "idempotent_existing_plan", "child_entry_rejected", "persistence_failure", "restart_restores_plan_mode"],
    resultSemantics: "Persist plan mode and return the managed plan artifact identity and revision before the restricted catalog becomes visible.",
    errorCodes: errors(
      ["plan_entry_forbidden", false, "The caller is not the root Agent or hard policy disallows entry."],
      ["plan_state_conflict", true, "The durable plan state cannot be created or resumed atomically."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
  ExitPlanMode: contract({
    name: "ExitPlanMode",
    description: "Submits the current managed plan revision for approval. Approval exits plan mode; rejection or cancellation keeps plan mode active.",
    inputSchema: emptyStrictObject,
    outputSchema: planExitOutput,
    concurrency: "session_serial",
    sideEffect: "interaction",
    timeoutMs: 600_000,
    outputLimits: outputLimits(262_144, 16),
    permissionClass: "session.plan.exit",
    checkpoint: "none",
    behaviorFixtureIds: ["approve_exits_atomically", "reject_preserves_plan_mode", "cancel_and_expire_preserve_plan_mode", "stale_revision", "restart_during_approval"],
    resultSemantics: "Approval returns the submitted plan and normal mode; rejection or cancellation returns feedback while plan mode remains active.",
    errorCodes: errors(
      ["interaction_unavailable", false, "No approval provider is available."],
      ["stale_plan_revision", true, "The submitted revision is no longer current."],
      ["plan_approval_rejected", false, "Approval is rejected, cancelled, or expired while plan mode remains active."],
    ),
    lifecycle: lifecycle("host_policy", "policy_required"),
  }),
  Skill: contract({
    name: "Skill",
    description: "Loads one model-invocable SKILL.md from the operation-visible approved DSH Skill catalog, strips frontmatter, expands deterministic arguments, and returns its bounded instructions inline.",
    inputSchema: strictObject({ skill: boundedIdentifier, args: Type.Optional(Type.String({ maxLength: 65_536 })) }),
    outputSchema: strictObject({
      skill: boundedIdentifier,
      content: Type.String({ maxLength: 262_144 }),
      source: boundedPath,
      sourceSha256: sha256,
      argumentsExpanded: Type.Boolean(),
    }),
    concurrency: "session_serial",
    sideEffect: "read",
    timeoutMs: 30_000,
    outputLimits: outputLimits(262_144, 16),
    permissionClass: "skill.load",
    checkpoint: "none",
    behaviorFixtureIds: ["visible_catalog_load", "frontmatter_removed", "argument_placeholder_expansion", "disabled_or_unknown_rejected", "duplicate_name_uses_catalog_winner"],
    resultSemantics: "Return bounded frontmatter-stripped instructions from the exact operation-visible declarative Skill catalog.",
    errorCodes: errors(
      ["skill_not_found", false, "The named Skill is absent from the frozen catalog."],
      ["skill_invocation_disabled", false, "The Skill disables model invocation."],
      ["skill_invalid", false, "The resource cannot be validated or expanded within bounds."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
  Agent: contract({
    name: "Agent",
    description: "Starts a supervised local child Agent with a fresh DSH context and the current bounded workspace/component snapshot. Omit subagent_type for the general descriptor; Explore and Plan provide read-only research/planning roles. Custom descriptors may narrow inherited tools. run_in_background defaults to true: omitted/true returns a background handle; false waits for this activation's result. All roles and both modes retain context for SendMessage follow-ups after completion. taskId addresses TaskStop, agentId addresses SendMessage. The first successful foreground result is returned only through this tool; background and follow-up completion reports arrive automatically. An idle retained handle is not still executing. TaskStop closes the handle and model messages cannot restart it.",
    inputSchema: strictObject({
      description: Type.String({ minLength: 1, maxLength: 80 }),
      prompt: Type.String({ minLength: 1, maxLength: 1_000_000 }),
      subagent_type: Type.Optional(boundedIdentifier),
      run_in_background: Type.Optional(Type.Boolean()),
      model: Type.Optional(boundedIdentifier),
    }),
    outputSchema: agentOutput,
    concurrency: "parallel",
    sideEffect: "delegation",
    timeoutMs: 600_000,
    outputLimits: outputLimits(262_144, 64, { maxRetainedOutputBytes: 8 * 1_024 * 1_024 }),
    permissionClass: "agent.spawn",
    checkpoint: "none",
    behaviorFixtureIds: ["foreground_child_terminal", "default_background_child_handle", "exact_model_alias", "background_permission_fail_closed", "stop_and_generation_cleanup"],
    resultSemantics: "Foreground returns this activation's result, usage, and continuable identity; background returns one supervised handle and output path. Execution completion and handle closure are separate.",
    errorCodes: errors(
      ["agent_unavailable", false, "No compatible child descriptor or model alias is visible."],
      ["child_nesting_forbidden", false, "A child attempts to spawn another child."],
      ["interaction_unavailable", false, "A background child requires unavailable interaction."],
      ["child_failed", true, "The supervised child reaches a failed terminal."],
    ),
    lifecycle: lifecycle("work_registry", "policy_required"),
  }),
  TaskStop: contract({
    name: "TaskStop",
    description: "Stops an owned child Agent by task ID and waits for terminal state and resource finalization.",
    inputSchema: strictObject({ task_id: boundedIdentifier }),
    outputSchema: strictObject({
      taskId: boundedIdentifier,
      kind: Type.Literal("agent"),
      terminal: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("aborted")]),
      alreadyTerminal: Type.Boolean(),
    }),
    concurrency: "session_serial",
    sideEffect: "session_state",
    timeoutMs: 120_000,
    outputLimits: outputLimits(16_384, 16),
    permissionClass: "work.stop",
    checkpoint: "none",
    behaviorFixtureIds: ["stop_process_tree", "stop_child", "already_terminal_idempotent", "cross_session_id_rejected", "waits_for_resource_finalizer"],
    resultSemantics: "Wait for the addressed work item to reach its existing or newly stopped terminal and finalize owned resources.",
    errorCodes: errors(
      ["task_not_found", false, "The task is unknown or belongs to another Runtime Session."],
      ["task_stop_failed", true, "The WorkRegistry cannot establish terminal cleanup."],
    ),
    lifecycle: lifecycle("work_registry", "allowed"),
  }),
  SendMessage: contract({
    name: "SendMessage",
    description: "Delivers an ordered plain-text message within the caller's root lineage. Use the agentId returned by Agent for one live child or sibling; a child may use the literal parent for the root. taskId, caller-defined names, broadcasts, team aliases, cross-Session recipients, and stopping or terminal Agents are unsupported. A queued receipt means admission for the recipient's next child-turn boundary, not interruption or completed work; delivered and queued are receipts, not terminal results.",
    inputSchema: strictObject({
      to: boundedIdentifier,
      summary: Type.String({ minLength: 1, maxLength: 200 }),
      message: boundedText,
    }),
    outputSchema: strictObject({
      messageId: boundedIdentifier,
      recipient: boundedIdentifier,
      state: Type.Union([Type.Literal("delivered"), Type.Literal("queued")]),
      sequence: nonNegativeInteger,
    }),
    concurrency: "session_serial",
    sideEffect: "delegation",
    timeoutMs: 120_000,
    outputLimits: outputLimits(16_384, 16),
    permissionClass: "agent.message",
    checkpoint: "none",
    behaviorFixtureIds: ["parent_child_sibling_delivery", "ordered_sequence", "stopped_child_resume", "terminal_recipient_notification", "broadcast_and_cross_session_rejected"],
    resultSemantics: "Return an ordered delivery receipt after resolving one exact live in-scope collaborator by agentId or the child-only parent alias.",
    errorCodes: errors(
      ["recipient_not_found", false, "The local recipient cannot be resolved."],
      ["recipient_out_of_scope", false, "The target is cross-Session, broadcast, team, or cloud-owned."],
      ["delivery_failed", true, "The ordered mailbox or resume path cannot accept the message."],
    ),
    lifecycle: lifecycle("work_registry", "allowed"),
  }),
  TaskCreate: contract({
    name: "TaskCreate",
    description: "Creates a task in the current Runtime Session-local TaskGraph. It does not create a product task or scheduled automation.",
    inputSchema: strictObject({
      subject: Type.String({ minLength: 1, maxLength: 512 }),
      description: Type.String({ minLength: 1, maxLength: 65_536 }),
      activeForm: Type.Optional(Type.String({ maxLength: 512 })),
      metadata: Type.Optional(boundedTaskMetadata),
    }),
    outputSchema: strictObject({ task: taskNode, revision }),
    concurrency: "session_serial",
    sideEffect: "session_state",
    timeoutMs: 30_000,
    outputLimits: outputLimits(65_536, 512),
    permissionClass: "task_graph.mutate",
    checkpoint: "none",
    behaviorFixtureIds: ["create_minimal_task", "create_with_active_form_and_metadata", "bounded_metadata", "append_snapshot_recovery", "session_local_scope"],
    resultSemantics: "Append one task to the Session-local TaskGraph and return its immutable ID and committed revision.",
    errorCodes: errors(
      ["task_graph_limit", false, "The graph or metadata bound is reached."],
      ["task_graph_conflict", true, "The append cannot commit against the current revision."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
  TaskGet: contract({
    name: "TaskGet",
    description: "Gets one task and its current dependency, owner, flat scalar metadata, and revision snapshot from the Session-local TaskGraph.",
    inputSchema: strictObject({ taskId: boundedIdentifier }),
    outputSchema: strictObject({ task: taskNode, revision }),
    concurrency: "parallel",
    sideEffect: "read",
    timeoutMs: 30_000,
    outputLimits: outputLimits(65_536, 512),
    permissionClass: "task_graph.read",
    checkpoint: "none",
    behaviorFixtureIds: ["get_current_task", "dependency_and_owner_projection", "unknown_task", "deleted_visibility", "restart_snapshot"],
    resultSemantics: "Return one task and graph revision from the durable Session-local projection.",
    errorCodes: errors(
      ["task_not_found", false, "The task is absent or not visible."],
      ["task_graph_unavailable", true, "The durable graph projection cannot be read safely."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
  TaskList: contract({
    name: "TaskList",
    description: "Lists a bounded, stable snapshot of non-deleted tasks in the current Runtime collaboration domain.",
    inputSchema: emptyStrictObject,
    outputSchema: strictObject({
      tasks: Type.Array(taskNode, { maxItems: 2_000 }),
      revision,
      truncated: Type.Boolean(),
    }),
    concurrency: "parallel",
    sideEffect: "read",
    timeoutMs: 30_000,
    outputLimits: outputLimits(262_144, 2_000),
    permissionClass: "task_graph.read",
    checkpoint: "none",
    behaviorFixtureIds: ["empty_graph", "stable_order", "cancelled_tasks_retained", "bounded_projection", "concurrent_snapshot_consistency"],
    resultSemantics: "Return a bounded stable task list and graph revision from the Session-local projection.",
    errorCodes: errors(
      ["task_graph_unavailable", true, "The durable graph projection cannot be read safely."],
      ["task_graph_limit", false, "The projection exceeds its declared output bound."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
  TaskUpdate: contract({
    name: "TaskUpdate",
    description: "Atomically updates one Session-local task, including status, ownership, dependencies, text, and bounded flat scalar metadata. When starting an unassigned task, owner may be omitted: the Runtime assigns the actual calling Agent. An existing owner is preserved; the root or current owner may explicitly transfer to root or a registered child agentId in this Session. Dependencies must remain acyclic.",
    inputSchema: strictObject({
      taskId: boundedIdentifier,
      status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")])),
      subject: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      description: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
      activeForm: Type.Optional(Type.String({ maxLength: 512 })),
      owner: Type.Optional(boundedIdentifier),
      addBlocks: Type.Optional(Type.Array(boundedIdentifier, { maxItems: 256, uniqueItems: true })),
      addBlockedBy: Type.Optional(Type.Array(boundedIdentifier, { maxItems: 256, uniqueItems: true })),
      metadata: Type.Optional(boundedTaskMetadata),
    }),
    outputSchema: strictObject({
      task: taskNode,
      revision,
      changedFields: Type.Array(taskChangedField, { minItems: 1, maxItems: 8, uniqueItems: true }),
    }),
    concurrency: "session_serial",
    sideEffect: "session_state",
    timeoutMs: 30_000,
    outputLimits: outputLimits(65_536, 512),
    permissionClass: "task_graph.mutate",
    checkpoint: "none",
    behaviorFixtureIds: ["status_and_text_update", "owner_and_metadata_update", "dependency_cycle_rejected", "terminal_transition_rejected", "append_snapshot_crash_recovery"],
    resultSemantics: "Atomically update one task and dependency graph and return the committed task, graph revision, and changed fields.",
    errorCodes: errors(
      ["task_not_found", false, "The target task does not exist."],
      ["task_dependency_invalid", false, "A dependency is absent, cross-Session, self-referential, or cyclic."],
      ["task_terminal_conflict", false, "The update attempts an invalid terminal transition."],
      ["task_graph_conflict", true, "The graph revision precondition fails."],
    ),
    lifecycle: lifecycle("bounded_executor", "allowed"),
  }),
} as const satisfies Record<CanonicalToolName, CanonicalToolContract>);

export const CANONICAL_TOOL_REUSE_MATRIX = deepFreeze({
  Read: { tool: "Read", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "file-tool-factories", importPath: "@deepseek-ai/dsh-tool-fs", classification: "helper", symbols: ["createReadTool", "createReadImageTool"] },
    { id: "filesystem", importPath: "@deepseek-ai/dsh-fs", classification: "provider", symbols: ["FileSystem"] },
    { id: "attachments", importPath: "@deepseek-ai/dsh-attachment", classification: "provider", symbols: ["AttachmentStore"] },
  ], productOwner: "@myagents-dsh/tools-fs", stockModelDefinition: "excluded" },
  Write: { tool: "Write", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "file-tool-factories", importPath: "@deepseek-ai/dsh-tool-fs", classification: "helper", symbols: ["createWriteTool"] },
    { id: "filesystem", importPath: "@deepseek-ai/dsh-fs", classification: "provider", symbols: ["FileSystem", "FsWriteIntent"] },
  ], productOwner: "@myagents-dsh/tools-fs", stockModelDefinition: "excluded" },
  Edit: { tool: "Edit", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "file-tool-factories", importPath: "@deepseek-ai/dsh-tool-fs", classification: "helper", symbols: ["createEditTool"] },
    { id: "local-file-provider", importPath: "@deepseek-ai/dsh-fs-local", classification: "helper", symbols: ["LocalFileSystem", "prepareTextEdit"] },
    { id: "filesystem", importPath: "@deepseek-ai/dsh-fs", classification: "provider", symbols: ["FileSystem", "FsEditRequest"] },
  ], productOwner: "@myagents-dsh/tools-fs", stockModelDefinition: "excluded" },
  Glob: { tool: "Glob", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "fs-search-helpers", importPath: "@deepseek-ai/dsh-tool-fs-search", classification: "helper", symbols: ["buildGlobCommand", "parseGlobArgs"] },
    { id: "subprocess", importPath: "@deepseek-ai/dsh-subprocess", classification: "provider", symbols: ["SubprocessRuntime"] },
  ], productOwner: "@myagents-dsh/tools-fs", stockModelDefinition: "excluded" },
  Grep: { tool: "Grep", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "fs-search-helpers", importPath: "@deepseek-ai/dsh-tool-fs-search", classification: "helper", symbols: ["buildGrepCommand", "parseGrepArgs"] },
    { id: "subprocess", importPath: "@deepseek-ai/dsh-subprocess", classification: "provider", symbols: ["SubprocessRuntime"] },
  ], productOwner: "@myagents-dsh/tools-fs", stockModelDefinition: "excluded" },
  bash: officialShellReuse("bash"),
  pwsh: officialShellReuse("pwsh"),
  job_output: officialShellReuse("job_output"),
  job_list: officialShellReuse("job_list"),
  job_kill: officialShellReuse("job_kill"),
  ls: { tool: "ls", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "filesystem", importPath: "@deepseek-ai/dsh-fs", classification: "provider", symbols: ["FileSystem"] },
  ], productOwner: "@myagents-dsh/tools-fs", stockModelDefinition: "excluded" },
  WebFetch: { tool: "WebFetch", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "web", importPath: "@deepseek-ai/dsh-web", classification: "provider", symbols: ["WebRuntime"] },
    { id: "web-helpers", importPath: "@deepseek-ai/dsh-tool-web", classification: "helper", symbols: ["formatFetchOutput", "parseFetchArgs"] },
  ], productOwner: "@myagents-dsh/tools-web", stockModelDefinition: "excluded" },
  WebSearch: { tool: "WebSearch", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "web", importPath: "@deepseek-ai/dsh-web", classification: "provider", symbols: ["WebRuntime"] },
    { id: "web-helpers", importPath: "@deepseek-ai/dsh-tool-web", classification: "helper", symbols: ["formatSearchOutput", "searchMetaFromValue"] },
  ], productOwner: "@myagents-dsh/tools-web", stockModelDefinition: "excluded" },
  AskUserQuestion: { tool: "AskUserQuestion", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "questions", importPath: "@deepseek-ai/dsh-user-questions", classification: "provider", symbols: ["UserQuestionService"] },
  ], productOwner: "@myagents-dsh/tools-interaction", stockModelDefinition: "excluded" },
  EnterPlanMode: { tool: "EnterPlanMode", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "plan-mode-fold", importPath: "@deepseek-ai/dsh-plan-mode", classification: "helper", symbols: ["planProjectionDefinition"] },
  ], productOwner: "@myagents-dsh/tools-interaction", stockModelDefinition: "excluded" },
  ExitPlanMode: { tool: "ExitPlanMode", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "plan-mode-fold", importPath: "@deepseek-ai/dsh-plan-mode", classification: "helper", symbols: ["planProjectionDefinition"] },
    { id: "questions", importPath: "@deepseek-ai/dsh-user-questions", classification: "provider", symbols: ["UserQuestionService"] },
  ], productOwner: "@myagents-dsh/tools-interaction", stockModelDefinition: "excluded" },
  Skill: { tool: "Skill", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "skills", importPath: "@deepseek-ai/dsh-skill", classification: "provider", symbols: ["SkillRegistry"] },
  ], productOwner: "@myagents-dsh/tools-agent", stockModelDefinition: "excluded" },
  Agent: { tool: "Agent", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "subagents", importPath: "@deepseek-ai/dsh-subagent", classification: "direct", symbols: ["SubagentRuntime"] },
    { id: "jobs", importPath: "@deepseek-ai/dsh-jobs", classification: "provider", symbols: ["JobRegistry"] },
  ], productOwner: "@myagents-dsh/tools-agent", stockModelDefinition: "excluded" },
  TaskStop: { tool: "TaskStop", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "subagents", importPath: "@deepseek-ai/dsh-subagent", classification: "direct", symbols: ["SubagentRuntime"] },
  ], productOwner: "@myagents-dsh/tools-agent", stockModelDefinition: "excluded" },
  SendMessage: { tool: "SendMessage", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "subagents", importPath: "@deepseek-ai/dsh-subagent", classification: "direct", symbols: ["SubagentRuntime"] },
  ], productOwner: "@myagents-dsh/tools-agent", stockModelDefinition: "excluded" },
  TaskCreate: { tool: "TaskCreate", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "session", importPath: "@deepseek-ai/dsh-session", classification: "product-plugin", symbols: ["Session"] },
  ], productOwner: "@myagents-dsh/task-graph", stockModelDefinition: "excluded" },
  TaskGet: { tool: "TaskGet", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "session", importPath: "@deepseek-ai/dsh-session", classification: "product-plugin", symbols: ["Session"] },
  ], productOwner: "@myagents-dsh/task-graph", stockModelDefinition: "excluded" },
  TaskList: { tool: "TaskList", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "session", importPath: "@deepseek-ai/dsh-session", classification: "product-plugin", symbols: ["Session"] },
  ], productOwner: "@myagents-dsh/task-graph", stockModelDefinition: "excluded" },
  TaskUpdate: { tool: "TaskUpdate", modelDefinition: "compat-tool", dshPublicReuse: [
    { id: "session", importPath: "@deepseek-ai/dsh-session", classification: "product-plugin", symbols: ["Session"] },
  ], productOwner: "@myagents-dsh/task-graph", stockModelDefinition: "excluded" },
} as const satisfies Record<CanonicalToolName, CanonicalToolReuseDecision>);

const fixtureTask = {
  id: "task-1",
  subject: "Fixture task",
  description: "A deterministic fixture",
  status: "pending",
  blockedBy: [],
  createdSequence: 1,
  updatedSequence: 1,
} as const;
const fixtureUsage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 2,
} as const;

const fixtureShellJob = { id: "job-1", kind: "bash", label: "Print fixture", status: "completed", startedAt: 1 };

export const CANONICAL_TOOL_SCHEMA_FIXTURES = deepFreeze({
  Read: { input: { file_path: "/fixture/read.txt" }, output: { path: "/fixture/read.txt", kind: "text", mimeType: "text/plain", offset: 1, lineCount: 1, truncated: false, content: "fixture" } },
  Write: { input: { file_path: "/fixture/write.txt", content: "fixture" }, output: { path: "/fixture/write.txt", bytes: 7, sha256: "a".repeat(64), created: true } },
  Edit: { input: { file_path: "/fixture/edit.txt", old_string: "old", new_string: "new" }, output: { path: "/fixture/edit.txt", replacements: 1, sha256: "b".repeat(64), externalChangesRetained: false } },
  Glob: { input: { pattern: "**/*.ts" }, output: { durationMs: 1, numFiles: 1, filenames: ["src/index.ts"], truncated: false } },
  Grep: { input: { pattern: "fixture" }, output: { mode: "content", records: [{ path: "src/index.ts", line: 1, text: "fixture" }], offset: 0, limit: 1, truncated: false, durationMs: 1 } },
  bash: { input: { command: "printf fixture", description: "Print fixture" }, output: { kind: "background", jobId: "job-1" } },
  pwsh: { input: { command: "Write-Output fixture", description: "Print fixture" }, output: { kind: "background", jobId: "job-1" } },
  job_output: { input: { job_id: "job-1" }, output: { text: "fixture", job: fixtureShellJob } },
  job_list: { input: {}, output: [] },
  job_kill: { input: { job_id: "job-1" }, output: { outcome: "already-finished", job: fixtureShellJob } },
  ls: { input: {}, output: "src/\npackage.json" },
  WebFetch: { input: { url: "https://example.invalid/fixture", prompt: "Summarize" }, output: { url: "https://example.invalid/fixture", finalUrl: "https://example.invalid/fixture", answer: "fixture", citations: [], usage: fixtureUsage, truncated: false } },
  WebSearch: { input: { query: "fixture" }, output: { query: "fixture", results: [], citations: [], usage: fixtureUsage, truncated: false, searchCount: 1, durationMs: 1 } },
  AskUserQuestion: { input: { questions: [{ question: "Continue?", header: "Choice", options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }], multiSelect: false }] }, output: { interactionId: "interaction-1", answers: [{ questionIndex: 0, selectedLabels: ["Yes"] }], policyRevision: "policy-1" } },
  EnterPlanMode: { input: {}, output: { mode: "plan", planPath: "/fixture/plan.md", revision: "plan-1" } },
  ExitPlanMode: { input: {}, output: { disposition: "approved", plan: "fixture plan", revision: "plan-1", mode: "normal" } },
  Skill: { input: { skill: "fixture" }, output: { skill: "fixture", content: "instructions", source: "skills/fixture/SKILL.md", sourceSha256: "c".repeat(64), argumentsExpanded: false } },
  Agent: { input: { description: "Review fixture changes", prompt: "Review the fixture" }, output: { taskId: "work-1", agentId: "agent-1", state: "succeeded", result: "done", resultTruncated: false, usage: fixtureUsage, model: "fixture-model" } },
  TaskStop: { input: { task_id: "work-1" }, output: { taskId: "work-1", kind: "agent", terminal: "aborted", alreadyTerminal: false } },
  SendMessage: { input: { to: "agent-1", summary: "Fixture update", message: "done" }, output: { messageId: "message-1", recipient: "agent-1", state: "delivered", sequence: 1 } },
  TaskCreate: { input: { subject: "Fixture task", description: "A deterministic fixture" }, output: { task: fixtureTask, revision: "task-graph-1" } },
  TaskGet: { input: { taskId: "task-1" }, output: { task: fixtureTask, revision: "task-graph-1" } },
  TaskList: { input: {}, output: { tasks: [fixtureTask], revision: "task-graph-1", truncated: false } },
  TaskUpdate: { input: { taskId: "task-1", status: "in_progress" }, output: { task: { ...fixtureTask, status: "in_progress", updatedSequence: 2 }, revision: "task-graph-2", changedFields: ["status"] } },
} as const satisfies Record<CanonicalToolName, { readonly input: unknown; readonly output: unknown }>);

export type CanonicalToolInput<Name extends CanonicalToolName> =
  Static<(typeof CANONICAL_TOOL_CONTRACTS)[Name]["inputSchema"]>;
export type CanonicalToolOutput<Name extends CanonicalToolName> =
  Static<(typeof CANONICAL_TOOL_CONTRACTS)[Name]["outputSchema"]>;

export const orderedCanonicalToolContracts = (): readonly CanonicalToolContract[] =>
  CANONICAL_TOOL_NAMES.map((name) => CANONICAL_TOOL_CONTRACTS[name]);

export const orderedCanonicalToolReuseMatrix = (): readonly CanonicalToolReuseDecision[] =>
  CANONICAL_TOOL_NAMES.map((name) => CANONICAL_TOOL_REUSE_MATRIX[name]);

export const canonicalToolContractAuthority = () => deepFreeze({
  artifactFormatVersion: 1 as const,
  profile: "canonical-agent-experience-v1" as const,
  source: TOOL_CONTRACT_SOURCE,
  canonicalJsonLimits: CANONICAL_JSON_LIMITS,
  canonicalTools: CANONICAL_TOOL_NAMES,
  contracts: orderedCanonicalToolContracts(),
});
