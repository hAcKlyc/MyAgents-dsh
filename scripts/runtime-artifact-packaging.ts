import {
  chmodSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const canonicalMode = (mode: number): 0o644 | 0o755 => {
  // Windows stat cannot preserve POSIX executable bits; Runtime aliases are
  // consumed through Node and use the same logical file mode as the manifest.
  if (process.platform === "win32") return 0o644;
  const exact = mode & 0o777;
  if (exact !== 0o644 && exact !== 0o755) {
    throw new TypeError("Runtime artifact link target has a non-canonical file mode");
  }
  return exact;
};

const isContained = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/**
 * npm creates executable aliases in `node_modules/.bin` as filesystem links on
 * POSIX hosts. Desktop bundle/installer implementations do not preserve those
 * links consistently, and the Runtime never executes the aliases. Materialize
 * every contained file link before the content manifest is created so one
 * sealed Runtime inventory remains portable across supported package formats.
 */
export const materializeRuntimeArtifactFileLinks = (value: string): number => {
  const root = resolve(value);
  const rootEntry = lstatSync(root);
  if (realpathSync(root) !== root || !rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new TypeError("Runtime artifact staging root must be one canonical non-symlink directory");
  }

  let materialized = 0;
  const walk = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, child.name);
      const entry = lstatSync(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(path);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;

      let target: string;
      try {
        target = realpathSync(path);
      } catch {
        throw new TypeError("Runtime artifact contains a dangling filesystem link");
      }
      if (!isContained(root, target)) {
        throw new TypeError("Runtime artifact filesystem link escapes its staging root");
      }
      const targetEntry = lstatSync(target);
      if (!targetEntry.isFile() || targetEntry.isSymbolicLink()) {
        throw new TypeError("Runtime artifact contains a non-file filesystem link");
      }
      const mode = canonicalMode(targetEntry.mode);
      const bytes = readFileSync(target);
      const targetAfter = lstatSync(target);
      if (!targetAfter.isFile() || targetAfter.isSymbolicLink()
        || targetAfter.dev !== targetEntry.dev || targetAfter.ino !== targetEntry.ino
        || targetAfter.size !== targetEntry.size || targetAfter.ctimeMs !== targetEntry.ctimeMs
        || targetAfter.mtimeMs !== targetEntry.mtimeMs || canonicalMode(targetAfter.mode) !== mode
        || !readFileSync(target).equals(bytes)) {
        throw new TypeError("Runtime artifact link target changed during materialization");
      }

      rmSync(path);
      writeFileSync(path, bytes, { flag: "wx", mode });
      chmodSync(path, mode);
      materialized += 1;
    }
  };

  walk(root);
  return materialized;
};
