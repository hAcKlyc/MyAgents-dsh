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
    packageName: "@myagents-dsh/runtime-server",
    relativeDirectory: "apps/runtime-server",
    allowedFiles: ["package.json", "src/index.ts", "src/lifecycle.ts"],
  },
  {
    packageName: "@myagents-dsh/artifact-verifier",
    relativeDirectory: "packages/artifact-verifier",
    allowedFiles: [
      "package.json",
      "src/artifact-policy.ts",
      "src/forbidden-content.ts",
      "src/index.ts",
      "src/repository-entry.ts",
    ],
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
    packageName: "@myagents-dsh/product-profile",
    relativeDirectory: "packages/product-profile",
    allowedFiles: [
      "manifests/accepted-patched-dsh-artifact-v1.json",
      "manifests/batch-1-a2-candidate-profile-v1.json",
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
      "generated/host-client.generated.ts",
      "generated/protocol-fixtures.json",
      "generated/protocol-meta.json",
      "generated/protocol.schema.json",
      "package.json",
      "src/contract-source.ts",
      "src/errors.ts",
      "src/index.ts",
      "src/peer.ts",
      "src/validation.ts",
    ],
  },
  {
    packageName: "@myagents-dsh/rpc-server",
    relativeDirectory: "packages/rpc-server",
    allowedFiles: ["package.json", "src/index.ts", "src/native-rpc-service.ts"],
  },
  {
    packageName: "@myagents-dsh/runtime-product",
    relativeDirectory: "packages/runtime-product",
    allowedFiles: ["package.json", "src/composition.ts", "src/index.ts"],
  },
  {
    packageName: "@myagents-dsh/test-host",
    relativeDirectory: "packages/test-host",
    allowedFiles: ["package.json", "src/index.ts", "src/memory-peer.ts", "src/standard-test-host.ts"],
  },
  {
    packageName: "@myagents-dsh/testkit",
    relativeDirectory: "packages/testkit",
    allowedFiles: ["package.json", "src/fake-llm-adapter.ts", "src/index.ts"],
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
