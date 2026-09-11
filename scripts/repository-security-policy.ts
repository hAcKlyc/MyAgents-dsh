import ts from "typescript";

import { analyzeModuleLoads } from "./dsh-baseline-policy.js";

export const ARTIFACT_LAUNCHER_PATH = "packages/test-host/src/artifact-launcher.ts" as const;
export const DYNAMIC_E2E_HOST_PATH = "packages/dynamic-e2e/src/host.ts" as const;
export const PRODUCT_NETWORK_TRANSPORT_PATH = "packages/tools-web/src/safe-http.ts" as const;
export const WEB_HOST_RUNTIME_PROCESS_PATH = "packages/web-host/src/runtime-process.ts" as const;
export const WEB_HOST_BROWSER_SERVER_PATH = "packages/web-host/src/browser-server.ts" as const;

export const isExactProductNetworkTransportSource = (
  relativePath: string,
  specifier: string,
  source: string,
): boolean => {
  if (relativePath !== PRODUCT_NETWORK_TRANSPORT_PATH) return false;
  const allowed = new Set(["node:dns/promises", "node:http", "node:https", "node:net"]);
  if (!allowed.has(specifier)) return false;
  const observed = analyzeModuleLoads(source, relativePath).specifiers
    .filter((value) => {
      const canonical = value.startsWith("node:") ? value.slice(5) : value;
      return ["dns", "http", "https", "net"].includes(canonical.split("/")[0] ?? canonical);
    })
    .sort();
  return JSON.stringify(observed) === JSON.stringify([...allowed].sort());
};

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

const isExactSpawnWorkerSource = (
  ownerPath: string,
  relativePath: string,
  specifier: string,
  source: string,
): boolean => {
  if (relativePath !== ownerPath || specifier !== "node:child_process") return false;
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
  const clause = imports[0]?.importClause;
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
    {
      imported: "ChildProcessWithoutNullStreams",
      local: "ChildProcessWithoutNullStreams",
      typeOnly: true,
    },
  ]);
};

export const isExactDynamicE2eChildProcessSource = (
  relativePath: string,
  specifier: string,
  source: string,
): boolean => isExactSpawnWorkerSource(DYNAMIC_E2E_HOST_PATH, relativePath, specifier, source);

export const isExactSessionOwnershipNativeTestSource = (
  relativePath: string,
  specifier: string,
  source: string,
): boolean => isExactSpawnWorkerSource(
  "tests/product-session-ownership.native.test.ts", relativePath, specifier, source,
);

export const isExactWebHostRuntimeProcessSource = (
  relativePath: string,
  specifier: string,
  source: string,
): boolean => {
  if (relativePath !== WEB_HOST_RUNTIME_PROCESS_PATH || specifier !== "node:child_process") return false;
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
  const clause = imports[0]?.importClause;
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
    {
      imported: "ChildProcessWithoutNullStreams",
      local: "ChildProcessWithoutNullStreams",
      typeOnly: true,
    },
  ]);
};

export const isExactWebHostBrowserServerSource = (
  relativePath: string,
  specifier: string,
  source: string,
): boolean => {
  if (relativePath !== WEB_HOST_BROWSER_SERVER_PATH || specifier !== "node:http") return false;
  const networkLoads = analyzeModuleLoads(source, relativePath).specifiers.filter((value) => {
    const canonical = value.startsWith("node:") ? value.slice(5) : value;
    return ["dgram", "dns", "http", "http2", "https", "net", "tls"].includes(
      canonical.split("/")[0] ?? canonical,
    );
  });
  if (JSON.stringify(networkLoads) !== JSON.stringify(["node:http"])) return false;
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  const imports = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === "node:http");
  if (imports.length !== 1) return false;
  const clause = imports[0]?.importClause;
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
    { imported: "createServer", local: "createServer", typeOnly: false },
    { imported: "IncomingMessage", local: "IncomingMessage", typeOnly: true },
    { imported: "Server", local: "Server", typeOnly: true },
    { imported: "ServerResponse", local: "ServerResponse", typeOnly: true },
  ]);
};
