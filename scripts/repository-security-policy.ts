import ts from "typescript";

import { analyzeModuleLoads } from "./dsh-baseline-policy.js";

export const ARTIFACT_LAUNCHER_PATH = "packages/test-host/src/artifact-launcher.ts" as const;

export const isExactArtifactLauncherChildProcessSource = (
  relativePath: string,
  specifier: string,
  source: string,
): boolean => {
  if (relativePath !== ARTIFACT_LAUNCHER_PATH || specifier !== "node:child_process") return false;
  const childProcessLoads = analyzeModuleLoads(source, relativePath).specifiers.filter((value) => {
    const canonical = value.startsWith("node:") ? value.slice(5) : value;
    return canonical.split("/")[0] === "child_process";
  });
  if (childProcessLoads.length !== 1) return false;
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  const imports = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === "node:child_process");
  if (imports.length !== 1) return false;
  const [declaration] = imports;
  const clause = declaration?.importClause;
  if (clause === undefined || clause.phaseModifier !== undefined || clause.name !== undefined
    || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) {
    return false;
  }
  const observed = clause.namedBindings.elements.map((element) => ({
    imported: element.propertyName?.text ?? element.name.text,
    local: element.name.text,
    typeOnly: element.isTypeOnly,
  }));
  return JSON.stringify(observed) === JSON.stringify([
    { imported: "spawn", local: "spawn", typeOnly: false },
    { imported: "spawnSync", local: "spawnSync", typeOnly: false },
    {
      imported: "ChildProcessWithoutNullStreams",
      local: "ChildProcessWithoutNullStreams",
      typeOnly: true,
    },
    { imported: "SpawnOptionsWithoutStdio", local: "SpawnOptionsWithoutStdio", typeOnly: true },
  ]);
};
