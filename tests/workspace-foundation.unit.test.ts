import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { evaluateToolchain } from "../scripts/toolchain-policy.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("workspace foundation", () => {
  it("pins one exact Node and npm toolchain", async () => {
    const rootPackage: unknown = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    );

    expect(rootPackage).toMatchObject({
      packageManager: "npm@11.19.0",
      engines: { node: "24.20.0", npm: "11.19.0" },
      devEngines: {
        runtime: { name: "node", version: "24.20.0", onFail: "error" },
        packageManager: { name: "npm", version: "11.19.0", onFail: "error" },
      },
    });
    await expect(readFile(resolve(repositoryRoot, ".nvmrc"), "utf8")).resolves.toBe("24.20.0\n");
  });

  it("rejects drifted Node and npm versions before installation", () => {
    expect(
      evaluateToolchain({
        nodeVersion: "v24.17.0",
        npmUserAgent: "npm/11.13.0 node/v24.17.0 darwin arm64",
      }),
    ).toEqual([
      "Node must be 24.20.0; received v24.17.0",
      "npm must be 11.19.0; received 11.13.0",
    ]);
    expect(
      evaluateToolchain({
        nodeVersion: "v24.20.0",
        npmUserAgent: "npm/11.19.0 node/v24.20.0 darwin arm64",
      }),
    ).toEqual([]);
  });

  it("keeps every npm workspace in the root TypeScript graph", async () => {
    const rootPackage = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { workspaces: string[] };
    const rootTsconfig = JSON.parse(
      await readFile(resolve(repositoryRoot, "tsconfig.json"), "utf8"),
    ) as { references: Array<{ path: string }> };
    const referencedPaths = new Set(
      rootTsconfig.references.map(({ path }) => path.replace(/^\.\//u, "")),
    );
    const declaredWorkspacePaths = (
      await Promise.all(
        ["apps", "packages"].map(async (parent) =>
          (await readdir(resolve(repositoryRoot, parent), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${parent}/${entry.name}`),
        ),
      )
    ).flat();

    expect(rootPackage.workspaces).toEqual(["apps/*", "packages/*"]);
    expect([...referencedPaths]).toEqual(expect.arrayContaining(declaredWorkspacePaths));
    await Promise.all(
      declaredWorkspacePaths.map((path) =>
        expect(readFile(resolve(repositoryRoot, path, "tsconfig.json"), "utf8")).resolves.toBeTruthy(),
      ),
    );
  });

  it("keeps credential and build outputs outside source control", async () => {
    const ignore = await readFile(resolve(repositoryRoot, ".gitignore"), "utf8");
    expect(ignore.split(/\r?\n/u)).toEqual(
      expect.arrayContaining([".env", ".env.*", "node_modules/", "dist/", "coverage/", "tmp/"]),
    );
  });
});
