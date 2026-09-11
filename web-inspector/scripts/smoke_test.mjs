#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { codexProxyForUrl } from "./lib/playwright.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const captureScript = path.join(scriptDir, "capture_page.mjs");
const BODY_TEXT_ASSERT_LIMIT = 400;

function pageFor(pathname) {
  const diagnostic = pathname === "/warning"
    ? "console.warn('smoke warning')"
    : pathname === "/error"
      ? "console.error('smoke error')"
      : "";
  const delayed = pathname === "/delayed"
    ? "setTimeout(() => { document.querySelector('#delayed').hidden = false; }, 100)"
    : "";
  const duplicate = pathname === "/duplicate"
    ? "<p id=\"duplicate\" hidden>Hidden duplicate</p><p id=\"duplicate\">Visible duplicate</p>"
    : "";
  const longText = pathname === "/longtext"
    ? `<p>${"Long body text for truncation checks. ".repeat(20)}END-OF-LONG-TEXT</p>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Web Inspector smoke test</title></head>
<body><main><h1>Smoke test</h1><button id="open">Open</button><label><input id="remember" type="checkbox"> Remember</label><p id="message" hidden>Ready</p><p id="delayed" hidden>Late warning</p>${duplicate}${longText}</main>
<script>
${diagnostic}
${delayed}
document.querySelector('#open').addEventListener('click', () => {
  document.querySelector('#message').hidden = false;
});
</script></body></html>`;
}

function startServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pageFor(new URL(request.url, "http://127.0.0.1").pathname));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runCapture(url, args) {
  const browser = process.env.WEB_INSPECTOR_BROWSER ? ["--browser", process.env.WEB_INSPECTOR_BROWSER] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [captureScript, url, ...browser, ...args], {
      cwd: path.dirname(scriptDir),
      env: { ...process.env, WEB_INSPECTOR_STATE_DIR: stateRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 60000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function readReport(outputDir) {
  return JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"));
}

const outputRoot = await mkdtemp(path.join(os.tmpdir(), "web-inspector-smoke-"));
const stateRoot = path.join(outputRoot, "state");
const server = await startServer();
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
const browser = process.env.WEB_INSPECTOR_BROWSER ?? "chromium";

const proxyEnvironment = {
  CODEX_NETWORK_PROXY_ACTIVE: "1",
  BUNDLE_HTTP_PROXY: "http://127.0.0.1:12345",
};
assert.deepEqual(
  codexProxyForUrl("http://lepaysanurbain.test:8888/", proxyEnvironment),
  { server: "http://127.0.0.1:12345" },
);
assert.equal(codexProxyForUrl("http://localhost:8888/", proxyEnvironment), null);
assert.equal(codexProxyForUrl("http://127.0.0.1:8888/", proxyEnvironment), null);
assert.equal(codexProxyForUrl("https://example.com/", proxyEnvironment), null);
assert.equal(codexProxyForUrl("http://lepaysanurbain.test:8888/", {
  CODEX_NETWORK_PROXY_ACTIVE: "0",
  BUNDLE_HTTP_PROXY: "http://127.0.0.1:12345",
}), null);

try {
  const removedScreenshotPrefixRun = await runCapture(`${baseUrl}/`, [
    "--screenshot-prefix", "editor-shell",
  ]);
  assert.equal(removedScreenshotPrefixRun.code, 1);
  assert.match(removedScreenshotPrefixRun.stderr, /Unknown option --screenshot-prefix/);

  const warningDir = path.join(outputRoot, "warning");
  const warningRun = await runCapture(`${baseUrl}/warning`, [
    "--viewport", "320x240",
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--timeout", "5000",
    "--fail-on-errors",
    "--output-dir", warningDir,
  ]);
  assert.equal(warningRun.code, 0, warningRun.stderr || warningRun.stdout);
  const warningReport = await readReport(warningDir);
  assert.equal(warningReport.options.browser, browser);
  assert.equal(warningReport.options.timeout, 5000);
  if (browser === "chromium") assert.equal(warningReport.options.executablePath, null);
  else assert.match(warningReport.options.executablePath, /firefox/);
  assert.equal(warningReport.options.localMapRequested, true);
  // The fixture URL uses 127.0.0.1, which localLaunchArgs intentionally does
  // not map; only localhost/*.test hostnames get a resolver rule.
  assert.equal(warningReport.options.localMapApplied, false);

  if (browser === "chromium") {
    const mappedDir = path.join(outputRoot, "local-map");
    const mappedRun = await runCapture(`${baseUrl.replace("127.0.0.1", "localhost")}/warning`, [
      "--wait-until", "domcontentloaded",
      "--wait-ms", "0",
      "--output-dir", mappedDir,
    ]);
    assert.equal(mappedRun.code, 0, mappedRun.stderr || mappedRun.stdout);
    assert.equal((await readReport(mappedDir)).options.localMapApplied, true);
  }
  assert.equal(warningReport.options.ignoreHttpsErrors, false);
  assert.equal(warningReport.options.failOnErrors, true);
  assert.equal(warningReport.options.headed, false);
  assert.equal(warningReport.options.profile, "default");
  assert.equal(warningReport.options.persistentContext, true);
  assert.equal(warningReport.viewports[0].console[0]?.type, "warning");

  const defaultDeviceDir = path.join(outputRoot, "default-device");
  const defaultDeviceRun = await runCapture(`${baseUrl}/`, [
    "--device", "Pixel 5",
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--output-dir", defaultDeviceDir,
  ]);
  assert.equal(defaultDeviceRun.code, 0, defaultDeviceRun.stderr || defaultDeviceRun.stdout);
  const defaultDeviceReport = await readReport(defaultDeviceDir);
  assert.equal(defaultDeviceReport.options.device, "Pixel 5");
  assert.deepEqual(defaultDeviceReport.options.viewports[0], defaultDeviceReport.viewports[0].runtime.viewport);
  assert.ok(defaultDeviceReport.viewports[0].runtime.viewport.width < 500);
  if (browser === "chromium") assert.ok(defaultDeviceReport.viewports[0].runtime.maxTouchPoints > 0);

  const errorDir = path.join(outputRoot, "error");
  const errorRun = await runCapture(`${baseUrl}/error`, [
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--fail-on-errors",
    "--output-dir", errorDir,
  ]);
  assert.equal(errorRun.code, 1, errorRun.stderr || errorRun.stdout);
  const errorReport = await readReport(errorDir);
  assert.equal(errorReport.viewports[0].console[0]?.type, "error");

  const delayedDir = path.join(outputRoot, "delayed-assertion");
  const delayedRun = await runCapture(`${baseUrl}/delayed`, [
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--action", JSON.stringify({ type: "assertNotVisible", selector: "#delayed", windowMs: 250 }),
    "--fail-on-errors",
    "--output-dir", delayedDir,
  ]);
  assert.equal(delayedRun.code, 1, delayedRun.stderr || delayedRun.stdout);
  const delayedReport = await readReport(delayedDir);
  assert.match(delayedReport.viewports[0].actionResults[0].error, /Expected no visible element/);

  const duplicateDir = path.join(outputRoot, "duplicate-assertion");
  const duplicateRun = await runCapture(`${baseUrl}/duplicate`, [
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--action", JSON.stringify({ type: "assertNotVisible", selector: "#duplicate", windowMs: 50 }),
    "--fail-on-errors",
    "--output-dir", duplicateDir,
  ]);
  assert.equal(duplicateRun.code, 1, duplicateRun.stderr || duplicateRun.stdout);
  const duplicateReport = await readReport(duplicateDir);
  assert.match(duplicateReport.viewports[0].actionResults[0].error, /Expected no visible element/);

  const actionDir = path.join(outputRoot, "actions");
  const actionRun = await runCapture(`${baseUrl}/`, [
    "--viewport", "320x240",
    "--device", "Pixel 5",
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--action", JSON.stringify({ type: "assertVisible", selector: "#open" }),
    "--action", JSON.stringify({ type: "check", selector: "#remember" }),
    "--action", JSON.stringify({ type: "assertNotVisible", selector: "#message" }),
    "--action", JSON.stringify({ type: "clickIfVisible", selector: "#message" }),
    "--action", JSON.stringify({ type: "click", selector: "#open" }),
    "--action", JSON.stringify({ type: "clickIfVisible", selector: "#open" }),
    "--action", JSON.stringify({ type: "assertText", selector: "#message", text: "Ready" }),
    "--output-dir", actionDir,
  ]);
  assert.equal(actionRun.code, 0, actionRun.stderr || actionRun.stdout);
  const actionReport = await readReport(actionDir);
  assert.equal(actionReport.options.device, "Pixel 5");
  assert.deepEqual(actionReport.viewports[0].actionResults.map(({ type }) => type), ["assertVisible", "check", "assertNotVisible", "clickIfVisible", "click", "clickIfVisible", "assertText"]);
  assert.equal(actionReport.viewports[0].actionResults[1].checked, true);
  assert.equal(actionReport.viewports[0].actionResults[3].clicked, false);
  assert.equal(actionReport.viewports[0].actionResults[5].clicked, true);
  assert.ok(actionReport.viewports[0].screenshot.endsWith("320x240.png"));
  assert.match(actionReport.viewports[0].runtime.userAgent, /Android/);
  if (browser === "chromium") assert.ok(actionReport.viewports[0].runtime.maxTouchPoints > 0);
  assert.equal(actionReport.viewports[0].runtime.devicePixelRatio, 2.75);
  assert.deepEqual(actionReport.viewports[0].runtime.viewport, { width: 320, height: 240 });

  const truncatedDir = path.join(outputRoot, "truncated-text");
  const truncatedRun = await runCapture(`${baseUrl}/longtext`, [
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--output-dir", truncatedDir,
  ]);
  assert.equal(truncatedRun.code, 0, truncatedRun.stderr || truncatedRun.stdout);
  const truncatedSummary = (await readReport(truncatedDir)).viewports[0].domSummary;
  assert.equal(truncatedSummary.bodyTextTruncated, true);
  assert.ok(truncatedSummary.bodyText.length < BODY_TEXT_ASSERT_LIMIT);
  assert.match(truncatedSummary.bodyText, /…\[TRUNCATED\]$/);

  const fullTextDir = path.join(outputRoot, "full-text");
  const fullTextRun = await runCapture(`${baseUrl}/longtext`, [
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--full-text",
    "--output-dir", fullTextDir,
  ]);
  assert.equal(fullTextRun.code, 0, fullTextRun.stderr || fullTextRun.stdout);
  const fullTextSummary = (await readReport(fullTextDir)).viewports[0].domSummary;
  assert.equal(fullTextSummary.bodyTextTruncated, false);
  assert.match(fullTextSummary.bodyText, /END-OF-LONG-TEXT$/);
  assert.doesNotMatch(fullTextSummary.bodyText, /\[TRUNCATED\]/);

  const badActionJson = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [captureScript, `${baseUrl}/`, "--action", "{not-json"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(badActionJson.code, 1);
  assert.match(badActionJson.stderr, /Invalid JSON for --action #1/);

  console.log("web-inspector smoke test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(outputRoot, { recursive: true, force: true });
}
