import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { lstat, open } from "node:fs/promises";

export interface RegularFileIdentity {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly size: number;
}

export interface RegularFileSnapshot {
  readonly bytes: Buffer;
  readonly identity: RegularFileIdentity;
}

const regularFileIdentity = (
  entry: Stats,
): RegularFileIdentity => Object.freeze({
  ctimeMs: entry.ctimeMs,
  dev: entry.dev,
  ino: entry.ino,
  mtimeMs: entry.mtimeMs,
  nlink: entry.nlink,
  size: entry.size,
});

export const readRegularFileNoFollow = async (absolutePath: string): Promise<Buffer> => {
  const before = await lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new TypeError("repository entry must be a singly linked regular file, not an alias or special file");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new TypeError("repository entry changed identity before its content audit");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

export const readRegularFileNoFollowSnapshotSync = (
  absolutePath: string,
): RegularFileSnapshot => {
  const before = lstatSync(absolutePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new TypeError("repository entry must be a singly linked regular file, not an alias or special file");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new TypeError("repository entry changed identity before its content audit");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== bytes.length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new TypeError("repository entry changed identity during its content audit");
    }
    return Object.freeze({ bytes, identity: regularFileIdentity(after) });
  } finally {
    closeSync(descriptor);
  }
};

export const readRegularFileNoFollowSync = (absolutePath: string): Buffer =>
  readRegularFileNoFollowSnapshotSync(absolutePath).bytes;
