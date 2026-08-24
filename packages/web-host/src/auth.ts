import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { WebHostError } from "./errors.js";

export const WEB_HOST_SESSION_COOKIE = "myagents_dsh_session" as const;

export type BrowserAuth = Readonly<{
  cookieToken: string;
  csrfToken: string;
  sessionDigest: string;
}>;

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
const validTokenShape = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/u.test(value);

export class LaunchAuthenticator {
  readonly launchCapability: string;
  #launchDigest: Buffer | undefined;
  #auth: BrowserAuth | undefined;

  constructor() {
    this.launchCapability = base64url(randomBytes(32));
    this.#launchDigest = digest(this.launchCapability);
  }

  exchange(candidate: string): BrowserAuth {
    const expected = this.#launchDigest;
    const observed = validTokenShape(candidate) ? digest(candidate) : Buffer.alloc(32);
    const matches = expected !== undefined && timingSafeEqual(expected, observed);
    if (!matches) throw new WebHostError("launch_capability_invalid", "Launch capability is invalid or already consumed");
    this.#launchDigest = undefined;
    const cookieToken = base64url(randomBytes(32));
    this.#auth = Object.freeze({
      cookieToken,
      csrfToken: base64url(randomBytes(32)),
      sessionDigest: createHash("sha256").update(cookieToken).digest("hex"),
    });
    return this.#auth;
  }

  authenticateCookie(cookieHeader: string | undefined): BrowserAuth {
    const auth = this.#auth;
    if (auth === undefined || cookieHeader === undefined) {
      throw new WebHostError("browser_unauthorized", "Browser Session is not authenticated");
    }
    const values = cookieHeader.split(";").map((part) => part.trim()).filter(Boolean);
    const matching = values.flatMap((part) => {
      const separator = part.indexOf("=");
      return separator < 0 || part.slice(0, separator) !== WEB_HOST_SESSION_COOKIE
        ? []
        : [part.slice(separator + 1)];
    });
    const first = matching[0];
    const candidate = matching.length === 1 && first !== undefined && validTokenShape(first)
      ? first
      : "";
    const matches = timingSafeEqual(digest(candidate), digest(auth.cookieToken));
    if (!matches || matching.length !== 1) {
      throw new WebHostError("browser_unauthorized", "Browser Session is not authenticated");
    }
    return auth;
  }

  assertCsrf(auth: BrowserAuth, candidate: string | undefined): void {
    const observed = candidate !== undefined && validTokenShape(candidate) ? candidate : "";
    if (!timingSafeEqual(digest(observed), digest(auth.csrfToken))) {
      throw new WebHostError("browser_csrf_invalid", "CSRF token is invalid");
    }
  }

  cookieHeader(auth: BrowserAuth): string {
    return `${WEB_HOST_SESSION_COOKIE}=${auth.cookieToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`;
  }
}
