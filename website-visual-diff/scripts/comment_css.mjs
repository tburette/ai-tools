#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  node scripts/comment_css.mjs disable --file <path> --range <start:end> [--range <start:end> ...] --state <path>
  node scripts/comment_css.mjs restore --state <path>

Ranges are one-based and inclusive. The helper refuses ranges containing an
existing CSS block comment, because CSS comments cannot be nested.
`);
  process.exit(message ? 2 : 0);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function parseRange(value) {
  const match = /^(\d+):(\d+)$/.exec(String(value ?? ""));
  if (!match) throw new Error(`Invalid range "${value}"; expected start:end`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end < start) throw new Error(`Invalid range "${value}"`);
  return { start, end };
}

function parseArgs(argv) {
  const command = argv[0];
  if (command === "--help" || command === "-h") usage();
  if (!["disable", "restore"].includes(command)) {
    usage(`Expected "disable" or "restore", got "${command ?? ""}"`);
  }

  const options = { command, file: null, ranges: [], state: null };
  const valueOptions = new Set(["file", "range", "state"]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) usage(`Unexpected argument "${arg}"`);
    const key = arg.slice(2);
    if (!valueOptions.has(key)) usage(`Unknown option "${arg}"`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) usage(`Missing value for ${arg}`);
    index += 1;
    if (key === "file") options.file = path.resolve(value);
    else if (key === "range") options.ranges.push(parseRange(value));
    else if (key === "state") options.state = path.resolve(value);
  }

  if (!options.state) usage("--state is required");
  if (command === "disable") {
    if (!options.file) usage("disable requires --file");
    if (!options.ranges.length) usage("disable requires at least one --range");
  }
  return options;
}

async function writeAtomically(filePath, contents) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, contents, "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function ensureRegularFile(filePath) {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink()) throw new Error(`Refusing to edit symlinked CSS file: ${filePath}`);
  if (!stats.isFile()) throw new Error(`CSS target is not a regular file: ${filePath}`);
}

function validateRanges(ranges, lineCount) {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  for (let index = 0; index < sorted.length; index += 1) {
    const range = sorted[index];
    if (range.end > lineCount) {
      throw new Error(`Range ${range.start}:${range.end} exceeds the file's ${lineCount} lines`);
    }
    if (index > 0 && range.start <= sorted[index - 1].end) {
      throw new Error(`CSS ranges overlap at ${range.start}:${range.end}`);
    }
  }
  return sorted;
}

async function disable(options) {
  const filePath = path.resolve(options.file);
  const statePath = path.resolve(options.state);
  await ensureRegularFile(filePath);
  const originalText = await fs.readFile(filePath, "utf8");
  if (originalText.includes("/* website-visual-diff: disabled")) {
    throw new Error(`The CSS file already contains a website-visual-diff marker: ${filePath}`);
  }

  const newline = originalText.includes("\r\n") ? "\r\n" : "\n";
  const lines = originalText.split(newline);
  const lineCount = originalText.endsWith(newline) ? lines.length - 1 : lines.length;
  const ranges = validateRanges(options.ranges, lineCount);
  const replacements = [];

  for (const range of ranges) {
    const selectedLines = lines.slice(range.start - 1, range.end);
    const selectedText = selectedLines.join(newline);
    if (!selectedText.trim()) {
      throw new Error(`Range ${range.start}:${range.end} contains no CSS text`);
    }
    if (selectedText.includes("/*") || selectedText.includes("*/")) {
      throw new Error(
        `Range ${range.start}:${range.end} contains an existing CSS block comment; select a narrower range`,
      );
    }
    const replacement = [
      `/* website-visual-diff: disabled ${range.start}:${range.end} */`,
      selectedText,
      "/* website-visual-diff: end */",
    ].join(newline);
    replacements.push({ range, replacement });
  }

  const modifiedLines = [...lines];
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const { range, replacement } = replacements[index];
    modifiedLines.splice(
      range.start - 1,
      range.end - range.start + 1,
      ...replacement.split(newline),
    );
  }
  const modifiedText = modifiedLines.join(newline);
  const state = {
    version: 1,
    file: filePath,
    originalSha256: sha256(originalText),
    modifiedSha256: sha256(modifiedText),
    originalText,
    ranges,
    createdAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  try {
    await writeAtomically(filePath, modifiedText);
    try {
      await writeAtomically(statePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch (stateError) {
      await writeAtomically(filePath, originalText).catch(() => {});
      throw new Error(`CSS was restored after the state file failed to write: ${stateError.message}`, { cause: stateError });
    }
  } catch (error) {
    throw new Error(`Could not deactivate CSS in ${filePath}: ${error.message}`, { cause: error });
  }

  console.log(JSON.stringify({
    action: "disabled",
    file: filePath,
    state: statePath,
    ranges,
    originalSha256: state.originalSha256,
    modifiedSha256: state.modifiedSha256,
  }, null, 2));
}

async function restore(options) {
  const statePath = path.resolve(options.state);
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (state?.version !== 1 || typeof state.file !== "string" || typeof state.originalText !== "string") {
    throw new Error(`Unsupported or incomplete CSS state file: ${statePath}`);
  }
  const filePath = path.resolve(options.file ?? state.file);
  if (filePath !== path.resolve(state.file)) {
    throw new Error(`--file does not match the state file target: ${filePath}`);
  }
  await ensureRegularFile(filePath);
  const currentText = await fs.readFile(filePath, "utf8");
  const currentSha256 = sha256(currentText);
  if (currentSha256 !== state.modifiedSha256) {
    throw new Error(
      `Refusing to restore ${filePath}: it no longer matches the expected modified content `
      + `(expected ${state.modifiedSha256}, found ${currentSha256})`,
    );
  }
  await writeAtomically(filePath, state.originalText);
  await fs.rm(statePath, { force: true });
  console.log(JSON.stringify({
    action: "restored",
    file: filePath,
    state: statePath,
    originalSha256: state.originalSha256,
  }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "disable") await disable(options);
  else await restore(options);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
