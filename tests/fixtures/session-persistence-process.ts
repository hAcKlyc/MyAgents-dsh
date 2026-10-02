import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionAlreadyOwnedError, type SessionHandle } from "@deepseek-ai/dsh-session-persistence";
import { ProductJsonlSessionPersistence, productCoordinationDatabasePath } from "@myagents-dsh/persistence-product";
import { resolveRuntimePlatformTarget, selectPlatformAdapter } from "@myagents-dsh/product-profile";
import { realpath } from "node:fs/promises";

const [homeArgument, mode] = process.argv.slice(2);
if (homeArgument === undefined || (mode !== "hold" && mode !== "probe")) throw new Error("invalid synthetic persistence fixture arguments");
const home = await realpath(homeArgument);
const ctx = new Context();
let writer: SessionHandle | undefined;
try {
  const platform = selectPlatformAdapter(resolveRuntimePlatformTarget(process.platform, process.arch));
  await ctx.plugin(SessionStore);
  await ctx.plugin(ProductJsonlSessionPersistence, {
    platform, runtimeHome: home,
    durability: platform.sqliteDurabilityPlan(productCoordinationDatabasePath(platform, home)),
  });
  const id = SessionId("native-persistence-fixture");
  if (mode === "hold") {
    const session = Session.create(id);
    writer = await ctx.sessionPersistence.create(session.header);
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await writer.append(session.snapshotEvents());
    await writer.flush();
    process.stdout.write("owned\n");
    process.stdin.resume();
    await new Promise<void>((resolve) => { process.stdin.once("end", resolve); });
  } else {
    writer = await ctx.sessionPersistence.open(id, "write");
    const read = await writer.read();
    if (read.events.length !== 2 || read.events[1]?.type !== "turn/end") throw new Error("committed prefix did not survive process exit");
    const session = Session.fromRestore(id, read.events, writer.header, writer.inheritedEventCount, read.eventState);
    session.append("turn/start", { turn: 2 });
    session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    await writer.append(session.snapshotEvents().slice(2));
    await writer.flush();
    const restored = (await writer.read()).events;
    if (restored.length !== 5 || restored[2]?.type !== "session/end-seed" || restored[4]?.type !== "turn/end") {
      throw new Error("successor append did not retain the native resume marker and continue the durable prefix");
    }
  }
  await writer.close();
  process.stdout.write("released\n");
} catch (error) {
  if (!(error instanceof SessionAlreadyOwnedError)) throw error;
  process.stdout.write("busy\n");
} finally {
  await writer?.close();
  await ctx.fiber.dispose();
}
