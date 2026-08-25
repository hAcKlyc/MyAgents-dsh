import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReferenceWebMutationStore } from "@myagents-dsh/web-host";
import { describe, expect, it } from "vitest";

describe("Reference Web Host mutation recovery journal", () => {
  it("persists one bounded operation authority per source Session with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "myagents-web-mutations-"));
    const path = join(root, "mutations.json");
    const store = await ReferenceWebMutationStore.open(path);
    await store.put({
      sourceWebSessionId: "source-1",
      mutation: "fork",
      clientMutationId: "mutation-1",
      operationToken: "operation-token-1",
      state: "prepared",
      targetWebSessionId: "target-1",
    });
    await store.setState("operation-token-1", "committed");

    const reopened = await ReferenceWebMutationStore.open(path);
    expect(reopened.list("source-1")).toEqual([{
      sourceWebSessionId: "source-1",
      mutation: "fork",
      clientMutationId: "mutation-1",
      operationToken: "operation-token-1",
      state: "committed",
      targetWebSessionId: "target-1",
    }]);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("DEEPSEEK_API_KEY");
    await expect(store.put({
      sourceWebSessionId: "source-1",
      mutation: "delete",
      clientMutationId: "mutation-2",
      operationToken: "operation-token-2",
      state: "prepared",
    })).rejects.toMatchObject({ code: "mutation_recovery_required" });
  });

  it("quarantines malformed journals and removes source/target recovery rows exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "myagents-web-mutations-bad-"));
    const path = join(root, "mutations.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      rows: [{
        sourceWebSessionId: "source-1",
        mutation: "fork",
        clientMutationId: "mutation-1",
        operationToken: "operation-token-1",
        state: "prepared",
      }],
    }), { mode: 0o600 });
    const recovered = await ReferenceWebMutationStore.open(path);
    expect(recovered.list("source-1")).toEqual([]);

    await recovered.put({
      sourceWebSessionId: "source-1",
      mutation: "fork",
      clientMutationId: "mutation-1",
      operationToken: "operation-token-1",
      state: "prepared",
      targetWebSessionId: "target-1",
    });
    await recovered.removeSession("target-1");
    expect(recovered.get("operation-token-1")).toBeUndefined();
  });
});
