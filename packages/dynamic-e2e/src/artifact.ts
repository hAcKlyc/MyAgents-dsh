import { verifyInstalledRuntimeArtifact } from "@myagents-dsh/artifact-verifier/runtime-artifact";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface DynamicArtifactIdentity {
  readonly root: string;
  readonly entrypoint: string;
  readonly manifestSha256: string;
  readonly fileCount: number;
  readonly repositoryHead: string;
  readonly runtimeVersion: string;
  readonly dshVersion: string;
  readonly dshManifestSha256: string;
  readonly profileDigest: string;
  readonly protocolVersion: string;
  readonly protocolSha256: string;
  readonly activation: "workstream-evidence-only";
}

export const inspectDynamicArtifact = (
  artifactRoot: string,
  expectedManifestSha256?: string,
): DynamicArtifactIdentity => {
  const lexicalRoot = resolve(artifactRoot);
  const root = realpathSync(lexicalRoot);
  const rootEntry = lstatSync(lexicalRoot);
  if (root !== lexicalRoot || !rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new TypeError("dynamic Runtime artifact root must be canonical and non-symlinked");
  }
  const installed = verifyInstalledRuntimeArtifact(root, expectedManifestSha256);
  const entrypoint = resolve(root, installed.manifest.entrypoint);
  const entry = lstatSync(entrypoint);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
    || ((entry.mode & 0o777) !== 0o644 && (entry.mode & 0o777) !== 0o755)) {
    throw new TypeError("dynamic Runtime artifact entrypoint must be one canonical singly-linked file");
  }
  return Object.freeze({
    root,
    entrypoint,
    manifestSha256: installed.manifestSha256,
    fileCount: installed.fileCount,
    repositoryHead: installed.manifest.build.repositoryHead,
    runtimeVersion: installed.manifest.runtimeVersion,
    dshVersion: installed.manifest.dsh.artifactVersion,
    dshManifestSha256: installed.manifest.dsh.artifactManifestSha256,
    profileDigest: installed.manifest.profile.digest,
    protocolVersion: installed.manifest.protocol.version,
    protocolSha256: installed.manifest.protocol.schemaSha256,
    activation: installed.manifest.activation,
  });
};
