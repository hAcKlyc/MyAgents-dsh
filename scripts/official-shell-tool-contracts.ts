import { Context } from "@deepseek-ai/cordis";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import * as ShellEnv from "@deepseek-ai/dsh-shell-env";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as ToolBash from "@deepseek-ai/dsh-tool-bash";
import * as ToolJobs from "@deepseek-ai/dsh-tool-jobs";
import * as ToolPwsh from "@deepseek-ai/dsh-tool-pwsh";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { WorkingDirectoryService } from "@deepseek-ai/dsh-working-directory";

/** Build-time only: materialize official definitions without executing any tool. */
export const officialShellToolContracts = async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(LocalFileSystem);
    await ctx.plugin(WorkingDirectoryService);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(LocalSubprocessRuntime);
    await ctx.plugin(LocalBashExecutor);
    await ctx.plugin(ShellEnv, { dshHome: "/contract-generation-only" });
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 });
    await ctx.plugin(ToolBash, { enableRunInBackground: true });
    await ctx.plugin(ToolPwsh, { enableRunInBackground: true });
    await ctx.plugin(ToolJobs, { completionDelivery: "quiet" });
    return Object.fromEntries(["bash", "pwsh", "job_output", "job_list", "job_kill"].map((name) => {
      const definition = ctx.tools.get(name);
      if (definition === undefined) throw new Error(`official tool failed to register: ${name}`);
      return [name, {
        name,
        description: definition.description,
        inputSchema: definition.parameters,
        outputSchema: definition.output.schema,
      }];
    }));
  } finally {
    await ctx.fiber.dispose();
  }
};
