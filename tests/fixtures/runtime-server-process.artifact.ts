const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    const { runRuntimeArtifactSelfCheck } = await import("@myagents-dsh/runtime-server/self-check");
    await runRuntimeArtifactSelfCheck(argv, import.meta.dirname);
    return 0;
  }

  const [runtimeServer, testkit] = await Promise.all([
    import("@myagents-dsh/runtime-server/process"),
    import("@myagents-dsh/testkit"),
  ]);
  const adapter = new testkit.ScriptedFakeLlmAdapter({
    contextWindow: 8_192,
    model: "fixture-model",
    provider: "fixture",
  });
  return await runtimeServer.runRuntimeServerProcess({
    composition: { adapter, providers: ["fixture"] },
    runtimeGeneration: "artifact-process-generation",
  });
};

try {
  process.exitCode = await main();
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : "Runtime process failed";
  const message = rawMessage.length > 4_096 ? `${rawMessage.slice(0, 4_095)}…` : rawMessage;
  process.stderr.write(`${JSON.stringify({ code: "runtime_process_failed", message })}\n`);
  process.exitCode = 1;
}
