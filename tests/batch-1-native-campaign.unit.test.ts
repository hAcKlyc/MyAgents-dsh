import { describe, expect, it } from "vitest";

import {
  BATCH_1_NATIVE_CAMPAIGN_VERSION,
  extractFinalCliJson,
} from "../scripts/run-batch-1-native-campaign.js";

describe("Batch 1 native campaign", () => {
  it("extracts only one final CLI JSON object from npm output", () => {
    expect(BATCH_1_NATIVE_CAMPAIGN_VERSION).toBe(1);
    expect(extractFinalCliJson("npm prefix\n{\n  \"outcome\": \"passed\"\n}"))
      .toEqual({ outcome: "passed" });
    expect(extractFinalCliJson('{"target":"linux-x64"}')).toEqual({ target: "linux-x64" });
    expect(() => extractFinalCliJson("not-json")).toThrow("final JSON object");
    expect(() => extractFinalCliJson("[]")).toThrow("final JSON object");
  });
});
