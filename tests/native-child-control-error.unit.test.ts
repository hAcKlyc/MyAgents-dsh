import { expect, it } from "vitest";
import { rethrowNativeChildControlError } from "../packages/rpc-server/src/native-child-control-error.js";

it.each([
  ["subagent/not-resumable", "subagent_not_resumable", false],
  ["subagent/unauthorized", "subagent_unauthorized", false],
  ["subagent/parent-unavailable", "subagent_unavailable", true],
  ["subagent/delivery-unavailable", "subagent_unavailable", true],
  ["gateway/cancelled", "request_cancelled", true],
] as const)("preserves native refusal %s with bounded Host-visible semantics", (native, code, retryable) => {
  const cause = { isDSHRemoteError: true, code: native, message: "private-native-detail" };
  let caught: unknown;
  try { rethrowNativeChildControlError(cause); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code, retryable });
  expect(String(caught)).not.toContain(cause.message);
  if (native === "subagent/not-resumable") expect(String(caught)).toContain("read-only");
});

it("leaves unknown and unmarked errors to the peer's default sanitized failure", () => {
  for (const error of [{ code: "subagent/not-resumable" }, { isDSHRemoteError: true, code: "gateway/internal" }]) {
    let caught: unknown;
    try { rethrowNativeChildControlError(error); } catch (value) { caught = value; }
    expect(caught).toBe(error);
  }
});
