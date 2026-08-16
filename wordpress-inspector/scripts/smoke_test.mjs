#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureArgs, runWebInspectorScript } from "./lib/web_inspector_process.mjs";
import { authRequired } from "./lib/wordpress.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const wordpressScript = path.join(scriptDir, "wordpress_inspector.mjs");

function loginPage() {
  return `<!doctype html><html><body><form id="loginform"><label>Username <input id="user_login"></label><label>Password <input type="password"></label><button>Log In</button></form></body></html>`;
}

function pageFor(requestUrl, authenticated) {
  if (requestUrl.pathname === "/set-session") {
    return `<!doctype html><html><body><main>session seeded</main></body></html>`;
  }
  if (requestUrl.pathname === "/wp-login.php") return loginPage();
  if (!authenticated) return loginPage();
  if (requestUrl.pathname === "/wp-admin/") {
    return `<!doctype html><html><body><div id="wpadminbar">Admin bar</div><main id="wpcontent"><h1>Dashboard</h1></main></body></html>`;
  }
  if (requestUrl.pathname === "/wp-admin/post.php") {
    const fixture = requestUrl.searchParams.get("fixture") || "healthy";
    if (fixture === "login") return loginPage();
    const warning = fixture === "invalid" ? `<div class="block-editor-warning">This block contains unexpected or invalid content.</div>` : "";
    const fatal = fixture === "fatal" ? `<div class="editor-error">Editor failed</div>` : "";
    const onboarding = fixture === "onboarding"
      ? `<div class="edit-post-welcome-guide"><div class="components-modal__header"><button aria-label="Close">Close</button></div></div>`
      : "";
    const technical = fixture === "technical" ? "<script>console.error('editor fixture error')</script>" : "";
    return `<!doctype html><html><body>${onboarding}<div class="edit-post-visual-editor"><div class="editor-styles-wrapper"><div class="block-editor-writing-flow"><p>Editor fixture</p>${warning}${fatal}</div></div></div><button>Save</button><button>Publish</button>${technical}</body></html>`;
  }
  return `<!doctype html><html><body><main>unknown</main></body></html>`;
}

function startServer() {
  let mutationCount = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET") mutationCount += 1;
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const authenticated = request.headers.cookie?.includes("wp-auth=ready") ?? false;
    if (requestUrl.pathname === "/set-session") response.setHeader("set-cookie", "wp-auth=ready; Path=/; Max-Age=3600");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pageFor(requestUrl, authenticated));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, getMutationCount: () => mutationCount }));
  });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wordpressScript, ...args], {
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

async function readSummary(outputDir) {
  return JSON.parse(await readFile(path.join(outputDir, "wordpress-summary.json"), "utf8"));
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "wordpress-inspector-smoke-"));
const stateRoot = path.join(tempRoot, "state");
const configPath = path.join(tempRoot, "config.json");
const outputRoot = path.join(tempRoot, "outputs");
const { server, getMutationCount } = await startServer();
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  WEB_INSPECTOR_STATE_DIR: stateRoot,
  WEB_INSPECTOR_CONFIG: configPath,
};

await writeFile(configPath, `${JSON.stringify({
  version: 1,
  defaults: { headed: false },
  profiles: { fake: { browser: "chromium" } },
}, null, 2)}\n`, "utf8");

try {
  const authenticateFailureOutput = path.join(outputRoot, "authenticate-failure");
  const authenticateFailureRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--profile", "missing",
    "--config", configPath,
    "--output-dir", authenticateFailureOutput,
    "--timeout", "100",
  ], env);
  assert.equal(authenticateFailureRun.code, 1, authenticateFailureRun.stderr || authenticateFailureRun.stdout);
  const authenticateFailureSummary = await readSummary(authenticateFailureOutput);
  assert.equal(authenticateFailureSummary.classification, "TECHNICAL_ERRORS");
  assert.match(authenticateFailureSummary.warnings.find((warning) => warning.startsWith("web-inspector-configuration:")), /unknown profile/);

  const unknownProfileOutput = path.join(outputRoot, "unknown-profile");
  const unknownProfileRun = await runCli([
    "check-admin",
    "--base-url", baseUrl,
    "--profile", "missing",
    "--config", configPath,
    "--output-dir", unknownProfileOutput,
    "--timeout", "5000",
  ], env);
  assert.equal(unknownProfileRun.code, 1, unknownProfileRun.stderr || unknownProfileRun.stdout);
  const unknownProfileSummary = await readSummary(unknownProfileOutput);
  assert.match(unknownProfileSummary.warnings.find((warning) => warning.startsWith("web-inspector-configuration:")), /unknown profile/);

  const unauthOutput = path.join(outputRoot, "unauthenticated-admin");
  const unauthRun = await runCli([
    "check-admin",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--output-dir", unauthOutput,
    "--timeout", "5000",
  ], env);
  assert.equal(unauthRun.code, 1, unauthRun.stderr || unauthRun.stdout);
  const unauthSummary = await readSummary(unauthOutput);
  assert.equal(unauthSummary.classification, "AUTH_REQUIRED");
  assert.equal(unauthSummary.finalUrl.endsWith("/wp-admin/"), true);
  assert.equal(unauthSummary.warnings.includes("page-error"), false);
  const seedOutput = path.join(outputRoot, "seed");
  const seedRun = await runWebInspectorScript("capture_page.mjs", captureArgs({
    url: `${baseUrl}/set-session`,
    profile: "fake",
    configPath,
    outputDir: seedOutput,
    timeout: 5000,
    waitUntil: "domcontentloaded",
    waitMs: 0,
    failOnErrors: true,
  }), { env });
  assert.equal(seedRun.code, 0, seedRun.stderr || seedRun.stdout);

  const adminOutput = path.join(outputRoot, "authenticated-admin");
  const adminRun = await runCli([
    "check-admin",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--output-dir", adminOutput,
    "--timeout", "5000",
  ], env);
  assert.equal(adminRun.code, 0, adminRun.stderr || adminRun.stdout);
  const adminSummary = await readSummary(adminOutput);
  assert.equal(adminSummary.classification, "AUTHENTICATED");
  assert.equal(adminSummary.checks.every(({ passed }) => passed), true);

  const editorUrl = `${baseUrl}/wp-admin/post.php?post=1&action=edit`;
  const editorOutput = path.join(outputRoot, "healthy-editor");
  const editorRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--editor-url", editorUrl,
    "--output-dir", editorOutput,
    "--timeout", "5000",
  ], env);
  assert.equal(editorRun.code, 0, editorRun.stderr || editorRun.stdout);
  const editorSummary = await readSummary(editorOutput);
  assert.equal(editorSummary.classification, "AUTHENTICATED");
  assert.equal(editorSummary.checks.every(({ passed }) => passed), true);

  const onboardingOutput = path.join(outputRoot, "onboarding-editor");
  const onboardingRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=onboarding`,
    "--output-dir", onboardingOutput,
    "--timeout", "5000",
  ], env);
  assert.equal(onboardingRun.code, 0, onboardingRun.stderr || onboardingRun.stdout);
  const onboardingSummary = await readSummary(onboardingOutput);
  assert.equal(onboardingSummary.classification, "AUTHENTICATED");
  assert.equal(onboardingSummary.checks.every(({ passed }) => passed), true);

  const loginEditorOutput = path.join(outputRoot, "login-editor");
  const loginEditorRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=login`,
    "--output-dir", loginEditorOutput,
    "--timeout", "5000",
  ], env);
  assert.equal(loginEditorRun.code, 1, loginEditorRun.stderr || loginEditorRun.stdout);
  const loginEditorSummary = await readSummary(loginEditorOutput);
  assert.equal(loginEditorSummary.classification, "AUTH_REQUIRED");
  assert.equal(loginEditorSummary.checks.find(({ name }) => name === "editor readiness probe").passed, null);

  const invalidOutput = path.join(outputRoot, "invalid-editor");
  const invalidRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=invalid`,
    "--output-dir", invalidOutput,
    "--timeout", "5000",
  ], env);
  assert.equal(invalidRun.code, 1, invalidRun.stderr || invalidRun.stdout);
  const invalidSummary = await readSummary(invalidOutput);
  assert.equal(invalidSummary.classification, "EDITOR_INVALID_BLOCKS");
  assert.equal(invalidSummary.checks.find(({ name }) => name === "invalid-block indicators absent").passed, false);
  assert.equal(invalidSummary.warnings.includes("page-error"), false);

  const fatalOutput = path.join(outputRoot, "fatal-editor");
  const fatalRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=fatal`,
    "--output-dir", fatalOutput,
    "--timeout", "5000",
  ], env);
  assert.equal(fatalRun.code, 1, fatalRun.stderr || fatalRun.stdout);
  const fatalSummary = await readSummary(fatalOutput);
  assert.equal(fatalSummary.classification, "EDITOR_LOAD_FAILED");

  const technicalOutput = path.join(outputRoot, "technical-editor");
  const technicalRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=technical`,
    "--output-dir", technicalOutput,
    "--timeout", "5000",
  ], env);
  assert.equal(technicalRun.code, 1, technicalRun.stderr || technicalRun.stdout);
  const technicalSummary = await readSummary(technicalOutput);
  assert.equal(technicalSummary.classification, "TECHNICAL_ERRORS");

  const crossOriginOutput = path.join(outputRoot, "cross-origin");
  const crossOriginRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--editor-url", "http://other.example/wp-admin/post.php?action=edit",
    "--output-dir", crossOriginOutput,
  ], env);
  assert.equal(crossOriginRun.code, 1);
  assert.match(crossOriginRun.stderr, /same origin/);

  const mutationRouteOutput = path.join(outputRoot, "mutation-route");
  const mutationRouteRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--editor-url", `${baseUrl}/wp-admin/admin-post.php?action=delete`,
    "--output-dir", mutationRouteOutput,
  ], env);
  assert.equal(mutationRouteRun.code, 1);
  assert.match(mutationRouteRun.stderr, /supported read-only Gutenberg editor route/);

  const duplicateActionOutput = path.join(outputRoot, "duplicate-action");
  const duplicateActionRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--config", configPath,
    "--editor-url", `${baseUrl}/wp-admin/post.php?action=edit&action=trash&post=1`,
    "--output-dir", duplicateActionOutput,
  ], env);
  assert.equal(duplicateActionRun.code, 1);
  assert.match(duplicateActionRun.stderr, /supported read-only Gutenberg editor route/);

  assert.equal(getMutationCount(), 0);
  assert.equal(JSON.stringify(editorSummary).includes("wp-auth=ready"), false);
  assert.equal(authRequired({ viewports: [{ finalUrl: editorUrl, actionResults: [], domSummary: { bodyText: "Username Password Log In Log Out" } }] }), false);
  console.log("wordpress-inspector smoke test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}
