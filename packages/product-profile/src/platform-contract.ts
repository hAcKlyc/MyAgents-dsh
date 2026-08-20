import { posix, win32 } from "node:path";

export const PLATFORM_CONTRACT_VERSION = "platform-adapters-v1" as const;

export const PLATFORM_TARGETS = Object.freeze([
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
] as const);

export type PlatformTarget = (typeof PLATFORM_TARGETS)[number];

export const resolveRuntimePlatformTarget = (
  platform: unknown,
  architecture: unknown,
): PlatformTarget => {
  if (typeof platform !== "string" || typeof architecture !== "string") {
    throw new TypeError("Runtime platform and architecture must be primitive strings");
  }
  if (platform === "darwin" && architecture === "arm64") return "darwin-arm64";
  if (platform === "win32" && architecture === "x64") return "win32-x64";
  if (platform === "linux" && architecture === "x64") return "linux-x64";
  throw new Error(`unsupported Runtime platform target: ${platform}-${architecture}`);
};

export const PLATFORM_EVIDENCE_STATES = Object.freeze([
  "contract_defined",
  "implementation-complete_pending-native-validation",
  "native_verified",
  "native_validation_failed",
] as const);

export type PlatformEvidenceState = (typeof PLATFORM_EVIDENCE_STATES)[number];

export interface PublicationPlan {
  readonly target: string;
  readonly temporary: string;
  readonly steps: readonly (
    | "create-exclusive-same-directory"
    | "flush-file"
    | "atomic-replace"
    | "atomic-replace-with-bounded-retry"
    | "flush-parent-directory"
    | "record-parent-flush-unavailable"
  )[];
}

export interface PlatformProcessTreeHandle {
  signal(signal: "SIGTERM" | "CTRL_BREAK_EVENT" | "SIGKILL" | "TerminateJobObject"): Promise<void>;
  wait(timeoutMs: number): Promise<boolean>;
}

export interface PlatformRoots {
  readonly attachmentStaging: string;
  readonly runtimeHome: string;
  readonly temporary: string;
}

export interface SqliteDurabilityPlan {
  readonly databasePath: string;
  readonly pragmas: readonly ["journal_mode=WAL", "synchronous=FULL"];
  readonly parentDirectoryFlush: "required" | "record-unavailable";
}

export interface PlatformAdapterContract {
  readonly target: PlatformTarget;
  readonly evidenceState: PlatformEvidenceState;
  readonly pathFlavor: "posix" | "win32";
  readonly shell: Readonly<{
    dialect: "bash";
    executableRef: "bundled-bash";
    utf8PreludeRef?: "windows-utf8-v1";
  }>;
  readonly processTree: Readonly<{
    owner: "process-group" | "job-object";
    gracefulSignal: "SIGTERM" | "CTRL_BREAK_EVENT";
    forceSignal: "SIGKILL" | "TerminateJobObject";
  }>;
  readonly stdio: Readonly<{
    framing: "ndjson-utf8";
    newline: "lf";
    stdoutUse: "protocol-only";
  }>;
  readonly directories: Readonly<{
    temporaryOwner: "platform-adapter";
    runtimeHomeOwner: "host-explicit";
    attachmentStagingOwner: "host-explicit";
  }>;
  readonly sqlite: Readonly<{
    journalMode: "wal";
    synchronous: "full";
    parentDirectoryFlush: "required" | "record-unavailable";
  }>;
  readonly artifact: Readonly<{
    archive: "tar.gz" | "zip";
    executableSuffix: "" | ".exe";
    targetTriple: PlatformTarget;
  }>;
  normalizeAbsolutePath(value: string): string;
  samePath(left: string, right: string): boolean;
  publicationPlan(target: string, nonce: string): PublicationPlan;
  artifactName(distribution: string, version: string): string;
  shellLaunchPlan(scriptPath: string, arguments_: readonly string[]): Readonly<{
    executableRef: "bundled-bash";
    arguments: readonly string[];
    utf8PreludeRef?: "windows-utf8-v1";
  }>;
  cleanupProcessTree(handle: PlatformProcessTreeHandle, graceMs: number): Promise<Readonly<{
    graceful: PlatformAdapterContract["processTree"]["gracefulSignal"];
    forced: boolean;
  }>>;
  encodeStdioFrame(value: Readonly<Record<string, unknown>>): Uint8Array;
  normalizeExplicitRoots(roots: PlatformRoots): PlatformRoots;
  sqliteDurabilityPlan(databasePath: string): SqliteDurabilityPlan;
}

const assertSegment = (value: string, description: string): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`${description} must be a bounded safe segment`);
  }
};

const assertArguments = (values: readonly string[]): readonly string[] => Object.freeze(values.map((value) => {
  if (value.includes("\0") || value.length > 32_768) throw new TypeError("shell argument is invalid");
  return value;
}));

const encodeStdioFrame = (value: unknown): Uint8Array => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("NDJSON frame must be an object");
  }
  const serialized: unknown = JSON.stringify(value);
  if (typeof serialized !== "string" || serialized.includes("\n") || serialized.includes("\r")) {
    throw new TypeError("NDJSON frame must serialize to one JSON line");
  }
  return new TextEncoder().encode(`${serialized}\n`);
};

const cleanupProcessTree = async (
  handle: PlatformProcessTreeHandle,
  graceMs: number,
  graceful: PlatformAdapterContract["processTree"]["gracefulSignal"],
  force: PlatformAdapterContract["processTree"]["forceSignal"],
): Promise<Readonly<{ graceful: typeof graceful; forced: boolean }>> => {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 60_000) {
    throw new TypeError("process cleanup grace must be a bounded positive integer");
  }
  await handle.signal(graceful);
  if (await handle.wait(graceMs)) return Object.freeze({ graceful, forced: false });
  await handle.signal(force);
  if (!await handle.wait(graceMs)) throw new Error("platform process tree remained live after force cleanup");
  return Object.freeze({ graceful, forced: true });
};

const normalizeRoots = (
  roots: PlatformRoots,
  normalize: (value: string) => string,
  same: (left: string, right: string) => boolean,
  separator: "/" | "\\",
): PlatformRoots => {
  const normalized = Object.freeze({
    attachmentStaging: normalize(roots.attachmentStaging),
    runtimeHome: normalize(roots.runtimeHome),
    temporary: normalize(roots.temporary),
  });
  const values = Object.values(normalized);
  for (const [index, left] of values.entries()) {
    for (const right of values.slice(index + 1)) {
      const leftPrefix = left.endsWith(separator) ? left : `${left}${separator}`;
      const rightPrefix = right.endsWith(separator) ? right : `${right}${separator}`;
      const foldedLeft = separator === "\\" ? left.toLowerCase() : left;
      const foldedRight = separator === "\\" ? right.toLowerCase() : right;
      const foldedLeftPrefix = separator === "\\" ? leftPrefix.toLowerCase() : leftPrefix;
      const foldedRightPrefix = separator === "\\" ? rightPrefix.toLowerCase() : rightPrefix;
      if (same(left, right) || foldedLeft.startsWith(foldedRightPrefix) || foldedRight.startsWith(foldedLeftPrefix)) {
        throw new TypeError("platform roots must be explicit and non-overlapping");
      }
    }
  }
  return normalized;
};

const posixAdapter = (
  target: "darwin-arm64" | "linux-x64",
): PlatformAdapterContract => Object.freeze({
  target,
  evidenceState: target === "linux-x64"
    ? "implementation-complete_pending-native-validation"
    : "contract_defined",
  pathFlavor: "posix",
  shell: Object.freeze({ dialect: "bash", executableRef: "bundled-bash" }),
  processTree: Object.freeze({ owner: "process-group", gracefulSignal: "SIGTERM", forceSignal: "SIGKILL" }),
  stdio: Object.freeze({ framing: "ndjson-utf8", newline: "lf", stdoutUse: "protocol-only" }),
  directories: Object.freeze({
    temporaryOwner: "platform-adapter",
    runtimeHomeOwner: "host-explicit",
    attachmentStagingOwner: "host-explicit",
  }),
  sqlite: Object.freeze({ journalMode: "wal", synchronous: "full", parentDirectoryFlush: "required" }),
  artifact: Object.freeze({ archive: "tar.gz", executableSuffix: "", targetTriple: target }),
  normalizeAbsolutePath(value: string): string {
    if (!posix.isAbsolute(value)) throw new TypeError(`${target} path must be absolute`);
    return posix.normalize(value);
  },
  samePath(left: string, right: string): boolean {
    return this.normalizeAbsolutePath(left) === this.normalizeAbsolutePath(right);
  },
  publicationPlan(targetPath: string, nonce: string): PublicationPlan {
    assertSegment(nonce, "publication nonce");
    const normalized = this.normalizeAbsolutePath(targetPath);
    const steps: PublicationPlan["steps"] = Object.freeze([
      "create-exclusive-same-directory",
      "flush-file",
      "atomic-replace",
      "flush-parent-directory",
    ]);
    return Object.freeze({
      target: normalized,
      temporary: posix.join(posix.dirname(normalized), `.${posix.basename(normalized)}.${nonce}.tmp`),
      steps,
    });
  },
  artifactName(distribution: string, version: string): string {
    assertSegment(distribution, "distribution");
    assertSegment(version, "version");
    return `${distribution}-${version}-${target}.tar.gz`;
  },
  shellLaunchPlan(scriptPath: string, arguments_: readonly string[]) {
    return Object.freeze({
      executableRef: "bundled-bash" as const,
      arguments: Object.freeze([this.normalizeAbsolutePath(scriptPath), ...assertArguments(arguments_)]),
    });
  },
  async cleanupProcessTree(handle: PlatformProcessTreeHandle, graceMs: number) {
    return await cleanupProcessTree(handle, graceMs, "SIGTERM", "SIGKILL");
  },
  encodeStdioFrame,
  normalizeExplicitRoots(roots: PlatformRoots): PlatformRoots {
    return normalizeRoots(roots, (value) => this.normalizeAbsolutePath(value), (left, right) => this.samePath(left, right), "/");
  },
  sqliteDurabilityPlan(databasePath: string): SqliteDurabilityPlan {
    return Object.freeze({
      databasePath: this.normalizeAbsolutePath(databasePath),
      pragmas: Object.freeze(["journal_mode=WAL", "synchronous=FULL"] as const),
      parentDirectoryFlush: "required",
    });
  },
});

const windowsAdapter = (): PlatformAdapterContract => Object.freeze({
  target: "win32-x64",
  evidenceState: "implementation-complete_pending-native-validation",
  pathFlavor: "win32",
  shell: Object.freeze({
    dialect: "bash",
    executableRef: "bundled-bash",
    utf8PreludeRef: "windows-utf8-v1",
  }),
  processTree: Object.freeze({
    owner: "job-object",
    gracefulSignal: "CTRL_BREAK_EVENT",
    forceSignal: "TerminateJobObject",
  }),
  stdio: Object.freeze({ framing: "ndjson-utf8", newline: "lf", stdoutUse: "protocol-only" }),
  directories: Object.freeze({
    temporaryOwner: "platform-adapter",
    runtimeHomeOwner: "host-explicit",
    attachmentStagingOwner: "host-explicit",
  }),
  sqlite: Object.freeze({ journalMode: "wal", synchronous: "full", parentDirectoryFlush: "record-unavailable" }),
  artifact: Object.freeze({ archive: "zip", executableSuffix: ".exe", targetTriple: "win32-x64" }),
  normalizeAbsolutePath(value: string): string {
    const root = win32.parse(value).root;
    if (!win32.isAbsolute(value) || root === "\\" || root === "/") {
      throw new TypeError("win32-x64 path must be fully qualified and absolute");
    }
    return win32.normalize(value);
  },
  samePath(left: string, right: string): boolean {
    return this.normalizeAbsolutePath(left).toLowerCase()
      === this.normalizeAbsolutePath(right).toLowerCase();
  },
  publicationPlan(targetPath: string, nonce: string): PublicationPlan {
    assertSegment(nonce, "publication nonce");
    const normalized = this.normalizeAbsolutePath(targetPath);
    const steps: PublicationPlan["steps"] = Object.freeze([
      "create-exclusive-same-directory",
      "flush-file",
      "atomic-replace-with-bounded-retry",
      "record-parent-flush-unavailable",
    ]);
    return Object.freeze({
      target: normalized,
      temporary: win32.join(win32.dirname(normalized), `.${win32.basename(normalized)}.${nonce}.tmp`),
      steps,
    });
  },
  artifactName(distribution: string, version: string): string {
    assertSegment(distribution, "distribution");
    assertSegment(version, "version");
    return `${distribution}-${version}-win32-x64.zip`;
  },
  shellLaunchPlan(scriptPath: string, arguments_: readonly string[]) {
    return Object.freeze({
      executableRef: "bundled-bash" as const,
      arguments: Object.freeze([this.normalizeAbsolutePath(scriptPath), ...assertArguments(arguments_)]),
      utf8PreludeRef: "windows-utf8-v1" as const,
    });
  },
  async cleanupProcessTree(handle: PlatformProcessTreeHandle, graceMs: number) {
    return await cleanupProcessTree(handle, graceMs, "CTRL_BREAK_EVENT", "TerminateJobObject");
  },
  encodeStdioFrame,
  normalizeExplicitRoots(roots: PlatformRoots): PlatformRoots {
    return normalizeRoots(roots, (value) => this.normalizeAbsolutePath(value), (left, right) => this.samePath(left, right), "\\");
  },
  sqliteDurabilityPlan(databasePath: string): SqliteDurabilityPlan {
    return Object.freeze({
      databasePath: this.normalizeAbsolutePath(databasePath),
      pragmas: Object.freeze(["journal_mode=WAL", "synchronous=FULL"] as const),
      parentDirectoryFlush: "record-unavailable",
    });
  },
});

const adapters: Readonly<Record<PlatformTarget, PlatformAdapterContract>> = Object.freeze({
  "darwin-arm64": posixAdapter("darwin-arm64"),
  "linux-x64": posixAdapter("linux-x64"),
  "win32-x64": windowsAdapter(),
});

export const selectPlatformAdapter = (target: string): PlatformAdapterContract => {
  if (typeof target !== "string" || !Object.hasOwn(adapters, target)) {
    throw new TypeError(`unsupported platform target: ${target}`);
  }
  return adapters[target as PlatformTarget];
};

export const platformContractManifest = Object.freeze({
  formatVersion: 1,
  contractVersion: PLATFORM_CONTRACT_VERSION,
  evidenceVocabulary: PLATFORM_EVIDENCE_STATES,
  targets: Object.freeze(PLATFORM_TARGETS.map((target) => {
    const adapter = selectPlatformAdapter(target);
    return Object.freeze({
      target,
      evidenceState: adapter.evidenceState,
      pathFlavor: adapter.pathFlavor,
      shell: adapter.shell,
      processTree: adapter.processTree,
      stdio: adapter.stdio,
      directories: adapter.directories,
      sqlite: adapter.sqlite,
      artifact: adapter.artifact,
    });
  })),
});
