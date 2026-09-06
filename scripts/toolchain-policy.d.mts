export const requiredNodeVersion: "v24.20.0";
export const requiredNpmVersion: "11.19.0";

export function evaluateToolchain(input: {
  nodeVersion: string;
  npmUserAgent: string | undefined;
}): string[];
