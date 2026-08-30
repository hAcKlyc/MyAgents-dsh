export const requiredNodeVersion = "v24.14.0";
export const requiredNpmVersion = "11.15.0";

export const evaluateToolchain = ({ nodeVersion, npmUserAgent }) => {
  const failures = [];
  if (nodeVersion !== requiredNodeVersion) {
    failures.push(`Node must be ${requiredNodeVersion.slice(1)}; received ${nodeVersion}`);
  }

  const npmVersion = /^npm\/([^\s]+)/u.exec(npmUserAgent ?? "")?.[1];
  if (npmVersion !== requiredNpmVersion) {
    failures.push(
      `npm must be ${requiredNpmVersion}; received ${npmVersion ?? "no npm lifecycle user-agent"}`,
    );
  }
  return failures;
};
