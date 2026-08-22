import { Context, Service } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from "@deepseek-ai/dsh-agent";
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
import type { JobSnapshot, JobStart } from "@deepseek-ai/dsh-jobs";
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
import type { DeepSeekConnectionOptions, RequestDefaults } from "@deepseek-ai/dsh-llm-deepseek";
import { apply as applyMcpClient } from "@deepseek-ai/dsh-mcp-client";
import type { Config as McpConfig, McpResult } from "@deepseek-ai/dsh-mcp-client";
import { PlanModeController, foldPlanMode } from "@deepseek-ai/dsh-plan-mode";
import type { PlanProjection } from "@deepseek-ai/dsh-plan-mode";
import { Session, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import type { Scope, ScopeKey, Scoped } from "@deepseek-ai/dsh-scope";
import { PersistenceCoordinator, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import type { PersistenceBackend, SessionInspection, SessionPersistenceSnapshot } from "@deepseek-ai/dsh-session-persistence";
import { SqliteSessionPersistence } from "@deepseek-ai/dsh-session-persistence-sqlite";
import type { Config as SqlitePersistenceConfig } from "@deepseek-ai/dsh-session-persistence-sqlite";
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
import { TOOL_TIMEOUT, apply as applyToolCallTimeoutPolicy } from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { buildGlobCommand, buildGrepCommand, parseGlobArgs, parseGrepArgs } from "@deepseek-ai/dsh-tool-fs-search";
import type { GlobInput, GrepInput, RipgrepRun } from "@deepseek-ai/dsh-tool-fs-search";
import { formatFetchOutput, formatSearchOutput, parseFetchArgs, searchMetaFromValue } from "@deepseek-ai/dsh-tool-web";
import type { WebFetchMeta, WebSearchMeta } from "@deepseek-ai/dsh-tool-web";
import { ApprovalRequestId, ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { UserQuestionService } from "@deepseek-ai/dsh-user-questions";
import type { AskUserQuestionRequest, UserQuestionProvider } from "@deepseek-ai/dsh-user-questions";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import type { WebFetchProvider, WebSearchProvider } from "@deepseek-ai/dsh-web";

export const dshPublicSurfaceValues = Object.freeze({
  AgentLoop,
  AgentRegistry,
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
  PersistenceCoordinator,
  PlanModeController,
  Service,
  Session,
  SessionId,
  SessionPersistence,
  SessionStore,
  ShellExecutor,
  SkillRegistry,
  SqliteSessionPersistence,
  SubagentRuntime,
  finalAssistantOutput,
  SubprocessRuntime,
  LocalSubprocessRuntime,
  SystemPrompt,
  TOOL_TIMEOUT,
  ToolRuntime,
  UserQuestionService,
  WebRuntime,
  applyMcpClient,
  applySubagentSpawnInProcess,
  applyToolCallTimeoutPolicy,
  assertUsableApiKey,
  buildGlobCommand,
  buildGrepCommand,
  credentialRef,
  createScope,
  defineTool,
  prepareImageFile,
  foldPlanMode,
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
});

export interface DshPublicSurfaceTypes {
  agent: [Agent, AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions];
  agentLoop: [AgentLoopConfig];
  approval: [ApprovalOutcome, ApprovalRequest];
  attachment: [ImageAttachmentRef, StoredImageAttachment];
  cordis: [Plugin];
  compaction: [CompactionAgentContext, CompactionResult];
  commands: [CommandDefinition, CommandExecution, CommandInputDescriptor, CommandInvocation, CommandResult, ParsedCommand];
  credentials: [CredentialInfo, ResolvedCredential];
  filesystem: [FsEditRequest, FsWriteIntent];
  fsSearchHelpers: [GlobInput, GrepInput, RipgrepRun];
  jobs: [JobSnapshot, JobStart];
  jobsLocal: [LocalJobRegistryConfig];
  llm: [GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk];
  llmDeepSeek: [DeepSeekConnectionOptions, RequestDefaults];
  mcp: [McpConfig, McpResult];
  persistence: [PersistenceBackend, SessionInspection, SessionPersistenceSnapshot];
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
  sqlitePersistence: [SqlitePersistenceConfig];
  subagent: [SubagentInterruptAuthority, SubagentProvider, SubagentResult];
  subagentInProcess: [InProcessRunOptions];
  subagentSpawnInProcess: [SubagentSpawnInProcessConfig];
  subprocess: [SubprocessHandle, SubprocessSpawnSpec];
  systemPrompt: [PromptAssembly, PromptContext, PromptSection];
  tools: [ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext];
  userQuestions: [AskUserQuestionRequest, UserQuestionProvider];
  web: [WebFetchProvider, WebSearchProvider];
  webHelpers: [WebFetchMeta, WebSearchMeta];
}
