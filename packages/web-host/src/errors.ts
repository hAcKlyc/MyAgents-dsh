export class WebHostError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebHostError";
    this.code = code;
    this.retryable = retryable;
  }
}
