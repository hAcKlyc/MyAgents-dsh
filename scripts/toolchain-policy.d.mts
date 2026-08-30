export const requiredNodeVersion: "v24.14.0";
export const requiredNpmVersion: "11.15.0";

export function evaluateToolchain(input: {
  nodeVersion: string;
  npmUserAgent: string | undefined;
}): string[];
