import {
  createRuntimeArtifactSelfCheckReport,
  serializeRuntimeArtifactSelfCheckReport,
  type RuntimeArtifactSelfCheckReport,
} from "@myagents-dsh/artifact-verifier/self-check";
import { resolveRuntimePlatformTarget } from "@myagents-dsh/product-profile";
import type { Writable } from "node:stream";
import { types as utilTypes } from "node:util";

const exactSelfCheckArguments = (value: readonly string[]): void => {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1 || value.length !== 1) {
    throw new TypeError("Runtime self-check accepts exactly one command-line argument");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "0");
  if (descriptor === undefined || !("value" in descriptor)
    || !descriptor.enumerable || descriptor.value !== "--self-check") {
    throw new TypeError("Runtime command-line surface allows only --self-check");
  }
};

const writeBytes = (output: Writable, bytes: string): Promise<void> => new Promise((resolve, reject) => {
  output.write(bytes, (error) => {
    if (error !== null && error !== undefined) reject(error);
    else resolve();
  });
});

export const runRuntimeArtifactSelfCheck = async (
  argv: readonly string[],
  artifactRoot: string,
  output: Writable = process.stdout,
): Promise<RuntimeArtifactSelfCheckReport> => {
  exactSelfCheckArguments(argv);
  const target = resolveRuntimePlatformTarget(process.platform, process.arch);
  const { verifyInstalledRuntimeArtifact } = await import("@myagents-dsh/artifact-verifier/runtime-artifact");
  const report = createRuntimeArtifactSelfCheckReport(
    target,
    verifyInstalledRuntimeArtifact(artifactRoot),
    process.versions.node,
  );
  await writeBytes(output, serializeRuntimeArtifactSelfCheckReport(report));
  return report;
};
