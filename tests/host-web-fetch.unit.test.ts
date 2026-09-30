import type { Context } from "@deepseek-ai/cordis";
import { Readable } from "node:stream";
import {
  convertHostWebContent,
  createHostDeepSeekWebFetchConfig,
} from "@myagents-dsh/runtime-product";
import type {
  ProductWebContentRequest,
} from "@myagents-dsh/tools-web";
import { describe, expect, it, vi } from "vitest";

const contentRequest = (
  contentType: string,
  bytes: Uint8Array,
  signal = new AbortController().signal,
): ProductWebContentRequest => Object.freeze({
  bytes,
  contentType,
  finalUrl: "https://example.com/document",
  signal,
  statusCode: 200,
});

const minimalPdf = (text: string): Uint8Array => {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 100 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
};

describe("Host WebFetch production adapters", () => {
  it("accepts HTTPS proxy responses with Undici's symbol-keyed TLS metadata", async () => {
    const sensitiveHeaders = Symbol("sensitiveHeaders");
    const headers = {
      "content-type": "text/plain",
      "set-cookie": ["session=test"],
      [sensitiveHeaders]: ["set-cookie"],
    };
    const config = createHostDeepSeekWebFetchConfig({} as Context, "network-policy-v1", {
      proxyTransportFor: () => ({ dispatch: () => Promise.resolve({
        body: Readable.from([Buffer.from("HTTPS content")]),
        headers,
        statusCode: 200,
        dispose: () => Promise.resolve(),
      }) }),
    });
    const opened = await config.client.open("https://example.com/article", {
      headers: {}, method: "GET", policyRef: "network-policy-v1", signal: AbortSignal.timeout(1_000),
    });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("HTTPS content");
    } finally { await opened.dispose(); }
  });

  it("uses the composition-selected proxy for native WebFetch without local DNS", async () => {
    const dispatch = vi.fn(() => Promise.resolve(Object.freeze({
      body: Readable.from([Buffer.from("proxied content")]),
      headers: Object.freeze({ "content-type": "text/plain" }),
      statusCode: 200,
      dispose: () => Promise.resolve(),
    })));
    const proxyTransportFor = vi.fn(() => Object.freeze({ dispatch }));
    const config = createHostDeepSeekWebFetchConfig({} as Context, "network-policy-v1", { proxyTransportFor });
    const opened = await config.client.open("https://example.com/article", {
      headers: {}, method: "GET", policyRef: "network-policy-v1", signal: AbortSignal.timeout(1_000),
    });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("proxied content");
      expect(proxyTransportFor).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      await opened.dispose();
    }
  });

  it("converts bounded HTML to markdown and removes active-content elements", async () => {
    const result = await convertHostWebContent(contentRequest(
      "text/html",
      Buffer.from("<html><body><h1>Title</h1><script>ignore()</script><p>Hello <strong>world</strong>.</p></body></html>"),
    ));
    expect(result).toEqual({
      content: "# Title\n\nHello **world**.",
      kind: "text",
      truncated: false,
    });
  });

  it("extracts text from a PDF without network or rendering authority", async () => {
    const result = await convertHostWebContent(contentRequest(
      "application/pdf",
      minimalPdf("Hello governed PDF"),
    ));
    expect(result).toEqual({ content: "Hello governed PDF", kind: "text", truncated: false });
  }, 30_000);

  it("bounds decoded source content and observes cancellation", async () => {
    const result = await convertHostWebContent(contentRequest(
      "text/plain",
      Buffer.from("a".repeat(210_000)),
    ));
    expect(Buffer.byteLength(result.content)).toBe(200_000);
    expect(result.truncated).toBe(true);

    const controller = new AbortController();
    controller.abort(new Error("cancelled fixture"));
    await expect(convertHostWebContent(contentRequest(
      "text/plain",
      Buffer.from("unread"),
      controller.signal,
    ))).rejects.toThrow("cancelled fixture");
  });

});
