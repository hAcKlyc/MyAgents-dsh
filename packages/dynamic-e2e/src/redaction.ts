import { types as utilTypes } from "node:util";

export type CanonicalJson = null | boolean | number | string | CanonicalJsonArray | CanonicalJsonObject;
export interface CanonicalJsonArray extends ReadonlyArray<CanonicalJson> {
  readonly __canonicalJsonArrayBrand?: never;
}
export interface CanonicalJsonObject extends Readonly<Record<string, CanonicalJson>> {
  readonly __canonicalJsonObjectBrand?: never;
}

export interface EvidenceRedactionPolicy {
  readonly privatePaths: Readonly<Record<string, string>>;
  readonly secretCanaries: readonly string[];
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxStringLength?: number;
}

export const MAX_EVIDENCE_ARRAY_LENGTH = 100_000;

const compareCodePoint = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export class SecretCanaryByteScanner {
  readonly #canaries: readonly Buffer[];
  readonly #carryLength: number;
  #carry = Buffer.alloc(0);
  #observed = false;

  constructor(canaries: readonly string[]) {
    this.#canaries = Object.freeze(canaries.map((canary) => {
      if (canary.length < 8 || canary.length > 65_536 || canary.includes("\0")) {
        throw new TypeError("secret canary is invalid");
      }
      return Buffer.from(canary);
    }));
    this.#carryLength = Math.max(0, ...this.#canaries.map((canary) => canary.length - 1));
  }

  get observed(): boolean { return this.#observed; }

  observe(chunk: Uint8Array): void {
    if (this.#observed || this.#canaries.length === 0) return;
    const bytes = Buffer.concat([this.#carry, Buffer.from(chunk)]);
    if (this.#canaries.some((canary) => bytes.indexOf(canary) >= 0)) this.#observed = true;
    this.#carry = bytes.subarray(Math.max(0, bytes.length - this.#carryLength));
  }
}

export const sanitizeEvidence = (
  value: unknown,
  policy: EvidenceRedactionPolicy,
): CanonicalJson => {
  const maximumDepth = policy.maxDepth ?? 48;
  const maximumNodes = policy.maxNodes ?? 100_000;
  const maximumStringLength = policy.maxStringLength ?? 262_144;
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > 128
    || !Number.isSafeInteger(maximumNodes) || maximumNodes < 1 || maximumNodes > 1_000_000
    || !Number.isSafeInteger(maximumStringLength) || maximumStringLength < 1
    || maximumStringLength > 1_000_000) {
    throw new TypeError("evidence redaction bounds are invalid");
  }
  const canaries = [...policy.secretCanaries];
  if (canaries.some((value) => value.length < 8 || value.length > 65_536 || value.includes("\0"))) {
    throw new TypeError("secret canaries must be bounded nonempty strings of at least eight characters");
  }
  const replacements = Object.entries(policy.privatePaths)
    .sort(([left], [right]) => right.length - left.length)
    .map(([path, label]) => {
      if (path.length === 0 || path.includes("\0") || !/^\$[A-Z][A-Z0-9_]{0,63}$/u.test(label)) {
        throw new TypeError("private path redaction entries are invalid");
      }
      return Object.freeze([path, label] as const);
    });
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): CanonicalJson => {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) {
      throw new TypeError("evidence exceeds canonical JSON bounds");
    }
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || !Number.isSafeInteger(candidate)) {
        throw new TypeError("evidence numbers must be finite safe integers");
      }
      return candidate;
    }
    if (typeof candidate === "string") {
      if (candidate.length > maximumStringLength || candidate.includes("\0")) {
        throw new TypeError("evidence strings exceed their bound");
      }
      if (canaries.some((canary) => candidate.includes(canary))) {
        throw new Error("secret canary reached the evidence boundary");
      }
      return replacements.reduce((text, [path, label]) => text.split(path).join(label), candidate);
    }
    if (typeof candidate !== "object" || utilTypes.isProxy(candidate)) {
      throw new TypeError("evidence must be trap-safe canonical JSON");
    }
    if (seen.has(candidate)) throw new TypeError("evidence must not be cyclic or aliased");
    seen.add(candidate);
    if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype
          || candidate.length > MAX_EVIDENCE_ARRAY_LENGTH) {
          throw new TypeError("evidence arrays must be bounded ordinary arrays");
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const result: CanonicalJson[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            throw new TypeError("evidence arrays must be dense own-data arrays");
          }
          result.push(visit(descriptor.value, depth + 1));
        }
        if (Reflect.ownKeys(candidate).some((key) => key !== "length"
          && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
            || Number(key) >= candidate.length))) {
          throw new TypeError("evidence arrays contain unsupported fields");
        }
      return Object.freeze(result);
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("evidence objects must be plain objects");
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > 4_096 || keys.some((key) => typeof key !== "string")) {
      throw new TypeError("evidence objects contain unsupported keys");
    }
    const result: Record<string, CanonicalJson> = {};
    for (const key of (keys as string[]).sort(compareCodePoint)) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
        || key.length === 0 || key.length > 256 || key.includes("\0")) {
        throw new TypeError("evidence objects must contain bounded enumerable own-data fields");
      }
      result[key] = visit(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  };
  return visit(value, 0);
};

export const canonicalJsonText = (value: CanonicalJson): string => `${JSON.stringify(value, null, 2)}\n`;

export const assertSanitizedBytes = (
  bytes: Uint8Array,
  policy: EvidenceRedactionPolicy,
): void => {
  const text = Buffer.from(bytes).toString("utf8");
  for (const canary of policy.secretCanaries) {
    if (text.includes(canary)) throw new Error("secret canary exists in sealed evidence bytes");
  }
  for (const path of Object.keys(policy.privatePaths)) {
    if (text.includes(path)) throw new Error("private path exists in sealed evidence bytes");
  }
};
