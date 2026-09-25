export const requiredNodeVersion = "v24.20.0";
export const minimumDevelopmentNodeVersion = "v24.15.0";
export const requiredNpmVersion = "11.19.0";

export const evaluateToolchain = ({ nodeVersion, npmUserAgent }) => {
  const failures = [];
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(nodeVersion);
  if (match === null || Number(match[1]) !== 24 || Number(match[2]) < 15) {
    failures.push(`Node must be >=${minimumDevelopmentNodeVersion.slice(1)} <25; received ${nodeVersion}`);
  }

  const npmVersion = /^npm\/([^\s]+)/u.exec(npmUserAgent ?? "")?.[1];
  if (npmVersion !== requiredNpmVersion) {
    failures.push(
      `npm must be ${requiredNpmVersion}; received ${npmVersion ?? "no npm lifecycle user-agent"}`,
    );
  }
  return failures;
};

/** Immutable Runtime artifacts retain their exact Node build/runtime authority. */
export const evaluateArtifactToolchain = (input) => [
  ...evaluateToolchain(input),
  ...(input.nodeVersion === requiredNodeVersion ? []
    : [`Runtime artifact build requires Node ${requiredNodeVersion.slice(1)}; received ${input.nodeVersion}`]),
];
