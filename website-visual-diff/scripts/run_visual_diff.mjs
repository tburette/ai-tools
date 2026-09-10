#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareBrowserViewer } from "./browser_viewer.mjs";
import { ensureEmptyDirectory } from "./output_directory.mjs";
import { resolveCssReference } from "./resolve_css.mjs";
import { writeReportSummary } from "./summarize_report.mjs";

const DEFAULT_VIEWPORTS = [
  { width: 1440, height: 1100 },
  { width: 390, height: 844 },
];

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  node scripts/run_visual_diff.mjs <url> [--url <url> ...] --css-ref <path:line (selector)> [options]
  node scripts/run_visual_diff.mjs <url> [--url <url> ...] --css-file <path> --range <start:end> [options]

Options:
  --url <url>             Add another page to the same before/after experiment
  --css-ref <reference>  Cursor reference copied from copy-file-ref (repeatable)
  --css-file <path>      CSS file to temporarily edit
  --range <start:end>    One-based inclusive line range to comment out (repeatable)
  --viewport <WxH>       Viewport to capture (repeatable; default: 1440x1100 and 390x844)
  --device <name>        Playwright device profile passed to Web Inspector
  --browser <name>       chromium or firefox (default: chromium)
  --full-page            Capture each page's full scrollable height (default)
  --no-full-page         Capture only the viewport instead of the full page
  --action <json>         Interaction action passed to both captures (repeatable)
  --wait-until <event>   load, domcontentloaded, or networkidle (default: networkidle)
  --wait-ms <ms>         Extra wait after navigation/actions (default: 300)
  --timeout <ms>         Browser navigation/action timeout (default: 30000)
  --fuzz <percent>       ImageMagick pixel-diff fuzz threshold (default: 0%)
  --output-dir <path>    Artifact directory (default: a new directory under /tmp)
  --no-viewer-relocation Do not copy the viewer to the Downloads directory
  --no-open               Do not open the aggregate HTML viewer automatically
  --web-inspector-dir <path> Companion web-inspector skill directory
  --ignore-https-errors  Ignore HTTPS certificate errors
  --no-local-map         Do not map localhost/*.test to 127.0.0.1
  --full-text            Keep full DOM text in Web Inspector reports
  --fail-on-errors       Make captures fail on browser/request/action errors
  --help                 Show this help
`);
  process.exit(message ? 2 : 0);
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(String(value ?? ""));
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) {
    throw new Error(`Invalid viewport "${value}"; expected WIDTHxHEIGHT`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseRange(value) {
  if (!/^\d+:\d+$/.test(String(value ?? ""))) {
    throw new Error(`Invalid range "${value}"; expected start:end`);
  }
  const [start, end] = String(value).split(":").map(Number);
  if (start < 1 || end < start) throw new Error(`Invalid range "${value}"`);
  return `${start}:${end}`;
}

function parseFuzz(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d+)?%?$/.test(text)) {
    throw new Error(`Invalid --fuzz value "${value}"; expected a percentage such as 0% or 2%`);
  }
  return text.endsWith("%") ? text : `${text}%`;
}

function parseArgs(argv) {
  const options = {
    urls: [],
    cssRefs: [],
    cssFile: null,
    ranges: [],
    viewports: [],
    device: null,
    browser: "chromium",
    fullPage: true,
    actions: [],
    waitUntil: "networkidle",
    waitMs: 300,
    timeout: 30000,
    fuzz: "0%",
    outputDir: null,
    relocateViewer: true,
    openViewer: true,
    webInspectorDir: null,
    ignoreHttpsErrors: false,
    localMap: true,
    fullText: false,
    failOnErrors: false,
  };
  const valueOptions = new Set([
    "url", "css-ref", "css-file", "range", "viewport", "device", "browser", "action",
    "wait-until", "wait-ms", "timeout", "fuzz", "output-dir", "web-inspector-dir",
  ]);
  const positionalUrls = [];
  let viewportSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) {
      positionalUrls.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "full-page") options.fullPage = true;
    else if (key === "no-full-page") options.fullPage = false;
    else if (key === "ignore-https-errors") options.ignoreHttpsErrors = true;
    else if (key === "no-local-map") options.localMap = false;
    else if (key === "full-text") options.fullText = true;
    else if (key === "fail-on-errors") options.failOnErrors = true;
    else if (key === "no-viewer-relocation") options.relocateViewer = false;
    else if (key === "no-open") options.openViewer = false;
    else if (valueOptions.has(key)) {
      const value = argv[index + 1];
      if (value == null || value.startsWith("--")) usage(`Missing value for ${arg}`);
      index += 1;
      if (key === "url") options.urls.push(value);
      else if (key === "css-ref") options.cssRefs.push(value);
      else if (key === "css-file") options.cssFile = value;
      else if (key === "range") options.ranges.push(parseRange(value));
      else if (key === "viewport") {
        if (!viewportSpecified) {
          options.viewports = [];
          viewportSpecified = true;
        }
        options.viewports.push(parseViewport(value));
      } else if (key === "device") options.device = value;
      else if (key === "browser") options.browser = value;
      else if (key === "action") {
        try {
          JSON.parse(value);
        } catch (error) {
          usage(`Invalid JSON for --action: ${error.message}`);
        }
        options.actions.push(value);
      } else if (key === "wait-until") options.waitUntil = value;
      else if (key === "wait-ms") options.waitMs = Number(value);
      else if (key === "timeout") options.timeout = Number(value);
      else if (key === "fuzz") options.fuzz = parseFuzz(value);
      else if (key === "output-dir") options.outputDir = path.resolve(value);
      else if (key === "web-inspector-dir") options.webInspectorDir = path.resolve(value);
    } else usage(`Unknown option "${arg}"`);
  }

  options.urls = [...positionalUrls, ...options.urls];
  if (!options.urls.length) usage("Provide at least one URL");
  if (options.cssRefs.length && (options.cssFile || options.ranges.length)) {
    usage("Use --css-ref by itself, or use --css-file with one or more --range options");
  }
  if (!options.cssRefs.length && !options.cssFile) usage("Provide --css-ref or --css-file");
  if (!options.cssRefs.length && !options.ranges.length) usage("Provide at least one --range with --css-file");
  if (!options.viewports.length) options.viewports = DEFAULT_VIEWPORTS.map((viewport) => ({ ...viewport }));
  if (!["chromium", "firefox"].includes(options.browser)) {
    usage(`Unknown browser "${options.browser}"; expected chromium or firefox`);
  }
  if (!["load", "domcontentloaded", "networkidle"].includes(options.waitUntil)) {
    usage(`Unknown --wait-until value "${options.waitUntil}"`);
  }
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0) usage("--wait-ms must be non-negative");
  if (!Number.isFinite(options.timeout) || options.timeout < 1) usage("--timeout must be positive");
  return options;
}

function safeName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "target";
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function relativeUrl(fromDirectory, filePath) {
  return path.relative(fromDirectory, filePath)
    .split(path.sep)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function runCommand(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, error: null }));
  });
}

async function runNodeCommand(label, script, args, options = {}) {
  const result = await runCommand(process.execPath, [script, ...args], options);
  if (result.error || result.code !== 0) {
    const streams = [];
    if (result.stderr.trim()) streams.push(`stderr:\n${result.stderr.trim()}`);
    if (result.stdout.trim()) streams.push(`stdout:\n${result.stdout.trim()}`);
    let details = result.error?.message || streams.join("\n") || `exit ${result.code}`;
    if (/sandbox_host_linux|sandbox_host|operation not permitted/i.test(`${result.stderr}\n${result.stdout}`)) {
      details += "\nThe browser was blocked while starting by the execution sandbox; retry this capture with elevated browser permission. This occurs before page navigation.";
    }
    throw new Error(`${label} failed: ${details}`);
  }
  return result;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readReport(captureDir, label) {
  const reportPath = path.join(captureDir, "report.json");
  if (!(await exists(reportPath))) throw new Error(`${label} did not write report.json: ${captureDir}`);
  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`${label} wrote an unreadable report.json: ${error.message}`);
  }
  if (!Array.isArray(report.viewports) || !report.viewports.length) {
    throw new Error(`${label} report has no captured viewports`);
  }
  for (const item of report.viewports) {
    if (!item.screenshot || !(await exists(item.screenshot))) {
      throw new Error(`${label} report is missing a screenshot for viewport ${JSON.stringify(item.viewport)}`);
    }
  }

  const navigationFailures = report.viewports.filter((item) => (
    item.navigationError
    || item.finalUrl === "about:blank"
    || (item.status == null && item.finalUrl)
  ));
  if (navigationFailures.length) {
    const details = navigationFailures.map((item) => {
      const failedRequests = Array.isArray(item.failedRequests) && item.failedRequests.length
        ? `; failed requests: ${item.failedRequests.map(({ url, error }) => `${url} (${error})`).join(", ")}`
        : "";
      return `${JSON.stringify(item.viewport)}: status ${item.status ?? "none"}, final URL ${item.finalUrl || "unknown"}${item.navigationError ? `, navigation error: ${item.navigationError}` : ""}${failedRequests}`;
    }).join("\n");
    let hint = "";
    if (report.options?.browser === "firefox" && report.options?.localMapRequested && !report.options?.localMapApplied) {
      let hostname = null;
      try {
        hostname = new URL(report.url).hostname;
      } catch {
        // The capture script already reported the malformed URL.
      }
      if (hostname === "localhost" || hostname?.endsWith(".test")) {
        hint = " Firefox does not apply Chromium's host mapping; ensure this hostname resolves through the operating system or use Chromium.";
      }
    }
    throw new Error(`${label} could not load the page; refusing to compare an incomplete capture.\n${details}${hint}`);
  }
  const summaryPath = await writeReportSummary(reportPath, report);
  return { report, summaryPath };
}

function cacheBustedUrl(originalUrl, token) {
  const parsed = new URL(originalUrl);
  parsed.searchParams.set("visual_diff_cache_bust", token);
  return parsed.toString();
}

function targetDirectoryName(originalUrl, index) {
  const parsed = new URL(originalUrl);
  const descriptor = `${parsed.hostname}${parsed.port ? `-${parsed.port}` : ""}${parsed.pathname}`;
  return `${String(index + 1).padStart(2, "0")}-${safeName(descriptor)}`;
}

async function capture({
  url,
  phase,
  targetIndex,
  outputDir,
  options,
  token,
  webInspectorDir,
  stateRoot,
}) {
  const captureScript = path.join(webInspectorDir, "scripts", "capture_page.mjs");
  if (!(await exists(captureScript))) {
    throw new Error(`Web Inspector capture script not found: ${captureScript}`);
  }
  const cacheBusted = cacheBustedUrl(url, `${token}-${phase}-${targetIndex + 1}`);
  const profile = `vdf-${token}-${phase[0]}${targetIndex + 1}`;
  const args = [captureScript, cacheBusted, "--browser", options.browser, "--profile", profile, "--output-dir", outputDir];
  for (const viewport of options.viewports) args.push("--viewport", `${viewport.width}x${viewport.height}`);
  if (options.device) args.push("--device", options.device);
  if (options.fullPage) args.push("--full-page");
  args.push("--wait-until", options.waitUntil, "--wait-ms", String(options.waitMs), "--timeout", String(options.timeout));
  if (options.ignoreHttpsErrors) args.push("--ignore-https-errors");
  if (!options.localMap) args.push("--no-local-map");
  if (options.fullText) args.push("--full-text");
  if (options.failOnErrors) args.push("--fail-on-errors");
  for (const action of options.actions) args.push("--action", action);

  await runNodeCommand(`${phase} capture for ${url}`, captureScript, args.slice(1), {
    cwd: webInspectorDir,
    env: { ...process.env, WEB_INSPECTOR_STATE_DIR: stateRoot },
  });
  const { report, summaryPath } = await readReport(outputDir, `${phase} capture for ${url}`);
  return { url, cacheBustedUrl: cacheBusted, profile, outputDir, reportPath: path.join(outputDir, "report.json"), summaryPath };
}

async function restoreCss({ commentScript, statePath }) {
  const result = await runNodeCommand("CSS restoration", commentScript, ["restore", "--state", statePath]);
  return result;
}

async function openViewer(filePath) {
  const absolutePath = path.resolve(filePath);
  const result = await runCommand("open", [absolutePath]);
  if (result.error || result.code !== 0) {
    return `Could not open the HTML viewer automatically: ${result.error?.message || result.stderr.trim() || `exit ${result.code}`}`;
  }
  return null;
}

async function writeRunIndex({ outputDir, targets, settings, cssFile, ranges, cssReferences, resolvedRules, restoration, error, openWarning }) {
  const targetItems = targets.map((target) => {
    const comparisonLink = target.comparisonDir
      ? `<a href="${relativeUrl(outputDir, path.join(target.comparisonDir, "index.html"))}">open comparison</a>`
      : "comparison unavailable";
    const beforeSummaryLink = target.before?.summaryPath
      ? `<a href="${relativeUrl(outputDir, target.before.summaryPath)}">original capture summary</a>`
      : "original summary unavailable";
    const afterSummaryLink = target.after?.summaryPath
      ? `<a href="${relativeUrl(outputDir, target.after.summaryPath)}">changed capture summary</a>`
      : "changed summary unavailable";
    return `<li><strong>${htmlEscape(target.originalUrl)}</strong> — ${comparisonLink} · ${beforeSummaryLink} · ${afterSummaryLink}</li>`;
  }).join("\n");
  const errors = [error, restoration.error, openWarning].filter(Boolean);
  const errorHtml = errors.length
    ? `<div class="errors"><h2>Problems</h2><ul>${errors.map((item) => `<li>${htmlEscape(item)}</li>`).join("")}</ul></div>`
    : "";
  const status = error || restoration.error ? "failed" : "complete";
  const cssReferenceHtml = cssReferences.length
    ? `<p><strong>CSS references:</strong> ${cssReferences.map((reference) => htmlEscape(reference)).join("<br>")}</p>`
    : "";
  const resolvedRulesHtml = resolvedRules.length
    ? `<p><strong>Resolved rules:</strong> ${resolvedRules.map((rule) => htmlEscape(`${rule.startLine}:${rule.endLine} (${rule.prelude})`)).join("<br>")}</p>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Website visual diff run</title>
<style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;line-height:1.5}.errors{border:1px solid #dc2626;padding:1rem;border-radius:.5rem}.meta{background:#f3f4f6;padding:1rem;border-radius:.5rem}a{color:#0369a1}</style></head>
<body><h1>Website visual diff run</h1><p><strong>Status:</strong> ${status}</p>
<div class="meta"><p><strong>CSS file:</strong> ${htmlEscape(cssFile)}</p>${cssReferenceHtml}${resolvedRulesHtml}<p><strong>Ranges:</strong> ${htmlEscape(ranges.join(", "))}</p><p><strong>Viewports:</strong> ${htmlEscape(settings.viewports.map(({ width, height }) => `${width}x${height}`).join(", "))}</p><p><strong>Restored:</strong> ${restoration.restored ? "yes" : "no"}</p></div>
${errorHtml}<h2>Targets</h2><ul>${targetItems}</ul></body></html>\n`;
  const htmlPath = path.join(outputDir, "index.html");
  await fs.writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const outputDir = options.outputDir ?? path.join(os.tmpdir(), "website-visual-diff", token);
  await ensureEmptyDirectory(outputDir, "Artifact directory");
  const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const webInspectorDir = options.webInspectorDir
    ?? process.env.WEB_INSPECTOR_SKILL_DIR
    ?? path.resolve(skillDir, "../web-inspector");
  const commentScript = path.join(skillDir, "scripts", "comment_css.mjs");
  const statePath = path.join(outputDir, `.css-state-${token}.json`);
  const stateRoot = process.env.WEB_INSPECTOR_STATE_DIR
    ? path.resolve(process.env.WEB_INSPECTOR_STATE_DIR)
    : path.join(os.tmpdir(), `website-visual-diff-browser-${token}`);
  const removeStateRoot = !process.env.WEB_INSPECTOR_STATE_DIR;
  let cssFile = options.cssFile ? path.resolve(options.cssFile) : null;
  const resolvedCss = [];
  if (options.cssRefs.length) {
    for (const reference of options.cssRefs) {
      const resolved = await resolveCssReference(reference, { cwd: process.cwd() });
      if (cssFile && cssFile !== resolved.file) {
        throw new Error(`CSS references must target one file; found ${cssFile} and ${resolved.file}`);
      }
      cssFile = resolved.file;
      resolvedCss.push(resolved);
    }
  }
  const cssSpans = resolvedCss.map(({ rule }) => ({ start: rule.startOffset, end: rule.endOffset }));
  const resolvedRanges = resolvedCss.length
    ? resolvedCss.map(({ rule }) => `${rule.startLine}:${rule.endLine}`)
    : options.ranges;
  const targets = options.urls.map((originalUrl, index) => ({
    originalUrl,
    name: targetDirectoryName(originalUrl, index),
    beforeDir: path.join(outputDir, "before", targetDirectoryName(originalUrl, index)),
    afterDir: path.join(outputDir, "after", targetDirectoryName(originalUrl, index)),
    comparisonDir: null,
    before: null,
    after: null,
    comparisonPath: null,
  }));
  const settings = {
    browser: options.browser,
    device: options.device,
    fullPage: options.fullPage,
    viewports: options.viewports,
    waitUntil: options.waitUntil,
    waitMs: options.waitMs,
    timeout: options.timeout,
    fuzz: options.fuzz,
    relocateViewer: options.relocateViewer,
    openViewer: options.openViewer,
    actions: options.actions.map((action) => JSON.parse(action)),
    cacheBustParameter: "visual_diff_cache_bust",
  };
  let failure = null;
  let restoration = { attempted: false, restored: false, error: null };
  let openWarning = null;
  let viewerPath = null;
  let cssDisabled = false;
  let runData = null;

  try {
    for (const target of targets) {
      await fs.mkdir(target.beforeDir, { recursive: true });
      target.before = await capture({
        url: target.originalUrl,
        phase: "before",
        targetIndex: targets.indexOf(target),
        outputDir: target.beforeDir,
        options,
        token,
        webInspectorDir,
        stateRoot,
      });
    }

    const disableArgs = ["disable", "--file", cssFile, "--state", statePath];
    if (cssSpans.length) {
      for (const span of cssSpans) disableArgs.push("--span", `${span.start}:${span.end}`);
    } else {
      for (const range of options.ranges) disableArgs.push("--range", range);
    }
    await runNodeCommand("CSS deactivation", commentScript, disableArgs);
    cssDisabled = true;

    for (const target of targets) {
      await fs.mkdir(target.afterDir, { recursive: true });
      target.after = await capture({
        url: target.originalUrl,
        phase: "after",
        targetIndex: targets.indexOf(target),
        outputDir: target.afterDir,
        options,
        token,
        webInspectorDir,
        stateRoot,
      });
    }

    const compareScript = path.join(skillDir, "scripts", "compare_screenshots.mjs");
    for (const target of targets) {
      target.comparisonDir = path.join(outputDir, "comparison", target.name);
      const compareArgs = ["--before", target.beforeDir, "--after", target.afterDir, "--output-dir", target.comparisonDir, "--fuzz", options.fuzz];
      await runNodeCommand(`Screenshot comparison for ${target.originalUrl}`, compareScript, compareArgs);
      target.comparisonPath = path.join(target.comparisonDir, "visual-diff.json");
    }
  } catch (error) {
    failure = error.message || String(error);
  } finally {
    if (cssDisabled || await exists(statePath)) {
      restoration.attempted = true;
      try {
        await restoreCss({ commentScript, statePath });
        restoration.restored = true;
        cssDisabled = false;
      } catch (error) {
        restoration.error = error.message || String(error);
      }
    }
    if (removeStateRoot) await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    runData = {
      version: 1,
      status: failure || restoration.error ? "failed" : "complete",
      generatedAt: new Date().toISOString(),
      outputDir,
      cssFile,
      ranges: resolvedRanges,
      cssReferences: options.cssRefs,
      resolvedRules: resolvedCss.map(({ rule }) => rule),
      settings,
      targets,
      restoration,
      error: failure,
      viewerPath,
      openWarning,
    };
    await fs.writeFile(path.join(outputDir, "run.json"), `${JSON.stringify(runData, null, 2)}\n`, "utf8");
    const indexPath = await writeRunIndex({
      outputDir,
      targets,
      settings,
      cssFile,
      ranges: resolvedRanges,
      cssReferences: options.cssRefs,
      resolvedRules: resolvedCss.map(({ rule }) => rule),
      restoration,
      error: failure,
      openWarning: null,
    });
    if (options.openViewer) {
      try {
        const viewer = await prepareBrowserViewer({
          sourceDirectory: outputDir,
          indexPath,
          token,
          relocate: options.relocateViewer,
        });
        viewerPath = viewer.indexPath;
        openWarning = await openViewer(viewer.indexPath);
      } catch (error) {
        openWarning = `Could not prepare the relocated HTML viewer: ${error.message}`;
      }
    }
    runData.viewerPath = viewerPath;
    runData.openWarning = openWarning;
    await fs.writeFile(path.join(outputDir, "run.json"), `${JSON.stringify(runData, null, 2)}\n`, "utf8");
    if (viewerPath && path.dirname(viewerPath) !== outputDir) {
      await fs.writeFile(path.join(path.dirname(viewerPath), "run.json"), `${JSON.stringify(runData, null, 2)}\n`, "utf8");
    }
    if (openWarning) console.error(openWarning);
  }

  const finalData = runData ?? JSON.parse(await fs.readFile(path.join(outputDir, "run.json"), "utf8"));
  if (failure || restoration.error) {
    console.error(JSON.stringify({ ...finalData, outputDir }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ...finalData, outputDir }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
