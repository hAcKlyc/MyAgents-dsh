import { mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const canCreateSymlink = (kind: "file" | "dir"): boolean => {
  const root = mkdtempSync(join(tmpdir(), "myagents-dsh-symlink-probe-"));
  const target = join(root, "target");
  const alias = join(root, "alias");
  try {
    if (kind === "dir") mkdirSync(target);
    else writeFileSync(target, "probe");
    symlinkSync(target, alias, kind);
    return true;
  } catch (error) {
    if (process.platform === "win32" && error instanceof Error
      && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) return false;
    throw error;
  } finally {
    rmSync(alias, { force: true, recursive: kind === "dir" });
    rmSync(target, { force: true, recursive: kind === "dir" });
    rmdirSync(root);
  }
};

export const supportsFileSymlinks = canCreateSymlink("file");
export const supportsDirectorySymlinks = canCreateSymlink("dir");
