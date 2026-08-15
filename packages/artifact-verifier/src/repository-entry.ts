import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

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
