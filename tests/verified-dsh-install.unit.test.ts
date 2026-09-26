import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { packageForVerifiedDshInstall } from "../scripts/verified-dsh-install-policy.mjs";

describe("verified DSH installation", () => {
  it("redirects root and workspace DSH dependencies to the same verified tarballs", () => {
    const source = {
      dependencies: { "@deepseek-ai/dsh-session": "0.1.7-rc.2" },
      overrides: { "@deepseek-ai/dsh-session": "0.1.7-rc.2", unrelated: "2.0.0" },
    };
    const packages = [
      { name: "@deepseek-ai/dsh-session", tarball: "session.tgz" },
      { name: "@deepseek-ai/dsh-agent", tarball: "agent.tgz" },
    ];
    const result = packageForVerifiedDshInstall(source, packages, "/artifact");

    expect(result.dependencies?.["@deepseek-ai/dsh-session"]).toBe(`file:${resolve("/artifact/session.tgz")}`);
    expect(result.overrides?.["@deepseek-ai/dsh-session"]).toBe(result.dependencies?.["@deepseek-ai/dsh-session"]);
    expect(result.overrides?.["@deepseek-ai/dsh-agent"]).toBe(`file:${resolve("/artifact/agent.tgz")}`);
    expect(result.overrides?.unrelated).toBe("2.0.0");
    expect(source.dependencies["@deepseek-ai/dsh-session"]).toBe("0.1.7-rc.2");
  });
});
