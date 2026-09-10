#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  node scripts/compare_screenshots.mjs --before <dir> --after <dir> --output-dir <dir> [options]

Options:
  --fuzz <percent>  Ignore pixel differences within an ImageMagick fuzz threshold (default: 0%)
  --open            Open the generated HTML viewer when a graphical session is available
  --help            Show this help
`);
  process.exit(message ? 2 : 0);
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
    before: null,
    after: null,
    outputDir: path.join(
      os.tmpdir(),
      "website-visual-diff",
      new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
    ),
    fuzz: "0%",
    open: false,
  };
  const valueOptions = new Set(["before", "after", "output-dir", "fuzz"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) usage(`Unexpected argument "${arg}"`);
    const key = arg.slice(2);
    if (key === "open") {
      options.open = true;
      continue;
    }
    if (!valueOptions.has(key)) usage(`Unknown option "${arg}"`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) usage(`Missing value for ${arg}`);
    index += 1;
    if (key === "before") options.before = path.resolve(value);
    else if (key === "after") options.after = path.resolve(value);
    else if (key === "output-dir") options.outputDir = path.resolve(value);
    else if (key === "fuzz") options.fuzz = parseFuzz(value);
  }
  if (!options.before) usage("--before is required");
  if (!options.after) usage("--after is required");
  return options;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(filePath) {
  if (!(await fileExists(filePath))) return null;
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function safeName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "screenshot";
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

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, error: null }));
  });
}

async function resolveScreenshots(directory) {
  const absoluteDirectory = path.resolve(directory);
  const reportPath = path.join(absoluteDirectory, "report.json");
  const warnings = [];
  let report = null;
  try {
    report = await readJsonIfPresent(reportPath);
  } catch (error) {
    warnings.push(`Could not read ${reportPath}: ${error.message}`);
  }

  const files = new Map();
  if (report?.viewports && Array.isArray(report.viewports)) {
    for (const item of report.viewports) {
      if (!item?.screenshot) continue;
      const screenshot = path.resolve(item.screenshot);
      if (!(await fileExists(screenshot))) {
        warnings.push(`Screenshot recorded in ${reportPath} is missing: ${screenshot}`);
        continue;
      }
      files.set(path.basename(screenshot), screenshot);
    }
  } else {
    let entries = [];
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Could not read screenshot directory ${absoluteDirectory}: ${error.message}`, { cause: error });
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
        files.set(entry.name, path.join(absoluteDirectory, entry.name));
      }
    }
  }

  return {
    directory: absoluteDirectory,
    reportPath: (await fileExists(reportPath)) ? reportPath : null,
    report,
    files,
    warnings,
  };
}

function parseDimensions(output, filePath) {
  const match = /^(\d+)\s+(\d+)/.exec(output.trim());
  if (!match) throw new Error(`Could not read image dimensions for ${filePath}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function imageDimensions(filePath) {
  const result = await runCommand("identify", ["-format", "%w %h", filePath]);
  if (result.error || result.code !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `identify failed for ${filePath}`);
  }
  return parseDimensions(result.stdout, filePath);
}

async function padImage(filePath, dimensions, outputPath) {
  const result = await runCommand("convert", [
    filePath,
    "-background", "#ffffff",
    "-gravity", "northwest",
    "-extent", `${dimensions.width}x${dimensions.height}`,
    outputPath,
  ]);
  if (result.error || result.code !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `convert failed for ${filePath}`);
  }
  return outputPath;
}

async function createPixelDiff(beforePath, afterPath, diffPath, fuzz) {
  const result = await runCommand("compare", [
    "-metric", "AE",
    "-fuzz", fuzz,
    "-highlight-color", "#ff00ff",
    "-lowlight-color", "#ffffff",
    beforePath,
    afterPath,
    diffPath,
  ]);
  if (result.error || (result.code !== 0 && result.code !== 1)) {
    throw new Error(result.error?.message || result.stderr.trim() || "compare failed");
  }
  const metricMatch = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/m.exec(result.stderr);
  return {
    changedPixels: metricMatch ? Number(metricMatch[1]) : null,
    metricOutput: result.stderr.trim(),
  };
}

async function createSideBySide(images, outputPath) {
  const result = await runCommand("montage", [
    ...images,
    "-tile", `${images.length}x1`,
    "-geometry", "+0+0",
    outputPath,
  ]);
  if (result.error || result.code !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || "montage failed");
  }
  return outputPath;
}

async function comparePair({ name, beforePath, afterPath, outputDir, fuzz }) {
  const pairDir = path.join(outputDir, "pairs", safeName(name.replace(/\.png$/i, "")));
  await fs.mkdir(pairDir, { recursive: true });
  const warnings = [];
  const dimensions = { before: null, after: null, canvas: null };
  let beforeForComparison = beforePath;
  let afterForComparison = afterPath;
  let diffPath = null;
  let sideBySidePath = null;
  let changedPixels = null;
  let metricOutput = null;

  try {
    dimensions.before = await imageDimensions(beforePath);
    dimensions.after = await imageDimensions(afterPath);
    dimensions.canvas = {
      width: Math.max(dimensions.before.width, dimensions.after.width),
      height: Math.max(dimensions.before.height, dimensions.after.height),
    };
    if (dimensions.before.width !== dimensions.canvas.width || dimensions.before.height !== dimensions.canvas.height) {
      beforeForComparison = await padImage(beforePath, dimensions.canvas, path.join(pairDir, "before-canvas.png"));
    }
    if (dimensions.after.width !== dimensions.canvas.width || dimensions.after.height !== dimensions.canvas.height) {
      afterForComparison = await padImage(afterPath, dimensions.canvas, path.join(pairDir, "after-canvas.png"));
    }
  } catch (error) {
    warnings.push(`Could not normalize image dimensions: ${error.message}`);
  }

  try {
    diffPath = path.join(pairDir, "diff.png");
    const result = await createPixelDiff(beforeForComparison, afterForComparison, diffPath, fuzz);
    changedPixels = result.changedPixels;
    metricOutput = result.metricOutput;
  } catch (error) {
    diffPath = null;
    warnings.push(`Pixel diff unavailable: ${error.message}`);
  }

  try {
    const images = [beforeForComparison, afterForComparison];
    if (diffPath) images.push(diffPath);
    sideBySidePath = await createSideBySide(images, path.join(pairDir, "side-by-side.png"));
  } catch (error) {
    sideBySidePath = null;
    warnings.push(`Side-by-side image unavailable: ${error.message}`);
  }

  const pixelCount = dimensions.canvas
    ? dimensions.canvas.width * dimensions.canvas.height
    : null;
  return {
    name,
    beforePath,
    afterPath,
    pairDir,
    dimensions,
    dimensionMismatch: Boolean(
      dimensions.before && dimensions.after
      && (dimensions.before.width !== dimensions.after.width || dimensions.before.height !== dimensions.after.height),
    ),
    changedPixels,
    changedPercent: changedPixels != null && pixelCount ? (changedPixels / pixelCount) * 100 : null,
    metricOutput,
    diffPath,
    sideBySidePath,
    warnings,
  };
}

function renderPair(pair, outputDir) {
  const before = relativeUrl(outputDir, pair.beforePath);
  const after = relativeUrl(outputDir, pair.afterPath);
  const diff = pair.diffPath ? relativeUrl(outputDir, pair.diffPath) : null;
  const sideBySide = pair.sideBySidePath ? relativeUrl(outputDir, pair.sideBySidePath) : null;
  const changed = pair.changedPixels == null
    ? "not measured"
    : `${pair.changedPixels.toLocaleString()} pixels (${pair.changedPercent.toFixed(3)}% of the comparison canvas)`;
  const warnings = pair.warnings.length
    ? `<ul class="warnings">${pair.warnings.map((warning) => `<li>${htmlEscape(warning)}</li>`).join("")}</ul>`
    : "";
  return `<section class="pair">
  <h2>${htmlEscape(pair.name)}</h2>
  <p><strong>Changed pixels:</strong> ${htmlEscape(changed)}${pair.dimensionMismatch ? " · image dimensions differ and were padded to a common canvas" : ""}</p>
  ${warnings}
  ${sideBySide ? `<figure class="wide"><figcaption>Original · changed · pixel diff</figcaption><a href="${sideBySide}"><img src="${sideBySide}" alt="Original, changed, and pixel diff side by side"></a></figure>` : ""}
  <div class="grid">
    <figure><figcaption>Original</figcaption><a href="${before}"><img src="${before}" alt="Original screenshot"></a></figure>
    <figure><figcaption>Changed</figcaption><a href="${after}"><img src="${after}" alt="Changed screenshot"></a></figure>
    ${diff ? `<figure><figcaption>Pixel diff</figcaption><a href="${diff}"><img src="${diff}" alt="Pixel differences highlighted in magenta"></a></figure>` : ""}
  </div>
</section>`;
}

function renderHtml({ beforeInfo, afterInfo, pairs, warnings, outputDir, options }) {
  const reportLinks = [];
  if (beforeInfo.reportPath) reportLinks.push(`<a href="${relativeUrl(outputDir, beforeInfo.reportPath)}">original report.json</a>`);
  if (afterInfo.reportPath) reportLinks.push(`<a href="${relativeUrl(outputDir, afterInfo.reportPath)}">changed report.json</a>`);
  const missingBefore = [...afterInfo.files.keys()].filter((name) => !beforeInfo.files.has(name));
  const missingAfter = [...beforeInfo.files.keys()].filter((name) => !afterInfo.files.has(name));
  const allWarnings = [
    ...warnings,
    ...beforeInfo.warnings,
    ...afterInfo.warnings,
    ...(missingBefore.length ? [`Missing from original capture: ${missingBefore.join(", ")}`] : []),
    ...(missingAfter.length ? [`Missing from changed capture: ${missingAfter.join(", ")}`] : []),
  ];
  const warningHtml = allWarnings.length
    ? `<div class="warning-box"><h2>Warnings</h2><ul>${allWarnings.map((warning) => `<li>${htmlEscape(warning)}</li>`).join("")}</ul></div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Website visual diff</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 2rem; background: Canvas; color: CanvasText; }
    main { max-width: 1800px; margin: 0 auto; }
    h1 { margin-top: 0; }
    .meta, .warning-box { padding: 1rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: .5rem; }
    .warning-box { border-color: #d97706; }
    .pair { margin-top: 2rem; padding-top: 1rem; border-top: 2px solid color-mix(in srgb, CanvasText 25%, transparent); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; align-items: start; }
    figure { margin: 0; }
    figure.wide { margin: 1rem 0; }
    figcaption { font-weight: 700; margin: .4rem 0; }
    img { display: block; max-width: 100%; height: auto; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: white; }
    a { color: LinkText; }
    .warnings { color: #d97706; }
  </style>
</head>
<body>
<main>
  <h1>Website visual diff</h1>
  <div class="meta">
    <p><strong>Original:</strong> ${htmlEscape(beforeInfo.directory)}</p>
    <p><strong>Changed:</strong> ${htmlEscape(afterInfo.directory)}</p>
    <p><strong>ImageMagick fuzz:</strong> ${htmlEscape(options.fuzz)}</p>
    <p>${reportLinks.join(" · ") || "No report.json files were present; PNGs were paired by filename."}</p>
  </div>
  ${warningHtml}
  ${pairs.map((pair) => renderPair(pair, outputDir)).join("\n")}
</main>
</body>
</html>
`;
}

async function maybeOpen(filePath) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "No graphical session detected; open the HTML viewer manually.";
  }
  const result = await runCommand("open", [path.resolve(filePath)]);
  if (result.error || result.code !== 0) {
    return `Could not open the HTML viewer automatically: ${result.error?.message || result.stderr.trim() || `exit ${result.code}`}`;
  }
  return null;
}

export async function compareDirectories(options) {
  const beforeInfo = await resolveScreenshots(options.before);
  const afterInfo = await resolveScreenshots(options.after);
  const outputDir = path.resolve(options.outputDir);
  if (outputDir === beforeInfo.directory || outputDir === afterInfo.directory) {
    throw new Error("--output-dir must be different from both screenshot directories");
  }
  await fs.mkdir(outputDir, { recursive: true });

  const names = [...beforeInfo.files.keys()]
    .filter((name) => afterInfo.files.has(name))
    .sort((left, right) => left.localeCompare(right));
  const missingBefore = [...afterInfo.files.keys()].filter((name) => !beforeInfo.files.has(name));
  const missingAfter = [...beforeInfo.files.keys()].filter((name) => !afterInfo.files.has(name));
  if (!names.length) {
    throw new Error(`No matching PNG screenshots found in ${beforeInfo.directory} and ${afterInfo.directory}`);
  }

  const pairs = [];
  for (const name of names) {
    pairs.push(await comparePair({
      name,
      beforePath: beforeInfo.files.get(name),
      afterPath: afterInfo.files.get(name),
      outputDir,
      fuzz: options.fuzz,
    }));
  }

  const warnings = [];
  if (beforeInfo.files.size !== afterInfo.files.size) {
    warnings.push(`Capture file counts differ: original ${beforeInfo.files.size}, changed ${afterInfo.files.size}`);
  }
  if (missingBefore.length) warnings.push(`Missing from original capture: ${missingBefore.join(", ")}`);
  if (missingAfter.length) warnings.push(`Missing from changed capture: ${missingAfter.join(", ")}`);
  const summary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    before: { directory: beforeInfo.directory, report: beforeInfo.reportPath },
    after: { directory: afterInfo.directory, report: afterInfo.reportPath },
    options: { fuzz: options.fuzz },
    missingBefore,
    missingAfter,
    pairs,
    warnings: [
      ...warnings,
      ...beforeInfo.warnings,
      ...afterInfo.warnings,
      ...pairs.flatMap((pair) => pair.warnings),
    ],
  };
  const summaryPath = path.join(outputDir, "visual-diff.json");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const htmlPath = path.join(outputDir, "index.html");
  await fs.writeFile(htmlPath, renderHtml({ beforeInfo, afterInfo, pairs, warnings, outputDir, options }), "utf8");

  if (options.open) {
    const openWarning = await maybeOpen(htmlPath);
    if (openWarning) summary.warnings.push(openWarning);
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  return { ...summary, summaryPath, htmlPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await compareDirectories(options);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
