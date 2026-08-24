import { scanForbiddenContent, type ForbiddenContentFinding } from "./forbidden-content.js";

export interface PackedFile {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
}

export interface PackedWorkspacePolicy {
  readonly packageName: string;
  readonly relativeDirectory: string;
  readonly allowedFiles: readonly string[];
}

export const PACKED_WORKSPACE_POLICIES: readonly PackedWorkspacePolicy[] = Object.freeze([
  {
    packageName: "@myagents-dsh/reference-web",
    relativeDirectory: "apps/reference-web",
    allowedFiles: [
      "index.html",
      "package.json",
      "src/app.tsx",
      "src/components/agent-surface.tsx",
      "src/components/composer.tsx",
      "src/components/inspector-pane.tsx",
      "src/components/interaction-tray.tsx",
      "src/components/safe-markdown.tsx",
      "src/components/session-sidebar.tsx",
      "src/history.ts",
      "src/main.tsx",
      "src/store.ts",
      "src/styles.css",
      "vite.config.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/runtime-server",
    relativeDirectory: "apps/runtime-server",
    allowedFiles: [
      "package.json",
      "src/index.ts",
      "src/lifecycle.ts",
      "src/official-composition.ts",
      "src/process.ts",
      "src/self-check.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/artifact-verifier",
    relativeDirectory: "packages/artifact-verifier",
    allowedFiles: [
      "package.json",
      "src/artifact-policy.ts",
      "src/batch-1-handoff.ts",
      "src/forbidden-content.ts",
      "src/index.ts",
      "src/repository-entry.ts",
      "src/runtime-artifact.ts",
      "src/self-check.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/checkpoint",
    relativeDirectory: "packages/checkpoint",
    allowedFiles: ["package.json", "src/index.ts", "src/runtime.ts"],
  },
  {
    packageName: "@myagents-dsh/compatibility",
    relativeDirectory: "packages/compatibility",
    allowedFiles: [
      "manifests/myagents-agent-sdk-compatibility-v1.json",
      "package.json",
      "src/agent-sdk-0.3.220-shapes.ts",
      "src/index.ts",
      "src/manifest.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/component-runtime",
    relativeDirectory: "packages/component-runtime",
    allowedFiles: ["package.json", "src/descriptors.ts", "src/index.ts", "src/service.ts"],
  },
  {
    packageName: "@myagents-dsh/components-agents",
    relativeDirectory: "packages/components-agents",
    allowedFiles: ["package.json", "src/index.ts"],
  },
  {
    packageName: "@myagents-dsh/components-commands",
    relativeDirectory: "packages/components-commands",
    allowedFiles: ["package.json", "src/index.ts"],
  },
  {
    packageName: "@myagents-dsh/components-host-tools",
    relativeDirectory: "packages/components-host-tools",
    allowedFiles: ["package.json", "src/compiler.ts", "src/index.ts"],
  },
  {
    packageName: "@myagents-dsh/components-hooks",
    relativeDirectory: "packages/components-hooks",
    allowedFiles: ["package.json", "src/index.ts", "src/runtime.ts"],
  },
  {
    packageName: "@myagents-dsh/components-mcp",
    relativeDirectory: "packages/components-mcp",
    allowedFiles: [
      "package.json", "src/compiler.ts", "src/index.ts", "src/managed-transport.ts", "src/sdk-connection.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/components-skills",
    relativeDirectory: "packages/components-skills",
    allowedFiles: ["package.json", "src/index.ts"],
  },
  {
    packageName: "@myagents-dsh/host-ports",
    relativeDirectory: "packages/host-ports",
    allowedFiles: ["package.json", "src/attachment-store.ts", "src/credential-provider.ts", "src/index.ts", "src/service.ts"],
  },
  {
    packageName: "@myagents-dsh/operation-runtime",
    relativeDirectory: "packages/operation-runtime",
    allowedFiles: [
      "package.json",
      "src/events.ts",
      "src/fold.ts",
      "src/index.ts",
      "src/limits.ts",
      "src/service.ts",
      "src/terminal.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/persistence-product",
    relativeDirectory: "packages/persistence-product",
    allowedFiles: [
      "package.json",
      "src/delete.ts",
      "src/compaction.ts",
      "src/index.ts",
      "src/fork.ts",
      "src/known-events.ts",
      "src/provider.ts",
      "src/read.ts",
      "src/rewind.ts",
      "src/schema.ts",
      "src/session-lock.ts",
      "src/sqlite-store.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/product-profile",
    relativeDirectory: "packages/product-profile",
    allowedFiles: [
      "manifests/accepted-patched-dsh-artifact-v1.json",
      "manifests/batch-1-candidate-profile-v1.json",
      "manifests/official-product-profile-v1.json",
      "manifests/platform-targets-v1.json",
      "package.json",
      "src/candidate-runtime-profile-authority.ts",
      "src/candidate-runtime-profile.ts",
      "src/index.ts",
      "src/official-profile-authority.generated.ts",
      "src/patched-dsh-artifact.ts",
      "src/platform-contract.ts",
      "src/profile.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/protocol",
    relativeDirectory: "packages/protocol",
    allowedFiles: [
      "generated/canonical-tools.generated.ts",
      "generated/host-client.generated.ts",
      "generated/protocol-fixtures.json",
      "generated/protocol-meta.json",
      "generated/protocol.schema.json",
      "package.json",
      "src/canonical-digests.ts",
      "src/canonical-json.ts",
      "src/contract-source.ts",
      "src/errors.ts",
      "src/index.ts",
      "src/peer.ts",
      "src/session-read.ts",
      "src/tool-catalog-schema.ts",
      "src/tool-catalog.ts",
      "src/validation.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/rpc-server",
    relativeDirectory: "packages/rpc-server",
    allowedFiles: ["package.json", "src/event-projector.ts", "src/index.ts", "src/native-rpc-service.ts"],
  },
  {
    packageName: "@myagents-dsh/runtime-product",
    relativeDirectory: "packages/runtime-product",
    allowedFiles: [
      "package.json",
      "src/composition.ts",
      "src/host-interaction.ts",
      "src/host-model.ts",
      "src/index.ts",
      "src/primary-session.ts",
      "src/utility.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/task-graph",
    relativeDirectory: "packages/task-graph",
    allowedFiles: ["package.json", "src/index.ts", "src/runtime.ts"],
  },
  {
    packageName: "@myagents-dsh/test-host",
    relativeDirectory: "packages/test-host",
    allowedFiles: [
      "package.json",
      "src/artifact-launcher.ts",
      "src/index.ts",
      "src/memory-peer.ts",
      "src/standard-test-host.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/testkit",
    relativeDirectory: "packages/testkit",
    allowedFiles: ["package.json", "src/fake-llm-adapter.ts", "src/index.ts"],
  },
  {
    packageName: "@myagents-dsh/tool-contracts",
    relativeDirectory: "packages/tool-contracts",
    allowedFiles: [
      "generated/catalog-fixtures-v1.json",
      "generated/canonical-tool-contracts-v1.json",
      "generated/dsh-reuse-matrix-v1.json",
      "generated/tool-catalog.schema.json",
      "generated/tool-contract-meta.json",
      "package.json",
      "src/contract-source.ts",
      "src/dsh-schema.ts",
      "src/index.ts",
      "src/schema.ts",
      "src/validation.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/tool-runtime-product",
    relativeDirectory: "packages/tool-runtime-product",
    allowedFiles: ["package.json", "src/index.ts", "src/keyed-locks.ts", "src/permission.ts", "src/runtime.ts"],
  },
  {
    packageName: "@myagents-dsh/tools-agent",
    relativeDirectory: "packages/tools-agent",
    allowedFiles: ["package.json", "src/index.ts", "src/skill-runtime.ts", "src/work-runtime.ts"],
  },
  {
    packageName: "@myagents-dsh/tools-fs",
    relativeDirectory: "packages/tools-fs",
    allowedFiles: ["package.json", "src/canonical-file-tools.ts", "src/index.ts", "src/local-filesystem.ts"],
  },
  {
    packageName: "@myagents-dsh/tools-interaction",
    relativeDirectory: "packages/tools-interaction",
    allowedFiles: ["package.json", "src/index.ts", "src/runtime.ts"],
  },
  {
    packageName: "@myagents-dsh/tools-process",
    relativeDirectory: "packages/tools-process",
    allowedFiles: [
      "package.json",
      "src/index.ts",
      "src/runtime.ts",
      "src/windows-job-host.ps1",
      "src/windows-job-subprocess.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/tools-web",
    relativeDirectory: "packages/tools-web",
    allowedFiles: ["package.json", "src/index.ts", "src/runtime.ts", "src/safe-http.ts"],
  },
  {
    packageName: "@myagents-dsh/web-host-contract",
    relativeDirectory: "packages/web-host-contract",
    allowedFiles: [
      "generated/browser-contract-meta.json",
      "generated/browser-contract.schema.json",
      "package.json",
      "src/canonical-json.ts",
      "src/client.ts",
      "src/errors.ts",
      "src/index.ts",
      "src/schemas.ts",
      "src/sse.ts",
      "src/validation.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/web-host",
    relativeDirectory: "packages/web-host",
    allowedFiles: [
      "package.json",
      "src/application.ts",
      "src/attachment-store.ts",
      "src/auth.ts",
      "src/browser-server.ts",
      "src/catalog.ts",
      "src/command-router.ts",
      "src/errors.ts",
      "src/event-hub.ts",
      "src/index.ts",
      "src/reference-profile.ts",
      "src/reverse-ports.ts",
      "src/runtime-process.ts",
      "src/supervisor.ts",
    ],
  },
]);

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const auditPackedFileList = (
  policy: PackedWorkspacePolicy,
  files: readonly PackedFile[],
): string[] => {
  const failures: string[] = [];
  const paths = files.map(({ path }) => path).sort(compareCodePoints);
  const expected = [...policy.allowedFiles].sort(compareCodePoints);
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    failures.push(`${policy.packageName} packed file allowlist differs: ${paths.join(", ")}`);
  }
  if (new Set(paths).size !== paths.length) failures.push(`${policy.packageName} contains duplicate packed paths`);
  for (const file of files) {
    if (file.size < 0 || !Number.isSafeInteger(file.size)) failures.push(`${policy.packageName}:${file.path} has invalid size`);
    if (file.mode !== 0o644 && file.mode !== 0o755) failures.push(`${policy.packageName}:${file.path} has invalid mode`);
    if (file.path.endsWith(".map")) failures.push(`${policy.packageName}:${file.path} contains an unexpected source map`);
  }
  return failures;
};

export const auditPackedContent = (
  packageName: string,
  entries: readonly { path: string; bytes: Uint8Array | string }[],
): ForbiddenContentFinding[] => entries.flatMap(({ path, bytes }) =>
  scanForbiddenContent(`${packageName}/${path}`, bytes));
