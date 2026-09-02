import { basename, posix } from "node:path";

export interface ForbiddenContentFinding {
  readonly rule: string;
  readonly path: string;
  readonly line?: number;
}

const secretPatterns = [
  {
    rule: "private-key-material",
    expression: new RegExp(["-----BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----"].join(""), "u"),
  },
  {
    rule: "provider-token",
    expression: new RegExp(["(?:sk|dsk)", "-[A-Za-z0-9_-]{20,}"].join(""), "u"),
  },
  {
    rule: "github-token",
    expression: new RegExp(["gh", "[pousr]_[A-Za-z0-9]{20,}"].join(""), "u"),
  },
  {
    rule: "npm-token",
    expression: new RegExp(["npm", "_[A-Za-z0-9_-]{20,}"].join(""), "u"),
  },
  {
    rule: "aws-access-key",
    expression: new RegExp(["AK", "IA[0-9A-Z]{16}"].join(""), "u"),
  },
  {
    rule: "assigned-secret-value",
    expression: new RegExp(
      [
        "(?:API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|GH[_-]?PAT|CI[_-]?JOB[_-]?JWT|NPM[_-]?CONFIG[_-]+AUTH)",
        "[\"']?\\s*[:=]\\s*(?:[\"'][A-Za-z0-9+/=_-]{12,}[\"']|[A-Za-z0-9+/=_-]{12,}(?=$|[\\s,;}\\]]))",
      ].join(""),
      "iu",
    ),
  },
  {
    rule: "authorization-credential",
    expression: new RegExp(
      ["AUTHORIZATION", "[\"']?\\s*[:=,]\\s*[\"']?", "(?:BEARER|BASIC)", "\\s+[A-Za-z0-9+./=_-]{12,}"].join(""),
      "iu",
    ),
  },
  {
    rule: "url-userinfo-credential",
    expression: new RegExp(
      ["(?:https?|registry):\\/\\/", "[^\\s:/@]+", ":[^\\s/@]{8,}@"].join(""),
      "iu",
    ),
  },
  {
    rule: "npm-auth-config",
    expression: new RegExp(
      ["(?:^|\\n)\\s*", "(?://[^=\\n]*:)?", "(?:_AUTH(?:TOKEN)?|_", "PASS", "WORD|USERNAME)", "\\s*="].join(""),
      "imu",
    ),
  },
] as const;

const syntheticHomeOwners = new Set(["fixture", "private", "runner", "user"]);

const lineNumber = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

const decodeUtf32 = (buffer: Buffer, endian: "le" | "be"): string => {
  const codePoints: string[] = [];
  const alignedLength = buffer.length - (buffer.length % 4);
  for (let offset = 0; offset < alignedLength; offset += 4) {
    const value = endian === "le" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    codePoints.push(value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)
      ? String.fromCodePoint(value)
      : "\ufffd");
  }
  return codePoints.join("");
};

const homePathFindings = (path: string, text: string): ForbiddenContentFinding[] => {
  const findings: ForbiddenContentFinding[] = [];
  const patterns = [
    /\/Users\/(?<owner>[^/\s"']+)\//giu,
    /\/home\/(?<owner>[^/\s"']+)\//giu,
    /[A-Za-z]:[\\/]Users[\\/](?<owner>[^\\/\s"']+)[\\/]/giu,
  ] as const;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const owner = match.groups?.owner?.toLowerCase();
      if (owner === undefined || syntheticHomeOwners.has(owner)) continue;
      findings.push({ rule: "private-home-path", path, line: lineNumber(text, match.index) });
    }
  }
  return findings;
};

export const normalizeArtifactPath = (value: string): string => {
  if (value.length === 0 || value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) {
    throw new TypeError("artifact path must be a non-empty relative POSIX path");
  }
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError("artifact path must not escape its root");
  }
  return normalized;
};

export const scanForbiddenContent = (
  relativePath: string,
  bytes: Uint8Array | string,
): ForbiddenContentFinding[] => {
  const path = normalizeArtifactPath(relativePath);
  const findings: ForbiddenContentFinding[] = [];
  const leaf = basename(path).toLowerCase();
  const lowerPath = path.toLowerCase();
  if (/(?:^|\/)\.claude\/(?:agents|rules)\//u.test(lowerPath)
    || /(?:^|\/)\.agents\/(?:memory\/|prompts?\/|(?:update[_-])?(?:memory|soul|user)\.md$)/u.test(lowerPath)
    || /^(?:update[_-])?(?:memory|soul|user)\.md$/u.test(lowerPath)) {
    findings.push({ rule: "private-agent-memory", path });
  }
  if (leaf === ".env" || leaf.startsWith(".env.")) findings.push({ rule: "environment-file", path });
  const credentialLeaf = [".npmrc", ".git-credentials", ".netrc"].some((name) =>
    leaf === name || leaf.startsWith(`${name}.`));
  if (credentialLeaf && path !== ".npmrc") {
    findings.push({ rule: "credential-file", path });
  }
  if (leaf.endsWith(".log")) findings.push({ rule: "log-file", path });
  if (leaf.endsWith(".pem") || leaf.endsWith(".key")) findings.push({ rule: "key-file", path });
  if (/(?:^|[-_.])(?:transcript|conversation)(?:[-_.]|$)/iu.test(leaf)) {
    findings.push({ rule: "transcript-file", path });
  }

  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  const decoded = [buffer.toString("utf8")];
  if (buffer.length >= 4) {
    const evenBytes = buffer.subarray(0, buffer.length - (buffer.length % 2));
    const byteSwapped = Buffer.from(evenBytes);
    byteSwapped.swap16();
    decoded.push(evenBytes.toString("utf16le"), byteSwapped.toString("utf16le"));
    decoded.push(decodeUtf32(buffer, "le"), decodeUtf32(buffer, "be"));
  }
  const semanticTexts = [...decoded];
  if (leaf.endsWith(".json")) {
    for (const text of decoded) {
      try {
        const semantic = JSON.stringify(JSON.parse(text));
        if (!semanticTexts.includes(semantic)) semanticTexts.push(semantic);
      } catch {
        // Invalid JSON remains covered by the byte-decoding scanners.
      }
    }
  }
  for (const text of semanticTexts) {
    for (const { rule, expression } of secretPatterns) {
      const match = expression.exec(text);
      if (match !== null && !findings.some((finding) => finding.rule === rule)) {
        findings.push({ rule, path, line: lineNumber(text, match.index) });
      }
    }
    for (const finding of homePathFindings(path, text)) {
      if (!findings.some((candidate) => candidate.rule === finding.rule && candidate.line === finding.line)) {
        findings.push(finding);
      }
    }
  }
  return findings;
};
