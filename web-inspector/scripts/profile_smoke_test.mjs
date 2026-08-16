#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareProfileDirectory, profileLaunchError } from "./lib/profiles.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const captureScript = path.join(scriptDir, "capture_page.mjs");

function pageFor(pathname, authenticated) {
  if (pathname === "/set") {
    return `<!doctype html><html><body><main>state-set</main><script>localStorage.setItem("profile-smoke", "ready")</script></body></html>`;
  }
  const state = authenticated ? "authenticated" : "unauthenticated";
  return `<!doctype html><html><body><main id="state">${state}</main><p id="storage">pending</p><script>document.querySelector("#storage").textContent = localStorage.getItem("profile-smoke") || "missing"</script></body></html>`;
}

function startServer() {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const authenticated = request.headers.cookie?.includes("profile-smoke=ready") ?? false;
    if (requestUrl.pathname === "/set") response.setHeader("set-cookie", "profile-smoke=ready; Path=/");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pageFor(requestUrl.pathname, authenticated));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runCapture(url, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [captureScript, url, ...args], {
      cwd: path.dirname(scriptDir),
      env: { ...process.env, ...env },
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

const outputRoot = await mkdtemp(path.join(os.tmpdir(), "web-inspector-profile-smoke-"));
const stateRoot = path.join(outputRoot, "state");
const configPath = path.join(outputRoot, "config.json");
const server = await startServer();
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  WEB_INSPECTOR_STATE_DIR: stateRoot,
  WEB_INSPECTOR_CONFIG: configPath,
};

await writeFile(configPath, `${JSON.stringify({
  version: 1,
  defaults: { headed: false },
  profiles: {
    persisted: { browser: "chromium" },
    other: { browser: "chromium" },
  },
}, null, 2)}\n`, "utf8");

try {
  const securityStateRoot = path.join(outputRoot, "security-state");
  const secureProfile = await prepareProfileDirectory(securityStateRoot, "secure");
  assert.equal((await lstat(secureProfile)).mode & 0o777, 0o700);
  await symlink(secureProfile, path.join(securityStateRoot, "linked"));
  await assert.rejects(
    () => prepareProfileDirectory(securityStateRoot, "linked"),
    /Refusing to use symlinked Web Inspector profile directory/,
  );
  assert.match(
    profileLaunchError("busy", new Error("The user data directory is already in use")).message,
    /profile may already be in use/,
  );

  const setDir = path.join(outputRoot, "set");
  const setRun = await runCapture(`${baseUrl}/set`, [
    "--profile", "persisted",
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--output-dir", setDir,
  ], env);
  assert.equal(setRun.code, 0, setRun.stderr || setRun.stdout);
  const setReport = await readReport(setDir);
  assert.equal(setReport.options.profile, "persisted");
  assert.equal(setReport.options.persistentContext, true);
  assert.equal(setReport.options.headed, false);

  const persistentDir = path.join(outputRoot, "persistent");
  const persistentRun = await runCapture(`${baseUrl}/auth`, [
    "--profile", "persisted",
    "--viewport", "320x240",
    "--viewport", "640x480",
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--output-dir", persistentDir,
  ], env);
  assert.equal(persistentRun.code, 0, persistentRun.stderr || persistentRun.stdout);
  const persistentReport = await readReport(persistentDir);
  assert.equal(persistentReport.options.persistentContext, true);
  assert.deepEqual(persistentReport.viewports.map(({ runtime }) => runtime.viewport), [
    { width: 320, height: 240 },
    { width: 640, height: 480 },
  ]);
  for (const item of persistentReport.viewports) {
    assert.match(item.domSummary.bodyText, /authenticated/);
    assert.match(item.domSummary.bodyText, /ready/);
  }
  assert.equal(persistentRun.stdout.includes("profile-smoke=ready"), false);
  assert.equal(JSON.stringify(persistentReport).includes("profile-smoke=ready"), false);

  const ephemeralDir = path.join(outputRoot, "ephemeral");
  const ephemeralRun = await runCapture(`${baseUrl}/auth`, [
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--output-dir", ephemeralDir,
  ], env);
  assert.equal(ephemeralRun.code, 0, ephemeralRun.stderr || ephemeralRun.stdout);
  const ephemeralReport = await readReport(ephemeralDir);
  assert.equal(ephemeralReport.options.profile, null);
  assert.equal(ephemeralReport.options.persistentContext, false);
  assert.match(ephemeralReport.viewports[0].domSummary.bodyText, /unauthenticated/);
  assert.match(ephemeralReport.viewports[0].domSummary.bodyText, /missing/);

  const otherProfileDir = path.join(outputRoot, "other-profile");
  const otherProfileRun = await runCapture(`${baseUrl}/auth`, [
    "--profile", "other",
    "--wait-until", "domcontentloaded",
    "--wait-ms", "0",
    "--output-dir", otherProfileDir,
  ], env);
  assert.equal(otherProfileRun.code, 0, otherProfileRun.stderr || otherProfileRun.stdout);
  const otherProfileReport = await readReport(otherProfileDir);
  assert.match(otherProfileReport.viewports[0].domSummary.bodyText, /unauthenticated/);

  const firefoxRun = await runCapture(`${baseUrl}/auth`, [
    "--browser", "firefox",
    "--profile", "persisted",
    "--output-dir", path.join(outputRoot, "firefox"),
  ], env);
  assert.equal(firefoxRun.code, 1);
  assert.match(firefoxRun.stderr, /configured for chromium|only supported with Chromium/i);

  const unknownProfileRun = await runCapture(`${baseUrl}/auth`, [
    "--profile", "unknown",
    "--output-dir", path.join(outputRoot, "unknown"),
  ], env);
  assert.equal(unknownProfileRun.code, 1);
  assert.match(unknownProfileRun.stderr, /Unknown profile/);

  console.log("web-inspector profile smoke test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(outputRoot, { recursive: true, force: true });
}
