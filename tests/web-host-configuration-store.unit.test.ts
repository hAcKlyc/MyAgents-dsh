import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REFERENCE_WEB_DEFAULT_CONTROLS,
  ReferenceWebConfigurationStore,
} from "@myagents-dsh/web-host";
import { describe, expect, it } from "vitest";

describe("Reference Web Host non-secret configuration store", () => {
  it("atomically persists bounded Session controls without placing them in the catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "myagents-web-controls-"));
    const path = join(root, "controls.json");
    const store = await ReferenceWebConfigurationStore.open(path, REFERENCE_WEB_DEFAULT_CONTROLS);
    await store.setConfiguration("session-1", {
      ...REFERENCE_WEB_DEFAULT_CONTROLS.configuration,
      revision: "session-config-v2",
      systemPrompt: "A public test prompt",
      visibleTools: ["Read", "Grep"],
    });
    const reopened = await ReferenceWebConfigurationStore.open(path, REFERENCE_WEB_DEFAULT_CONTROLS);
    expect(reopened.get("session-1").configuration).toMatchObject({
      revision: "session-config-v2",
      visibleTools: ["Read", "Grep"],
    });
    expect(await readFile(path, "utf8")).not.toContain("DEEPSEEK_API_KEY");
  });

  it("quarantines malformed or secret-bearing component state", async () => {
    const root = await mkdtemp(join(tmpdir(), "myagents-web-controls-bad-"));
    const path = join(root, "controls.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      rows: [{
        webSessionId: "session-1",
        configuration: REFERENCE_WEB_DEFAULT_CONTROLS.configuration,
        components: {
          revision: "components-v1",
          digest: "a".repeat(64),
          components: [{
            id: "bad-mcp",
            kind: "mcp",
            enabled: true,
            configuration: { descriptor: { transport: "http", url: "https://example.com", apiKey: "forbidden" } },
          }],
        },
      }],
    }), { mode: 0o600 });
    const store = await ReferenceWebConfigurationStore.open(path, REFERENCE_WEB_DEFAULT_CONTROLS);
    expect(store.get("session-1")).toEqual(REFERENCE_WEB_DEFAULT_CONTROLS);
  });
});
