import { installProxyFromEnvironment, proxyRouteFor } from "@deepseek-ai/dsh-http-proxy";
import { LocalFileSystem, prepareTextEdit } from "@deepseek-ai/dsh-fs-local";
import { createReadTool, createReadImageTool, createWriteTool, createEditTool, type ReadToolCaps } from "@deepseek-ai/dsh-tool-fs";
import * as OfficialBashLocal from "@deepseek-ai/dsh-bash-local";
import * as OfficialPwshLocal from "@deepseek-ai/dsh-pwsh-local";
import * as OfficialShellEnv from "@deepseek-ai/dsh-shell-env";
import * as OfficialToolBash from "@deepseek-ai/dsh-tool-bash";
import * as OfficialToolJobs from "@deepseek-ai/dsh-tool-jobs";
import * as OfficialToolPwsh from "@deepseek-ai/dsh-tool-pwsh";
import { Context, Service } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from "@deepseek-ai/dsh-agent";
import {
  Config as AgentInstructionsConfigValue,
  apply as applyAgentInstructions,
  name as agentInstructionsName,
} from "@deepseek-ai/dsh-agent-instructions";
import type { Config as AgentInstructionsConfig } from "@deepseek-ai/dsh-agent-instructions";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import type { Config as AgentLoopConfig } from "@deepseek-ai/dsh-agent-loop";
import { AttachmentId, AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { ImageAttachmentRef, StoredImageAttachment } from "@deepseek-ai/dsh-attachment";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  prepareImageFile,
} from "@deepseek-ai/dsh-attachment-local";
import { CredentialProvider, credentialRef } from "@deepseek-ai/dsh-credentials";
import type { CredentialInfo, ResolvedCredential } from "@deepseek-ai/dsh-credentials";
import { CompactionEngine, CompactionId } from "@deepseek-ai/dsh-compaction";
import type { CompactionAgentContext, CompactionResult } from "@deepseek-ai/dsh-compaction";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import type { BasicCompactionConfig } from "@deepseek-ai/dsh-compaction-basic";
import { DEFAULTS as TOOL_RESULT_PRUNER_DEFAULTS, ToolResultPruner } from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import type { PruneResult, ToolResultPruneConfig } from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import { CommandId, CommandRuntime, parseCommand } from "@deepseek-ai/dsh-commands";
import type {
  CommandDefinition,
  CommandExecution,
  CommandInputDescriptor,
  CommandInvocation,
  CommandResult,
  ParsedCommand,
} from "@deepseek-ai/dsh-commands";
import { FileSystem, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import type { FsEditRequest, FsWriteIntent } from "@deepseek-ai/dsh-fs";
import { JobId, JobRegistry } from "@deepseek-ai/dsh-jobs";
import type { JobView, JobRead } from "@deepseek-ai/dsh-jobs";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import type { Config as LocalJobRegistryConfig } from "@deepseek-ai/dsh-jobs-local";
import { LlmAdapter, LlmError, LlmRuntime, assertUsableApiKey, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DeepSeekAdapter,
  PUBLIC_BASE_URL,
} from "@deepseek-ai/dsh-llm-deepseek";
import { SettingsForms } from "@deepseek-ai/dsh-settings";
import type { SettingsNamespace, SettingsPathOp } from "@deepseek-ai/dsh-settings";
import type { DeepSeekConnectionOptions, RequestDefaults } from "@deepseek-ai/dsh-llm-deepseek";
import { apply as applyMcpClient } from "@deepseek-ai/dsh-mcp-client";
import type { Config as McpConfig, McpResult } from "@deepseek-ai/dsh-mcp-client";
import { PlanModeController, planProjectionDefinition } from "@deepseek-ai/dsh-plan-mode";
import type { PlanProjection } from "@deepseek-ai/dsh-plan-mode";
import { SqliteSessionQueryEngine } from "@deepseek-ai/dsh-session-query-sqlite";
import { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import { deepFreeze, snapshotJsonValue } from "@deepseek-ai/dsh-util-values";
import { Session, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import type { Scope, ScopeKey, Scoped } from "@deepseek-ai/dsh-scope";
import { validateStoredEvents, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import type { SessionHandle, SessionInspection, SessionPersistenceSnapshot } from "@deepseek-ai/dsh-session-persistence";
import { ShellExecutor, parseExitStatus } from "@deepseek-ai/dsh-shell";
import type { ShellExecRequest, ShellRunResult } from "@deepseek-ai/dsh-shell";
import { isModelInvocable, isSkillName, renderSkillContent, SkillRegistry } from "@deepseek-ai/dsh-skill";
import type {
  SkillCandidate,
  SkillDefinition,
  SkillInvocationPolicy,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillSummary,
} from "@deepseek-ai/dsh-skill";
import { finalAssistantOutput, SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type { SubagentInterruptAuthority, SubagentProvider, SubagentResult } from "@deepseek-ai/dsh-subagent";
import { startInProcessRun } from "@deepseek-ai/dsh-subagent-in-process-driver";
import type { InProcessRunOptions } from "@deepseek-ai/dsh-subagent-in-process-driver";
import { apply as applySubagentSpawnInProcess } from "@deepseek-ai/dsh-subagent-spawn-in-process";
import type { Config as SubagentSpawnInProcessConfig } from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { SubprocessRuntime, scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { PromptAssembly, PromptContext, PromptSection } from "@deepseek-ai/dsh-system-prompt";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import type { Deadline } from "@deepseek-ai/dsh-timeout";
import { TOOL_TIMEOUT, apply as applyToolCallTimeoutPolicy } from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { deriveTurnTokenUsage } from "@deepseek-ai/dsh-token-meter/client";
import type { ContextPressureProjection, TokenUsageProjection } from "@deepseek-ai/dsh-token-meter/client";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import type { TokenMeasurement, TokenMeterConfig } from "@deepseek-ai/dsh-token-meter";
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { buildGlobCommand, buildGrepCommand, parseGlobArgs, parseGrepArgs } from "@deepseek-ai/dsh-tool-fs-search";
import type { GlobInput, GrepInput, RipgrepRun } from "@deepseek-ai/dsh-tool-fs-search";
import { formatFetchOutput, formatSearchOutput, parseFetchArgs, searchMetaFromValue } from "@deepseek-ai/dsh-tool-web";
import type { WebFetchMeta, WebSearchMeta } from "@deepseek-ai/dsh-tool-web";
import { ApprovalRequestId, ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { UserQuestionService } from "@deepseek-ai/dsh-user-questions";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import type { WebFetchProvider, WebSearchProvider } from "@deepseek-ai/dsh-web";

export const dshPublicSurfaceValues = Object.freeze({
  officialShell: [OfficialBashLocal, OfficialPwshLocal, OfficialShellEnv, OfficialToolBash, OfficialToolJobs, OfficialToolPwsh],
  AgentLoop,
  AgentRegistry,
  AgentInstructionsConfigValue,
  agentInstructionsName,
  ApprovalRequestId,
  ApprovalService,
  AttachmentId,
  AttachmentStore,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  CompactionEngine,
  CompactionId,
  BasicCompactionEngine,
  ToolResultPruner,
  TOOL_RESULT_PRUNER_DEFAULTS,
  CommandId,
  CommandRuntime,
  Context,
  CredentialProvider,
  FileSystem,
  FsTargetKey,
  FsVersion,
  JobId,
  JobRegistry,
  LocalJobRegistry,
  LlmAdapter,
  LlmError,
  LlmRuntime,
  DeepSeekAdapter,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  PUBLIC_BASE_URL,
  validateStoredEvents,
  PlanModeController,
  Service,
  Session,
  SessionId,
  SessionPersistence,
  SessionStore,
  SessionQueryEngine,
  SqliteSessionQueryEngine,
  deepFreeze,
  snapshotJsonValue,
  ShellExecutor,
  SkillRegistry,
  SubagentRuntime,
  finalAssistantOutput,
  SubprocessRuntime,
  LocalSubprocessRuntime,
  SystemPrompt,
  TOOL_TIMEOUT,
  TokenMeter,
  deriveTurnTokenUsage,
  ToolRuntime,
  SettingsForms,
  UserQuestionService,
  WebRuntime,
  applyMcpClient,
  applyAgentInstructions,
  applySubagentSpawnInProcess,
  applyToolCallTimeoutPolicy,
  assertUsableApiKey,
  buildGlobCommand,
  buildGrepCommand,
  credentialRef,
  createScope,
  deadline,
  defineTool,
  prepareImageFile,
  planProjectionDefinition,
  formatFetchOutput,
  formatSearchOutput,
  parseFetchArgs,
  parseGlobArgs,
  parseGrepArgs,
  searchMetaFromValue,
  parseExitStatus,
  parseCommand,
  scrubbedParentEnv,
  scopeOf,
  isModelInvocable,
  isSkillName,
  renderSkillContent,
  resolveRetryPolicy,
  startInProcessRun,
  timeoutOf,
});

export interface DshPublicSurfaceTypes {
  agent: [Agent, AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions];
  agentInstructions: [AgentInstructionsConfig];
  agentLoop: [AgentLoopConfig];
  approval: [ApprovalOutcome, ApprovalRequest];
  attachment: [ImageAttachmentRef, StoredImageAttachment];
  cordis: [Plugin];
  compaction: [CompactionAgentContext, CompactionResult];
  compactionBasic: [BasicCompactionConfig];
  compactionToolResultPruner: [PruneResult, ToolResultPruneConfig];
  commands: [CommandDefinition, CommandExecution, CommandInputDescriptor, CommandInvocation, CommandResult, ParsedCommand];
  credentials: [CredentialInfo, ResolvedCredential];
  filesystem: [FsEditRequest, FsWriteIntent];
  fsSearchHelpers: [GlobInput, GrepInput, RipgrepRun];
  jobs: [JobView, JobRead];
  jobsLocal: [LocalJobRegistryConfig];
  llm: [GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk];
  llmDeepSeek: [DeepSeekConnectionOptions, RequestDefaults];
  settings: [SettingsNamespace, SettingsPathOp];
  mcp: [McpConfig, McpResult];
  persistence: [SessionHandle, SessionInspection, SessionPersistenceSnapshot];
  planMode: [PlanProjection];
  session: [SessionEvent, SessionHeader];
  scope: [Scope, ScopeKey, Scoped<object>];
  shell: [ShellExecRequest, ShellRunResult];
  skill: [
    SkillCandidate,
    SkillDefinition,
    SkillInvocationPolicy,
    SkillLookupOptions,
    SkillProvider,
    SkillProviderControl,
    SkillSummary,
  ];
  subagent: [SubagentInterruptAuthority, SubagentProvider, SubagentResult];
  subagentInProcess: [InProcessRunOptions];
  subagentSpawnInProcess: [SubagentSpawnInProcessConfig];
  subprocess: [SubprocessHandle, SubprocessSpawnSpec];
  systemPrompt: [PromptAssembly, PromptContext, PromptSection];
  timeout: [Deadline];
  tools: [ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext];
  tokenMeter: [TokenMeasurement, TokenMeterConfig];
  tokenMeterClient: [ContextPressureProjection, TokenUsageProjection];
  userQuestions: [AskUserQuestionRequest];
  web: [WebFetchProvider, WebSearchProvider];
  webHelpers: [WebFetchMeta, WebSearchMeta];
}

export const officialFileComposition = { LocalFileSystem, prepareTextEdit, createReadTool, createReadImageTool, createWriteTool, createEditTool };
export type OfficialReadCaps = ReadToolCaps;

export const officialNetworkComposition = { installProxyFromEnvironment, proxyRouteFor };
