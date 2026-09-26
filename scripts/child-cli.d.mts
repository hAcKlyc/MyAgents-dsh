export function childCli(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): { readonly command: string; readonly args: readonly string[] };
