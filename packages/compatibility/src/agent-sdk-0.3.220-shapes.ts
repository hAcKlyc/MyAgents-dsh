/**
 * Sanitized, declaration-only view of the accepted Agent SDK 0.3.220 surface.
 * Exact public field and generic shapes come from the pinned development-only
 * reference package; this module does not import its runtime implementation.
 */
import type {
  AgentDefinition as ReferenceAgentDefinition,
  CanUseTool as ReferenceCanUseTool,
  EffortLevel as ReferenceEffortLevel,
  ForkSessionOptions as ReferenceForkSessionOptions,
  GetSessionMessagesOptions as ReferenceGetSessionMessagesOptions,
  HookCallback as ReferenceHookCallback,
  HookCallbackMatcher as ReferenceHookCallbackMatcher,
  HookJSONOutput as ReferenceHookJSONOutput,
  McpSdkServerConfigWithInstance as ReferenceMcpSdkServerConfigWithInstance,
  McpServerConfig as ReferenceMcpServerConfig,
  Options as ReferenceOptions,
  PermissionMode as ReferencePermissionMode,
  PermissionRequestHookInput as ReferencePermissionRequestHookInput,
  PostToolUseHookInput as ReferencePostToolUseHookInput,
  PreToolUseHookInput as ReferencePreToolUseHookInput,
  RewindFilesResult as ReferenceRewindFilesResult,
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKCommandsChangedMessage,
  SDKCompactBoundaryMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKStatusMessage,
  SDKSystemMessage as ReferenceSDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKUserMessage as ReferenceSDKUserMessage,
  SDKUserMessageReplay,
  SdkMcpToolDefinition as ReferenceSdkMcpToolDefinition,
  SessionMessage as ReferenceSessionMessage,
  SlashCommand as ReferenceSlashCommand,
  TerminalReason as ReferenceTerminalReason,
  ThinkingConfig as ReferenceThinkingConfig,
  createSdkMcpServer as referenceCreateSdkMcpServer,
  tool as referenceTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentInput as ReferenceAgentInput,
  BashInput as ReferenceBashInput,
  FileEditInput as ReferenceFileEditInput,
  FileReadInput as ReferenceFileReadInput,
  FileWriteInput as ReferenceFileWriteInput,
  GlobInput as ReferenceGlobInput,
  GrepInput as ReferenceGrepInput,
  NotebookEditInput as ReferenceNotebookEditInput,
  TaskCreateInput as ReferenceTaskCreateInput,
  TaskGetInput as ReferenceTaskGetInput,
  TaskListInput as ReferenceTaskListInput,
  TaskUpdateInput as ReferenceTaskUpdateInput,
  TodoWriteInput as ReferenceTodoWriteInput,
  WebFetchInput as ReferenceWebFetchInput,
  WebSearchInput as ReferenceWebSearchInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";

export const AGENT_SDK_0_3_220_SHAPE_PROVENANCE = {
  acceptedRuntimeCommit: "b7bbcadb172254defc0ea86229dd5de043fbb5f3",
  acceptedManifestGitBlob: "fc3e694d5482eaeaf0597bae94999b5c3333549a",
  acceptedFacadeTypesGitBlob: "4608b2d279866cb747e29aa00032ee2ebf9078f0",
  acceptedCompileFixtureGitBlob: "2391c7982adc34a7e361058e60eb327fd9b56998",
  publicShapeCommit: "eee6be92086ebf0e9eb1af994fbedaddde4aea76",
  package: "@anthropic-ai/claude-agent-sdk",
  version: "0.3.220",
  tarballIntegrity: "sha512-glc7SdwPkOkLw8oxwLo9PKTdLJGqW/PIR4urWXFoRtX9YllwozsEVc5Tc1+EvLSkfrsxPJqQWqOgpjUOQXf1oA==",
} as const;

export type PermissionMode = ReferencePermissionMode;
export type EffortLevel = ReferenceEffortLevel;
export type ThinkingConfig = ReferenceThinkingConfig;
export type AgentDefinition = ReferenceAgentDefinition;
export type SlashCommand = ReferenceSlashCommand;
export type TerminalReason = ReferenceTerminalReason;

export type AgentInput = ReferenceAgentInput;
export type BashInput = ReferenceBashInput;
export type FileEditInput = ReferenceFileEditInput;
export type FileReadInput = ReferenceFileReadInput;
export type FileWriteInput = ReferenceFileWriteInput;
export type GlobInput = ReferenceGlobInput;
export type GrepInput = ReferenceGrepInput;
export type TaskCreateInput = ReferenceTaskCreateInput;
export type TaskGetInput = ReferenceTaskGetInput;
export type TaskListInput = ReferenceTaskListInput;
export type TaskUpdateInput = ReferenceTaskUpdateInput;
export type TodoWriteInput = ReferenceTodoWriteInput;
export type WebFetchInput = ReferenceWebFetchInput;
export type WebSearchInput = ReferenceWebSearchInput;
export type NotebookEditInput = ReferenceNotebookEditInput;

export type SDKUserMessage = ReferenceSDKUserMessage;
export type SDKMessage =
  | SDKAssistantMessage
  | ReferenceSDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKPartialAssistantMessage
  | ReferenceSDKSystemMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKAPIRetryMessage
  | SDKCommandsChangedMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskUpdatedMessage
  | SDKSessionStateChangedMessage;
export type SDKSystemMessage = Extract<SDKMessage, { type: "system" }>;

export type PreToolUseHookInput = ReferencePreToolUseHookInput;
export type PostToolUseHookInput = ReferencePostToolUseHookInput;
export type PermissionRequestHookInput = ReferencePermissionRequestHookInput;
export type HookInput = PreToolUseHookInput | PostToolUseHookInput | PermissionRequestHookInput;
export type HookJSONOutput = ReferenceHookJSONOutput;
export type HookCallback = ReferenceHookCallback;
export type HookCallbackMatcher = ReferenceHookCallbackMatcher;
export type CanUseTool = ReferenceCanUseTool;
export type SdkMcpToolDefinition = ReferenceSdkMcpToolDefinition;
export type McpSdkServerConfigWithInstance = ReferenceMcpSdkServerConfigWithInstance;
export type McpServerConfig = ReferenceMcpServerConfig;

type DirectAcceptedOptionKey =
  | "abortController"
  | "agents"
  | "allowDangerouslySkipPermissions"
  | "allowedTools"
  | "canUseTool"
  | "cwd"
  | "disallowedTools"
  | "effort"
  | "enableFileCheckpointing"
  | "env"
  | "forkSession"
  | "includePartialMessages"
  | "maxTurns"
  | "mcpServers"
  | "model"
  | "pathToClaudeCodeExecutable"
  | "permissionMode"
  | "persistSession"
  | "resume"
  | "resumeSessionAt"
  | "sessionId"
  | "skills"
  | "stderr"
  | "systemPrompt"
  | "thinking"
  | "toolConfig"
  | "tools";
type ReferenceHooks = NonNullable<ReferenceOptions["hooks"]>;

export type AcceptedAgentSdkSettings = {
  cleanupPeriodDays?: number;
  disableArtifact?: boolean;
  disableBundledSkills?: boolean;
  feedbackDrafts?: "off";
  plansDirectory?: string;
  skipWebFetchPreflight?: boolean;
};
export type AcceptedAgentSdkOptions = Pick<ReferenceOptions, DirectAcceptedOptionKey> & {
  hooks?: Partial<Pick<ReferenceHooks, "PermissionRequest" | "PostToolUse" | "PreToolUse">>;
  settingSources?: Array<"project">;
  settings?: AcceptedAgentSdkSettings;
  plugins?: Array<{ type: "local"; path: string }>;
  extraArgs?: { "replay-user-messages"?: null };
};

export type QueryInitializationResult = {
  session_id: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  skills: string[];
  agents: string[];
  commands: SlashCommand[];
  component_status: Array<{ key: string; state: string; reason?: string }>;
};
export type RewindFilesResult = ReferenceRewindFilesResult;
export interface Query extends AsyncGenerator<SDKMessage, void> {
  initializationResult(): Promise<QueryInitializationResult>;
  interrupt(): Promise<{ still_queued: string[]; cancelled: string[] } | undefined>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  getContextUsage(): Promise<{ totalTokens: number; maxTokens: number; rawMaxTokens: number; model: string }>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  }>;
  mcpServerStatus(): Promise<Array<{ name: string; status: string }>>;
  reloadSkills(): Promise<{ skills: string[] }>;
  rewindFiles(messageId: string): Promise<RewindFilesResult>;
  cancelAsyncMessage(messageId: string): Promise<boolean>;
  close(): void;
}
export type QueryParams = { prompt: string | AsyncIterable<SDKUserMessage>; options?: AcceptedAgentSdkOptions };

export type SessionMessage = ReferenceSessionMessage;
export type GetSessionMessagesOptions = ReferenceGetSessionMessagesOptions;
export type ForkSessionOptions = ReferenceForkSessionOptions;

export type AgentSdkCompatibilityExports = {
  query(params: QueryParams): Query;
  getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
  forkSession(sessionId: string, options?: ForkSessionOptions): Promise<{ sessionId: string }>;
  deleteSession(sessionId: string, options?: { dir?: string }): Promise<void>;
  tool: typeof referenceTool;
  createSdkMcpServer: typeof referenceCreateSdkMcpServer;
};
