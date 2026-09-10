#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  node scripts/comment_css.mjs disable --file <path> --range <start:end> [--range <start:end> ...] --state <path>
  node scripts/comment_css.mjs disable --file <path> --span <start:end> [--span <start:end> ...] --state <path>
  node scripts/comment_css.mjs restore --state <path>

Ranges are one-based and inclusive. Spans are zero-based character offsets
with an exclusive end. Spans are replaced by CSS comment sentinels, so the
selected rule may contain existing CSS comments.
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

function parseSpan(value) {
  const match = /^(\d+):(\d+)$/.exec(String(value ?? ""));
  if (!match) throw new Error(`Invalid span "${value}"; expected start:end`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end <= start) throw new Error(`Invalid span "${value}"; end must be greater than start`);
  return { start, end };
}

function parseArgs(argv) {
  const command = argv[0];
  if (command === "--help" || command === "-h") usage();
  if (!["disable", "restore"].includes(command)) {
    usage(`Expected "disable" or "restore", got "${command ?? ""}"`);
  }

  const options = { command, file: null, ranges: [], spans: [], state: null };
  const valueOptions = new Set(["file", "range", "span", "state"]);
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
    else if (key === "span") options.spans.push(parseSpan(value));
    else if (key === "state") options.state = path.resolve(value);
  }

  if (!options.state) usage("--state is required");
  if (command === "disable") {
    if (!options.file) usage("disable requires --file");
    if (options.ranges.length && options.spans.length) usage("disable accepts either --range or --span, not both");
    if (!options.ranges.length && !options.spans.length) usage("disable requires at least one --range or --span");
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

function lineStarts(text) {
  const starts = [0];
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === "\n") starts.push(offset + 1);
  }
  return starts;
}

function lineForOffset(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return high + 1;
}

function validateSpans(spans, textLength) {
  const sorted = [...spans].sort((left, right) => left.start - right.start);
  for (let index = 0; index < sorted.length; index += 1) {
    const span = sorted[index];
    if (span.start < 0 || span.end > textLength) {
      throw new Error(`CSS span ${span.start}:${span.end} is outside the file (${textLength} characters)`);
    }
    if (index > 0 && span.start < sorted[index - 1].end) {
      throw new Error(`CSS spans overlap at ${span.start}:${span.end}`);
    }
  }
  return sorted;
}

async function disableSpans(options) {
  const filePath = path.resolve(options.file);
  const statePath = path.resolve(options.state);
  await ensureRegularFile(filePath);
  const originalText = await fs.readFile(filePath, "utf8");
  if (originalText.includes("/* website-visual-diff: disabled")) {
    throw new Error(`The CSS file already contains a website-visual-diff marker: ${filePath}`);
  }

  const starts = lineStarts(originalText);
  const spans = validateSpans(
    options.spans.map((span) => ({ ...span, kind: "span", label: `span ${span.start}:${span.end}` })),
    originalText.length,
  );
  const replacements = [];
  for (const span of spans) {
    const selectedText = originalText.slice(span.start, span.end);
    if (!selectedText.trim()) {
      throw new Error(`CSS span ${span.label} contains no CSS text`);
    }
    replacements.push({
      span,
      replacement: `/* website-visual-diff: disabled ${span.label} */`,
    });
  }

  let modifiedText = originalText;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const { span, replacement } = replacements[index];
    modifiedText = modifiedText.slice(0, span.start) + replacement + modifiedText.slice(span.end);
  }
  const state = {
    version: 2,
    file: filePath,
    originalSha256: sha256(originalText),
    modifiedSha256: sha256(modifiedText),
    originalText,
    spans: spans.map(({ start, end, kind, label }) => ({
      start,
      end,
      kind,
      label,
      startLine: lineForOffset(starts, start),
      endLine: lineForOffset(starts, Math.max(start, end - 1)),
    })),
    ranges: [],
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
    ranges: [],
    spans: state.spans,
    originalSha256: state.originalSha256,
    modifiedSha256: state.modifiedSha256,
  }, null, 2));
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
  if (![1, 2].includes(state?.version) || typeof state.file !== "string" || typeof state.originalText !== "string") {
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
  if (options.command === "disable" && options.spans.length) await disableSpans(options);
  else if (options.command === "disable") await disable(options);
  else await restore(options);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
