export const requiredNodeVersion: "v24.20.0";
export const minimumDevelopmentNodeVersion: "v24.15.0";
export const requiredNpmVersion: "11.19.0";

export function evaluateToolchain(input: {
  nodeVersion: string;
  npmUserAgent: string | undefined;
}): string[];

export function evaluateArtifactToolchain(input: {
  nodeVersion: string;
  npmUserAgent: string | undefined;
}): string[];
