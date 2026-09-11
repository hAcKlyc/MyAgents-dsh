import { SessionId } from "@deepseek-ai/dsh-session";
import { SessionAlreadyOwnedError } from "@deepseek-ai/dsh-session-persistence";
import { createProductSessionOwnershipProvider } from "../../packages/persistence-product/src/session-ownership.js";
import { resolveRuntimePlatformTarget } from "../../packages/product-profile/src/platform-contract.js";

const [path, mode] = process.argv.slice(2);
if (path === undefined || (mode !== "hold" && mode !== "probe")) throw new Error("invalid synthetic ownership fixture arguments");
try {
  const provider = createProductSessionOwnershipProvider(resolveRuntimePlatformTarget(process.platform, process.arch));
  const owner = await provider.acquire(path, SessionId("native-ownership-fixture"));
  await owner.assertHeld();
  if (mode === "hold") {
    process.stdout.write("owned\n");
    process.stdin.resume();
    await new Promise<void>((resolve) => { process.stdin.once("end", resolve); });
  }
  await owner.release();
  process.stdout.write("released\n");
} catch (error) {
  if (!(error instanceof SessionAlreadyOwnedError)) throw error;
  process.stdout.write("busy\n");
}
