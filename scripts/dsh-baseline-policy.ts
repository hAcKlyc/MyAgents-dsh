import ts from "typescript";

type JsonObject = Record<string, unknown>;

export const expectedDshDependencies = new Map([
  ["@deepseek-ai/cordis", "4.0.1"],
  ["@deepseek-ai/dsh-agent", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-agent-loop", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-agent-presets", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-attachment", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-commands", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-compaction", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-credentials", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-fs", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-invariants", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-jobs", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-jobs-local", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-llm", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-llm-deepseek", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-mcp-client", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-plan-mode", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-sandbox", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-sandbox-policy", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-scope", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-session", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-session-persistence", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-session-persistence-sqlite", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-session-projection", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-session-projection-cache", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-settings", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-shell", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-skill", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-storage", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-storage-domain", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-subagent", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-subagent-in-process-driver", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-subagent-spawn-in-process", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-subprocess", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-subprocess-local", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-system-prompt", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-timeout", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-tool-call-timeout-policy", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-tool-fs-search", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-tool-web", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-tools", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-typert-protocol", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-user-approval", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-user-questions", "0.1.0-rc.6"],
  ["@deepseek-ai/dsh-web", "0.1.0-rc.6"],
] as const);

export interface PublicSeamEvidence {
  id: string;
  package: string;
  importPath: string;
  classification: "direct" | "provider" | "helper" | "excluded-stock";
  batchUse: string[];
  values: string[];
  types: string[];
}

export const publicSeams: PublicSeamEvidence[] = [
  { id: "cordis", package: "@deepseek-ai/cordis", importPath: "@deepseek-ai/cordis", classification: "direct", batchUse: ["B1-W1"], values: ["Context", "Service"], types: ["Plugin"] },
  { id: "scope", package: "@deepseek-ai/dsh-scope", importPath: "@deepseek-ai/dsh-scope", classification: "direct", batchUse: ["B1-W1", "B1-W2", "B1-W3"], values: ["createScope", "scopeOf"], types: ["Scope", "ScopeKey", "Scoped"] },
  { id: "session", package: "@deepseek-ai/dsh-session", importPath: "@deepseek-ai/dsh-session", classification: "direct", batchUse: ["B1-W1", "B1-W4"], values: ["Session", "SessionId", "SessionStore"], types: ["SessionEvent", "SessionHeader"] },
  { id: "agent", package: "@deepseek-ai/dsh-agent", importPath: "@deepseek-ai/dsh-agent", classification: "direct", batchUse: ["B1-W1"], values: ["AgentRegistry"], types: ["Agent", "AgentFactory", "AgentHandle", "CreateAgentOptions", "ResumeAgentOptions"] },
  { id: "agent-loop", package: "@deepseek-ai/dsh-agent-loop", importPath: "@deepseek-ai/dsh-agent-loop", classification: "direct", batchUse: ["B1-W1"], values: ["AgentLoop"], types: ["Config"] },
  { id: "tools", package: "@deepseek-ai/dsh-tools", importPath: "@deepseek-ai/dsh-tools", classification: "direct", batchUse: ["B1-W1", "B1-W2", "B1-W3"], values: ["ToolRuntime", "defineTool"], types: ["ToolDefinition", "ToolExecution", "ToolExecutionResult", "ToolRunContext"] },
  { id: "llm", package: "@deepseek-ai/dsh-llm", importPath: "@deepseek-ai/dsh-llm", classification: "provider", batchUse: ["B1-W1", "B1-W3"], values: ["LlmAdapter", "LlmError", "LlmRuntime", "assertUsableApiKey", "resolveRetryPolicy"], types: ["GenerateOptions", "LlmModelInfo", "LlmProviderInfo", "LlmResolvedModelInfo", "StreamChunk"] },
  { id: "llm-deepseek", package: "@deepseek-ai/dsh-llm-deepseek", importPath: "@deepseek-ai/dsh-llm-deepseek", classification: "provider", batchUse: ["B1-W3"], values: ["DEFAULT_STREAM_IDLE_TIMEOUT_MS", "DeepSeekAdapter", "PUBLIC_BASE_URL"], types: ["DeepSeekConnectionOptions", "RequestDefaults"] },
  { id: "system-prompt", package: "@deepseek-ai/dsh-system-prompt", importPath: "@deepseek-ai/dsh-system-prompt", classification: "direct", batchUse: ["B1-W1", "B1-W3"], values: ["SystemPrompt"], types: ["PromptAssembly", "PromptContext", "PromptSection"] },
  { id: "persistence", package: "@deepseek-ai/dsh-session-persistence", importPath: "@deepseek-ai/dsh-session-persistence", classification: "provider", batchUse: ["B1-W1", "B1-W4"], values: ["PersistenceCoordinator", "SessionPersistence"], types: ["PersistenceBackend", "SessionInspection", "SessionPersistenceSnapshot"] },
  { id: "sqlite-persistence", package: "@deepseek-ai/dsh-session-persistence-sqlite", importPath: "@deepseek-ai/dsh-session-persistence-sqlite", classification: "helper", batchUse: ["B1-W1", "B1-W4"], values: ["SqliteSessionPersistence"], types: ["Config"] },
  { id: "compaction", package: "@deepseek-ai/dsh-compaction", importPath: "@deepseek-ai/dsh-compaction", classification: "provider", batchUse: ["B1-W4"], values: ["CompactionEngine", "CompactionId"], types: ["CompactionAgentContext", "CompactionResult"] },
  { id: "mcp", package: "@deepseek-ai/dsh-mcp-client", importPath: "@deepseek-ai/dsh-mcp-client", classification: "excluded-stock", batchUse: ["B1-W3"], values: ["apply"], types: ["Config", "McpResult"] },
  { id: "skills", package: "@deepseek-ai/dsh-skill", importPath: "@deepseek-ai/dsh-skill", classification: "provider", batchUse: ["B1-W2", "B1-W3"], values: ["SkillRegistry", "isModelInvocable", "isSkillName", "renderSkillContent"], types: ["SkillCandidate", "SkillDefinition", "SkillInvocationPolicy", "SkillLookupOptions", "SkillProvider", "SkillProviderControl", "SkillSummary"] },
  { id: "subagents", package: "@deepseek-ai/dsh-subagent", importPath: "@deepseek-ai/dsh-subagent", classification: "direct", batchUse: ["B1-W2"], values: ["SubagentRuntime", "finalAssistantOutput"], types: ["SubagentInterruptAuthority", "SubagentProvider", "SubagentResult"] },
  { id: "subagent-in-process-driver", package: "@deepseek-ai/dsh-subagent-in-process-driver", importPath: "@deepseek-ai/dsh-subagent-in-process-driver", classification: "helper", batchUse: ["B1-W2"], values: ["startInProcessRun"], types: ["InProcessRunOptions"] },
  { id: "subagent-spawn-in-process", package: "@deepseek-ai/dsh-subagent-spawn-in-process", importPath: "@deepseek-ai/dsh-subagent-spawn-in-process", classification: "provider", batchUse: ["B1-W2"], values: ["apply"], types: ["Config"] },
  { id: "jobs", package: "@deepseek-ai/dsh-jobs", importPath: "@deepseek-ai/dsh-jobs", classification: "provider", batchUse: ["B1-W2"], values: ["JobId", "JobRegistry"], types: ["JobSnapshot", "JobStart"] },
  { id: "jobs-local", package: "@deepseek-ai/dsh-jobs-local", importPath: "@deepseek-ai/dsh-jobs-local", classification: "provider", batchUse: ["B1-W2"], values: ["LocalJobRegistry"], types: ["Config"] },
  { id: "approval", package: "@deepseek-ai/dsh-user-approval", importPath: "@deepseek-ai/dsh-user-approval", classification: "provider", batchUse: ["B1-W2", "B1-W3"], values: ["ApprovalRequestId", "ApprovalService"], types: ["ApprovalOutcome", "ApprovalRequest"] },
  { id: "questions", package: "@deepseek-ai/dsh-user-questions", importPath: "@deepseek-ai/dsh-user-questions", classification: "provider", batchUse: ["B1-W2", "B1-W3"], values: ["UserQuestionService"], types: ["AskUserQuestionRequest", "UserQuestionProvider"] },
  { id: "credentials", package: "@deepseek-ai/dsh-credentials", importPath: "@deepseek-ai/dsh-credentials", classification: "provider", batchUse: ["B1-W3"], values: ["CredentialProvider", "credentialRef"], types: ["CredentialInfo", "ResolvedCredential"] },
  { id: "attachments", package: "@deepseek-ai/dsh-attachment", importPath: "@deepseek-ai/dsh-attachment", classification: "provider", batchUse: ["B1-W2", "B1-W3"], values: ["AttachmentId", "AttachmentStore"], types: ["ImageAttachmentRef", "StoredImageAttachment"] },
  { id: "filesystem", package: "@deepseek-ai/dsh-fs", importPath: "@deepseek-ai/dsh-fs", classification: "provider", batchUse: ["B1-W2"], values: ["FileSystem", "FsTargetKey", "FsVersion"], types: ["FsEditRequest", "FsWriteIntent"] },
  { id: "subprocess", package: "@deepseek-ai/dsh-subprocess", importPath: "@deepseek-ai/dsh-subprocess", classification: "provider", batchUse: ["B1-W2"], values: ["SubprocessRuntime", "scrubbedParentEnv"], types: ["SubprocessHandle", "SubprocessSpawnSpec"] },
  { id: "subprocess-local", package: "@deepseek-ai/dsh-subprocess-local", importPath: "@deepseek-ai/dsh-subprocess-local", classification: "provider", batchUse: ["B1-W2"], values: ["LocalSubprocessRuntime"], types: [] },
  { id: "shell", package: "@deepseek-ai/dsh-shell", importPath: "@deepseek-ai/dsh-shell", classification: "provider", batchUse: ["B1-W2"], values: ["ShellExecutor", "parseExitStatus"], types: ["ShellExecRequest", "ShellRunResult"] },
  { id: "tool-call-timeout-policy", package: "@deepseek-ai/dsh-tool-call-timeout-policy", importPath: "@deepseek-ai/dsh-tool-call-timeout-policy", classification: "provider", batchUse: ["B1-W2"], values: ["TOOL_TIMEOUT", "apply"], types: [] },
  { id: "web", package: "@deepseek-ai/dsh-web", importPath: "@deepseek-ai/dsh-web", classification: "provider", batchUse: ["B1-W2"], values: ["WebRuntime"], types: ["WebFetchProvider", "WebSearchProvider"] },
  { id: "plan-mode", package: "@deepseek-ai/dsh-plan-mode", importPath: "@deepseek-ai/dsh-plan-mode", classification: "direct", batchUse: ["B1-W2"], values: ["PlanModeController", "foldPlanMode"], types: ["PlanProjection"] },
  { id: "fs-search-helpers", package: "@deepseek-ai/dsh-tool-fs-search", importPath: "@deepseek-ai/dsh-tool-fs-search", classification: "helper", batchUse: ["B1-W2"], values: ["buildGlobCommand", "buildGrepCommand", "parseGlobArgs", "parseGrepArgs"], types: ["GlobInput", "GrepInput", "RipgrepRun"] },
  { id: "web-helpers", package: "@deepseek-ai/dsh-tool-web", importPath: "@deepseek-ai/dsh-tool-web", classification: "helper", batchUse: ["B1-W2"], values: ["formatFetchOutput", "formatSearchOutput", "parseFetchArgs", "parseSearchArgs"], types: ["WebFetchMeta", "WebSearchMeta"] },
];

const allowedPublicDshImportPaths = new Set(publicSeams.map(({ importPath }) => importPath));

export const knownLimitations = [
  {
    id: "source-release-association-unproven",
    effect: "The executable npm rc.6 bytes have no published gitHead and are not claimed to correspond byte-for-byte to the fixed rc.5 source commit.",
    decision: "Treat the lockfile tarball URLs and integrities as executable authority and the fixed commit as separate source/design evidence.",
  },
  {
    id: "private-export-wildcards-forbidden",
    effect: "Several upstream packages export ./src/* even though those paths are not a supported product seam.",
    decision: "Repository policy and the executable import scanner reject every @deepseek-ai/*/src/* and @deepseek-ai/*/dist/* import.",
  },
  {
    id: "pre-tool-input-rewrite-missing",
    effect: "The public tools/pre-execute seam runs after durable call identity and cannot authoritatively replace tool arguments.",
    decision: "Keep the Batch 1 transformed-input Spike and minimal upstream-ready patch decision mandatory.",
  },
  {
    id: "persistence-mutations-missing",
    effect: "The public SessionPersistence contract is append-only and has no delete, replace, retention, or transaction operation.",
    decision: "Implement a product Provider and companion mutation service over one owned backend without private imports.",
  },
  {
    id: "downstream-known-events-not-registered",
    effect: "The stock persistence coordinator's generated known-event set cannot include downstream declaration-merged product events.",
    decision: "The persistence Spike must prove a public predicate seam or record a minimal upstream-ready patch; required product events may not be marked ignorable.",
  },
  {
    id: "mcp-public-types-require-dom-library",
    effect: "The public MCP client type graph reaches @modelcontextprotocol/sdk declarations that reference HeadersInit.",
    decision: "The compile-evidence project explicitly includes DOM and DOM.Iterable libraries; Runtime behavior remains Node-owned and must not assume a browser environment.",
  },
] as const;

export const licenseObligations = [
  { license: "BSD-2-Clause", obligation: "Retain the copyright notice, license conditions, and disclaimer in redistributed source or binary materials." },
  { license: "BSD-3-Clause", obligation: "Retain the copyright notice, license conditions, disclaimer, and non-endorsement condition." },
  { license: "ISC", obligation: "Retain the copyright and permission notice with redistributed copies." },
  { license: "MIT", obligation: "Retain the copyright and permission notice in substantial copies or distributions." },
  { license: "Python-2.0", obligation: "Reproduce the Python license and applicable notices; re-audit the exact packaged text before any public binary release." },
] as const;

interface LockEntry extends JsonObject {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  integrity?: string;
  license?: string;
  optional?: boolean;
  resolved?: string;
  version?: string;
}

interface PackageLock extends JsonObject {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const packageNameFromLockPath = (path: string): string => {
  const marker = "node_modules/";
  const start = path.lastIndexOf(marker);
  if (start < 0) throw new Error(`not a registry package path: ${path}`);
  return path.slice(start + marker.length);
};

const resolveDependencyPath = (
  packages: Record<string, LockEntry>,
  fromPath: string,
  dependency: string,
): string | undefined => {
  let base = fromPath;
  for (;;) {
    const candidate = `${base ? `${base}/` : ""}node_modules/${dependency}`;
    if (packages[candidate] !== undefined) return candidate;
    const parentMarker = base.lastIndexOf("/node_modules/");
    if (parentMarker < 0) return packages[`node_modules/${dependency}`] === undefined
      ? undefined
      : `node_modules/${dependency}`;
    base = base.slice(0, parentMarker);
  }
};

const requireString = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${description} must be a non-empty string`);
  return value;
};

export const buildDshBaseline = (rootPackage: JsonObject, lockfile: PackageLock): JsonObject => {
  const dependencies = rootPackage.dependencies;
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    throw new Error("root dependencies must be an object");
  }
  const dependencyEntries = Object.entries(dependencies as JsonObject).sort(([left], [right]) => compareCodePoints(left, right));
  if (JSON.stringify(dependencyEntries) !== JSON.stringify([...expectedDshDependencies.entries()])) {
    throw new Error("root DSH dependency set or exact versions differ from the accepted baseline");
  }
  if (lockfile.lockfileVersion !== 3 || lockfile.packages === undefined) {
    throw new Error("package-lock.json must use lockfileVersion 3 and contain packages");
  }

  const packages = lockfile.packages;
  const rootLock = packages[""];
  if (rootLock === undefined) throw new Error("package-lock.json is missing its root package entry");
  const rootLockDependencyEntries = Object.entries(rootLock.dependencies ?? {}).sort(([left], [right]) => compareCodePoints(left, right));
  if (JSON.stringify(rootLockDependencyEntries) !== JSON.stringify(dependencyEntries)) {
    throw new Error("package-lock root dependencies must equal the exact accepted DSH dependency authority");
  }
  const directPaths = new Set<string>();
  const pending: string[] = [];
  for (const [name, version] of dependencyEntries) {
    const path = resolveDependencyPath(packages, "", name);
    if (path === undefined) throw new Error(`lockfile does not resolve direct dependency ${name}`);
    const entry = packages[path];
    if (entry?.version !== version) throw new Error(`${name} must resolve to ${String(version)}, found ${String(entry?.version)}`);
    directPaths.add(path);
    pending.push(path);
  }

  const closure = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || closure.has(path)) continue;
    closure.add(path);
    const entry = packages[path];
    if (entry === undefined) throw new Error(`missing lock entry ${path}`);
    const dependencyNames = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}).filter(
        (name) => entry.peerDependenciesMeta?.[name]?.optional !== true,
      ),
    ]);
    for (const name of [...dependencyNames].sort(compareCodePoints)) {
      const resolved = resolveDependencyPath(packages, path, name);
      if (resolved === undefined) throw new Error(`${path} does not resolve required dependency ${name}`);
      pending.push(resolved);
    }
  }

  const productionPackages = [...closure].sort(compareCodePoints).map((path) => {
    const entry = packages[path];
    if (entry === undefined) throw new Error(`missing lock entry ${path}`);
    const resolved = requireString(entry.resolved, `${path} resolved URL`);
    if (!resolved.startsWith("https://registry.npmjs.org/")) {
      throw new Error(`${path} must resolve from the canonical npm registry`);
    }
    return {
      path,
      name: packageNameFromLockPath(path),
      version: requireString(entry.version, `${path} version`),
      resolved,
      integrity: requireString(entry.integrity, `${path} integrity`),
      license: requireString(entry.license, `${path} license`),
      direct: directPaths.has(path),
      optional: entry.optional === true,
    };
  });
  const licenseCounts = Object.entries(
    productionPackages.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.license] = (counts[entry.license] ?? 0) + 1;
      return counts;
    }, {}),
  ).sort(([left], [right]) => compareCodePoints(left, right)).map(([license, count]) => ({ license, count }));
  const recordedObligationLicenses = licenseObligations.map(({ license }) => license).sort(compareCodePoints);
  const observedLicenses = licenseCounts.map(({ license }) => license);
  if (JSON.stringify(recordedObligationLicenses) !== JSON.stringify(observedLicenses)) {
    throw new Error(`license obligations must exactly cover the production closure: observed ${observedLicenses.join(", ")}`);
  }

  return {
    formatVersion: 1,
    generatedFrom: ["package.json", "package-lock.json", "scripts/dsh-baseline-policy.ts"],
    sourceBaseline: {
      repository: "https://github.com/deepseek-ai/deepseek-harness.git",
      commit: "47f943859bef60e4160492346772ded9b24f765a",
      tree: "f904efab9ef435201d6ba4da88a34d6366568272",
      declaredRelease: "0.1.0-rc.5",
      license: "MIT",
      licenseSha256: "ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be",
    },
    executableBaseline: {
      registry: "https://registry.npmjs.org",
      dshRelease: "0.1.0-rc.6",
      sourceAssociation: "unproven",
      directPackageCount: directPaths.size,
      productionPackageCount: productionPackages.length,
    },
    publicCompileFixture: "packages/product-profile/src/dsh-public-surface.compile.ts",
    publicSeams,
    knownLimitations,
    licenseCounts,
    licenseObligations,
    productionPackages,
  };
};

export const serializeDshBaseline = (baseline: JsonObject): string => `${JSON.stringify(baseline, null, 2)}\n`;

const staticStringValue = (expression: ts.Expression): string | undefined => {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return staticStringValue(expression.expression);
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return staticStringValue(expression.expression);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(expression.left);
    const right = staticStringValue(expression.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const substitution = staticStringValue(span.expression);
      if (substitution === undefined) return undefined;
      value += substitution + span.literal.text;
    }
    return value;
  }
  return undefined;
};

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const requireTargetKind = (
  expression: ts.Expression,
  requireAliases: ReadonlySet<string>,
  createRequireNames: ReadonlySet<string>,
  moduleObjectNames: ReadonlySet<string>,
): "require" | "require.resolve" | undefined => {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target) && requireAliases.has(target.text)) return "require";
  if (ts.isCallExpression(target)) {
    const factory = unwrapExpression(target.expression);
    if (isCreateRequireFactory(factory, createRequireNames, moduleObjectNames)) return "require";
  }
  if (ts.isPropertyAccessExpression(target)) {
    const owner = unwrapExpression(target.expression);
    if (ts.isIdentifier(owner) && requireAliases.has(owner.text) && target.name.text === "resolve") return "require.resolve";
  }
  if (ts.isElementAccessExpression(target)) {
    const owner = unwrapExpression(target.expression);
    if (
      ts.isIdentifier(owner)
      && requireAliases.has(owner.text)
      && staticStringValue(target.argumentExpression) === "resolve"
    ) return "require.resolve";
  }
  return undefined;
};

const isCreateRequireFactory = (
  expression: ts.Expression,
  createRequireNames: ReadonlySet<string>,
  moduleObjectNames: ReadonlySet<string>,
): boolean => {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return createRequireNames.has(target.text);
  if (ts.isPropertyAccessExpression(target)) {
    const owner = unwrapExpression(target.expression);
    return ts.isIdentifier(owner)
      && moduleObjectNames.has(owner.text)
      && target.name.text === "createRequire";
  }
  if (ts.isElementAccessExpression(target)) {
    const owner = unwrapExpression(target.expression);
    return ts.isIdentifier(owner)
      && moduleObjectNames.has(owner.text)
      && staticStringValue(target.argumentExpression) === "createRequire";
  }
  return false;
};

interface ModuleLoadAnalysis {
  specifiers: string[];
  unresolvedDynamicLoads: string[];
}

export const analyzeModuleLoads = (sourceText: string, filename = "source.ts"): ModuleLoadAnalysis => {
  const source = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const unresolvedDynamicLoads: string[] = [];
  const createRequireNames = new Set(["createRequire"]);
  const moduleObjectNames = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || (statement.moduleSpecifier.text !== "node:module" && statement.moduleSpecifier.text !== "module")) continue;
    const importClause = statement.importClause;
    if (importClause?.name !== undefined) moduleObjectNames.add(importClause.name.text);
    const bindings = importClause?.namedBindings;
    if (bindings !== undefined) {
      if (ts.isNamespaceImport(bindings)) {
        moduleObjectNames.add(bindings.name.text);
      } else {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "createRequire") {
            createRequireNames.add(element.name.text);
          }
        }
      }
    }
  }
  const requireAliases = new Set(["require"]);
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    const addAlias = (set: Set<string>, name: string): void => {
      if (!set.has(name)) {
        set.add(name);
        aliasesChanged = true;
      }
    };
    const collectLoaderAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isIdentifier(node.name)) {
          if (ts.isIdentifier(initializer) && moduleObjectNames.has(initializer.text)) {
            addAlias(moduleObjectNames, node.name.text);
          }
          if (isCreateRequireFactory(initializer, createRequireNames, moduleObjectNames)) {
            addAlias(createRequireNames, node.name.text);
          }
          if (ts.isCallExpression(initializer)
            && isCreateRequireFactory(initializer.expression, createRequireNames, moduleObjectNames)) {
            addAlias(requireAliases, node.name.text);
          }
          if (ts.isIdentifier(initializer) && requireAliases.has(initializer.text)) {
            addAlias(requireAliases, node.name.text);
          }
        } else if (ts.isObjectBindingPattern(node.name)
          && ts.isIdentifier(initializer) && moduleObjectNames.has(initializer.text)) {
          for (const element of node.name.elements) {
            const importedName = element.propertyName?.getText(source) ?? element.name.getText(source);
            if (importedName === "createRequire" && ts.isIdentifier(element.name)) {
              addAlias(createRequireNames, element.name.text);
            }
          }
        }
      }
      ts.forEachChild(node, collectLoaderAliases);
    };
    collectLoaderAliases(source);
  }
  const requireReferences = new Map<number, ts.Identifier>();
  const consumedRequireReferences = new Set<number>();
  const addExpression = (expression: ts.Expression | undefined, node: ts.Node, kind: string): void => {
    const value = expression === undefined ? undefined : staticStringValue(expression);
    if (value === undefined) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      unresolvedDynamicLoads.push(`${kind} at ${filename}:${position.line + 1}:${position.character + 1}`);
    } else {
      specifiers.push(value);
    }
  };
  const consumeRequireReferences = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && requireAliases.has(node.text)) consumedRequireReferences.add(node.getStart(source));
    ts.forEachChild(node, consumeRequireReferences);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && requireAliases.has(node.text)
      && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
      requireReferences.set(node.getStart(source), node);
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addExpression(node.moduleReference.expression, node, "import-equals");
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const argument = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireKind = requireTargetKind(node.expression, requireAliases, createRequireNames, moduleObjectNames);
      if (isDynamicImport || requireKind !== undefined) {
        if (requireKind !== undefined) consumeRequireReferences(node.expression);
        addExpression(argument, node, isDynamicImport ? "dynamic import" : requireKind ?? "require");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [position, node] of requireReferences) {
    if (consumedRequireReferences.has(position)) continue;
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    unresolvedDynamicLoads.push(`unresolved require reference at ${filename}:${location.line + 1}:${location.character + 1}`);
  }
  return { specifiers, unresolvedDynamicLoads };
};

export const moduleSpecifiers = (sourceText: string, filename = "source.ts"): string[] =>
  analyzeModuleLoads(sourceText, filename).specifiers;

export const forbiddenPrivateImports = (sourceText: string, filename = "source.ts"): string[] =>
  moduleSpecifiers(sourceText, filename).filter((specifier) => {
    const normalized = specifier.replaceAll("\\", "/");
    if (/(?:^|\/)node_modules\/@deepseek-ai\//u.test(normalized)) return true;
    if (!normalized.startsWith("@deepseek-ai/")) return false;
    return !allowedPublicDshImportPaths.has(normalized);
  });

export const unresolvedDynamicModuleLoads = (sourceText: string, filename = "source.ts"): string[] =>
  analyzeModuleLoads(sourceText, filename).unresolvedDynamicLoads;

export const namedImports = (sourceText: string, filename = "source.ts"): Map<string, Set<string>> => {
  const source = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, Set<string>>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const names = imports.get(statement.moduleSpecifier.text) ?? new Set<string>();
    for (const element of bindings.elements) names.add(element.propertyName?.text ?? element.name.text);
    imports.set(statement.moduleSpecifier.text, names);
  }
  return imports;
};

export const missingCompileImports = (sourceText: string): string[] => {
  const imports = namedImports(sourceText);
  const failures: string[] = [];
  for (const seam of publicSeams) {
    const names = imports.get(seam.importPath);
    for (const symbol of [...seam.values, ...seam.types]) {
      if (!names?.has(symbol)) failures.push(`${seam.importPath} must import ${symbol}`);
    }
  }
  return failures;
};
