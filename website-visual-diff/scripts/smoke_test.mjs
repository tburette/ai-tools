#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

async function runNode(script, args) {
  const result = await run(process.execPath, [script, ...args], { cwd: skillDir });
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
