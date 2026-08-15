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
    rule: "aws-access-key",
    expression: new RegExp(["AK", "IA[0-9A-Z]{16}"].join(""), "u"),
  },
  {
    rule: "assigned-secret-value",
    expression: new RegExp(
      [
        "(?:API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|GH[_-]?PAT|CI[_-]?JOB[_-]?JWT|NPM[_-]?CONFIG[_-]+AUTH)",
        "[\"']?\\s*[:=]\\s*[\"']?[A-Za-z0-9+/=_-]{12,}",
      ].join(""),
      "iu",
    ),
  },
] as const;

const syntheticHomeOwners = new Set(["fixture", "private", "runner", "user"]);

const lineNumber = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

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
  if (leaf.endsWith(".log")) findings.push({ rule: "log-file", path });
  if (leaf.endsWith(".pem") || leaf.endsWith(".key")) findings.push({ rule: "key-file", path });
  if (/(?:^|[-_.])(?:transcript|conversation)(?:[-_.]|$)/iu.test(leaf)) {
    findings.push({ rule: "transcript-file", path });
  }

  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  const decoded = [buffer.toString("utf8")];
  if (buffer.length >= 4 && buffer.length % 2 === 0) {
    const byteSwapped = Buffer.from(buffer);
    byteSwapped.swap16();
    decoded.push(buffer.toString("utf16le"), byteSwapped.toString("utf16le"));
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
