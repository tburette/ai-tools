#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureArgs, runWebInspectorScript } from "./lib/web_inspector_process.mjs";
import { authRequired, inferBaseUrlFromEditorUrl, technicalIssues } from "./lib/wordpress.mjs";
import { formatBlocksTree } from "./lib/editor_artifacts.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const wordpressScript = path.join(scriptDir, "wordpress_inspector.mjs");

function loginPage() {
  return `<!doctype html><html><body><form id="loginform" method="post" action="/wp-login.php"><label>Username <input id="user_login" name="log"></label><label>Password <input id="user_pass" name="pwd" type="password"></label><label><input id="rememberme" name="rememberme" type="checkbox" value="forever"> Remember Me</label><button id="wp-submit" type="submit">Log In</button></form></body></html>`;
}

function pageFor(requestUrl, authenticated) {
  if (requestUrl.pathname.startsWith("/wp-json/")) {
    // A REST API route. Mimic WordPress: private content is invisible to the
    // public REST API (a rest error / empty result), while published content
    // is readable by anyone and drafts/private become visible when logged in.
    const slug = requestUrl.searchParams.get("slug");
    const postType = requestUrl.pathname.split("/").pop();
    if (postType === "pages" && slug === "server-error") {
      return JSON.stringify({ code: "fixture_server_error", message: "Fixture REST failure.", data: { status: 500 } });
    }
    if (postType === "pages" && slug === "login-required-page") {
      return JSON.stringify({ code: "rest_not_logged_in", message: "Authentication required.", data: { status: 401 } });
    }
    if (postType === "pages" && slug === "malformed-page") {
      // A non-JSON body exercises the public technical-error classification.
      return "<!doctype html><html><body><h1>Malformed REST response</h1></body></html>";
    }
    if (postType === "pages" && slug === "my-draft-page" && authenticated && requestUrl.searchParams.get("context") !== "edit") {
      // Authenticated collection queries need edit context to include private
      // content, matching the WordPress REST API behavior under test.
      return JSON.stringify({ code: "rest_context_required", message: "Edit context is required.", data: { status: 400 } });
    }
    if (postType === "pages" && slug === "my-draft-page" && !authenticated) {
      // Private content is invisible to the public REST API.
      return JSON.stringify({ code: "rest_forbidden", message: "Sorry, you are not allowed to do that.", data: { status: 403 } });
    }
    if (postType === "pages" && slug === "my-draft-page") {
      return JSON.stringify([{ id: 42, slug: "my-draft-page", status: "private", link: "/my-draft-page/", title: { rendered: "My Draft Page" } }]);
    }
    if (postType === "pages" && slug === "public-page") {
      return JSON.stringify([{ id: 7, slug: "public-page", status: "publish", link: "/public-page/", title: { rendered: "Public Page" } }]);
    }
    if (postType === "pages" && slug === "error-page") {
      // A non-JSON body exercises the technical-error classification.
      return "<!doctype html><html><body><h1>Gateway error</h1></body></html>";
    }
    return JSON.stringify([]);
  }
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
    if (fixture === "snapshot") {
      const frameHtml = "<!doctype html><html><head><style>html,body{margin:0} .editor-styles-wrapper{height:1800px;padding:16px;background:linear-gradient(#fff,#ddd)} [data-block]{margin:12px;padding:12px;border:1px solid #888}</style></head><body><div class='editor-styles-wrapper'><div data-block='root'><div data-block='child'>Snapshot fixture</div></div></div></body></html>";
      const escapedFrameHtml = frameHtml.replaceAll("&", "&amp;").replaceAll("\"", "&quot;");
      return `<!doctype html><html><body><script>
        const rootBlocks = [{ clientId: "root", name: "core/group", attributes: { layout: "constrained" } }];
        const childBlocks = [{ clientId: "child", name: "core/paragraph", attributes: { content: "Snapshot fixture" } }];
        window.wp = {
          data: { select: (namespace) => namespace === "core/block-editor"
            ? { getBlocks: (root) => root === "root" ? childBlocks : root ? [] : rootBlocks, isBlockValid: () => true, areInnerBlocksControlled: () => false }
            : namespace === "core/editor"
              ? { getEditedPostContent: () => "<!-- wp:group --><div class=\\"wp-block-group\\"><!-- wp:paragraph --><p>Snapshot fixture</p><!-- /wp:paragraph --></div><!-- /wp:group -->", getCurrentPostType: () => "page", getCurrentPostId: () => 1 }
              : {} },
          blocks: { getBlockType: (name) => ({ title: name }) }
        };
      </script><style>.edit-post-visual-editor{width:640px;height:160px;overflow:hidden}.edit-post-visual-editor iframe{display:block;width:100%;height:100%;border:0}</style><div class="edit-post-visual-editor"><iframe title="Editor" srcdoc="${escapedFrameHtml}"></iframe></div></body></html>`;
    }
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
  let loginSubmissionCount = 0;
  let rememberedLoginSubmissionCount = 0;
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET") {
      if (requestUrl.pathname === "/wp-login.php") loginSubmissionCount += 1;
      else mutationCount += 1;
    }
    if (request.method === "POST" && requestUrl.pathname === "/wp-login.php") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get("log") === "fixture-user" && form.get("pwd") === "fixture-password" && form.get("rememberme") === "forever") {
        rememberedLoginSubmissionCount += 1;
        response.writeHead(302, {
          location: "/wp-admin/",
          "set-cookie": "wp-auth=ready; Path=/; Max-Age=3600",
        });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(loginPage());
      }
      return;
    }
    const authenticated = request.headers.cookie?.includes("wp-auth=ready") ?? false;
    const isJson = requestUrl.pathname.startsWith("/wp-json/");
    if (requestUrl.pathname === "/set-session") response.setHeader("set-cookie", "wp-auth=ready; Path=/; Max-Age=3600");
    const jsonSlug = isJson ? requestUrl.searchParams.get("slug") : null;
    const responseStatus = isJson && jsonSlug === "server-error"
      ? 500
      : isJson && jsonSlug === "login-required-page"
        ? 401
        : 200;
    response.writeHead(responseStatus, {
      "content-type": isJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    });
    response.end(pageFor(requestUrl, authenticated));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      getMutationCount: () => mutationCount,
      getLoginSubmissionCount: () => loginSubmissionCount,
      getRememberedLoginSubmissionCount: () => rememberedLoginSubmissionCount,
    }));
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

async function readSummary(outputDir, fileName = "wordpress-summary.json") {
  return JSON.parse(await readFile(path.join(outputDir, fileName), "utf8"));
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "wordpress-inspector-smoke-"));
const stateRoot = path.join(tempRoot, "state");
const outputRoot = path.join(tempRoot, "outputs");
const { server, getMutationCount, getLoginSubmissionCount, getRememberedLoginSubmissionCount } = await startServer();
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  WEB_INSPECTOR_STATE_DIR: stateRoot,
};
const blockedWebInspectorDir = path.join(tempRoot, "blocked-web-inspector");
await mkdir(path.join(blockedWebInspectorDir, "scripts"), { recursive: true });
await writeFile(path.join(blockedWebInspectorDir, "scripts", "capture_page.mjs"), "process.exitCode = 1;\n", "utf8");

const authWebInspectorDir = path.join(tempRoot, "auth-web-inspector");
await mkdir(path.join(authWebInspectorDir, "scripts"), { recursive: true });
await writeFile(path.join(authWebInspectorDir, "scripts", "open_profile.mjs"), `
const args = process.argv.slice(2);
if (args.includes("--headed") || args.includes("--headless")) {
  console.error("authenticate forwarded an unexpected display-mode flag");
  process.exitCode = 1;
} else if (process.env.FAKE_OPEN_PROFILE_RESULT === "failed") {
  console.error("fake interactive profile failure");
  process.exitCode = 1;
} else {
  const sessionEndReason = process.env.FAKE_OPEN_PROFILE_RESULT === "timeout" ? "timeout" : "window-closed";
  console.log("Interactive session ended: " + sessionEndReason + ".");
  console.log(JSON.stringify({ event: "interactive-session-ended", sessionEndReason }));
  if (sessionEndReason !== "window-closed") process.exitCode = 1;
}
`, "utf8");
await writeFile(path.join(authWebInspectorDir, "scripts", "capture_page.mjs"), `
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const outputDirIndex = args.indexOf("--output-dir");
const outputDir = path.resolve(args[outputDirIndex + 1]);
const url = args[0];
const actionCount = args.filter((arg) => arg === "--action").length;
await fs.mkdir(outputDir, { recursive: true });
const screenshot = path.join(outputDir, "screenshot.png");
await fs.writeFile(screenshot, "fake screenshot", "utf8");
const report = {
  options: { profile: null },
  viewports: [{
    finalUrl: url,
    actionResults: Array.from({ length: actionCount }, () => ({ error: null })),
    console: [],
    pageErrors: [],
    failedRequests: [],
    failedResponses: [],
    screenshot,
  }],
};
const reportPath = path.join(outputDir, "report.json");
await fs.writeFile(reportPath, JSON.stringify(report), "utf8");
console.log(JSON.stringify({ ...report, report: reportPath }));
`, "utf8");

try {
  const postEditorUrl = `${baseUrl}/wp-admin/post.php?post=1&action=edit`;
  const siteEditorUrl = `${baseUrl}/wp-admin/site-editor.php?p=%2Fwp_template%2Fhome`;
  assert.equal(inferBaseUrlFromEditorUrl(postEditorUrl), baseUrl);
  assert.equal(inferBaseUrlFromEditorUrl(siteEditorUrl), baseUrl);
  assert.equal(
    inferBaseUrlFromEditorUrl(`http://example.test/blog/site/wp-admin/post.php?post=1&action=edit`),
    "http://example.test/blog/site",
  );
  assert.equal(
    inferBaseUrlFromEditorUrl(`${baseUrl}/wp-admin/post.php?post=1&action=unexpected`),
    baseUrl,
  );
  assert.equal(
    inferBaseUrlFromEditorUrl(`${baseUrl}/some/other/path?post=1&action=edit`),
    baseUrl,
  );
  assert.throws(
    () => inferBaseUrlFromEditorUrl("/wp-admin/post.php?post=1&action=edit"),
    /--editor-url must be an absolute http or https URL when --base-url is omitted/,
  );
  for (const [command, commandArgs] of [
    ["authenticate", ["--profile", "fake"]],
    ["check-admin", ["--profile", "fake"]],
    ["find-post", ["--slug", "public-page"]],
  ]) {
    const missingBaseRun = await runCli([command, ...commandArgs], env);
    assert.equal(missingBaseRun.code, 1);
    assert.match(missingBaseRun.stderr, /--base-url is required/);
  }
  const relativeNoBaseOutput = path.join(outputRoot, "relative-editor-without-base");
  const relativeNoBaseRun = await runCli([
    "check-editor",
    "--profile", "fake",
    "--editor-url", "/wp-admin/post.php?post=1&action=edit",
    "--output-dir", relativeNoBaseOutput,
  ], env);
  assert.equal(relativeNoBaseRun.code, 1);
  assert.match(relativeNoBaseRun.stderr, /--editor-url must be an absolute http or https URL when --base-url is omitted/);
  await assert.rejects(() => stat(relativeNoBaseOutput), { code: "ENOENT" });

  const unsupportedAbsoluteEditorRun = await runCli([
    "check-editor",
    "--profile", "fake",
    "--editor-url", `${baseUrl}/wp-admin/admin-post.php?action=delete`,
    "--output-dir", path.join(outputRoot, "unsupported-absolute-editor"),
  ], env);
  assert.equal(unsupportedAbsoluteEditorRun.code, 1);
  assert.match(unsupportedAbsoluteEditorRun.stderr, /supported read-only Gutenberg editor route/);

  const helpRun = await runCli(["authenticate", "--help"]);
  assert.equal(helpRun.code, 0, helpRun.stderr || helpRun.stdout);
  assert.match(helpRun.stderr, /random temporary directory, e\.g\. \/tmp\/wordpress-inspector-XXXXXX/);

  const authOutput = path.join(outputRoot, "authenticate");
  const authRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--profile", "fake-auth",
    "--output-dir", authOutput,
    "--timeout", "10000",
  ], { ...env, WEB_INSPECTOR_SKILL_DIR: authWebInspectorDir });
  assert.equal(authRun.code, 0, authRun.stderr || authRun.stdout);
  const authSummary = await readSummary(authOutput);
  const authOutputJson = JSON.parse(authRun.stdout);
  assert.equal(authSummary.classification, "AUTHENTICATED");
  assert.equal(authSummary.sessionEndReason, "window-closed");
  assert.equal(authOutputJson.summary, path.join(authOutput, "wordpress-summary.json"));
  assert.equal(authSummary.browserReport, path.join(authOutput, "admin-check", "web-inspector", "report.json"));
  await stat(path.join(authOutput, "wordpress-summary.json"));
  await stat(path.join(authOutput, "admin-check", "auth-probe", "report.json"));
  await stat(authSummary.browserReport);
  await stat(authSummary.screenshots[0]);

  const failedAuthOutput = path.join(outputRoot, "authenticate-failed");
  const failedAuthRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--profile", "fake-auth",
    "--output-dir", failedAuthOutput,
    "--timeout", "10000",
  ], { ...env, WEB_INSPECTOR_SKILL_DIR: authWebInspectorDir, FAKE_OPEN_PROFILE_RESULT: "failed" });
  assert.equal(failedAuthRun.code, 1, failedAuthRun.stderr || failedAuthRun.stdout);
  const failedAuthSummary = await readSummary(failedAuthOutput);
  const failedAuthOutputJson = JSON.parse(failedAuthRun.stdout);
  assert.equal(failedAuthSummary.classification, "TECHNICAL_ERRORS");
  assert.equal(failedAuthOutputJson.summary, path.join(failedAuthOutput, "wordpress-summary.json"));
  await stat(path.join(failedAuthOutput, "wordpress-summary.json"));

  const timedOutAuthOutput = path.join(outputRoot, "authenticate-timeout");
  const timedOutAuthRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--profile", "fake-auth",
    "--output-dir", timedOutAuthOutput,
    "--timeout", "10000",
  ], { ...env, WEB_INSPECTOR_SKILL_DIR: authWebInspectorDir, FAKE_OPEN_PROFILE_RESULT: "timeout" });
  assert.equal(timedOutAuthRun.code, 1, timedOutAuthRun.stderr || timedOutAuthRun.stdout);
  const timedOutAuthSummary = await readSummary(timedOutAuthOutput);
  assert.equal(timedOutAuthSummary.classification, "TECHNICAL_ERRORS");
  assert.equal(timedOutAuthSummary.sessionEndReason, "timeout");
  assert.match(timedOutAuthSummary.warnings.join(" "), /reached its timeout/);
  await assert.rejects(() => stat(path.join(timedOutAuthOutput, "admin-check")), { code: "ENOENT" });

  const defaultAuthRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--profile", "fake-auth",
    "--timeout", "10000",
  ], { ...env, WEB_INSPECTOR_SKILL_DIR: authWebInspectorDir });
  assert.equal(defaultAuthRun.code, 0, defaultAuthRun.stderr || defaultAuthRun.stdout);
  const defaultAuthOutputJson = JSON.parse(defaultAuthRun.stdout);
  const defaultAuthSummaryPath = defaultAuthOutputJson.summary;
  assert.equal(defaultAuthSummaryPath.startsWith(path.join(os.tmpdir(), "wordpress-inspector-")), true);
  await stat(defaultAuthSummaryPath);
  await rm(path.dirname(defaultAuthSummaryPath), { recursive: true, force: true });

  // Supplying both credentials automates the login form without launching a
  // headed browser, then verifies the resulting session with check-admin.
  const automatedOutput = path.join(outputRoot, "authenticate-automated");
  const automatedRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--profile", "automated-auth",
    "--output-dir", automatedOutput,
    "--timeout", "10000",
    "--username", "fixture-user",
    "--password", "fixture-password",
  ], env);
  assert.equal(automatedRun.code, 0, automatedRun.stderr || automatedRun.stdout);
  const automatedSummary = await readSummary(automatedOutput);
  assert.equal(automatedSummary.classification, "AUTHENTICATED");
  assert.equal(automatedSummary.loginAttemptReport, path.join(automatedOutput, "login-attempt", "report.json"));
  await stat(automatedSummary.loginAttemptReport);
  await stat(automatedSummary.browserReport);
  const automatedReport = JSON.parse(await readFile(automatedSummary.loginAttemptReport, "utf8"));
  assert.equal(automatedReport.options.profile, "automated-auth");
  assert.equal(automatedReport.options.headed, false);
  assert.deepEqual(automatedReport.viewports[0].actionResults.map(({ type }) => type), ["fill", "fill", "check", "click"]);
  assert.equal(automatedReport.viewports[0].actionResults[2].checked, true);
  assert.equal(automatedReport.viewports[0].finalUrl, `${baseUrl}/wp-admin/`);

  // The same headless path may take credentials from environment variables,
  // which avoids putting the password in the command line.
  const environmentOutput = path.join(outputRoot, "authenticate-environment");
  const environmentRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--profile", "automated-auth-environment",
    "--output-dir", environmentOutput,
    "--timeout", "10000",
  ], {
    ...env,
    WORDPRESS_INSPECTOR_USERNAME: "fixture-user",
    WORDPRESS_INSPECTOR_PASSWORD: "fixture-password",
  });
  assert.equal(environmentRun.code, 0, environmentRun.stderr || environmentRun.stdout);
  const environmentSummary = await readSummary(environmentOutput);
  assert.equal(environmentSummary.classification, "AUTHENTICATED");
  assert.equal(getRememberedLoginSubmissionCount(), 2);

  const invalidAutomatedOutput = path.join(outputRoot, "authenticate-automated-invalid");
  const invalidAutomatedRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--profile", "automated-auth-invalid",
    "--output-dir", invalidAutomatedOutput,
    "--timeout", "10000",
    "--username", "fixture-user",
    "--password", "wrong-secret",
  ], env);
  assert.equal(invalidAutomatedRun.code, 1, invalidAutomatedRun.stderr || invalidAutomatedRun.stdout);
  const invalidAutomatedSummary = await readSummary(invalidAutomatedOutput);
  assert.equal(invalidAutomatedSummary.classification, "AUTH_REQUIRED");
  assert.equal(invalidAutomatedSummary.warnings.includes("automated-login-did-not-authenticate"), true);

  for (const credentials of [
    ["--username", "fixture-user"],
    ["--password", "fixture-password"],
  ]) {
    const incompleteCredentialsRun = await runCli([
      "authenticate",
      "--base-url", baseUrl,
      ...credentials,
    ], env);
    assert.equal(incompleteCredentialsRun.code, 1);
    assert.match(incompleteCredentialsRun.stderr, /must be provided together/);
  }
  const nonAuthenticateCredentialsRun = await runCli([
    "check-admin",
    "--base-url", baseUrl,
    "--username", "fixture-user",
    "--password", "fixture-password",
  ], env);
  assert.equal(nonAuthenticateCredentialsRun.code, 1);
  assert.match(nonAuthenticateCredentialsRun.stderr, /only valid for authenticate/);
  const headedAutomatedRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--username", "fixture-user",
    "--password", "fixture-password",
    "--headed",
  ], env);
  assert.equal(headedAutomatedRun.code, 1);
  assert.match(headedAutomatedRun.stderr, /always headless/);

  const automatedTextArtifacts = await Promise.all([
    readFile(path.join(automatedOutput, "wordpress-summary.json"), "utf8"),
    readFile(path.join(automatedOutput, "login-attempt", "report.json"), "utf8"),
    readFile(path.join(automatedOutput, "admin-check", "web-inspector", "report.json"), "utf8"),
    Promise.resolve(automatedRun.stdout),
    Promise.resolve(automatedRun.stderr),
  ]);
  for (const artifact of automatedTextArtifacts) {
    assert.equal(artifact.includes("fixture-user"), false);
    assert.equal(artifact.includes("fixture-password"), false);
  }

  const headlessAuthRun = await runCli([
    "authenticate",
    "--base-url", baseUrl,
    "--profile", "fake-auth",
    "--headless",
  ], env);
  assert.equal(headlessAuthRun.code, 1);
  assert.match(headlessAuthRun.stderr, /authenticate requires a visible browser/);

  const blockedOutput = path.join(outputRoot, "browser-launch-blocked");
  const blockedRun = await runCli([
    "check-admin",
    "--base-url", baseUrl,
    "--profile", "blocked-browser",
    "--output-dir", blockedOutput,
    "--timeout", "10000",
  ], { ...env, WEB_INSPECTOR_SKILL_DIR: blockedWebInspectorDir });
  assert.equal(blockedRun.code, 1, blockedRun.stderr || blockedRun.stdout);
  const blockedSummary = await readSummary(blockedOutput);
  assert.equal(blockedSummary.classification, "BROWSER_LAUNCH_BLOCKED");
  assert.equal(blockedSummary.warnings.includes("browser-report-unavailable"), false);
  assert.match(blockedSummary.warnings.join(" "), /browser launch was blocked/i);

  const unauthOutput = path.join(outputRoot, "unauthenticated-admin");
  const unauthRun = await runCli([
    "check-admin",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--output-dir", unauthOutput,
    "--timeout", "10000",
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
    outputDir: seedOutput,
    timeout: 5000,
    waitUntil: "domcontentloaded",
    waitMs: 0,
    failOnErrors: true,
  }), { env });
  assert.equal(seedRun.code, 0, seedRun.stderr || seedRun.stdout);

  const defaultSeedOutput = path.join(outputRoot, "default-seed");
  const defaultSeedRun = await runWebInspectorScript("capture_page.mjs", captureArgs({
    url: `${baseUrl}/set-session`,
    outputDir: defaultSeedOutput,
    timeout: 5000,
    waitUntil: "domcontentloaded",
    waitMs: 0,
    failOnErrors: true,
  }), { env });
  assert.equal(defaultSeedRun.code, 0, defaultSeedRun.stderr || defaultSeedRun.stdout);

  const defaultAdminOutput = path.join(outputRoot, "default-profile-admin");
  const defaultAdminRun = await runCli([
    "check-admin",
    "--base-url", baseUrl,
    "--output-dir", defaultAdminOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(defaultAdminRun.code, 0, defaultAdminRun.stderr || defaultAdminRun.stdout);
  const defaultAdminSummary = await readSummary(defaultAdminOutput);
  const defaultAdminReport = JSON.parse(await readFile(defaultAdminSummary.browserReport, "utf8"));
  assert.equal(defaultAdminSummary.profile, "default");
  assert.equal(defaultAdminReport.options.profile, "default");
  assert.equal(defaultAdminReport.options.persistentContext, true);

  // find-post without a profile uses the public REST API and cannot see
  // draft/private content (the fixture returns an empty array for it).
  const findPublicRun = await runCli([
    "find-post",
    "--base-url", baseUrl,
    "--slug", "my-draft-page",
    "--output-dir", path.join(outputRoot, "find-public"),
    "--timeout", "10000",
  ], env);
  assert.equal(findPublicRun.code, 1, findPublicRun.stderr || findPublicRun.stdout);
  const findPublic = JSON.parse(findPublicRun.stdout);
  assert.equal(findPublic.classification, "NOT_FOUND");
  assert.equal(findPublic.method, "public");

  // Public REST HTTP failures are returned as structured classifications.
  const findPublicServerErrorRun = await runCli([
    "find-post",
    "--base-url", baseUrl,
    "--slug", "server-error",
    "--output-dir", path.join(outputRoot, "find-public-server-error"),
    "--timeout", "10000",
  ], env);
  assert.equal(findPublicServerErrorRun.code, 1, findPublicServerErrorRun.stderr || findPublicServerErrorRun.stdout);
  const findPublicServerError = JSON.parse(findPublicServerErrorRun.stdout);
  assert.equal(findPublicServerError.classification, "TECHNICAL_ERRORS");
  assert.equal(findPublicServerError.method, "public");
  assert.equal(findPublicServerError.httpStatus, 500);
  assert.deepEqual(findPublicServerError.warnings, ["response-error"]);

  // A public REST authentication error tells the caller to retry with a profile.
  const findPublicAuthRequiredRun = await runCli([
    "find-post",
    "--base-url", baseUrl,
    "--slug", "login-required-page",
    "--output-dir", path.join(outputRoot, "find-public-auth-required"),
    "--timeout", "10000",
  ], env);
  assert.equal(findPublicAuthRequiredRun.code, 1, findPublicAuthRequiredRun.stderr || findPublicAuthRequiredRun.stdout);
  const findPublicAuthRequired = JSON.parse(findPublicAuthRequiredRun.stdout);
  assert.equal(findPublicAuthRequired.classification, "AUTH_REQUIRED");
  assert.equal(findPublicAuthRequired.method, "public");
  assert.equal(findPublicAuthRequired.httpStatus, 401);
  assert.deepEqual(findPublicAuthRequired.warnings, ["authentication-required"]);

  // A malformed public REST response is also reported in the JSON result.
  const findPublicMalformedRun = await runCli([
    "find-post",
    "--base-url", baseUrl,
    "--slug", "malformed-page",
    "--output-dir", path.join(outputRoot, "find-public-malformed"),
    "--timeout", "10000",
  ], env);
  assert.equal(findPublicMalformedRun.code, 1, findPublicMalformedRun.stderr || findPublicMalformedRun.stdout);
  const findPublicMalformed = JSON.parse(findPublicMalformedRun.stdout);
  assert.equal(findPublicMalformed.classification, "TECHNICAL_ERRORS");
  assert.equal(findPublicMalformed.method, "public");
  assert.equal(findPublicMalformed.httpStatus, 200);
  assert.deepEqual(findPublicMalformed.warnings, ["invalid-json"]);

  // Public find-post resolves publicly readable content.
  const findPublicFoundRun = await runCli([
    "find-post",
    "--base-url", baseUrl,
    "--slug", "public-page",
    "--output-dir", path.join(outputRoot, "find-public-found"),
    "--timeout", "10000",
  ], env);
  assert.equal(findPublicFoundRun.code, 0, `stderr=${findPublicFoundRun.stderr} stdout=${findPublicFoundRun.stdout}`);
  const findPublicFound = JSON.parse(findPublicFoundRun.stdout);
  assert.equal(findPublicFound.classification, "FOUND");
  assert.equal(findPublicFound.method, "public");
  assert.equal(findPublicFound.post.id, 7);

  // find-post with the seeded authenticated profile resolves a private draft.
  const findAuthRun = await runCli([
    "find-post",
    "--base-url", baseUrl,
    "--slug", "my-draft-page",
    "--profile", "fake",
    "--output-dir", path.join(outputRoot, "find-auth"),
    "--timeout", "10000",
  ], env);
  assert.equal(findAuthRun.code, 0, findAuthRun.stderr || findAuthRun.stdout);
  const findAuth = JSON.parse(findAuthRun.stdout);
  assert.equal(findAuth.classification, "FOUND");
  assert.equal(findAuth.method, "authenticated");
  assert.equal(findAuth.found, true);
  assert.equal(findAuth.post.id, 42);
  assert.equal(findAuth.post.status, "private");
  assert.match(findAuth.editorUrl, /post\.php\?post=42&action=edit/);

  // Authenticated find-post with a profile that lacks a session reports
  // AUTH_REQUIRED (the REST fixture returns a rest_forbidden error).
  const findAuthRequiredRun = await runCli([
    "find-post",
    "--base-url", baseUrl,
    "--slug", "my-draft-page",
    "--profile", "no-session",
    "--output-dir", path.join(outputRoot, "find-auth-required"),
    "--timeout", "10000",
  ], env);
  assert.equal(findAuthRequiredRun.code, 1, findAuthRequiredRun.stderr || findAuthRequiredRun.stdout);
  const findAuthRequired = JSON.parse(findAuthRequiredRun.stdout);
  assert.equal(findAuthRequired.classification, "AUTH_REQUIRED");
  assert.equal(findAuthRequired.method, "authenticated");

  // Authenticated find-post for a slug that does not exist reports NOT_FOUND.
  const findAuthNotFoundRun = await runCli([
    "find-post",
    "--base-url", baseUrl,
    "--slug", "missing-page",
    "--profile", "fake",
    "--output-dir", path.join(outputRoot, "find-auth-not-found"),
    "--timeout", "10000",
  ], env);
  assert.equal(findAuthNotFoundRun.code, 1, findAuthNotFoundRun.stderr || findAuthNotFoundRun.stdout);
  const findAuthNotFound = JSON.parse(findAuthNotFoundRun.stdout);
  assert.equal(findAuthNotFound.classification, "NOT_FOUND");
  assert.equal(findAuthNotFound.method, "authenticated");

  // Authenticated find-post hitting a non-JSON body reports TECHNICAL_ERRORS.
  const findAuthTechnicalRun = await runCli([
    "find-post",
    "--base-url", baseUrl,
    "--slug", "error-page",
    "--profile", "fake",
    "--output-dir", path.join(outputRoot, "find-auth-technical"),
    "--timeout", "10000",
  ], env);
  assert.equal(findAuthTechnicalRun.code, 1, findAuthTechnicalRun.stderr || findAuthTechnicalRun.stdout);
  const findAuthTechnical = JSON.parse(findAuthTechnicalRun.stdout);
  assert.equal(findAuthTechnical.classification, "TECHNICAL_ERRORS");
  assert.equal(findAuthTechnical.method, "authenticated");

  const adminOutput = path.join(outputRoot, "authenticated-admin");
  const adminRun = await runCli([
    "check-admin",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--output-dir", adminOutput,
    "--timeout", "10000",
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
    "--editor-url", editorUrl,
    "--output-dir", editorOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(editorRun.code, 0, editorRun.stderr || editorRun.stdout);
  const editorSummary = await readSummary(editorOutput);
  assert.equal(editorSummary.classification, "EDITOR_HEALTHY");
  assert.equal(editorSummary.checks.every(({ passed }) => passed), true);
  assert.equal(editorSummary.checks.find(({ name }) => name === "no blocking browser errors").passed, true);
  assert.equal(path.basename(editorSummary.screenshots[0]), "editor-shell-1440x1100.png");

  const inferredEditorOutput = path.join(outputRoot, "inferred-editor");
  const inferredEditorRun = await runCli([
    "check-editor",
    "--profile", "fake",
    "--editor-url", editorUrl,
    "--output-dir", inferredEditorOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(inferredEditorRun.code, 0, inferredEditorRun.stderr || inferredEditorRun.stdout);
  const inferredEditorSummary = await readSummary(inferredEditorOutput);
  assert.equal(inferredEditorSummary.baseUrl, baseUrl);
  assert.equal(inferredEditorSummary.editorUrl, editorUrl);
  assert.equal(inferredEditorSummary.classification, "EDITOR_HEALTHY");

  const relativeEditorOutput = path.join(outputRoot, "relative-editor-with-base");
  const relativeEditorRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--editor-url", "/wp-admin/post.php?post=1&action=edit",
    "--output-dir", relativeEditorOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(relativeEditorRun.code, 0, relativeEditorRun.stderr || relativeEditorRun.stdout);
  const relativeEditorSummary = await readSummary(relativeEditorOutput);
  assert.equal(relativeEditorSummary.baseUrl, baseUrl);
  assert.equal(relativeEditorSummary.editorUrl, editorUrl);
  assert.equal(relativeEditorSummary.classification, "EDITOR_HEALTHY");

  const onboardingOutput = path.join(outputRoot, "onboarding-editor");
  const onboardingRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=onboarding`,
    "--output-dir", onboardingOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(onboardingRun.code, 0, onboardingRun.stderr || onboardingRun.stdout);
  const onboardingSummary = await readSummary(onboardingOutput);
  assert.equal(onboardingSummary.classification, "EDITOR_HEALTHY");
  assert.equal(onboardingSummary.checks.every(({ passed }) => passed), true);

  const loginEditorOutput = path.join(outputRoot, "login-editor");
  const loginEditorRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=login`,
    "--output-dir", loginEditorOutput,
    "--timeout", "10000",
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
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=invalid`,
    "--output-dir", invalidOutput,
    "--timeout", "10000",
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
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=fatal`,
    "--output-dir", fatalOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(fatalRun.code, 1, fatalRun.stderr || fatalRun.stdout);
  const fatalSummary = await readSummary(fatalOutput);
  assert.equal(fatalSummary.classification, "EDITOR_LOAD_FAILED");

  const technicalOutput = path.join(outputRoot, "technical-editor");
  const technicalRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=technical`,
    "--output-dir", technicalOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(technicalRun.code, 1, technicalRun.stderr || technicalRun.stdout);
  const technicalSummary = await readSummary(technicalOutput);
  assert.equal(technicalSummary.classification, "TECHNICAL_ERRORS");

  const snapshotOutput = path.join(outputRoot, "editor-snapshot");
  const snapshotRun = await runCli([
    "snapshot-editor",
    "--profile", "fake",
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=snapshot`,
    "--output-dir", snapshotOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(snapshotRun.code, 0, snapshotRun.stderr || snapshotRun.stdout);
  const snapshotSummary = await readSummary(snapshotOutput, "snapshot-editor.json");
  assert.equal(snapshotSummary.baseUrl, baseUrl);
  assert.equal(snapshotSummary.classification, "EDITOR_SNAPSHOT_CAPTURED");
  assert.equal(snapshotSummary.browserReport, path.join(snapshotOutput, "snapshot-editor", "report.json"));
  const snapshotBrowserReport = JSON.parse(await readFile(snapshotSummary.browserReport, "utf8"));
  assert.equal(path.basename(snapshotBrowserReport.viewports[0].screenshot), "editor-shell-1440x1100.png");
  await assert.rejects(
    () => stat(path.join(snapshotOutput, "snapshot-editor", "1440x1100.png")),
    { code: "ENOENT" },
  );
  assert.equal(snapshotSummary.artifacts.blocks.rootCount, 1);
  assert.equal(snapshotSummary.artifacts.blocks.totalCount, 2);
  assert.equal(snapshotSummary.artifacts.source.method, "wp.data.select('core/editor').getEditedPostContent");
  assert.ok(snapshotSummary.artifacts.editorCanvasScreenshot.height > 1100);
  assert.equal(snapshotSummary.artifacts.editorCanvasScreenshot.captureMode, "scroll-stitch");
  assert.equal(path.basename(snapshotSummary.artifacts.editorCanvasScreenshot.path), "editor-canvas-full.png");
  assert.ok(snapshotSummary.artifacts.editorCanvasScreenshot.tileCount > 1);
  assert.ok((await stat(snapshotSummary.artifacts.editorCanvasScreenshot.path)).size > 0);
  const snapshotBlocks = JSON.parse(await readFile(snapshotSummary.artifacts.blocks.path, "utf8"));
  assert.equal(snapshotBlocks.blocks[0].innerBlocks[0].name, "core/paragraph");
  assert.equal(await readFile(snapshotSummary.artifacts.source.path, "utf8"), "<!-- wp:group --><div class=\"wp-block-group\"><!-- wp:paragraph --><p>Snapshot fixture</p><!-- /wp:paragraph --></div><!-- /wp:group -->");
  assert.equal(snapshotSummary.artifacts.blockTreeText.lineCount, 4);
  assert.equal(
    await readFile(snapshotSummary.artifacts.blockTreeText.path, "utf8"),
    "page=1 postType=page\n.\n└── group\n    └── paragraph [content: Snapshot fixture]\n",
  );

  const snapshotNoIframeOutput = path.join(outputRoot, "editor-snapshot-no-iframe");
  const snapshotNoIframeRun = await runCli([
    "snapshot-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=healthy`,
    "--output-dir", snapshotNoIframeOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(snapshotNoIframeRun.code, 1, snapshotNoIframeRun.stderr || snapshotNoIframeRun.stdout);
  const snapshotNoIframeSummary = await readSummary(snapshotNoIframeOutput, "snapshot-editor.json");
  assert.equal(snapshotNoIframeSummary.classification, "EDITOR_IFRAME_NOT_FOUND");
  assert.equal(snapshotNoIframeSummary.checks.find(({ name }) => name === "editor snapshot artifacts captured").passed, false);

  const snapshotTechnicalOutput = path.join(outputRoot, "editor-snapshot-technical");
  const snapshotTechnicalRun = await runCli([
    "snapshot-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=technical`,
    "--output-dir", snapshotTechnicalOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(snapshotTechnicalRun.code, 1, snapshotTechnicalRun.stderr || snapshotTechnicalRun.stdout);
  const snapshotTechnicalSummary = await readSummary(snapshotTechnicalOutput, "snapshot-editor.json");
  assert.equal(snapshotTechnicalSummary.classification, "TECHNICAL_ERRORS");

  const crossOriginOutput = path.join(outputRoot, "cross-origin");
  const crossOriginRun = await runCli([
    "check-editor",
    "--base-url", baseUrl,
    "--profile", "fake",
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
    "--editor-url", `${baseUrl}/wp-admin/post.php?action=edit&action=trash&post=1`,
    "--output-dir", duplicateActionOutput,
  ], env);
  assert.equal(duplicateActionRun.code, 1);
  assert.match(duplicateActionRun.stderr, /supported read-only Gutenberg editor route/);

  assert.equal(getMutationCount(), 0);
  assert.equal(getLoginSubmissionCount(), 3);
  assert.equal(JSON.stringify(editorSummary).includes("wp-auth=ready"), false);
  assert.equal(authRequired({ viewports: [{ finalUrl: editorUrl, actionResults: [], domSummary: { bodyText: "Username Password Log In Log Out" } }] }), false);

  // Benign editor-internal blob:/data: requests must not count as technical
  // failures; real network failures still do.
  assert.deepEqual(technicalIssues({ viewports: [{ failedRequests: [{ url: "blob:http://site.test/abc", method: "GET", error: "net::ERR_ABORTED" }, { url: "data:image/png;base64,AAA", method: "GET", error: "net::ERR_ABORTED" }] }] }), []);
  assert.deepEqual(technicalIssues({ viewports: [{ failedRequests: [{ url: "http://site.test/missing.css", method: "GET", error: "net::ERR_FAILED" }, { url: "blob:http://site.test/abc", method: "GET", error: "net::ERR_ABORTED" }] }] }), ["request-failure"]);

  // blocks.txt ascii tree rendering (GNU tree style: connecting lines everywhere, root no indent)
  assert.equal(
    formatBlocksTree({
      postType: "page",
      postId: 1,
      blocks: [
        { clientId: "a", name: "core/group", valid: true, attributes: { layout: "constrained" }, innerBlocks: [
          { clientId: "b", name: "core/paragraph", valid: true, attributes: { content: "Hello\nworld" }, innerBlocks: [] },
          { clientId: "c", name: "plugin/hero", valid: false, attributes: { className: "alpha beta", level: 2 }, innerBlocks: [] },
        ] },
        { clientId: "d", name: "core/image", valid: true, attributes: { url: "x".repeat(100), alt: "pic" }, innerBlocks: [] },
      ],
    }),
    "page=1 postType=page\n" +
      ".\n" +
      "├── group\n" +
      "│   ├── paragraph [content: Hello world]\n" +
      "│   └── plugin/hero [invalid] .alpha.beta [level: 2]\n" +
      "└── image [url: " + "x".repeat(59) + "…]\n",
  );

  console.log("wordpress-inspector smoke test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}
