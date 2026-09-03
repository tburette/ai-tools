#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureArgs, runWebInspectorScript } from "./lib/web_inspector_process.mjs";
import { authRequired, technicalIssues } from "./lib/wordpress.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const wordpressScript = path.join(scriptDir, "wordpress_inspector.mjs");

function loginPage() {
  return `<!doctype html><html><body><form id="loginform"><label>Username <input id="user_login"></label><label>Password <input type="password"></label><button>Log In</button></form></body></html>`;
}

function pageFor(requestUrl, authenticated) {
  if (requestUrl.pathname.startsWith("/wp-json/")) {
    // A REST API route. Mimic WordPress: private content is invisible to the
    // public REST API (a rest error / empty result), while published content
    // is readable by anyone and drafts/private become visible when logged in.
    const slug = requestUrl.searchParams.get("slug");
    const postType = requestUrl.pathname.split("/").pop();
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
  const server = createServer((request, response) => {
    if (request.method !== "GET") mutationCount += 1;
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const authenticated = request.headers.cookie?.includes("wp-auth=ready") ?? false;
    const isJson = requestUrl.pathname.startsWith("/wp-json/");
    if (requestUrl.pathname === "/set-session") response.setHeader("set-cookie", "wp-auth=ready; Path=/; Max-Age=3600");
    response.writeHead(200, {
      "content-type": isJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    });
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

async function readSummary(outputDir, fileName = "wordpress-summary.json") {
  return JSON.parse(await readFile(path.join(outputDir, fileName), "utf8"));
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "wordpress-inspector-smoke-"));
const stateRoot = path.join(tempRoot, "state");
const outputRoot = path.join(tempRoot, "outputs");
const { server, getMutationCount } = await startServer();
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  WEB_INSPECTOR_STATE_DIR: stateRoot,
};

try {
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
  assert.equal(editorSummary.classification, "AUTHENTICATED");
  assert.equal(editorSummary.checks.every(({ passed }) => passed), true);

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
  assert.equal(onboardingSummary.classification, "AUTHENTICATED");
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
    "--base-url", baseUrl,
    "--profile", "fake",
    "--editor-url", `${baseUrl}/wp-admin/post.php?post=1&action=edit&fixture=snapshot`,
    "--output-dir", snapshotOutput,
    "--timeout", "10000",
  ], env);
  assert.equal(snapshotRun.code, 0, snapshotRun.stderr || snapshotRun.stdout);
  const snapshotSummary = await readSummary(snapshotOutput, "snapshot-editor.json");
  assert.equal(snapshotSummary.classification, "EDITOR_SNAPSHOT_CAPTURED");
  assert.equal(snapshotSummary.artifacts.blocks.rootCount, 1);
  assert.equal(snapshotSummary.artifacts.blocks.totalCount, 2);
  assert.equal(snapshotSummary.artifacts.source.method, "wp.data.select('core/editor').getEditedPostContent");
  assert.ok(snapshotSummary.artifacts.renderedIframe.height > 1100);
  assert.equal(snapshotSummary.artifacts.renderedIframe.captureMode, "scroll-stitch");
  assert.ok(snapshotSummary.artifacts.renderedIframe.tileCount > 1);
  assert.ok((await stat(snapshotSummary.artifacts.renderedIframe.path)).size > 0);
  const snapshotBlocks = JSON.parse(await readFile(snapshotSummary.artifacts.blocks.path, "utf8"));
  assert.equal(snapshotBlocks.blocks[0].innerBlocks[0].name, "core/paragraph");
  assert.equal(await readFile(snapshotSummary.artifacts.source.path, "utf8"), "<!-- wp:group --><div class=\"wp-block-group\"><!-- wp:paragraph --><p>Snapshot fixture</p><!-- /wp:paragraph --></div><!-- /wp:group -->");

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
  assert.equal(JSON.stringify(editorSummary).includes("wp-auth=ready"), false);
  assert.equal(authRequired({ viewports: [{ finalUrl: editorUrl, actionResults: [], domSummary: { bodyText: "Username Password Log In Log Out" } }] }), false);

  // Benign editor-internal blob:/data: requests must not count as technical
  // failures; real network failures still do.
  assert.deepEqual(technicalIssues({ viewports: [{ failedRequests: [{ url: "blob:http://site.test/abc", method: "GET", error: "net::ERR_ABORTED" }, { url: "data:image/png;base64,AAA", method: "GET", error: "net::ERR_ABORTED" }] }] }), []);
  assert.deepEqual(technicalIssues({ viewports: [{ failedRequests: [{ url: "http://site.test/missing.css", method: "GET", error: "net::ERR_FAILED" }, { url: "blob:http://site.test/abc", method: "GET", error: "net::ERR_ABORTED" }] }] }), ["request-failure"]);
  console.log("wordpress-inspector smoke test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}
