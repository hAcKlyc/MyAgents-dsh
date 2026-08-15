export class ProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const JSON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  overloaded: -32001,
  cancelled: -32002,
} as const;
