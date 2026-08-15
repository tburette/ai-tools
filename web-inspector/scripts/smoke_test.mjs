#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const captureScript = path.join(scriptDir, "capture_page.mjs");

function pageFor(pathname) {
  const diagnostic = pathname === "/warning"
    ? "console.warn('smoke warning')"
    : pathname === "/error"
      ? "console.error('smoke error')"
      : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Web Inspector smoke test</title></head>
<body><main><h1>Smoke test</h1><button id="open">Open</button><p id="message" hidden>Ready</p></main>
<script>
${diagnostic}
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
      env: process.env,
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
const server = await startServer();
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
const browser = process.env.WEB_INSPECTOR_BROWSER ?? "chromium";

try {
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
  assert.equal(warningReport.options.localMap, true);
  assert.equal(warningReport.options.ignoreHttpsErrors, false);
  assert.equal(warningReport.options.failOnErrors, true);
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

  const actionDir = path.join(outputRoot, "actions");
  const actionRun = await runCapture(`${baseUrl}/`, [
    "--viewport", "320x240",
    "--device", "Pixel 5",
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--action", JSON.stringify({ type: "assertVisible", selector: "#open" }),
    "--action", JSON.stringify({ type: "click", selector: "#open" }),
    "--action", JSON.stringify({ type: "assertText", selector: "#message", text: "Ready" }),
    "--output-dir", actionDir,
  ]);
  assert.equal(actionRun.code, 0, actionRun.stderr || actionRun.stdout);
  const actionReport = await readReport(actionDir);
  assert.equal(actionReport.options.device, "Pixel 5");
  assert.deepEqual(actionReport.viewports[0].actionResults.map(({ type }) => type), ["assertVisible", "click", "assertText"]);
  assert.ok(actionReport.viewports[0].screenshot.endsWith("320x240.png"));
  assert.match(actionReport.viewports[0].runtime.userAgent, /Android/);
  if (browser === "chromium") assert.ok(actionReport.viewports[0].runtime.maxTouchPoints > 0);
  assert.equal(actionReport.viewports[0].runtime.devicePixelRatio, 2.75);
  assert.deepEqual(actionReport.viewports[0].runtime.viewport, { width: 320, height: 240 });

  console.log("web-inspector smoke test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(outputRoot, { recursive: true, force: true });
}
