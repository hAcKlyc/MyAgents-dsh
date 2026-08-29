/** Compile-only evidence for every accepted Agent SDK 0.3.220 call group. */
import type {
  AgentInput as ReferenceAgentInput,
  BashInput as ReferenceBashInput,
  FileEditInput as ReferenceFileEditInput,
  FileReadInput as ReferenceFileReadInput,
  FileWriteInput as ReferenceFileWriteInput,
  GlobInput as ReferenceGlobInput,
  GrepInput as ReferenceGrepInput,
  TaskCreateInput as ReferenceTaskCreateInput,
  TaskGetInput as ReferenceTaskGetInput,
  TaskListInput as ReferenceTaskListInput,
  TaskUpdateInput as ReferenceTaskUpdateInput,
  TodoWriteInput as ReferenceTodoWriteInput,
  WebFetchInput as ReferenceWebFetchInput,
  WebSearchInput as ReferenceWebSearchInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import type { z } from "zod/v4";

import type {
  AcceptedAgentSdkOptions,
  AgentSdkCompatibilityExports,
  AgentInput,
  BashInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  HookCallback,
  HookJSONOutput,
  Query,
  SDKMessage,
  SDKUserMessage,
  TaskCreateInput,
  TaskGetInput,
  TaskListInput,
  TaskUpdateInput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
} from "./agent-sdk-0.3.220-shapes.js";

type Exact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left] ? true : false
  : false;
type Assert<Condition extends true> = Condition;
type ToolInputParity = [
  Assert<Exact<AgentInput, ReferenceAgentInput>>,
  Assert<Exact<BashInput, ReferenceBashInput>>,
  Assert<Exact<FileEditInput, ReferenceFileEditInput>>,
  Assert<Exact<FileReadInput, ReferenceFileReadInput>>,
  Assert<Exact<FileWriteInput, ReferenceFileWriteInput>>,
  Assert<Exact<GlobInput, ReferenceGlobInput>>,
  Assert<Exact<GrepInput, ReferenceGrepInput>>,
  Assert<Exact<TaskCreateInput, ReferenceTaskCreateInput>>,
  Assert<Exact<TaskGetInput, ReferenceTaskGetInput>>,
  Assert<Exact<TaskListInput, ReferenceTaskListInput>>,
  Assert<Exact<TaskUpdateInput, ReferenceTaskUpdateInput>>,
  Assert<Exact<TodoWriteInput, ReferenceTodoWriteInput>>,
  Assert<Exact<WebFetchInput, ReferenceWebFetchInput>>,
  Assert<Exact<WebSearchInput, ReferenceWebSearchInput>>,
];
const acceptToolParity = (...parity: ToolInputParity): ToolInputParity => parity;

const toolInputFixtures = {
  Agent: {
    description: "fixture task",
    prompt: "fixture",
    subagent_type: "reviewer",
    model: "fable",
    run_in_background: true,
    name: "fixture-agent",
    team_name: "deprecated-fixture",
    mode: "default",
    isolation: "worktree",
  } satisfies AgentInput,
  Bash: {
    command: "fixture",
    timeout: 1_000,
    description: "Run fixture",
    run_in_background: true,
    dangerouslyDisableSandbox: false,
  } satisfies BashInput,
  Edit: { file_path: "/fixture/a", old_string: "a", new_string: "b", replace_all: true } satisfies FileEditInput,
  Read: { file_path: "/fixture/a", offset: 1, limit: 2, pages: "1-2" } satisfies FileReadInput,
  Write: { file_path: "/fixture/a", content: "fixture" } satisfies FileWriteInput,
  Glob: { pattern: "**/*.ts", path: "/fixture" } satisfies GlobInput,
  Grep: {
    pattern: "fixture",
    path: "/fixture",
    glob: "*.ts",
    output_mode: "content",
    "-B": 1,
    "-A": 1,
    "-C": 1,
    context: 1,
    "-n": true,
    "-i": true,
    "-o": true,
    type: "ts",
    head_limit: 10,
    offset: 1,
    multiline: true,
  } satisfies GrepInput,
  TaskCreate: { subject: "fixture", description: "fixture", activeForm: "Running", metadata: { key: true } } satisfies TaskCreateInput,
  TaskGet: { taskId: "task-1" } satisfies TaskGetInput,
  TaskList: {} satisfies TaskListInput,
  TaskUpdate: {
    taskId: "task-1",
    subject: "fixture",
    description: "fixture",
    activeForm: "Running",
    status: "in_progress",
    addBlocks: ["task-2"],
    addBlockedBy: ["task-3"],
    owner: "fixture-owner",
    metadata: { key: null },
  } satisfies TaskUpdateInput,
  TodoWrite: {
    todos: [{ content: "fixture", status: "in_progress", activeForm: "Running" }],
  } satisfies TodoWriteInput,
  WebFetch: { url: "https://fixture.invalid", prompt: "fixture" } satisfies WebFetchInput,
  WebSearch: {
    query: "fixture",
    allowed_domains: ["fixture.invalid"],
    blocked_domains: ["blocked.invalid"],
  } satisfies WebSearchInput,
} as const;

const hook: HookCallback = (input, toolUseId, options): Promise<HookJSONOutput> => {
  if (input.hook_event_name === "PostToolUse") void input.tool_response;
  if (input.hook_event_name === "PermissionRequest") void input.agent_id;
  void toolUseId;
  void options.signal;
  return Promise.resolve({ continue: true });
};

const acceptedOptions = (abortController: AbortController): AcceptedAgentSdkOptions => ({
  abortController,
  agents: {
    reviewer: {
      description: "fixture",
      tools: ["Read"],
      disallowedTools: ["Bash"],
      prompt: "fixture",
      model: "fixture-model",
      mcpServers: ["fixture-server"],
      criticalSystemReminder_EXPERIMENTAL: "fixture",
      skills: ["fixture-skill"],
      initialPrompt: "fixture",
      maxTurns: 2,
      background: true,
      memory: "project",
      effort: "high",
      permissionMode: "default",
      observer: "fixture-observer",
      observerMessage: "fixture",
    },
  },
  allowDangerouslySkipPermissions: true,
  allowedTools: ["Read"],
  canUseTool: (_toolName, input, { signal, title, displayName }) => {
    void signal;
    void title;
    void displayName;
    return Promise.resolve({ behavior: "allow" as const, updatedInput: input });
  },
  cwd: "/fixture/workspace",
  disallowedTools: ["Bash"],
  effort: "high",
  enableFileCheckpointing: true,
  env: { LANG: "C.UTF-8", OPTIONAL: undefined },
  extraArgs: { "replay-user-messages": null },
  forkSession: true,
  hooks: {
    PermissionRequest: [{ matcher: "*", hooks: [hook], timeout: 1_000 }],
    PostToolUse: [{ hooks: [hook] }],
    PreToolUse: [{ hooks: [hook] }],
  },
  includePartialMessages: true,
  maxTurns: 4,
  mcpServers: {
    http: { type: "http", url: "https://fixture.invalid/mcp" },
    stdio: { type: "stdio", command: "fixture", args: ["--fixture"], env: { LANG: "C" } },
  },
  model: "fixture-model",
  pathToClaudeCodeExecutable: "/fixture/runtime",
  permissionMode: "default",
  persistSession: true,
  plugins: [{ type: "local", path: "/fixture/plugin" }],
  resume: "session-source",
  resumeSessionAt: "message-source",
  sessionId: "session-target",
  settingSources: ["project"],
  settings: {
    cleanupPeriodDays: 30,
    disableArtifact: true,
    disableBundledSkills: true,
    feedbackDrafts: "off",
    plansDirectory: "/fixture/plans",
    skipWebFetchPreflight: true,
  },
  skills: ["fixture-skill"],
  stderr: (message) => { void message; },
  systemPrompt: { type: "preset", preset: "claude_code", append: "fixture" },
  thinking: { type: "adaptive", display: "summarized" },
  toolConfig: { askUserQuestion: { previewFormat: "html" } },
  tools: ["Read", "Edit"],
});

const consumeMessage = (message: SDKMessage): void => {
  switch (message.type) {
    case "assistant": void message.message.stop_reason; break;
    case "user": void ("isReplay" in message ? message.isReplay : undefined); break;
    case "result": void message.terminal_reason; break;
    case "stream_event": void message.event; break;
    case "system": {
      switch (message.subtype) {
        case "init": void message.slash_commands; break;
        case "status": void message.status; break;
        case "api_retry": void message.retry_delay_ms; break;
        case "compact_boundary": void message.compact_metadata.pre_tokens; break;
        case "commands_changed": void message.commands; break;
        case "task_notification": void message.status; break;
        case "task_started": void message.description; break;
        case "task_updated": void message.patch; break;
        case "session_state_changed": void message.state; break;
      }
    }
  }
};

const consumeQuery = (queryHandle: Query): void => {
  void queryHandle.next();
  void queryHandle.initializationResult().then((result) => result.component_status);
  void queryHandle.interrupt().then((receipt) => receipt?.still_queued);
  void queryHandle.setPermissionMode("plan");
  void queryHandle.setModel("fixture-model");
  void queryHandle.setModel();
  void queryHandle.getContextUsage().then((usage) => usage.rawMaxTokens);
  void queryHandle.setMcpServers({ http: { type: "sse", url: "https://fixture.invalid/mcp" } });
  void queryHandle.mcpServerStatus();
  void queryHandle.reloadSkills();
  void queryHandle.rewindFiles("message-1");
  void queryHandle.cancelAsyncMessage("message-2");
  queryHandle.close();
};

const compileAcceptedCalls = async (
  sdk: AgentSdkCompatibilityExports,
  abortController: AbortController,
  streamingPrompt: AsyncIterable<SDKUserMessage>,
  stringSchema: z.ZodString,
): Promise<void> => {
  const options = acceptedOptions(abortController);
  const queryHandle = sdk.query({ prompt: streamingPrompt, options });
  consumeQuery(queryHandle);
  consumeMessage((await queryHandle.next()).value as SDKMessage);
  void sdk.query({ prompt: "fixture", options: { ...options, systemPrompt: "fixture" } });

  const definition = sdk.tool(
    "fixture_tool",
    "fixture",
    { input: stringSchema },
    (args, extra) => {
      void args;
      void extra;
      return Promise.resolve({ content: [{ type: "text", text: "fixture" }] });
    },
    { annotations: { readOnlyHint: true }, searchHint: "fixture", alwaysLoad: true },
  );
  const server = sdk.createSdkMcpServer({
    name: "fixture",
    version: "1.0.0",
    instructions: "fixture",
    tools: [definition],
    alwaysLoad: true,
  });
  void sdk.query({ prompt: "fixture", options: { mcpServers: { fixture: server } } });

  await sdk.getSessionMessages("session-1", {
    dir: "/fixture/workspace",
    limit: 100,
    offset: 0,
    includeSystemMessages: true,
  });
  const forked = await sdk.forkSession("session-1", {
    dir: "/fixture/workspace",
    upToMessageId: "message-1",
  });
  await sdk.deleteSession(forked.sessionId, { dir: "/fixture/workspace" });
};

void acceptedOptions;
void acceptToolParity;
void compileAcceptedCalls;
void consumeMessage;
void consumeQuery;
void toolInputFixtures;
