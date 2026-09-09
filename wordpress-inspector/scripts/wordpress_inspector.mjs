#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SELECTORS,
  actionFailed,
  authRequired,
  buildBaseUrl,
  collectorArtifacts,
  collectorError,
  createSummary,
  finalUrl,
  isEditorCommand,
  inferBaseUrlFromEditorUrl,
  isLoginUrl,
  normalizeBaseUrl,
  normalizeEditorUrl,
  technicalIssues,
} from "./lib/wordpress.mjs";
import {
  DEFAULT_PROFILE_NAME,
  captureArgs,
  openProfileArgs,
  runWebInspectorScript,
} from "./lib/web_inspector_process.mjs";

const EDITOR_COLLECTOR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib", "editor_artifacts.mjs");

// The adapter has two layers: this file defines the WordPress-specific probes
// and classifications, while Web Inspector performs the actual Playwright
// navigation, assertions, screenshots, and browser diagnostics.

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  node scripts/wordpress_inspector.mjs authenticate [options]
  node scripts/wordpress_inspector.mjs check-admin [options]
  node scripts/wordpress_inspector.mjs check-editor --editor-url <url> [options]
  node scripts/wordpress_inspector.mjs snapshot-editor --editor-url <url> [options]
  node scripts/wordpress_inspector.mjs find-post --slug <slug> [--post-type page|post] [--profile <name>] [options]

Shared options:
  --base-url <url>                WordPress site origin/base URL (required except editor commands with absolute --editor-url)
  --profile <name>                Persistent profile (default: default; find-post without it uses public lookup)
  --output-dir <path>             Artifact directory (default: random temporary directory, e.g. /tmp/wordpress-inspector-XXXXXX)
  --headed                        Forward headed capture mode (manual authenticate is headed by default)
  --headless                      Force headless capture mode (automated authenticate is always headless)
  --username <name>               Username for automated authenticate (must be paired with --password)
  --password <value>              Password for automated authenticate (must be paired with --username)
  --timeout <milliseconds>        Navigation/action timeout (default: 30000)
  --editor-url <url>              Same-origin Gutenberg editor URL for editor commands
  --help                          Show this help
`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const command = argv.shift();
  if (!command || !["authenticate", "check-admin", "check-editor", "snapshot-editor", "find-post"].includes(command)) {
    throw new Error(`Unknown command "${command ?? ""}"; expected authenticate, check-admin, check-editor, snapshot-editor, or find-post`);
  }
  const options = {
    baseUrl: null,
    profile: null,
    outputDir: null,
    headed: false,
    headless: false,
    headedSpecified: false,
    headlessSpecified: false,
    timeout: 30000,
    timeoutSpecified: false,
    editorUrl: null,
    slug: null,
    postType: "page",
    username: null,
    password: null,
  };
  const positional = [];
  const valueOptions = new Set(["base-url", "profile", "output-dir", "timeout", "editor-url", "slug", "post-type", "username", "password"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "headed") {
      options.headed = true;
      options.headedSpecified = true;
    } else if (key === "headless") {
      options.headless = true;
      options.headlessSpecified = true;
    } else if (valueOptions.has(key)) {
      const value = argv[index + 1];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      index += 1;
      if (key === "base-url") options.baseUrl = value;
      else if (key === "profile") options.profile = value;
      else if (key === "output-dir") options.outputDir = value;
      else if (key === "timeout") {
        options.timeout = Number(value);
        options.timeoutSpecified = true;
      }
      else if (key === "editor-url") options.editorUrl = value;
      else if (key === "slug") options.slug = value;
      else if (key === "post-type") options.postType = value;
      else if (key === "username") options.username = value;
      else if (key === "password") options.password = value;
    } else throw new Error(`Unknown option --${key}`);
  }
  if (positional.length) throw new Error("Unexpected positional arguments");
  if (options.headedSpecified && options.headlessSpecified) throw new Error("--headed and --headless are mutually exclusive");
  if (!Number.isFinite(options.timeout) || options.timeout < 1) throw new Error("--timeout must be positive");
  return { command, ...options };
}

async function prepareOutputRoot(value) {
  if (value) {
    const outputDir = path.resolve(value);
    await fs.mkdir(outputDir, { recursive: true });
    return outputDir;
  }
  return fs.mkdtemp(path.join(os.tmpdir(), "wordpress-inspector-"));
}

function adminActions() {
  return [
    { type: "assertNotVisible", selector: SELECTORS.loginForm },
    { type: "assertNotVisible", selector: SELECTORS.loginUser },
    { type: "assertVisible", selector: SELECTORS.adminShell },
  ];
}

function authProbeActions() {
  return [
    { type: "assertNotVisible", selector: SELECTORS.loginForm },
    { type: "assertNotVisible", selector: SELECTORS.loginUser },
  ];
}

function automatedLoginActions(username, password) {
  return [
    { type: "fill", selector: SELECTORS.loginUser, value: username },
    { type: "fill", selector: SELECTORS.loginPassword, value: password },
    { type: "check", selector: SELECTORS.loginRemember },
    { type: "click", selector: SELECTORS.loginSubmit },
  ];
}

function editorActions() {
  // Keep this order in sync with classifyEditor(): the classifier refers to
  // action indexes in the browser report (3 = shell, 4 = canvas,
  // 5-7 = invalid/recovery/missing indicators, and 8 = fatal editor error).
  // TODO: replace this positional-index coupling with named action ids.
  return [
    { type: "assertNotVisible", selector: SELECTORS.loginForm },
    { type: "assertNotVisible", selector: SELECTORS.loginUser },
    { type: "clickIfVisible", selector: SELECTORS.onboardingClose },
    { type: "assertVisible", selector: SELECTORS.editorShell },
    { type: "assertVisible", selector: SELECTORS.editorCanvas },
    { type: "assertNotVisible", selector: SELECTORS.invalidBlockWarning },
    { type: "assertNotVisible", selector: SELECTORS.recoveryPrompt },
    { type: "assertNotVisible", selector: SELECTORS.missingBlock },
    { type: "assertNotVisible", selector: SELECTORS.fatalEditor },
  ];
}

function actionCheck(name, passed, detail = null) {
  return { name, passed, ...(detail ? { detail } : {}) };
}

function unavailableChecks(names) {
  return names.map((name) => actionCheck(name, null, "Browser report unavailable"));
}

function stateDirectoryFailure(stderr) {
  return /ENOENT: no such file or directory, mkdir .*web-inspector|EACCES:.*web-inspector|Could not enforce owner-only permissions/i.test(String(stderr ?? ""));
}

function childExitedWithoutReport(run) {
  const stdout = String(run?.stdout ?? "");
  const stderr = String(run?.stderr ?? "");
  const failed = run && (run.code !== 0 || Boolean(run.signal));
  return Boolean(run?.report == null && failed && !stdout.trim() && !stderr.trim());
}

function browserLaunchBlocked(run) {
  const stderr = String(run?.stderr ?? "");
  if (stateDirectoryFailure(stderr)) return false;
  return /sandbox_host_linux|Operation not permitted/i.test(stderr) || childExitedWithoutReport(run);
}

function webInspectorFailureWarning(run) {
  const stderr = String(run?.stderr ?? "");
  if (/Invalid profile name/i.test(stderr)) return "web-inspector-profile: invalid profile name";
  if (browserLaunchBlocked(run) && /sandbox_host_linux|Operation not permitted/i.test(stderr)) {
    return "web-inspector-runtime: Chromium launch was blocked by the execution sandbox; retry with elevated browser permission";
  }
  if (stateDirectoryFailure(stderr)) {
    return "web-inspector-profile: state directory is unavailable; set WEB_INSPECTOR_STATE_DIR to a writable directory";
  }
  if (/requires a graphical display|usable display environment/i.test(stderr)) return "web-inspector-runtime: headed mode requires a graphical display";
  if (/Could not resolve Playwright|No usable Firefox executable/i.test(stderr)) return "web-inspector-runtime: compatible Playwright runtime unavailable";
  if (/profile may already be in use|user data directory/i.test(stderr)) return "web-inspector-profile: profile is already in use";
  if (browserLaunchBlocked(run)) return "web-inspector-runtime: browser launch was blocked before creating a report; in a managed sandbox, retry with elevated browser permission";
  return "web-inspector-runtime: failed before a report was created";
}

function webInspectorFailureClassification(run) {
  return browserLaunchBlocked(run) ? "BROWSER_LAUNCH_BLOCKED" : "TECHNICAL_ERRORS";
}

function interactiveSessionFailureWarning(run) {
  if (run?.timedOut || run?.sessionEndReason === "timeout") {
    return "Interactive profile session reached its timeout before the browser was closed.";
  }
  if (run?.sessionEndReason === "SIGINT") return "Interactive profile session was interrupted by SIGINT.";
  if (run?.sessionEndReason === "SIGTERM") return "Interactive profile session was interrupted by SIGTERM.";
  if (run?.sessionEndReason) return `Interactive profile session ended (${run.sessionEndReason}) before the browser was closed.`;
  return "Interactive profile session failed before the browser-close signal was received.";
}

function interactiveSessionWarnings(run) {
  const warnings = [interactiveSessionFailureWarning(run)];
  if (!["timeout", "SIGINT", "SIGTERM"].includes(run?.sessionEndReason)) {
    warnings.push(webInspectorFailureWarning(run));
  }
  return [...new Set(warnings)];
}

function addFailureWarning(result, run) {
  if (run.report) return result;
  const blocked = browserLaunchBlocked(run);
  const warnings = [...new Set([...(result.warnings ?? result.technical ?? []), webInspectorFailureWarning(run)])]
    .filter((warning) => !(blocked && warning === "browser-report-unavailable"));
  return {
    ...result,
    classification: blocked ? "BROWSER_LAUNCH_BLOCKED" : result.classification,
    technical: warnings,
    warnings,
  };
}

function classifyAdmin(run) {
  const report = run.report;
  if (!report) {
    return {
      classification: "TECHNICAL_ERRORS",
      checks: unavailableChecks([
        "login form absent",
        "login username control absent",
        "wp-admin shell visible",
        "no blocking browser errors",
      ]),
      technical: ["browser-report-unavailable"],
    };
  }
  const technical = technicalIssues(report);
  const auth = authRequired(report, [0, 1]);
  const shellFailed = actionFailed(report, 2);
  const checks = [
    actionCheck("login form absent", !actionFailed(report, 0)),
    actionCheck("login username control absent", !actionFailed(report, 1)),
    actionCheck("wp-admin shell visible", !shellFailed),
    actionCheck("no blocking browser errors", technical.length === 0, technical.join(", ") || null),
  ];
  let classification = "AUTHENTICATED";
  if (auth) classification = "AUTH_REQUIRED";
  else if (technical.length) classification = "TECHNICAL_ERRORS";
  else if (shellFailed) classification = "ADMIN_LOAD_FAILED";
  const warnings = [...technical, ...(auth ? ["authentication-required"] : [])];
  return { classification, checks, technical, warnings };
}

function classifyEditor(run) {
  // A report contains action results plus browser diagnostics. Convert those
  // low-level results into the stable WordPress classifications and warning
  // names written to wordpress-summary.json.
  const report = run.report;
  if (!report) {
    return {
      classification: "TECHNICAL_ERRORS",
      checks: unavailableChecks([
        "login form absent",
        "login username control absent",
        "editor shell visible",
        "editor canvas visible",
        "invalid-block indicators absent",
        "editor fatal-error indicator absent",
        "no blocking browser errors",
      ]),
      technical: ["browser-report-unavailable"],
    };
  }
  const technical = technicalIssues(report);
  const auth = authRequired(report, [0, 1]);
  const shellFailed = actionFailed(report, 3);
  const canvasFailed = actionFailed(report, 4);
  const invalid = [5, 6, 7].some((index) => actionFailed(report, index));
  const fatal = actionFailed(report, 8);
  const checks = [
    actionCheck("login form absent", !actionFailed(report, 0)),
    actionCheck("login username control absent", !actionFailed(report, 1)),
    actionCheck("editor shell visible", !shellFailed),
    actionCheck("editor canvas visible", !canvasFailed),
    actionCheck("invalid-block indicators absent", !invalid),
    actionCheck("editor fatal-error indicator absent", !fatal),
    actionCheck("no blocking browser errors", technical.length === 0, technical.join(", ") || null),
  ];
  let classification = "EDITOR_HEALTHY";
  if (auth) classification = "AUTH_REQUIRED";
  else if (technical.length) classification = "TECHNICAL_ERRORS";
  else if (shellFailed || canvasFailed || fatal) classification = "EDITOR_LOAD_FAILED";
  else if (invalid) classification = "EDITOR_INVALID_BLOCKS";
  const warnings = [...technical];
  if (actionFailed(report, 5)) warnings.push("invalid-block-warning");
  if (actionFailed(report, 6)) warnings.push("block-recovery-prompt");
  if (actionFailed(report, 7)) warnings.push("missing-block-placeholder");
  if (fatal) warnings.push("fatal-editor-error");
  if (auth) warnings.push("authentication-required");
  return { classification, checks, technical, warnings };
}

function classifySnapshot(run) {
  const editorResult = classifyEditor(run);
  const report = run.report;
  const snapshotFailure = collectorError(report);
  const snapshotCheck = actionCheck(
    "editor snapshot artifacts captured",
    snapshotFailure ? false : report ? true : null,
    snapshotFailure?.message ?? (report ? null : "Browser report unavailable"),
  );
  const checks = [...editorResult.checks, snapshotCheck];
  if (snapshotFailure) {
    const supportedSnapshotErrors = new Set([
      "EDITOR_IFRAME_NOT_FOUND",
      "EDITOR_IFRAME_EMPTY",
      "EDITOR_DATA_UNAVAILABLE",
      "EDITOR_SOURCE_UNAVAILABLE",
      "EDITOR_SOURCE_INVALID",
    ]);
    const classification = ["AUTH_REQUIRED", "TECHNICAL_ERRORS", "BROWSER_LAUNCH_BLOCKED"].includes(editorResult.classification)
      ? editorResult.classification
      : supportedSnapshotErrors.has(snapshotFailure.code)
        ? snapshotFailure.code
        : "TECHNICAL_ERRORS";
    return {
      ...editorResult,
      classification,
      checks,
      warnings: [...new Set([...(editorResult.warnings ?? []), snapshotFailure.code])],
    };
  }
  if (editorResult.classification === "EDITOR_HEALTHY") {
    return { ...editorResult, classification: "EDITOR_SNAPSHOT_CAPTURED", checks };
  }
  return { ...editorResult, checks };
}

function authProbeChecks(command, run) {
  const report = run.report;
  if (!report) return unavailableChecks([
    "login form absent",
    "login username control absent",
    isEditorCommand(command) ? "editor readiness probe" : "wp-admin readiness probe",
    "no blocking browser errors",
  ]);
  const technical = technicalIssues(report);
  return [
    actionCheck("login form absent", !actionFailed(report, 0)),
    actionCheck("login username control absent", !actionFailed(report, 1)),
    actionCheck(
      isEditorCommand(command) ? "editor readiness probe" : "wp-admin readiness probe",
      null,
      "Skipped after authentication probe detected a login screen",
    ),
    actionCheck("no blocking browser errors", technical.length === 0, technical.join(", ") || null),
  ];
}

async function captureInspection({ url, profile, outputDir, timeout, headed, headless, actions, collectorPath = null, waitMs }) {
  return runWebInspectorScript("capture_page.mjs", captureArgs({
    url,
    profile,
    outputDir,
    timeout,
    headed,
    headless,
    actions,
    collectorPath,
    waitMs,
  }));
}

async function renameEditorShellScreenshots(run) {
  if (!run.report) return run;

  let renamed = false;
  for (const viewport of run.report.viewports ?? []) {
    if (!viewport.screenshot) continue;

    const oldPath = path.resolve(viewport.screenshot);
    const oldName = path.basename(oldPath);
    if (oldName.startsWith("editor-shell-")) continue;

    const newPath = path.join(path.dirname(oldPath), `editor-shell-${oldName}`);
    await fs.rm(newPath, { force: true });
    await fs.rename(oldPath, newPath);
    viewport.screenshot = newPath;
    renamed = true;
  }

  if (renamed && run.reportPath) {
    await fs.writeFile(run.reportPath, `${JSON.stringify(run.report, null, 2)}\n`, "utf8");
  }
  return run;
}

function summaryFileName(command) {
  return command === "snapshot-editor" ? "snapshot-editor.json" : "wordpress-summary.json";
}

async function runCheck({ command, baseUrl, editorUrl, profile, outputDir, timeout, headed, headless }) {
  // Every check is deliberately two-pass: first detect an expired session,
  // then run the admin/editor readiness probe only when the login screen is
  // absent. This keeps AUTH_REQUIRED separate from editor-load failures.
  const actions = isEditorCommand(command) ? editorActions() : adminActions();
  const url = editorUrl ?? buildBaseUrl(baseUrl, "wp-admin/");
  const authProbe = await captureInspection({
    url,
    profile,
    outputDir: path.join(outputDir, "auth-probe"),
    timeout,
    headed,
    headless,
    actions: authProbeActions(),
    waitMs: 0,
  });
  if (isEditorCommand(command)) await renameEditorShellScreenshots(authProbe);
  if (authProbe.report && authRequired(authProbe.report, [0, 1])) {
    const technical = technicalIssues(authProbe.report);
    const summary = createSummary({
      command,
      baseUrl,
      editorUrl,
      profile,
      classification: "AUTH_REQUIRED",
      reportPath: authProbe.reportPath,
      report: authProbe.report,
      checks: authProbeChecks(command, authProbe),
      warnings: [...technical, "authentication-required"],
      limitations: [
        "Read-only inspection stopped after the authentication probe detected a WordPress login screen.",
        "No editor/admin readiness or mutation controls were exercised.",
      ],
    });
    return {
      ...authProbe,
      classification: "AUTH_REQUIRED",
      checks: summary.checks,
      technical,
      summary,
      summaryPath: path.join(outputDir, summaryFileName(command)),
    };
  }
  if (!authProbe.report) {
    const result = addFailureWarning(
      command === "snapshot-editor"
        ? classifySnapshot(authProbe)
        : isEditorCommand(command)
          ? classifyEditor(authProbe)
          : classifyAdmin(authProbe),
      authProbe,
    );
    const summary = createSummary({
      command,
      baseUrl,
      editorUrl,
      profile,
      classification: result.classification,
      reportPath: null,
      report: null,
      checks: result.checks,
      warnings: result.warnings,
      limitations: ["Read-only inspection; the browser report was unavailable."],
    });
    return { ...authProbe, ...result, summary, summaryPath: path.join(outputDir, summaryFileName(command)) };
  }
  const browserOutputDir = path.join(outputDir, command === "snapshot-editor" ? "snapshot-editor" : "web-inspector");
  const run = await captureInspection({
    url,
    profile,
    outputDir: browserOutputDir,
    timeout,
    headed,
    headless,
    actions,
    collectorPath: command === "snapshot-editor" ? EDITOR_COLLECTOR_PATH : null,
    waitMs: 750,
  });
  if (isEditorCommand(command)) await renameEditorShellScreenshots(run);
  const result = command === "snapshot-editor"
    ? classifySnapshot(run)
    : isEditorCommand(command)
      ? classifyEditor(run)
      : classifyAdmin(run);
  const reportedResult = addFailureWarning(result, run);
  const summary = createSummary({
    command,
    baseUrl,
    editorUrl,
    profile,
    classification: reportedResult.classification,
    reportPath: run.report ? run.reportPath : null,
    report: run.report,
    checks: reportedResult.checks,
    warnings: reportedResult.warnings ?? reportedResult.technical,
    limitations: ["Read-only inspection; no WordPress mutation controls are exercised."],
    artifacts: command === "snapshot-editor" ? collectorArtifacts(run.report) : null,
  });
  return { ...run, ...reportedResult, summary, summaryPath: path.join(outputDir, summaryFileName(command)) };
}

function resolveAutomatedCredentials(parsed) {
  const cliCredentialsProvided = parsed.username !== null || parsed.password !== null;
  if (cliCredentialsProvided && parsed.command !== "authenticate") {
    throw new Error("--username and --password are only valid for authenticate");
  }
  if (cliCredentialsProvided) {
    if (parsed.username === null || parsed.password === null) {
      throw new Error("--username and --password must be provided together");
    }
    if (!parsed.username) throw new Error("--username must not be empty");
    return { username: parsed.username, password: parsed.password };
  }
  if (parsed.command !== "authenticate") return null;

  const username = process.env.WORDPRESS_INSPECTOR_USERNAME ?? null;
  const password = process.env.WORDPRESS_INSPECTOR_PASSWORD ?? null;
  if (username === null && password === null) return null;
  if (username === null || password === null) {
    throw new Error("WORDPRESS_INSPECTOR_USERNAME and WORDPRESS_INSPECTOR_PASSWORD must be provided together");
  }
  if (!username) throw new Error("WORDPRESS_INSPECTOR_USERNAME must not be empty");
  return { username, password };
}

async function runAutomatedAuthentication({ baseUrl, profile, outputDir, timeout, username, password }) {
  const loginRun = await captureInspection({
    url: buildBaseUrl(baseUrl, "wp-login.php"),
    profile,
    outputDir: path.join(outputDir, "login-attempt"),
    timeout,
    headed: false,
    headless: true,
    actions: automatedLoginActions(username, password),
    waitMs: 750,
  });
  const adminResult = await runCheck({
    command: "check-admin",
    baseUrl,
    editorUrl: null,
    profile,
    outputDir: path.join(outputDir, "admin-check"),
    timeout,
    headed: false,
    headless: true,
  });

  const loginWarnings = [];
  if (!loginRun.report) {
    loginWarnings.push(webInspectorFailureWarning(loginRun));
  } else {
    if (loginRun.code !== 0) loginWarnings.push("automated-login-attempt-failed");
    if (isLoginUrl(finalUrl(loginRun.report))) loginWarnings.push("automated-login-did-not-authenticate");
    for (const issue of technicalIssues(loginRun.report)) loginWarnings.push(`automated-login-${issue}`);
  }
  const summary = {
    ...adminResult.summary,
    command: "authenticate",
    loginAttemptReport: loginRun.reportPath,
    warnings: [...new Set([...adminResult.summary.warnings, ...loginWarnings])],
    limitations: [
      "Automated authentication submits the supplied credentials to the WordPress login form; this is the only non-GET request made by authenticate.",
      "The final authentication status is based on the follow-up read-only wp-admin probe.",
      "Two-factor authentication, CAPTCHA, SSO, and customized login forms may require manual authentication.",
    ],
  };
  return { ...adminResult, loginAttempt: loginRun, summary, summaryPath: path.join(outputDir, "wordpress-summary.json") };
}

async function writeSummary(result) {
  await fs.writeFile(result.summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...result.summary, summary: result.summaryPath }, null, 2));
}

const FIND_POST_TYPES = new Set(["page", "post"]);

const FIND_POST_FIELDS = "id,link,slug,status,title";

function findPostEndpoint(baseUrl, postType) {
  return buildBaseUrl(baseUrl, `/wp-json/wp/v2/${postType}s`);
}

function findPostQuery(slug, context = null) {
  const query = `?slug=${encodeURIComponent(slug)}&_fields=${FIND_POST_FIELDS}`;
  return context ? `${query}&context=${encodeURIComponent(context)}` : query;
}

// The public path is a plain read-only GET: it needs no browser, profile, or
// authentication, but it can only see publicly readable content.
async function findPostPublic({ baseUrl, slug, postType, timeout }) {
  const endpoint = findPostEndpoint(baseUrl, postType);
  const query = findPostQuery(slug);
  let response;
  try {
    response = await fetch(`${endpoint}${query}`, { signal: AbortSignal.timeout(timeout) });
  } catch {
    return {
      method: "public",
      classification: "TECHNICAL_ERRORS",
      matches: [],
      warnings: ["request-failure"],
      limitations: [`Could not query the public WordPress REST API at ${endpoint}.`],
    };
  }
  let bodyText;
  try {
    bodyText = await response.text();
  } catch {
    return {
      method: "public",
      classification: "TECHNICAL_ERRORS",
      status: response.status,
      matches: [],
      warnings: ["response-error"],
      limitations: [`The public WordPress REST API response from ${endpoint} could not be read.`],
    };
  }
  const restError = restErrorFromBody(bodyText);
  if (!response.ok) {
    const privateContent = response.status === 403 || Number(restError?.status) === 403;
    const authRequired = response.status === 401 || Number(restError?.status) === 401 || restError?.code === "rest_not_logged_in";
    return {
      method: "public",
      classification: privateContent ? "NOT_FOUND" : authRequired ? "AUTH_REQUIRED" : "TECHNICAL_ERRORS",
      status: response.status,
      matches: [],
      ...(privateContent || authRequired ? { warnings: privateContent ? [] : ["authentication-required"] } : { warnings: ["response-error"] }),
      limitations: [
        privateContent
          ? "The public REST API did not expose this content; draft or private content requires --profile for an authenticated lookup."
          : authRequired
            ? "The public REST API requires authentication for this lookup; pass --profile for an authenticated lookup."
            : `The public WordPress REST API returned HTTP ${response.status} for ${endpoint}.`,
      ],
    };
  }
  let matches;
  try {
    matches = JSON.parse(bodyText);
  } catch {
    return {
      method: "public",
      classification: "TECHNICAL_ERRORS",
      status: response.status,
      matches: [],
      warnings: ["invalid-json"],
      limitations: ["The public WordPress REST API did not return valid JSON."],
    };
  }
  if (!Array.isArray(matches)) {
    const privateContent = restError?.code === "rest_forbidden" || Number(restError?.status) === 403;
    const authRequired = restError?.code === "rest_not_logged_in" || Number(restError?.status) === 401;
    return {
      method: "public",
      classification: privateContent ? "NOT_FOUND" : authRequired ? "AUTH_REQUIRED" : "TECHNICAL_ERRORS",
      status: response.status,
      matches: [],
      ...(privateContent || authRequired ? { warnings: privateContent ? [] : ["authentication-required"] } : { warnings: ["invalid-response"] }),
      limitations: [
        privateContent
          ? "The public REST API cannot distinguish a non-existent slug from content that is private; pass --profile for an authenticated lookup."
          : authRequired
            ? "The public REST API requires authentication for this lookup; pass --profile for an authenticated lookup."
            : "The public WordPress REST API returned an object instead of the expected post array.",
      ],
    };
  }
  return {
    method: "public",
    classification: matches.length > 0 ? "FOUND" : "NOT_FOUND",
    status: response.status,
    matches,
    limitations: [
      "Resolution uses the public REST API; draft or private content requires --profile for an authenticated lookup.",
      "The public API cannot distinguish a non-existent slug from one whose content is private; both report NOT_FOUND.",
    ],
  };
}

// A REST error body looks like { code, message, data: { status } }; return a
// classification-relevant summary or null when the body is not such an object.
function restErrorFromBody(bodyText) {
  try {
    const parsed = JSON.parse(bodyText ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.code === "string") {
      return {
        code: parsed.code,
        status: parsed.data?.status ?? null,
        message: typeof parsed.message === "string" ? parsed.message : null,
      };
    }
  } catch {
    // Body was not JSON; the caller decides how to report that.
  }
  return null;
}

const REST_AUTH_ERROR_CODES = new Set(["rest_cookie_invalid", "rest_cookie_invalid_nonce", "rest_not_logged_in", "rest_forbidden", "rest_cannot_view"]);

// The authenticated path reuses the persistent browser profile (which holds the
// WordPress session cookies) to query the REST API through a real browser, so it
// can also resolve drafts/private content the current user is allowed to read.
async function findPostAuthenticated({ baseUrl, slug, postType, profile, timeout }) {
  const endpoint = findPostEndpoint(baseUrl, postType);
  // WordPress requires edit context for collection queries that include
  // drafts/private posts; the persistent browser profile supplies the session.
  const query = findPostQuery(slug, "edit");
  const url = `${endpoint}${query}`;
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "wordpress-inspector-findpost-"));
  let run;
  try {
    run = await runWebInspectorScript("capture_page.mjs", captureArgs({
      url,
      profile,
      outputDir,
      timeout,
      headed: false,
      headless: true,
      waitUntil: "domcontentloaded",
      waitMs: 0,
      failOnErrors: false,
      fullText: true,
    }));
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
  if (!run.report) {
    return {
      method: "authenticated",
      classification: webInspectorFailureClassification(run),
      matches: [],
      warnings: [webInspectorFailureWarning(run)],
      limitations: ["Authenticated lookup could not produce a Web Inspector report."],
    };
  }
  const viewport = run.report.viewports?.[0] ?? null;
  const final = viewport?.finalUrl ?? null;
  const status = viewport?.status ?? null;
  const bodyText = viewport?.domSummary?.bodyText ?? "";

  const base = { method: "authenticated", matches: [] };
  if (isLoginUrl(final)) {
    return {
      ...base,
      classification: "AUTH_REQUIRED",
      finalUrl: final,
      warnings: ["authentication-required"],
      limitations: ["Authenticated lookup was redirected to a login route; re-authenticate with the same profile and retry."],
    };
  }
  const restError = restErrorFromBody(bodyText);
  const statusCode = Number(status);
  if (restError) {
    if (REST_AUTH_ERROR_CODES.has(restError.code) || Number(restError.status) === 401 || Number(restError.status) === 403) {
      return {
        ...base,
        classification: "AUTH_REQUIRED",
        finalUrl: final,
        status,
        warnings: ["authentication-required"],
        limitations: [`The authenticated REST API did not grant read access (${restError.code || `HTTP ${restError.status}`}); re-authenticate with the same profile and retry.`],
      };
    }
    return {
      ...base,
      classification: "TECHNICAL_ERRORS",
      finalUrl: final,
      status,
      warnings: [restError.code],
      limitations: [`The authenticated REST API returned an error: ${restError.message ?? restError.code ?? `HTTP ${status}`}.`],
    };
  }
  if (statusCode === 401 || statusCode === 403) {
    // Some setups return an HTML error page for an unauthorized REST read; the
    // plain HTTP status is still a clear authentication/permission signal.
    return {
      ...base,
      classification: "AUTH_REQUIRED",
      finalUrl: final,
      status,
      warnings: ["authentication-required"],
      limitations: [`The authenticated REST API returned HTTP ${status} for an unauthorized read; re-authenticate with the same profile and retry.`],
    };
  }
  let matches;
  try {
    matches = JSON.parse(bodyText);
  } catch (error) {
    return {
      ...base,
      classification: "TECHNICAL_ERRORS",
      finalUrl: final,
      status,
      warnings: error.message ? [String(error.message)] : [],
      limitations: ["The authenticated REST API did not return a JSON array.", `HTTP ${status ?? "unknown"}, final URL ${final ?? "unknown"}.`],
    };
  }
  if (!Array.isArray(matches)) {
    return {
      ...base,
      classification: "TECHNICAL_ERRORS",
      finalUrl: final,
      status,
      limitations: [`The authenticated REST API returned a non-array body of type ${typeof matches}; expected a JSON array.`],
    };
  }
  return {
    ...base,
    classification: matches.length > 0 ? "FOUND" : "NOT_FOUND",
    finalUrl: final,
    status,
    matches,
  };
}

async function findPost({ baseUrl, slug, postType, profile, timeout }) {
  if (!slug) throw new Error("--slug is required for find-post");
  if (!FIND_POST_TYPES.has(postType)) {
    throw new Error(`--post-type must be one of: ${[...FIND_POST_TYPES].join(", ")}`);
  }
  const source = profile ? await findPostAuthenticated({ baseUrl, slug, postType, profile, timeout }) : await findPostPublic({ baseUrl, slug, postType, timeout });
  const matches = Array.isArray(source.matches) ? source.matches : [];
  const post = matches[0] ?? null;
  return {
    command: "find-post",
    baseUrl,
    slug,
    postType,
    method: source.method,
    classification: source.classification,
    found: source.classification === "FOUND",
    ...(source.finalUrl !== undefined ? { finalUrl: source.finalUrl } : {}),
    ...(source.status !== undefined ? { httpStatus: source.status } : {}),
    ...(post ? {
      post: {
        id: post.id,
        slug: post.slug,
        status: post.status,
        link: post.link,
        title: post.title?.rendered ?? null,
      },
      editorUrl: buildBaseUrl(baseUrl, `wp-admin/post.php?post=${post.id}&action=edit`),
    } : {}),
    ...(source.warnings?.length ? { warnings: source.warnings } : {}),
    limitations: source.limitations ?? [],
  };
}

function resolveBaseUrl(parsed) {
  if (parsed.baseUrl !== null) return normalizeBaseUrl(parsed.baseUrl);
  if (isEditorCommand(parsed.command)) return inferBaseUrlFromEditorUrl(parsed.editorUrl);
  throw new Error("--base-url is required");
}

async function main() {
  // `main` validates the target and dispatches the public commands.
  // `authenticate` either submits supplied credentials headlessly or opens the
  // visible profile; editor/admin commands go through runCheck() and then emit
  // a sanitized summary.
  const parsed = parseArgs(process.argv.slice(2));
  const credentials = resolveAutomatedCredentials(parsed);
  const baseUrl = resolveBaseUrl(parsed);

  if (parsed.command === "find-post") {
    const result = await findPost({
      baseUrl,
      slug: parsed.slug,
      postType: parsed.postType,
      profile: parsed.profile,
      timeout: parsed.timeout,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.classification !== "FOUND") process.exitCode = 1;
    return;
  }

  const profile = parsed.profile ?? DEFAULT_PROFILE_NAME;
  const editorUrl = isEditorCommand(parsed.command) ? normalizeEditorUrl(baseUrl, parsed.editorUrl) : null;
  if (!isEditorCommand(parsed.command) && parsed.editorUrl) throw new Error("--editor-url is only valid with editor commands");
  if (credentials && parsed.headedSpecified) throw new Error("automated authenticate is always headless; do not pass --headed");
  if (parsed.command === "authenticate" && parsed.headlessSpecified && !credentials) throw new Error("authenticate requires a visible browser when credentials are not supplied; do not pass --headless");
  const outputDir = await prepareOutputRoot(parsed.outputDir);

  if (parsed.command === "authenticate") {
    if (credentials) {
      const result = await runAutomatedAuthentication({
        baseUrl,
        profile,
        outputDir,
        timeout: parsed.timeout,
        username: credentials.username,
        password: credentials.password,
      });
      await writeSummary(result);
      if (result.classification !== "AUTHENTICATED") process.exitCode = 1;
      return;
    }
    // open_profile.mjs always launches a headed interactive session. The
    // --headed flag remains accepted for compatibility but is not required.
    const loginUrl = buildBaseUrl(baseUrl, "wp-login.php");
    const authRun = await runWebInspectorScript("open_profile.mjs", openProfileArgs({
      url: loginUrl,
      profile,
      timeout: parsed.timeoutSpecified ? parsed.timeout : null,
    }));
    if (authRun.code !== 0 || authRun.sessionEndReason !== "window-closed") {
      const summary = {
        ...createSummary({
          command: "authenticate",
          baseUrl,
          profile,
          classification: webInspectorFailureClassification(authRun),
          reportPath: null,
          report: null,
          checks: unavailableChecks([
            "interactive profile session",
            "read-only wp-admin probe",
          ]),
          warnings: interactiveSessionWarnings(authRun),
          limitations: [
            "The read-only wp-admin probe was skipped because the interactive profile session did not complete successfully.",
            "No credentials were supplied, so authentication was left to the dedicated headed browser.",
          ],
        }),
        sessionEndReason: authRun.sessionEndReason,
      };
      const result = { summary, summaryPath: path.join(outputDir, "wordpress-summary.json") };
      await writeSummary(result);
      process.exitCode = 1;
      return;
    }
    const adminResult = await runCheck({
      command: "check-admin",
      baseUrl,
      editorUrl: null,
      profile,
      outputDir: path.join(outputDir, "admin-check"),
      timeout: parsed.timeout,
      headed: false,
      headless: true,
    });
    const summary = {
      ...adminResult.summary,
      command: "authenticate",
      sessionEndReason: authRun.sessionEndReason,
      warnings: [
        ...adminResult.summary.warnings,
      ],
      limitations: [
        "No credentials were supplied, so authentication was left to the dedicated headed browser.",
        "Read-only admin probe follows the interactive session.",
      ],
    };
    const result = { ...adminResult, summary, summaryPath: path.join(outputDir, "wordpress-summary.json") };
    await writeSummary(result);
    if (authRun.sessionEndReason !== "window-closed" || result.classification !== "AUTHENTICATED") process.exitCode = 1;
    return;
  }

  const result = await runCheck({
    command: parsed.command,
    baseUrl,
    editorUrl,
    profile,
    outputDir,
    timeout: parsed.timeout,
    headed: parsed.headedSpecified,
    headless: parsed.headlessSpecified,
  });
  await writeSummary(result);
  const successfulClassifications = {
    "check-admin": "AUTHENTICATED",
    "check-editor": "EDITOR_HEALTHY",
    "snapshot-editor": "EDITOR_SNAPSHOT_CAPTURED",
  };
  if (result.classification !== successfulClassifications[parsed.command]) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
