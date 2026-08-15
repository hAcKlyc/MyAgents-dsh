export const requiredNodeVersion: "v24.13.1";
export const requiredNpmVersion: "11.8.0";

export function evaluateToolchain(input: {
  nodeVersion: string;
  npmUserAgent: string | undefined;
}): string[];
