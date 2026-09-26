import { resolve } from "node:path";

export function packageForVerifiedDshInstall(sourcePackage, packages, artifactRoot) {
  const temporaryPackage = JSON.parse(JSON.stringify(sourcePackage));
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
