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
    const result = packageForVerifiedDshInstall(source, packages, "/artifact", {
      dependencies: { zod: "4.6.5", "@deepseek-ai/cordis": "4.0.4", "@deepseek-ai/cordis-plugin-group": "1.0.4" },
    });

    expect(result.dependencies?.["@deepseek-ai/dsh-session"]).toBe(`file:${resolve("/artifact/session.tgz")}`);
    expect(result.overrides?.["@deepseek-ai/dsh-session"]).toBe(result.dependencies?.["@deepseek-ai/dsh-session"]);
    expect(result.overrides?.["@deepseek-ai/dsh-agent"]).toBe(`file:${resolve("/artifact/agent.tgz")}`);
    expect(result.dependencies?.["@deepseek-ai/dsh-agent"]).toBe(result.overrides?.["@deepseek-ai/dsh-agent"]);
    expect(result.overrides?.unrelated).toBe("2.0.0");
    expect(result.dependencies?.zod).toBe("4.6.5");
    // A fresh no-lock install must not resolve group 1.0.5, whose Cordis
    // peer requirement differs from the verified consumer's 4.0.4.
    expect(result.dependencies?.["@deepseek-ai/cordis"]).toBe("4.0.4");
    expect(result.dependencies?.["@deepseek-ai/cordis-plugin-group"]).toBe("1.0.4");
    expect(source.dependencies["@deepseek-ai/dsh-session"]).toBe("0.1.7-rc.2");
    expect(source.dependencies).not.toHaveProperty("zod");
  });

  it("rejects a floating schema dependency before installing unverified types", () => {
    expect(() => packageForVerifiedDshInstall({}, [], "/artifact", {
      dependencies: { zod: "^4.6.5" },
    })).toThrow("exact Zod version");
  });
});
