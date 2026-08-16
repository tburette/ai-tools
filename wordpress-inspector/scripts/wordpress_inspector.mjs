#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SELECTORS,
  actionFailed,
  authRequired,
  buildBaseUrl,
  createSummary,
  finalUrl,
  normalizeBaseUrl,
  normalizeEditorUrl,
  technicalIssues,
} from "./lib/wordpress.mjs";
import {
  captureArgs,
  openProfileArgs,
  runWebInspectorScript,
} from "./lib/web_inspector_process.mjs";

// The adapter has two layers: this file defines the WordPress-specific probes
// and classifications, while Web Inspector performs the actual Playwright
// navigation, assertions, screenshots, and browser diagnostics.

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  node scripts/wordpress_inspector.mjs authenticate [options]
  node scripts/wordpress_inspector.mjs check-admin [options]
  node scripts/wordpress_inspector.mjs check-editor --editor-url <url> [options]

Shared options:
  --base-url <url>                WordPress site origin/base URL (required)
  --profile <name>                Web Inspector persistent profile (required)
  --config <path>                 Forward Web Inspector config override
  --output-dir <path>             Artifact directory (default: /tmp/wordpress-inspector/<timestamp>)
  --headed                        Forward headed capture mode
  --headless                      Force headless capture mode
  --timeout <milliseconds>        Navigation/action timeout (default: 30000)
  --editor-url <url>              Same-origin Gutenberg editor URL for check-editor
  --help                          Show this help
`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const command = argv.shift();
  if (!command || !["authenticate", "check-admin", "check-editor"].includes(command)) {
    throw new Error(`Unknown command "${command ?? ""}"; expected authenticate, check-admin, or check-editor`);
  }
  const options = {
    baseUrl: null,
    profile: null,
    configPath: null,
    outputDir: null,
    headed: false,
    headless: false,
    headedSpecified: false,
    headlessSpecified: false,
    timeout: 30000,
    timeoutSpecified: false,
    editorUrl: null,
  };
  const positional = [];
  const valueOptions = new Set(["base-url", "profile", "config", "output-dir", "timeout", "editor-url"]);
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
      else if (key === "config") options.configPath = value;
      else if (key === "output-dir") options.outputDir = value;
      else if (key === "timeout") {
        options.timeout = Number(value);
        options.timeoutSpecified = true;
      }
      else if (key === "editor-url") options.editorUrl = value;
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

function editorActions() {
  // Keep this order in sync with classifyEditor(): the classifier refers to
  // action indexes in the generic Web Inspector report (3 = shell, 4 = canvas,
  // 5-7 = invalid/recovery/missing indicators, and 8 = fatal editor error).
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
  return names.map((name) => actionCheck(name, null, "Generic Web Inspector report unavailable"));
}

function webInspectorFailureWarning(run) {
  const stderr = String(run?.stderr ?? "");
  const unknownProfile = stderr.match(/Unknown profile "([A-Za-z0-9][A-Za-z0-9._-]{0,63})"/i);
  if (unknownProfile) return `web-inspector-configuration: unknown profile "${unknownProfile[1]}"; declare it before use`;
  if (/Invalid JSON in Web Inspector config/i.test(stderr)) return "web-inspector-configuration: invalid JSON";
  if (/Unsupported Web Inspector config version/i.test(stderr)) return "web-inspector-configuration: unsupported version";
  if (/requires a graphical display|usable display environment/i.test(stderr)) return "web-inspector-runtime: headed mode requires a graphical display";
  if (/Could not resolve Playwright|No usable Firefox executable/i.test(stderr)) return "web-inspector-runtime: compatible Playwright runtime unavailable";
  if (/profile may already be in use|user data directory/i.test(stderr)) return "web-inspector-profile: profile is already in use";
  return "web-inspector-runtime: failed before a report was created";
}

function addFailureWarning(result, run) {
  if (run.report) return result;
  const warnings = [...new Set([...(result.warnings ?? result.technical ?? []), webInspectorFailureWarning(run)])];
  return { ...result, technical: warnings, warnings };
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
        "browser diagnostics clear",
      ]),
      technical: ["generic-report-unavailable"],
    };
  }
  const technical = technicalIssues(report);
  const auth = authRequired(report, [0, 1]);
  const shellFailed = actionFailed(report, 2);
  const checks = [
    actionCheck("login form absent", !actionFailed(report, 0)),
    actionCheck("login username control absent", !actionFailed(report, 1)),
    actionCheck("wp-admin shell visible", !shellFailed),
    actionCheck("browser diagnostics clear", technical.length === 0, technical.join(", ") || null),
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
        "browser diagnostics clear",
      ]),
      technical: ["generic-report-unavailable"],
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
    actionCheck("browser diagnostics clear", technical.length === 0, technical.join(", ") || null),
  ];
  let classification = "AUTHENTICATED";
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

function authProbeChecks(command, run) {
  const report = run.report;
  if (!report) return unavailableChecks([
    "login form absent",
    "login username control absent",
    command === "check-editor" ? "editor readiness probe" : "wp-admin readiness probe",
    "browser diagnostics clear",
  ]);
  const technical = technicalIssues(report);
  return [
    actionCheck("login form absent", !actionFailed(report, 0)),
    actionCheck("login username control absent", !actionFailed(report, 1)),
    actionCheck(
      command === "check-editor" ? "editor readiness probe" : "wp-admin readiness probe",
      null,
      "Skipped after authentication probe detected a login screen",
    ),
    actionCheck("browser diagnostics clear", technical.length === 0, technical.join(", ") || null),
  ];
}

async function captureInspection({ url, profile, configPath, outputDir, timeout, headed, headless, actions, waitMs }) {
  return runWebInspectorScript("capture_page.mjs", captureArgs({
    url,
    profile,
    configPath,
    outputDir,
    timeout,
    headed,
    headless,
    actions,
    waitMs,
  }));
}

async function runCheck({ command, baseUrl, editorUrl, profile, configPath, outputDir, timeout, headed, headless }) {
  // Every check is deliberately two-pass: first detect an expired session,
  // then run the admin/editor readiness probe only when the login screen is
  // absent. This keeps AUTH_REQUIRED separate from editor-load failures.
  const actions = command === "check-editor" ? editorActions() : adminActions();
  const url = editorUrl ?? buildBaseUrl(baseUrl, "wp-admin/");
  const authProbe = await captureInspection({
    url,
    profile,
    configPath,
    outputDir: path.join(outputDir, "auth-probe"),
    timeout,
    headed,
    headless,
    actions: authProbeActions(),
    waitMs: 0,
  });
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
      summaryPath: path.join(outputDir, "wordpress-summary.json"),
    };
  }
  if (!authProbe.report) {
    const result = addFailureWarning(
      command === "check-editor" ? classifyEditor(authProbe) : classifyAdmin(authProbe),
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
      limitations: ["Read-only inspection; the generic Web Inspector report was unavailable."],
    });
    return { ...authProbe, ...result, summary, summaryPath: path.join(outputDir, "wordpress-summary.json") };
  }
  const genericOutputDir = path.join(outputDir, "web-inspector");
  const run = await captureInspection({
    url,
    profile,
    configPath,
    outputDir: genericOutputDir,
    timeout,
    headed,
    headless,
    actions,
    waitMs: 750,
  });
  const result = command === "check-editor" ? classifyEditor(run) : classifyAdmin(run);
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
  });
  return { ...run, ...reportedResult, summary, summaryPath: path.join(outputDir, "wordpress-summary.json") };
}

async function writeSummary(result) {
  await fs.writeFile(result.summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...result.summary, summary: result.summaryPath }, null, 2));
}

async function main() {
  // `main` validates the target and dispatches one of the three public
  // commands. `authenticate` opens the visible profile first; the two check
  // commands go through runCheck() and then emit a sanitized summary.
  const parsed = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(parsed.baseUrl);
  if (!parsed.profile) throw new Error("--profile is required");
  const editorUrl = parsed.command === "check-editor" ? normalizeEditorUrl(baseUrl, parsed.editorUrl) : null;
  if (parsed.command !== "check-editor" && parsed.editorUrl) throw new Error("--editor-url is only valid with check-editor");
  if (parsed.command === "authenticate" && parsed.headlessSpecified) throw new Error("authenticate requires a visible browser; do not pass --headless");
  const outputDir = await prepareOutputRoot(parsed.outputDir);
  const configPath = parsed.configPath ? path.resolve(parsed.configPath) : null;

  if (parsed.command === "authenticate") {
    const loginUrl = buildBaseUrl(baseUrl, "wp-login.php");
    const authRun = await runWebInspectorScript("open_profile.mjs", openProfileArgs({
      url: loginUrl,
      profile: parsed.profile,
      configPath,
      timeout: parsed.timeoutSpecified ? parsed.timeout : null,
    }));
    if (authRun.code !== 0) {
      const timeoutWarning = authRun.timedOut || authRun.sessionEndedByTimeout
        ? "Interactive profile session reached its timeout."
        : "Interactive profile session failed before the read-only admin probe.";
      const summary = createSummary({
        command: "authenticate",
        baseUrl,
        profile: parsed.profile,
        classification: "TECHNICAL_ERRORS",
        reportPath: null,
        report: null,
        checks: unavailableChecks([
          "interactive profile session",
          "read-only wp-admin probe",
        ]),
        warnings: [...new Set([timeoutWarning, webInspectorFailureWarning(authRun)])],
        limitations: [
          "The read-only wp-admin probe was skipped because the interactive profile session did not complete successfully.",
          "Credentials are entered interactively in the dedicated browser; this command never accepts or stores passwords.",
        ],
      });
      const result = { summary, summaryPath: path.join(outputDir, "wordpress-summary.json") };
      await writeSummary(result);
      process.exitCode = 1;
      return;
    }
    const adminResult = await runCheck({
      command: "check-admin",
      baseUrl,
      editorUrl: null,
      profile: parsed.profile,
      configPath,
      outputDir: path.join(outputDir, "admin-check"),
      timeout: parsed.timeout,
      headed: false,
      headless: true,
    });
    const summary = {
      ...adminResult.summary,
      command: "authenticate",
      warnings: [
        ...adminResult.summary.warnings,
        ...(authRun.timedOut || authRun.sessionEndedByTimeout
          ? ["Interactive profile session reached its timeout."]
          : []),
      ],
      limitations: [
        "Credentials are entered interactively in the dedicated browser; this command never accepts or stores passwords.",
        "Read-only admin probe follows the interactive session.",
      ],
    };
    const result = { ...adminResult, summary, summaryPath: path.join(outputDir, "wordpress-summary.json") };
    await writeSummary(result);
    if (authRun.code !== 0 || result.classification !== "AUTHENTICATED") process.exitCode = 1;
    return;
  }

  const result = await runCheck({
    command: parsed.command,
    baseUrl,
    editorUrl,
    profile: parsed.profile,
    configPath,
    outputDir,
    timeout: parsed.timeout,
    headed: parsed.headedSpecified,
    headless: parsed.headlessSpecified,
  });
  await writeSummary(result);
  if (result.classification !== "AUTHENTICATED") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
