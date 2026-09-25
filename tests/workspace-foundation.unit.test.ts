import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { evaluateArtifactToolchain, evaluateToolchain } from "../scripts/toolchain-policy.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("workspace foundation", () => {
  it("admits Node 24.15+ for development while pinning artifact builds", async () => {
    const rootPackage: unknown = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    );

    expect(rootPackage).toMatchObject({
      packageManager: "npm@11.19.0",
      engines: { node: ">=24.15.0 <25", npm: "11.19.0" },
      devEngines: {
        runtime: { name: "node", version: ">=24.15.0 <25", onFail: "error" },
        packageManager: { name: "npm", version: "11.19.0", onFail: "error" },
      },
    });
    await expect(readFile(resolve(repositoryRoot, ".nvmrc"), "utf8")).resolves.toBe("24.15.0\n");
  });

  it("rejects unsupported development versions before installation", () => {
    expect(
      evaluateToolchain({
        nodeVersion: "v24.17.0",
        npmUserAgent: "npm/11.13.0 node/v24.17.0 darwin arm64",
      }),
    ).toEqual([
      "npm must be 11.19.0; received 11.13.0",
    ]);
    expect(
      evaluateToolchain({
        nodeVersion: "v24.20.0",
        npmUserAgent: "npm/11.19.0 node/v24.20.0 darwin arm64",
      }),
    ).toEqual([]);
    expect(evaluateToolchain({ nodeVersion: "v24.15.0", npmUserAgent: "npm/11.19.0" })).toEqual([]);
    expect(evaluateToolchain({ nodeVersion: "v24.14.0", npmUserAgent: "npm/11.19.0" }))
      .toEqual(["Node must be >=24.15.0 <25; received v24.14.0"]);
    expect(evaluateToolchain({ nodeVersion: "v25.0.0", npmUserAgent: "npm/11.19.0" }))
      .toEqual(["Node must be >=24.15.0 <25; received v25.0.0"]);
    expect(evaluateArtifactToolchain({ nodeVersion: "v24.15.0", npmUserAgent: "npm/11.19.0" }))
      .toEqual(["Runtime artifact build requires Node 24.20.0; received v24.15.0"]);
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
