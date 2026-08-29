import { describe, expect, it } from "vitest";

import { probeDefaultNetworkBlocks } from "./setup/default-isolation.js";

describe("default test isolation", () => {
  it("removes credential-bearing environment names without loading root .env", () => {
    expect(process.env.MYAGENTS_DEFAULT_TEST_ISOLATION).toBe("enabled");
    expect(Object.keys(process.env).filter((name) =>
      /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|(?:^|_)PAT(?:_|$)|(?:^|_)JWT(?:_|$)|(?:^|_)AUTH(?:_|$))/iu.test(name))).toEqual([]);
    expect(process.env.HOME).toContain("myagents-dsh-default-test-home");
    expect(process.env.USERPROFILE).toBe(process.env.HOME);
  });

  it("blocks fetch, HTTP, and raw socket entry points", async () => {
    await expect(probeDefaultNetworkBlocks()).resolves.toBeUndefined();
  });
});
