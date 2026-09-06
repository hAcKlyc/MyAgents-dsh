import { resolvePwshPath } from "@deepseek-ai/dsh-pwsh-local";
import {
  CANONICAL_TOOL_NAMES,
  CANONICAL_TOOL_CONTRACT_SHA256,
  DEEPSEEK_WEB_SEARCH_POLICY_REF,
  effectiveToolCatalogDigest,
  extensionSnapshotDigest,
  validateNormalizedEffectiveToolCatalog,
  type EffectiveToolCatalogSnapshot,
  type MethodParams,
} from "@myagents-dsh/protocol";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  resolveRuntimePlatformTarget,
  selectPlatformAdapter,
  type PlatformTarget,
} from "@myagents-dsh/product-profile";
import {
  composeDshRootServices,
  createHostProviderWebFetchPlaneConfig,
  createHostProviderWebSearchPlaneConfig,
  createHostBackedInteractionProvider,
  createProductAgentComponentCompiler,
  createProductCommandComponentCompiler,
  createProductHookComponentCompiler,
  createProductHostToolComponentCompiler,
  createProductManagedMcpComponentCompiler,
  createProductSkillComponentCompiler,
  installCanonicalToolPlane,
  installHostModelPlane,
  installProductComponentPlane,
  staticSkillCatalogDigest,
  type DshRootComposition,
  type StaticSkillCatalog,
} from "@myagents-dsh/runtime-product";
import { rgPath } from "@vscode/ripgrep";
import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";

export const OFFICIAL_HOST_INTERACTION_REVISION = "host-interaction-v1" as const;
export const OFFICIAL_TOOL_CATALOG_REVISION = "official-canonical-tools-v4" as const;
export const OFFICIAL_EXTENSION_REVISION = "official-empty-extensions-v1" as const;
export const OFFICIAL_PLAN_REVISION = "official-plan-v1" as const;
export const OFFICIAL_ORIGIN_REVISION = "official-root-origin-v1" as const;

const unavailableShellTools = new Set<string>([selectPlatformAdapter(resolveRuntimePlatformTarget(process.platform, process.arch)).shell.dialect === "pwsh" ? "bash" : "pwsh"]);
const effectiveTools = Object.freeze(CANONICAL_TOOL_NAMES.filter((tool) => !unavailableShellTools.has(tool)));
const toolCatalogAuthority = Object.freeze({
  formatVersion: 1 as const,
  contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
  implementationCatalog: CANONICAL_TOOL_NAMES,
  effectiveTools,
  revision: OFFICIAL_TOOL_CATALOG_REVISION,
  diagnostics: Object.freeze(CANONICAL_TOOL_NAMES.map((tool) => Object.freeze(
    unavailableShellTools.has(tool)
      ? { tool, available: false as const, reasonCode: "shell-not-selected-for-platform" }
      : { tool, available: true as const },
  ))),
});

export const OFFICIAL_TOOL_CATALOG: EffectiveToolCatalogSnapshot =
  validateNormalizedEffectiveToolCatalog(Object.freeze({
    ...toolCatalogAuthority,
    digest: effectiveToolCatalogDigest(toolCatalogAuthority),
  }));

const extensionAuthority: Omit<MethodParams<"extension/replace">, "digest"> = Object.freeze({
  formatVersion: 1 as const,
  revision: OFFICIAL_EXTENSION_REVISION,
  components: [],
  resources: [],
  skillSourcePolicy: Object.freeze({
    revision: "official-skill-source-policy-v1",
    roots: [],
  }),
  mcpLaunchPolicy: Object.freeze({
    revision: "official-mcp-launch-policy-v1",
    profiles: [],
  }),
});

export const OFFICIAL_EXTENSION_SNAPSHOT = Object.freeze({
  ...extensionAuthority,
  digest: extensionSnapshotDigest(extensionAuthority),
});

const staticSkillAuthority = Object.freeze({
  formatVersion: 1 as const,
  revision: "official-static-skills-v1",
  skills: Object.freeze([]),
});

export const OFFICIAL_STATIC_SKILL_CATALOG: StaticSkillCatalog = Object.freeze({
  ...staticSkillAuthority,
  digest: staticSkillCatalogDigest(staticSkillAuthority),
});

const anonymousUserId = (): string => {
  const hex = createHash("sha256")
    .update(`myagents-dsh-anonymous-user\0${ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const executableCandidates = (name: string, target: PlatformTarget): readonly string[] =>
  target === "win32-x64" ? Object.freeze([`${name}.exe`, name]) : Object.freeze([name]);

const resolveExecutable = async (name: string, target: PlatformTarget): Promise<string> => {
  const searchPath = process.env.PATH ?? "";
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const candidate of executableCandidates(name, target)) {
      const path = resolve(directory, candidate);
      try {
        await access(path, fsConstants.X_OK);
        return await realpath(path);
      } catch {
        // Continue through the bounded process PATH inventory.
      }
    }
  }
  throw new Error(`official Runtime executable is unavailable: ${name}`);
};

const sha256File = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

/** Host owns the child environment policy. Read only its admitted declarations, never ambient extras. */
const readProcessEnvironment = (keys: readonly string[]): Readonly<Record<string, string>> =>
  Object.freeze(Object.fromEntries(keys.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  })));

const processAuthority = async (target: PlatformTarget) => {
  const platform = selectPlatformAdapter(target);
  if (target !== resolveRuntimePlatformTarget(process.platform, process.arch)) {
    throw new Error("official Runtime process authority must match the native artifact target");
  }
  const [shell, bundledNode, ripgrep] = await Promise.all([
    platform.shell.dialect === "pwsh" ? realpath(resolvePwshPath()) : resolveExecutable("bash", target),
    realpath(process.execPath),
    realpath(rgPath),
  ]);
  await Promise.all([access(shell, fsConstants.X_OK), access(ripgrep, fsConstants.X_OK)]);
  const [shellSha256, nodeSha256, ripgrepSha256] = await Promise.all([sha256File(shell), sha256File(bundledNode), sha256File(ripgrep)]);
  return Object.freeze({
    shellDialect: platform.shell.dialect,
    allowedCommandRefs: Object.freeze(["runtime-shell", "bundled-node", "bundled-ripgrep"]),
    environmentValues: Object.freeze({}),
    readEnvironment: readProcessEnvironment,
    executablePaths: Object.freeze({ shell, bundledNode, ripgrep }),
    executableRefs: Object.freeze({ shell: "runtime-shell", bundledNode: "bundled-node", ripgrep: "bundled-ripgrep" }),
    executableSha256: Object.freeze({ shell: shellSha256, bundledNode: nodeSha256, ripgrep: ripgrepSha256 }),
  });
};

export const composeOfficialRuntimeServices = async (
  target: PlatformTarget = resolveRuntimePlatformTarget(process.platform, process.arch),
): Promise<DshRootComposition> => {
  const authority: { composition?: DshRootComposition } = {};
  const configured = await composeDshRootServices({
    operationBirthAuthority: Object.freeze({
      capture: (params: MethodParams<"turn/start">) => {
        const root = authority.composition?.context;
        if (root === undefined) throw new Error("official Runtime composition is not installed");
        const agent = root.productSession.requireAgent();
        const modelProfile = root.productSession.requireOperationModelProfile();
        return Object.freeze({
          configRevision: params.configRevision,
          modelProfileRevision: modelProfile.revision,
          componentRevision: OFFICIAL_EXTENSION_SNAPSHOT.revision,
          componentDigest: OFFICIAL_EXTENSION_SNAPSHOT.digest,
          toolCatalogRevision: OFFICIAL_TOOL_CATALOG.revision,
          toolCatalogDigest: OFFICIAL_TOOL_CATALOG.digest,
          executionEnvironmentRevision: params.executionEnvironmentRevision,
          executionEnvironmentDigest: params.executionEnvironmentDigest,
          permissionRevision: root.productPermission.currentRevision(agent),
          interactionScenarioRevision: root.productSession.requireOperationInteractionScenarioRevision(),
          planRevision: root.productPlan.currentRevision(agent),
          originRevision: OFFICIAL_ORIGIN_REVISION,
          limits: params.limits,
          ...(modelProfile.pricing === undefined ? {} : { pricing: modelProfile.pricing }),
        });
      },
    }),
    systemPrompt: Object.freeze({
      includeHarnessIdentity: false,
    }),
    tools: Object.freeze({ mode: "native" }),
  });
  authority.composition = configured;
  try {
    await installHostModelPlane(configured, Object.freeze({ resolveUserId: anonymousUserId }));
    const interaction = createHostBackedInteractionProvider(configured, Object.freeze({
      revision: OFFICIAL_HOST_INTERACTION_REVISION,
      deadlineMs: 120_000,
    }));
    await installCanonicalToolPlane(configured, Object.freeze({
      catalog: () => OFFICIAL_TOOL_CATALOG,
      permission: Object.freeze({
        autoAllowTools: Object.freeze([]),
        interaction,
        interactionRegistrationDeadlineMs: 120_000,
        maxRules: 128,
        mode: "default",
        ruleTtlMs: 86_400_000,
      }),
      plan: Object.freeze({ revision: OFFICIAL_PLAN_REVISION }),
      platformTarget: target,
      process: await processAuthority(target),
      skills: OFFICIAL_STATIC_SKILL_CATALOG,
      temporaryRoot: await realpath(process.env.TMPDIR ?? tmpdir()),
      web: Object.freeze({
        fetch: createHostProviderWebFetchPlaneConfig(
          configured,
          DEEPSEEK_WEB_SEARCH_POLICY_REF,
        ),
        search: createHostProviderWebSearchPlaneConfig(
          configured,
          DEEPSEEK_WEB_SEARCH_POLICY_REF,
        ),
      }),
    }));
    const componentConfig = Object.freeze({
      catalog: OFFICIAL_TOOL_CATALOG,
      compilers: Object.freeze([
        createProductManagedMcpComponentCompiler(configured),
        createProductSkillComponentCompiler(configured),
        createProductAgentComponentCompiler(configured),
        createProductCommandComponentCompiler(configured),
        createProductHookComponentCompiler(configured),
        createProductHostToolComponentCompiler(configured),
      ]),
      initialSnapshot: OFFICIAL_EXTENSION_SNAPSHOT,
    });
    await installProductComponentPlane(configured, componentConfig);
    return configured;
  } catch (error) {
    await configured.dispose();
    throw error;
  }
};
