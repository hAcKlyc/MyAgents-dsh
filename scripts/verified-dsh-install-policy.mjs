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
  temporaryPackage.dependencies.zod = zod;
  for (const { name, tarball } of packages) {
    const localSpec = `file:${resolve(artifactRoot, tarball)}`;
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
