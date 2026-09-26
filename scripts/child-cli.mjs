import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import process from "node:process";

export function childCli(command, args, env = process.env) {
  if (command !== "npm" && command !== "corepack" && command !== "pnpm") return { command, args };
  const npmEntrypoint = env.npm_execpath ?? process.env.npm_execpath;
  if (!npmEntrypoint) {
    if (process.platform === "win32") throw new Error("npm_execpath is required to launch package tools on Windows");
    return { command, args };
  }
  if (command === "npm") return { command: process.execPath, args: [npmEntrypoint, ...args] };
  const nodeModules = dirname(dirname(dirname(npmEntrypoint)));
  const candidates = [
    resolve(nodeModules, "corepack/dist/corepack.js"),
    resolve(dirname(process.execPath), "node_modules/corepack/dist/corepack.js"),
    ...(env.PATH ?? process.env.PATH ?? "").split(delimiter).flatMap((directory) => [
      resolve(directory, "node_modules/corepack/dist/corepack.js"),
      resolve(directory, "../lib/node_modules/corepack/dist/corepack.js"),
    ]),
  ];
  const corepackEntrypoint = candidates.find((path) => existsSync(path));
  if (corepackEntrypoint) {
    return { command: process.execPath,
      args: [corepackEntrypoint, ...(command === "pnpm" ? ["pnpm"] : []), ...args] };
  }
  if (process.platform === "win32") throw new Error("Corepack JS entrypoint is missing from the selected Node toolchain");
  return { command, args };
}
