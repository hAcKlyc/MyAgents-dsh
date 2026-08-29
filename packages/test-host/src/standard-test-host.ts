import { ProtocolError } from "@myagents-dsh/protocol";
import type {
  GeneratedHostClient,
  GeneratedHostRequestHandlers,
} from "@myagents-dsh/protocol/generated/host-client";

export type StandardTestHostCall = {
  method: keyof GeneratedHostRequestHandlers;
  params: unknown;
};

export class StandardTestHost {
  readonly calls: StandardTestHostCall[] = [];
  readonly #disposeHandlers: () => void;

  constructor(
    readonly client: GeneratedHostClient,
    overrides: Partial<GeneratedHostRequestHandlers> = {},
  ) {
    const defaults: GeneratedHostRequestHandlers = {
      "host/credential/resolve": (params) => {
        this.#record("host/credential/resolve", params);
        if (params.purpose !== "availability") {
          throw new ProtocolError(
            "host_credential_unavailable",
            "Standard Test Host has no credential material",
          );
        }
        return {
          kind: "availability",
          available: false,
          authoritativeCredentialRevision: "synthetic-none",
          reasonCode: "fixture_unavailable",
        };
      },
      "host/interaction/request": (params) => {
        this.#record("host/interaction/request", params);
        return { registered: true };
      },
      "host/tool/execute": (params) => {
        this.#record("host/tool/execute", params);
        return { state: "failed", code: "fixture_tool_unconfigured" };
      },
      "host/hook/execute": (params) => {
        this.#record("host/hook/execute", params);
        return { state: "continue" };
      },
      "host/attachment/put": (params) => {
        this.#record("host/attachment/put", params);
        return {
          attachmentId: `synthetic:${params.sha256}`,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
          sha256: params.sha256,
        };
      },
      "host/attachment/acquire": (params) => {
        this.#record("host/attachment/acquire", params);
        throw new ProtocolError(
          "host_attachment_unavailable",
          "Standard Test Host has no attachment bytes",
        );
      },
      "host/attachment/release": (params) => {
        this.#record("host/attachment/release", params);
        return { ok: true };
      },
    };
    this.#disposeHandlers = client.registerHostHandlers({ ...defaults, ...overrides });
  }

  dispose(): void {
    this.#disposeHandlers();
  }

  #record(method: keyof GeneratedHostRequestHandlers, params: unknown): void {
    this.calls.push({ method, params: structuredClone(params) });
  }
}
