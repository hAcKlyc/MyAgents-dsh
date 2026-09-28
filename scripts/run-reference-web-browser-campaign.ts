import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { chromium, type BrowserContext, type Page } from "playwright-core";

import { verifyInstalledReferenceWebArtifact } from "@myagents-dsh/artifact-verifier/reference-web-artifact";

import { resolveExternalOutputRoot } from "./run-batch-1-pre-artifact-gate.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const chromeDefault = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const safeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  .replace(/([?&]launch=)[^&\s)]+/gu, "$1[redacted]")
  .slice(0, 4_096);

const sanitizeUrl = (value: string): string => {
  const url = new URL(value);
  url.searchParams.delete("launch");
  return url.toString();
};

const assert: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const waitOnline = async (page: Page): Promise<void> => {
  await page.locator('.connection-pill[data-state="online"]').waitFor({ state: "visible", timeout: 20_000 });
};

const domAccessibilityAudit = (page: Page): Promise<Readonly<{
  duplicateIds: readonly string[];
  unnamedInteractiveCount: number;
  landmarks: readonly string[];
  horizontalOverflow: number;
}>> => page.evaluate(() => {
  const ids = Array.from(document.querySelectorAll<HTMLElement>("[id]")).map(({ id }) => id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const interactive = Array.from(document.querySelectorAll<HTMLElement>(
    "button, a[href], input:not([type='hidden']), select, textarea, [role='button'], [role='dialog']",
  )).filter((element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  });
  return {
    duplicateIds: duplicates,
    unnamedInteractiveCount: interactive.filter((element) => {
      const direct = element.getAttribute("aria-label") ?? element.getAttribute("title");
      if (direct !== null && direct.trim() !== "") return false;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy !== null) {
        const text = labelledBy.split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        if (text !== "") return false;
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement
        || element instanceof HTMLTextAreaElement) {
        const explicitLabels = element.id === "" ? [] : Array.from(document.querySelectorAll<HTMLLabelElement>(
          `label[for="${CSS.escape(element.id)}"]`,
        ));
        const wrappingLabel = element.closest("label");
        const associated = [...explicitLabels, ...(wrappingLabel === null ? [] : [wrappingLabel])]
          .map((candidate) => candidate.textContent).join(" ").trim();
        if (associated !== "") return false;
      }
      return element.textContent.trim() === "";
    }).length,
    landmarks: Array.from(document.querySelectorAll("main, aside, nav, header, section[aria-label]"))
      .map((element) => `${element.tagName.toLowerCase()}:${element.getAttribute("aria-label") ?? ""}`),
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
});

const verifyComposerHostControls = async (page: Page): Promise<Readonly<{
  attachmentRoundTrip: boolean;
  permissionRoundTrip: boolean;
}>> => {
  await page.getByRole("button", { name: "Add content" }).click();
  await page.getByRole("menu", { name: "添加内容" }).waitFor({ timeout: 10_000 });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("menuitem", { name: /添加图片/u }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "browser-proof.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  const pendingAttachment = page.locator(".composer-attachments > span", { hasText: /browser-proof\.png · staged/u });
  await pendingAttachment.waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Remove browser-proof.png" }).click();
  await pendingAttachment.waitFor({ state: "detached", timeout: 20_000 });

  const permission = page.getByRole("combobox", { name: "Permission mode" });
  await permission.waitFor({ state: "visible", timeout: 20_000 });
  await permission.selectOption("workspace-autonomous");
  await page.locator(".permission-state", { hasText: /已生效|已排队/u }).waitFor({ timeout: 20_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitOnline(page);
  await page.getByRole("combobox", { name: "Permission mode" }).waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(
    'select[aria-label="Permission mode"]',
  )?.value === "workspace-autonomous", undefined, { timeout: 20_000 });
  assert(await page.getByRole("combobox", { name: "Permission mode" }).inputValue() === "workspace-autonomous",
    "composer permission mode did not survive a browser reload");
  await page.getByRole("combobox", { name: "Permission mode" }).selectOption("approval-required");
  await page.locator(".permission-state", { hasText: /已生效|已排队/u }).waitFor({ timeout: 20_000 });
  return { attachmentRoundTrip: true, permissionRoundTrip: true };
};

const verifyControls = async (page: Page): Promise<Readonly<{
  tools: number;
  skills: number;
  settingsRoundTrip: boolean;
}>> => {
  await page.getByRole("button", { name: "Controls" }).click();
  await page.getByRole("complementary", { name: "Session control center" }).waitFor({ timeout: 20_000 });
  const model = page.locator(".control-section label.field select").first();
  await model.waitFor({ state: "visible", timeout: 20_000 });
  assert(await model.inputValue() === "deepseek-v4-flash", "control center model differs from the production profile");
  const tools = await page.locator(".tool-policy input[type='checkbox']").count();
  const effort = page.getByRole("combobox", { name: "推理强度" });
  await effort.selectOption("max");
  const save = page.getByRole("button", { name: "保存并应用" });
  assert(await save.isEnabled(), "changed Control setting did not enable save");
  await save.click();
  await page.locator(".control-feedback", { hasText: /设置已保存/u }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "关闭控制中心" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitOnline(page);
  await page.getByRole("button", { name: "Controls" }).click();
  await page.getByRole("combobox", { name: "推理强度" }).waitFor({ state: "visible", timeout: 20_000 });
  assert(await page.getByRole("combobox", { name: "推理强度" }).inputValue() === "max",
    "Control setting did not survive a browser reload");
  await page.getByRole("combobox", { name: "推理强度" }).selectOption("high");
  await page.getByRole("button", { name: "保存并应用" }).click();
  await page.locator(".control-feedback", { hasText: /设置已保存/u }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "组件", exact: true }).click();
  await page.locator(".component-health").waitFor({ timeout: 20_000 });
  const skillText = await page.locator(".component-health").locator("span").filter({ hasText: "Skills" }).innerText();
  const skills = Number.parseInt(skillText, 10);
  assert(tools === 20, `expected 20 visible canonical tools, observed ${String(tools)}`);
  assert(Number.isSafeInteger(skills) && skills >= 2, "expected both production starter Skills");
  await page.getByRole("button", { name: "关闭控制中心" }).click();
  return { tools, skills, settingsRoundTrip: true };
};

const verifyMutationRecovery = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Controls" }).click();
  await page.getByRole("button", { name: "会话", exact: true }).click();
  const rewind = page.locator("article.session-operation").filter({ hasText: "Rewind" });
  const prepare = rewind.getByRole("button", { name: "Prepare" });
  await prepare.waitFor({ state: "visible", timeout: 20_000 });
  const boundaryDeadline = Date.now() + 20_000;
  while (await prepare.isDisabled() && Date.now() < boundaryDeadline) {
    await page.waitForTimeout(100);
  }
  assert(!(await prepare.isDisabled()), "rewind requires one durable stable boundary");
  await prepare.click();
  await page.getByRole("dialog", { name: /确认 rewind/u }).waitFor({ timeout: 20_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitOnline(page);
  await page.getByRole("button", { name: "Controls" }).click();
  await page.getByRole("button", { name: "会话", exact: true }).click();
  const recovered = page.getByRole("dialog", { name: /确认 rewind/u });
  await recovered.waitFor({ timeout: 20_000 });
  await recovered.getByRole("button", { name: "回滚 / Abort" }).click();
  await recovered.waitFor({ state: "detached", timeout: 20_000 });
  await page.getByRole("button", { name: "关闭控制中心" }).click();
};

const verifyResponsiveAndMedia = async (page: Page, outputRoot: string): Promise<Readonly<{
  mobileOverflow: number;
  dark: boolean;
  reducedMotion: boolean;
}>> => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  const audit = await domAccessibilityAudit(page);
  const media = await page.evaluate(() => ({
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  await page.screenshot({ path: resolve(outputRoot, "mobile-dark.png"), fullPage: true });
  assert(audit.horizontalOverflow <= 1, `mobile layout overflows by ${String(audit.horizontalOverflow)}px`);
  assert(media.dark && media.reducedMotion, "browser media preferences were not applied");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  return { mobileOverflow: audit.horizontalOverflow, ...media };
};

const verifyConcurrentTab = async (context: BrowserContext, cleanUrl: string): Promise<void> => {
  const page = await context.newPage();
  try {
    const response = await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    assert(response?.status() === 200, "concurrent tab did not receive the authenticated application shell");
    await waitOnline(page);
    await page.locator(".session-item").first().waitFor({ timeout: 20_000 });
  } finally {
    await page.close();
  }
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      url: { type: "string" },
      out: { type: "string" },
      chrome: { type: "string" },
      artifact: { type: "string" },
      "expected-manifest-sha256": { type: "string" },
      "skip-real-turn": { type: "boolean", default: false },
    },
  });
  if (values.url === undefined) throw new TypeError("--url is required");
  if (values.out === undefined || !isAbsolute(values.out)) throw new TypeError("--out must be absolute");
  if (values.artifact === undefined) throw new TypeError("--artifact is required");
  if (values["expected-manifest-sha256"] === undefined) {
    throw new TypeError("--expected-manifest-sha256 is required");
  }
  const artifact = verifyInstalledReferenceWebArtifact(
    resolve(values.artifact),
    values["expected-manifest-sha256"],
  );
  const launchUrl = new URL(values.url);
  if (launchUrl.protocol !== "http:" || (launchUrl.hostname !== "127.0.0.1" && launchUrl.hostname !== "localhost")) {
    throw new TypeError("--url must be one loopback Reference Web launch URL");
  }
  const outputRoot = resolveExternalOutputRoot(values.out, repositoryRoot);
  mkdirSync(outputRoot, { mode: 0o700 });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const httpErrors: string[] = [];
  const externalRequests: string[] = [];
  const startedAt = new Date().toISOString();
  const browser = await chromium.launch({
    executablePath: resolve(values.chrome ?? chromeDefault),
    headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--no-default-browser-check"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  const observe = (candidate: Page): void => {
    candidate.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(safeError(message.text()));
    });
    candidate.on("pageerror", (error) => pageErrors.push(safeError(error)));
    candidate.on("requestfailed", (request) => requestFailures.push(
      `${request.method()} ${sanitizeUrl(request.url())} ${request.failure()?.errorText ?? "failed"}`,
    ));
    candidate.on("response", (response) => {
      if (response.status() >= 400) httpErrors.push(`${String(response.status())} ${sanitizeUrl(response.url())}`);
    });
    candidate.on("request", (request) => {
      const url = new URL(request.url());
      if ((url.protocol === "http:" || url.protocol === "https:")
        && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        externalRequests.push(`${request.method()} ${sanitizeUrl(request.url())}`);
      }
    });
  };
  context.on("page", observe);
  observe(page);
  let evidence: Record<string, unknown>;
  try {
    const response = await page.goto(launchUrl.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
    assert(response?.status() === 200, "launch navigation did not return HTTP 200");
    const indexEntry = artifact.manifest.files.find(({ path }) => path === "apps/reference-web/dist/index.html");
    assert(indexEntry !== undefined, "verified Web artifact has no production index");
    assert(digest(await response.body()) === indexEntry.sha256, "served browser shell differs from the verified Web artifact");
    await waitOnline(page);
    const cleanUrl = sanitizeUrl(page.url());
    assert(!page.url().includes("launch="), "one-time launch authority remained in the visible URL");
    await page.getByRole("button", { name: "Create Session" }).click();
    await page.locator(".session-item .status-ready").first().waitFor({ timeout: 30_000 });
    const textarea = page.getByRole("textbox", { name: "Message the agent" });
    await textarea.focus();
    await textarea.fill("可访问性键盘输入检查");
    assert(await page.getByRole("button", { name: "Send message" }).isEnabled(), "send button did not follow the editable draft");
    await textarea.fill("");
    const composerControls = await verifyComposerHostControls(page);
    const controls = await verifyControls(page);
    const accessibility = await domAccessibilityAudit(page);
    assert(accessibility.duplicateIds.length === 0, "page contains duplicate element identifiers");
    assert(accessibility.unnamedInteractiveCount === 0, "page contains unnamed interactive controls");
    assert(accessibility.landmarks.some((landmark) => landmark.startsWith("main:")), "page is missing its main landmark");
    await verifyConcurrentTab(context, cleanUrl);
    const partitionOffsets = {
      console: consoleErrors.length,
      page: pageErrors.length,
      request: requestFailures.length,
      http: httpErrors.length,
      external: externalRequests.length,
    };
    await context.setOffline(true);
    await page.locator('.connection-pill[data-state="offline"]').waitFor({ timeout: 10_000 });
    await context.setOffline(false);
    await waitOnline(page);
    await page.waitForTimeout(250);
    const controlledPartition = {
      consoleErrors: consoleErrors.splice(partitionOffsets.console),
      pageErrors: pageErrors.splice(partitionOffsets.page),
      requestFailures: requestFailures.splice(partitionOffsets.request),
      httpErrors: httpErrors.splice(partitionOffsets.http),
      externalRequests: externalRequests.splice(partitionOffsets.external),
    };
    assert(controlledPartition.pageErrors.length === 0, "controlled offline transition emitted a page error");
    assert(controlledPartition.httpErrors.length === 0, "controlled offline transition received an HTTP error");
    assert(controlledPartition.externalRequests.length === 0, "controlled offline transition attempted external network access");
    assert(controlledPartition.consoleErrors.every((message) => message.includes("ERR_INTERNET_DISCONNECTED")),
      "controlled offline transition emitted an unexpected console error");
    assert(controlledPartition.requestFailures.every((message) =>
      message.includes("ERR_INTERNET_DISCONNECTED") || message.includes("ERR_ABORTED")),
    "controlled offline transition emitted an unexpected request failure");
    let realTurns: readonly string[] | "skipped" = "skipped";
    if (!values["skip-real-turn"]) {
      const sentinel = `B1_A5_BROWSER_OK_${Date.now().toString(36).toUpperCase()}`;
      await textarea.fill(`Reply with exactly ${sentinel} and do not use tools.`);
      await page.getByRole("button", { name: "Send message" }).click();
      await page.locator(".user-message", { hasText: sentinel }).waitFor({ timeout: 20_000 });
      await page.locator(".assistant-turn", { hasText: sentinel }).waitFor({ timeout: 180_000 });
      await page.locator(".assistant-turn .turn-actions", { hasText: "已完成" }).waitFor({ timeout: 20_000 });
      const rewindSource = `B1_A5_REWIND_SOURCE_${Date.now().toString(36).toUpperCase()}`;
      await textarea.fill(`Reply with exactly ${rewindSource} and do not use tools.`);
      await page.getByRole("button", { name: "Send message" }).click();
      await page.locator(".user-message", { hasText: rewindSource }).waitFor({ timeout: 20_000 });
      await page.locator(".assistant-turn", { hasText: rewindSource }).waitFor({ timeout: 180_000 });
      await page.locator(".assistant-turn .turn-actions", { hasText: "已完成" }).last().waitFor({ timeout: 20_000 });
      realTurns = [sentinel, rewindSource];
      await verifyMutationRecovery(page);
    }
    await page.screenshot({ path: resolve(outputRoot, "desktop.png"), fullPage: true });
    const media = await verifyResponsiveAndMedia(page, outputRoot);
    const performanceEvidence = await page.evaluate(() => {
      const navigation = window.performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return {
        domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? 0,
        loadMs: navigation?.loadEventEnd ?? 0,
        resourceCount: window.performance.getEntriesByType("resource").length,
        conversationEntries: document.querySelectorAll(".conversation-entry").length,
      };
    });
    assert(consoleErrors.length === 0, "browser console contains errors");
    assert(pageErrors.length === 0, "browser emitted uncaught page errors");
    assert(requestFailures.length === 0, "browser emitted failed requests");
    assert(httpErrors.length === 0, "browser received HTTP error responses");
    assert(externalRequests.length === 0, "browser attempted an external network request");
    evidence = {
      schemaVersion: 1,
      campaign: "reference-web-exact-runtime-browser",
      status: "passed",
      startedAt,
      finishedAt: new Date().toISOString(),
      cleanUrl,
      browserVersion: browser.version(),
      controls,
      composerControls,
      accessibility,
      media,
      performance: performanceEvidence,
      artifact: {
        manifestSha256: artifact.manifestSha256,
        repositoryHead: artifact.manifest.build.repositoryHead,
        runtimeManifestSha256: artifact.manifest.runtime.manifestSha256,
        fileCount: artifact.fileCount,
        totalBytes: artifact.totalBytes,
        servedIndexSha256: indexEntry.sha256,
      },
      reconnect: "passed",
      concurrentTab: "passed",
      mutationRecovery: values["skip-real-turn"] ? "skipped" : "passed",
      realTurns,
      controlledPartition,
      consoleErrors,
      pageErrors,
      requestFailures,
      httpErrors,
      externalRequests,
    };
  } catch (error) {
    await page.screenshot({ path: resolve(outputRoot, "failure.png"), fullPage: true }).catch(() => undefined);
    evidence = {
      schemaVersion: 1,
      campaign: "reference-web-exact-runtime-browser",
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: safeError(error),
      consoleErrors,
      pageErrors,
      requestFailures,
      httpErrors,
      externalRequests,
    };
  } finally {
    await context.tracing.stop({ path: resolve(outputRoot, "trace.zip") }).catch(() => undefined);
    await context.close();
    await browser.close();
  }
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(resolve(outputRoot, "browser-campaign-v1.json"), bytes, { flag: "wx", mode: 0o400 });
  const summary = { status: evidence.status, outputRoot, evidenceSha256: digest(bytes) };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (evidence.status !== "passed") throw new Error(requiredString(evidence.error, "browser campaign failure"));
};

const requiredString = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${description} is unavailable`);
  return value;
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
