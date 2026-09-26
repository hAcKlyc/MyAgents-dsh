export interface InstallPackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

export function packageForVerifiedDshInstall(
  sourcePackage: InstallPackageManifest,
  packages: readonly { name: string; tarball: string }[],
  artifactRoot: string,
): InstallPackageManifest;
