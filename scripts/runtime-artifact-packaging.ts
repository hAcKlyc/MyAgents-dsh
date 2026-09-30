import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Prune only the installed delivery staging tree, before its content manifest is sealed. */
export const pruneRuntimeArtifactResources = (
  value: string,
  target: Pick<NodeJS.Process, "platform" | "arch">,
): Readonly<{ filesRemoved: number; bytesRemoved: number }> => {
  let filesRemoved = 0;
  let bytesRemoved = 0;
  const remove = (path: string): void => {
    if (!existsSync(path)) return;
    const count = (current: string): void => {
      const entry = lstatSync(current);
      if (entry.isDirectory()) {
        for (const child of readdirSync(current)) count(resolve(current, child));
      } else if (entry.isFile()) {
        filesRemoved += 1;
        bytesRemoved += entry.size;
      }
    };
    count(path);
    rmSync(path, { recursive: true });
  };
  const pruneFiles = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, child.name);
      if (child.isDirectory()) pruneFiles(path);
      else if (child.isFile() && (
        /\.d\.[cm]?ts$/u.test(child.name)
        || /\.(?:[cm]?js|[cm]?ts|css)\.map$/u.test(child.name)
        || child.name.endsWith(".pdb")
      )) remove(path);
    }
  };
  const prunePackage = (directory: string): void => {
    const manifestPath = resolve(directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name: string };
    // Limit documentation/test directory removal to package roots; a library's
    // lib/test or dist/examples can contain executable implementation modules.
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (child.isDirectory() && ["test", "tests", "__tests__", "example", "examples", ".github", ".yarn"].includes(child.name)) {
        remove(resolve(directory, child.name));
      }
    }
    // These SDKs publish compiled runtime exports alongside their original TS
    // sources. Keep both runtime module formats; only omit the unused sources.
    if (manifest.name === "openai" || manifest.name === "@anthropic-ai/sdk") {
      remove(resolve(directory, "src"));
    }
    if (manifest.name === "node-pty") {
      const prebuilds = resolve(directory, "prebuilds");
      if (existsSync(prebuilds)) {
        for (const child of readdirSync(prebuilds)) {
          if (child !== `${target.platform}-${target.arch}`) remove(resolve(prebuilds, child));
        }
      }
      if (target.platform !== "win32") remove(resolve(directory, "third_party"));
    }
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (child.name === "node_modules" && child.isDirectory()) prunePackages(resolve(directory, child.name));
    }
  };
  const prunePackages = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (!child.isDirectory() || child.name === ".bin") continue;
      const path = resolve(directory, child.name);
      if (child.name.startsWith("@")) prunePackages(path);
      else prunePackage(path);
    }
  };
  const modules = resolve(value, "node_modules");
  prunePackages(modules);
  pruneFiles(modules);
  return Object.freeze({ filesRemoved, bytesRemoved });
};

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
