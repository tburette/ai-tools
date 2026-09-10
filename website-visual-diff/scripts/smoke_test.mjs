#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCssReference } from "./resolve_css.mjs";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(skillDir, "scripts");

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, error: null }));
  });
}

async function commandAvailable(command) {
  const result = await run(command, ["-version"]);
  return !result.error && result.code === 0;
}

async function runNode(script, args, options = {}) {
  const result = await run(process.execPath, [script, ...args], { cwd: skillDir, ...options });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "website-visual-diff-smoke-"));
try {
  const cssFile = path.join(root, "theme.css");
  const stateFile = path.join(root, "css-state.json");
  const originalCss = ":root {\n  --brand: red;\n}\n\n.card {\n  display: block;\n}\n";
  await fs.writeFile(cssFile, originalCss, "utf8");

  await runNode(path.join(scriptsDir, "comment_css.mjs"), [
    "disable", "--file", cssFile, "--range", "1:3", "--range", "5:7", "--state", stateFile,
  ]);
  const changedCss = await fs.readFile(cssFile, "utf8");
  assert.notEqual(changedCss, originalCss);
  assert.match(changedCss, /website-visual-diff: disabled 1:3/);
  assert.match(changedCss, /website-visual-diff: disabled 5:7/);
  assert.equal(await fs.access(stateFile).then(() => true).catch(() => false), true);

  await runNode(path.join(scriptsDir, "comment_css.mjs"), ["restore", "--state", stateFile]);
  assert.equal(await fs.readFile(cssFile, "utf8"), originalCss);
  assert.equal(await fs.access(stateFile).then(() => true).catch(() => false), false);

  const escapedComma = String.fromCharCode(92);
  const complexCss = [
    "/* header { not a block } */",
    "",
    "@media (min-width: 1px) {",
    "  .alpha,",
    "  .beta" + escapedComma + ",part,",
    "  .gamma {",
    "    /* existing comment */",
    "    content: \"}\";",
    "  }",
    "}",
    "",
    ".same-line { color: blue; }",
  ].join("\n") + "\n";
  await fs.writeFile(cssFile, complexCss, "utf8");
  const cssReference = `${cssFile}:5 (.beta) [symbol-range=4-6]`;
  const resolved = await resolveCssReference(cssReference);
  assert.equal(resolved.rule.startLine, 4);
  assert.equal(resolved.rule.endLine, 9);
  assert.equal(resolved.rule.prelude.includes(".beta" + escapedComma + ",part"), true);

  const spanStateFile = path.join(root, "span-state.json");
  await runNode(path.join(scriptsDir, "comment_css.mjs"), [
    "disable", "--file", cssFile, "--span", `${resolved.rule.startOffset}:${resolved.rule.endOffset}`, "--state", spanStateFile,
  ]);
  const spanDisabledCss = await fs.readFile(cssFile, "utf8");
  assert.match(spanDisabledCss, /website-visual-diff: disabled span/);
  assert.doesNotMatch(spanDisabledCss, /existing comment/);
  await runNode(path.join(scriptsDir, "comment_css.mjs"), ["restore", "--state", spanStateFile]);
  assert.equal(await fs.readFile(cssFile, "utf8"), complexCss);

  const fakeInspectorDir = path.join(root, "fake-web-inspector");
  await fs.mkdir(path.join(fakeInspectorDir, "scripts"), { recursive: true });
  const fakeCaptureScript = [
    'import fs from "node:fs/promises";',
    'import path from "node:path";',
    'const args = process.argv.slice(2);',
    'const valueFor = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };',
    'const url = args[0];',
    'const outputDir = path.resolve(valueFor("--output-dir"));',
    'const profile = valueFor("--profile");',
    'const phase = new URL(url).searchParams.get("visual_diff_cache_bust").includes("-before-") ? "before" : "after";',
    'const screenshot = path.join(outputDir, "32x32.png");',
    'const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");',
    'await fs.mkdir(outputDir, { recursive: true });',
    'await fs.writeFile(screenshot, png);',
    'await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify({ url, viewports: [{ screenshot, viewport: { width: 32, height: 32 } }] }) + "\\n");',
    'if (process.env.WVD_CAPTURE_LOG) await fs.appendFile(process.env.WVD_CAPTURE_LOG, JSON.stringify({ url, profile, phase }) + "\\n");',
  ].join("\n");
  await fs.writeFile(path.join(fakeInspectorDir, "scripts", "capture_page.mjs"), fakeCaptureScript, "utf8");
  const runnerOutput = path.join(root, "runner-output");
  const captureLog = path.join(root, "capture-log.jsonl");
  await runNode(path.join(scriptsDir, "run_visual_diff.mjs"), [
    "http://example.test/",
    "--css-ref", cssReference,
    "--web-inspector-dir", fakeInspectorDir,
    "--output-dir", runnerOutput,
    "--viewport", "32x32",
  ], { env: { ...process.env, WVD_CAPTURE_LOG: captureLog } });
  const runData = JSON.parse(await fs.readFile(path.join(runnerOutput, "run.json"), "utf8"));
  assert.equal(runData.status, "complete");
  assert.deepEqual(runData.ranges, ["4:9"]);
  assert.equal(runData.resolvedRules[0].prelude.includes(".beta" + escapedComma + ",part"), true);
  assert.equal(runData.restoration.restored, true);
  assert.equal(await fs.readFile(cssFile, "utf8"), complexCss);
  const outputEntries = await fs.readdir(runnerOutput);
  assert.equal(outputEntries.some((entry) => entry.startsWith(".css-state-")), false);
  assert.equal(await fs.access(path.join(runnerOutput, "comparison", "01-example.test", "index.html")).then(() => true).catch(() => false), true);
  const captureRecords = (await fs.readFile(captureLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(captureRecords.length, 2);
  assert.notEqual(captureRecords[0].url, captureRecords[1].url);
  assert.match(captureRecords[0].url, /visual_diff_cache_bust=/);
  assert.notEqual(captureRecords[0].profile, captureRecords[1].profile);

  const imageToolsAvailable = await Promise.all(["convert", "identify", "compare", "montage"].map(commandAvailable));
  if (imageToolsAvailable.every(Boolean)) {
    const beforeDir = path.join(root, "before");
    const afterDir = path.join(root, "after");
    const comparisonDir = path.join(root, "comparison");
    await fs.mkdir(beforeDir);
    await fs.mkdir(afterDir);
    const beforeImage = path.join(beforeDir, "1440x1100-full.png");
    const afterImage = path.join(afterDir, "1440x1100-full.png");
    let result = await run("convert", ["-size", "64x32", "xc:#ffffff", beforeImage]);
    assert.equal(result.code, 0, result.stderr);
    result = await run("convert", ["-size", "64x32", "xc:#ffffff", "-fill", "#ef3d2f", "-draw", "rectangle 12,8 40,24", afterImage]);
    assert.equal(result.code, 0, result.stderr);
    const report = (screenshot) => ({ viewports: [{ screenshot, viewport: { width: 1440, height: 1100 } }] });
    await fs.writeFile(path.join(beforeDir, "report.json"), `${JSON.stringify(report(beforeImage))}\n`, "utf8");
    await fs.writeFile(path.join(afterDir, "report.json"), `${JSON.stringify(report(afterImage))}\n`, "utf8");

    await runNode(path.join(scriptsDir, "compare_screenshots.mjs"), [
      "--before", beforeDir, "--after", afterDir, "--output-dir", comparisonDir,
    ]);
    const summary = JSON.parse(await fs.readFile(path.join(comparisonDir, "visual-diff.json"), "utf8"));
    assert.equal(summary.pairs.length, 1);
    assert.ok(summary.pairs[0].changedPixels > 0);
    assert.equal(await fs.access(path.join(comparisonDir, "index.html")).then(() => true).catch(() => false), true);
    assert.equal(await fs.access(path.join(comparisonDir, "pairs", "1440x1100-full", "diff.png")).then(() => true).catch(() => false), true);
    assert.equal(await fs.access(path.join(comparisonDir, "pairs", "1440x1100-full", "side-by-side.png")).then(() => true).catch(() => false), true);
  } else {
    console.log("ImageMagick not available; skipped PNG metric smoke check.");
  }

  console.log(JSON.stringify({ status: "passed", root, imageToolsAvailable }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
