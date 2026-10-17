import { resolve } from "node:path";

export function packageForVerifiedDshInstall(sourcePackage, packages, artifactRoot, consumerPackage) {
  const temporaryPackage = JSON.parse(JSON.stringify(sourcePackage));
  // Zod schemas cross the native/product API boundary. A no-lock install may
  // otherwise hoist a newer transitive copy beside the exact workspace pin,
  // making those public schema types incompatible. Use the accepted consumer's
  // dependency identity, just as the Runtime composition does.
  const zod = consumerPackage?.dependencies?.zod;
  if (typeof zod !== "string" || !/^\d+\.\d+\.\d+$/u.test(zod)) {
    throw new Error("Verified DSH consumer must pin an exact Zod version");
  }
  temporaryPackage.dependencies ??= {};
  // The verified consumer also pins Cordis plugins and other external peers.
  // Reuse those pins: resolving their ranges again can select a newer plugin
  // requiring a different Cordis version even though DSH bytes are unchanged.
  const patchedNames = new Set(packages.map(({ name }) => name));
  for (const [name, version] of Object.entries(consumerPackage.dependencies)) {
    if (!patchedNames.has(name)) temporaryPackage.dependencies[name] = version;
  }
  for (const { name, tarball } of packages) {
    const localSpec = `file:${resolve(artifactRoot, tarball)}`;
    // The post-install verifier checks the complete accepted inventory, including
    // packages not imported by the source workspace's ordinary root manifest.
    temporaryPackage.dependencies[name] = localSpec;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (Object.hasOwn(temporaryPackage[section] ?? {}, name)) {
        temporaryPackage[section][name] = localSpec;
      }
    }
    temporaryPackage.overrides ??= {};
    temporaryPackage.overrides[name] = localSpec;
  }
  return temporaryPackage;
}
