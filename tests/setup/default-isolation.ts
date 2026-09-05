import childProcess from "node:child_process";
import cluster from "node:cluster";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { basename, resolve } from "node:path";
import { arch, platform, release, tmpdir } from "node:os";
import tls from "node:tls";
import workerThreads from "node:worker_threads";

const originalSymlinkSync = fs.symlinkSync.bind(fs);

export class DefaultNetworkIsolationError extends Error {
  readonly code = "default_network_disabled";

  constructor(capability: string) {
    super(`Default tests cannot use real network capability: ${capability}`);
    this.name = "DefaultNetworkIsolationError";
  }
}

const blocked = (capability: string) => function blockedCapability(): never {
  throw new DefaultNetworkIsolationError(capability);
};

const blockedAsync = (capability: string) => (): Promise<never> =>
  Promise.reject(new DefaultNetworkIsolationError(capability));

const replace = (target: object, property: string, value: unknown): void => {
  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const patchedModules = [
  ["node:http", http, ["get", "request", "createServer"]],
  ["node:https", https, ["get", "request", "createServer"]],
  ["node:http2", http2, ["connect", "createServer", "createSecureServer"]],
  ["node:net", net, ["connect", "createConnection", "createServer"]],
  ["node:tls", tls, ["connect", "createServer"]],
  ["node:dgram", dgram, ["createSocket"]],
  ["node:dns", dns, [
    "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
    "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv",
    "resolveTxt", "reverse",
  ]],
  ["node:child_process", childProcess, [
    "exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync",
  ]],
  ["node:cluster", cluster, ["fork"]],
  ["node:worker_threads", workerThreads, ["Worker"]],
] as const;

for (const [specifier, module, methods] of patchedModules) {
  for (const method of methods) replace(module, method, blocked(`${specifier}.${method}`));
}

const dnsPromiseMethods = [
  "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
  "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv",
  "resolveTxt", "reverse",
] as const;
for (const method of dnsPromiseMethods) {
  replace(dns.promises, method, blocked(`node:dns.promises.${method}`));
}

for (const [prototype, methods, owner] of [
  [net.Socket.prototype, ["connect"], "node:net.Socket"],
  [net.Server.prototype, ["listen"], "node:net.Server"],
  [childProcess.ChildProcess.prototype, ["spawn"], "node:child_process.ChildProcess"],
  [dgram.Socket.prototype, ["bind", "connect", "send"], "node:dgram.Socket"],
  [dns.Resolver.prototype, [
    "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx",
    "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse",
  ], "node:dns.Resolver"],
] as const) {
  for (const method of methods) replace(prototype, method, blocked(`${owner}.${method}`));
}

const credentialFile = (value: unknown): boolean => {
  let path: string;
  if (value instanceof URL) {
    try {
      path = decodeURIComponent(value.pathname);
    } catch {
      return true;
    }
  }
  else if (typeof value === "string" || Buffer.isBuffer(value)) path = String(value);
  else return false;
  const leaf = basename(resolve(path)).toLowerCase();
  return leaf === ".env" || leaf.startsWith(".env.");
};

const credentialFileOrAlias = (value: unknown): boolean => {
  if (credentialFile(value)) return true;
  if (!(value instanceof URL) && typeof value !== "string" && !Buffer.isBuffer(value)) return false;
  try {
    return credentialFile(fs.realpathSync(value));
  } catch {
    return false;
  }
};

const guardFileMethod = (
  owner: object,
  method: string,
  capability: string,
  pathArgumentIndexes: readonly number[] = [0],
): void => {
  const original = Reflect.get(owner, method) as (...args: unknown[]) => unknown;
  replace(owner, method, function guardedCredentialFile(this: unknown, ...args: unknown[]): unknown {
    if (pathArgumentIndexes.some((index) => credentialFileOrAlias(args[index]))) {
      throw new DefaultNetworkIsolationError(capability);
    }
    return Reflect.apply(original, this, args);
  });
};

for (const method of ["open", "openSync", "readFile", "readFileSync", "createReadStream"] as const) {
  guardFileMethod(fs, method, `node:fs.${method}(.env)`);
}
for (const method of ["open", "readFile"] as const) {
  guardFileMethod(fsPromises, method, `node:fs/promises.${method}(.env)`);
}
for (const method of [
  "copyFile", "copyFileSync", "cp", "cpSync", "link", "linkSync", "rename", "renameSync",
  "symlink", "symlinkSync",
] as const) {
  guardFileMethod(fs, method, `node:fs.${method}(.env)`, [0, 1]);
}
for (const method of ["copyFile", "cp", "link", "rename", "symlink"] as const) {
  guardFileMethod(fsPromises, method, `node:fs/promises.${method}(.env)`, [0, 1]);
}

replace(process, "loadEnvFile", blocked("process.loadEnvFile"));
// pi-ai's browser-safe User-Agent loader reads only these OS facts. Do not
// expose module loading as a way around the network/process/worker guards.
const osMetadata = Object.freeze({ arch, platform, release });
replace(process, "getBuiltinModule", (name: string) => {
  if (name === "node:os" || name === "os") return osMetadata;
  return blocked("process.getBuiltinModule")();
});

syncBuiltinESMExports();

replace(globalThis, "fetch", (): Promise<never> =>
  Promise.reject(new DefaultNetworkIsolationError("globalThis.fetch")));
replace(globalThis, "WebSocket", function DisabledWebSocket(): never {
  throw new DefaultNetworkIsolationError("globalThis.WebSocket");
});

const allowedEnvironment = new Set([
  "CI",
  "GITHUB_ACTIONS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_ENV",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "VITEST",
  "VITEST_POOL_ID",
  "WINDIR",
]);
for (const name of Object.keys(process.env)) if (!allowedEnvironment.has(name)) delete process.env[name];
const isolatedHome = resolve(tmpdir(), "myagents-dsh-default-test-home");
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.MYAGENTS_DEFAULT_TEST_ISOLATION = "enabled";

export const probeDefaultNetworkBlocks = async (): Promise<void> => {
  for (const [capability, invoke] of [
    ["execSync", () => childProcess.execSync("default-isolation-canary")],
    ["execFileSync", () => childProcess.execFileSync(process.execPath, ["--version"])],
    ["spawnSync", () => childProcess.spawnSync(process.execPath, ["--version"])],
  ] as const) {
    try {
      invoke();
      throw new Error(`${capability} canary unexpectedly passed`);
    } catch (error) {
      if (!(error instanceof DefaultNetworkIsolationError)) throw error;
    }
  }
  try {
    (new childProcess.ChildProcess() as unknown as {
      spawn(options: unknown): void;
    }).spawn({ file: process.execPath });
    throw new Error("ChildProcess prototype canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    process.getBuiltinModule("worker_threads");
    throw new Error("getBuiltinModule canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    new workerThreads.Worker("", { eval: true });
    throw new Error("Worker canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    process.loadEnvFile(["/definitely-missing/.", "env"].join(""));
    throw new Error("process.loadEnvFile canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    new WebSocket("not a url");
    throw new Error("WebSocket canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    http.request("http://fixture.invalid");
    throw new Error("HTTP canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    net.connect({ port: 9 });
    throw new Error("socket canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    new net.Socket().connect({ port: 9 });
    throw new Error("Socket prototype canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    http2.connect("https://fixture.invalid");
    throw new Error("HTTP/2 canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    const unprefixedHttp2 = await import("http2");
    unprefixedHttp2.connect("https://fixture.invalid");
    throw new Error("unprefixed HTTP/2 canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    await dns.promises.reverse("192.0.2.1");
    throw new Error("DNS reverse canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    dns.resolveMx("fixture.invalid", () => undefined);
    throw new Error("DNS record canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    await dns.promises.resolveMx("fixture.invalid");
    throw new Error("DNS promises record canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    new dns.Resolver().resolveMx("fixture.invalid", () => undefined);
    throw new Error("DNS resolver record canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  await fetch("https://fixture.invalid").then(
    () => { throw new Error("fetch canary unexpectedly passed"); },
    (error: unknown) => {
      if (!(error instanceof DefaultNetworkIsolationError)) throw error;
    },
  );
  try {
    fs.readFileSync([".", "env"].join(""));
    throw new Error("environment-file canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    fs.readFileSync(new URL(["file:///definitely-missing/%2e", "env"].join("")));
    throw new Error("encoded environment-file URL canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  try {
    const promises = await import("node:fs/promises");
    await promises.readFile([".", "env.default-test-canary"].join(""));
    throw new Error("environment-file promises canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  }
  const aliasRoot = fs.mkdtempSync(resolve(tmpdir(), "myagents-dsh-env-alias-canary-"));
  const credentialSource = resolve(aliasRoot, "source", ".env");
  const aliasPath = resolve(aliasRoot, "alias.txt");
  fs.mkdirSync(resolve(aliasRoot, "source"));
  fs.writeFileSync(credentialSource, "SYNTHETIC_CANARY");
  try {
    for (const [capability, invoke] of [
      ["copyFile", () => fs.copyFile(credentialSource, resolve(aliasRoot, "copy.txt"), () => undefined)],
      ["copyFileSync", () => fs.copyFileSync(credentialSource, resolve(aliasRoot, "copy-sync.txt"))],
      ["cp", () => fs.cp(credentialSource, resolve(aliasRoot, "cp.txt"), () => undefined)],
      ["cpSync", () => fs.cpSync(credentialSource, resolve(aliasRoot, "cp-sync.txt"))],
      ["link", () => fs.link(credentialSource, resolve(aliasRoot, "link.txt"), () => undefined)],
      ["linkSync", () => fs.linkSync(credentialSource, resolve(aliasRoot, "link-sync.txt"))],
      ["rename", () => fs.rename(credentialSource, resolve(aliasRoot, "rename.txt"), () => undefined)],
      ["renameSync", () => fs.renameSync(credentialSource, resolve(aliasRoot, "rename-sync.txt"))],
      ["symlink", () => fs.symlink(credentialSource, resolve(aliasRoot, "symlink.txt"), () => undefined)],
      ["symlinkSync", () => fs.symlinkSync(credentialSource, resolve(aliasRoot, "symlink-sync.txt"))],
    ] as const) {
      try {
        invoke();
        throw new Error(`${capability} credential alias canary unexpectedly passed`);
      } catch (error) {
        if (!(error instanceof DefaultNetworkIsolationError)) throw error;
      }
    }
    for (const [capability, invoke] of [
      ["copyFile", () => fsPromises.copyFile(credentialSource, resolve(aliasRoot, "promise-copy.txt"))],
      ["cp", () => fsPromises.cp(credentialSource, resolve(aliasRoot, "promise-cp.txt"))],
      ["link", () => fsPromises.link(credentialSource, resolve(aliasRoot, "promise-link.txt"))],
      ["rename", () => fsPromises.rename(credentialSource, resolve(aliasRoot, "promise-rename.txt"))],
      ["symlink", () => fsPromises.symlink(credentialSource, resolve(aliasRoot, "promise-symlink.txt"))],
    ] as const) {
      try {
        await invoke();
        throw new Error(`promises.${capability} credential alias canary unexpectedly passed`);
      } catch (error) {
        if (!(error instanceof DefaultNetworkIsolationError)) throw error;
      }
    }
    originalSymlinkSync(credentialSource, aliasPath);
    try {
      fs.readFileSync(aliasPath);
      throw new Error("environment-file realpath alias canary unexpectedly passed");
    } catch (error) {
      if (!(error instanceof DefaultNetworkIsolationError)) throw error;
    }
  } finally {
    fs.rmSync(aliasRoot, { force: true, recursive: true });
  }
  await blockedAsync("canary")().catch((error: unknown) => {
    if (!(error instanceof DefaultNetworkIsolationError)) throw error;
  });
};
