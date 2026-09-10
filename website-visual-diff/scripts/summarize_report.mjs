#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: node scripts/summarize_report.mjs <report.json> [--output <summary.txt>]");
  process.exit(message ? 2 : 0);
}

function numberOrUnknown(value) {
  return Number.isFinite(value) ? String(value) : "unknown";
}

function formatImageSummary(item) {
  const images = Array.isArray(item.domSummary?.images) ? item.domSummary.images : [];
  if (!images.length) return "none recorded";
  const loaded = images.filter((image) => image.complete && Number(image.naturalWidth) > 0).length;
  const failed = images.length - loaded;
  return `${loaded}/${images.length} loaded${failed ? `; ${failed} incomplete or empty` : ""}`;
}

function formatConsoleSummary(item) {
  const consoleEntries = Array.isArray(item.console) ? item.console : [];
  const errors = consoleEntries.filter(({ type }) => type === "error").length;
  const warnings = consoleEntries.filter(({ type }) => type === "warning").length;
  return `${errors} error(s), ${warnings} warning(s)`;
}

function formatActionSummary(item) {
  const actions = Array.isArray(item.actionResults) ? item.actionResults : [];
  const failures = actions.filter((action) => action.error).length;
  return `${actions.length} action(s), ${failures} failed`;
}

function appendDetails(lines, label, values) {
  if (!Array.isArray(values) || !values.length) return;
  lines.push(`  ${label}:`);
  for (const value of values) {
    if (typeof value === "string") lines.push(`    - ${value}`);
    else if (value && typeof value === "object") {
      const details = [value.url, value.error, value.status].filter((part) => part != null).join(" — ");
      lines.push(`    - ${details || JSON.stringify(value)}`);
    }
  }
}

export function renderReportSummary(report) {
  const viewports = Array.isArray(report.viewports) ? report.viewports : [];
  const lines = [
    "Web Inspector capture summary",
    `URL: ${report.url || "unknown"}`,
    `Browser: ${report.options?.browser || "unknown"}`,
    `Capture started: ${report.startedAt || "unknown"}`,
    `Capture finished: ${report.finishedAt || "unknown"}`,
    `Viewports: ${viewports.length}`,
    "",
  ];

  for (const [index, item] of viewports.entries()) {
    const viewport = item.viewport ? `${item.viewport.width}x${item.viewport.height}` : "unknown";
    const documentWidth = numberOrUnknown(item.domSummary?.documentWidth);
    const documentHeight = numberOrUnknown(item.domSummary?.documentHeight);
    lines.push(`Viewport ${index + 1}: ${viewport}`);
    lines.push(`  status: ${item.status ?? "none"}`);
    lines.push(`  final URL: ${item.finalUrl || "unknown"}`);
    lines.push(`  screenshot: ${item.screenshot || "missing"}`);
    lines.push(`  document: ${documentWidth}x${documentHeight}`);
    lines.push(`  images: ${formatImageSummary(item)}`);
    lines.push(`  console: ${formatConsoleSummary(item)}`);
    lines.push(`  actions: ${formatActionSummary(item)}`);
    lines.push(`  failed requests: ${Array.isArray(item.failedRequests) ? item.failedRequests.length : 0}`);
    lines.push(`  failed responses: ${Array.isArray(item.failedResponses) ? item.failedResponses.length : 0}`);
    lines.push(`  page errors: ${Array.isArray(item.pageErrors) ? item.pageErrors.length : 0}`);
    if (item.navigationError) lines.push(`  navigation error: ${item.navigationError}`);
    appendDetails(lines, "failed request details", item.failedRequests);
    appendDetails(lines, "failed response details", item.failedResponses);
    appendDetails(lines, "page error details", item.pageErrors);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeReportSummary(reportPath, report = null, outputPath = null) {
  const absoluteReportPath = path.resolve(reportPath);
  const source = report ?? JSON.parse(await fs.readFile(absoluteReportPath, "utf8"));
  const summaryPath = path.resolve(outputPath || path.join(path.dirname(absoluteReportPath), "capture-summary.txt"));
  await fs.writeFile(summaryPath, renderReportSummary(source), "utf8");
  return summaryPath;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) usage(args.length ? null : "A report path is required");
  const reportPath = args.shift();
  let outputPath = null;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--output") usage("Expected --output <summary.txt>");
    outputPath = args[1];
  }
  const summaryPath = await writeReportSummary(reportPath, null, outputPath);
  console.log(summaryPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
