#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function cssError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function parseContextLines(start, end) {
  const startLine = parsePositiveInteger(start, "context line range start");
  const endLine = parsePositiveInteger(end, "context line range end");
  if (endLine < startLine) throw new Error("context line range end must not precede its start");
  return { startLine, endLine };
}

/**
 * Parse the human-readable reference copied by copy-file-ref.
 *
 * Supported forms:
 *   path/to/file.css:26
 *   path/to/file.css:26 (.selector)
 *   path/to/file.css:26 (.selector) [context-lines=20-28]
 *
 * The former symbol-range spelling is also accepted for older references.
 */
export function parseCssReference(reference) {
  let value = String(reference ?? "").trim();
  if (!value) throw new Error("CSS reference cannot be empty");

  let contextLines = null;
  const suffix = /\s+\[(?:context-lines|symbol-range)=(\d+)-(\d+)\]\s*$/i.exec(value);
  if (suffix) {
    contextLines = parseContextLines(suffix[1], suffix[2]);
    value = value.slice(0, suffix.index).trimEnd();
  }

  const match = /^(.+):(\d+)(?:\s+\(([\s\S]*)\))?$/.exec(value);
  if (!match) {
    throw new Error(
      `Invalid CSS reference "${reference}"; expected path:line, optionally followed by (context)`,
    );
  }

  const filePart = match[1].trim();
  if (!filePart) throw new Error(`Invalid CSS reference "${reference}"; file path is empty`);
  return {
    raw: String(reference),
    file: filePart,
    line: parsePositiveInteger(match[2], "CSS reference line"),
    hint: match[3]?.trim() || null,
    contextLines,
  };
}

function skipLeadingTrivia(text, start, end) {
  let offset = start;
  while (offset < end) {
    while (offset < end && /\s/.test(text[offset])) offset += 1;
    if (text.startsWith("/*", offset)) {
      const commentEnd = text.indexOf("*/", offset + 2);
      if (commentEnd === -1 || commentEnd + 2 > end) {
        throw cssError("Unterminated CSS block comment while resolving a CSS reference");
      }
      offset = commentEnd + 2;
      continue;
    }
    break;
  }
  return offset;
}

function stripComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function normalizeForMatch(value) {
  return stripComments(String(value ?? "")).replace(/\s+/g, " ").trim();
}

function lineStarts(text) {
  const starts = [0];
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === "\n") starts.push(offset + 1);
  }
  return starts;
}

function lineAtOffset(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return high + 1;
}

function lineBounds(starts, text, line) {
  if (line < 1 || line > starts.length) return null;
  const start = starts[line - 1];
  const end = line < starts.length ? starts[line] : text.length;
  return { start, end };
}

/**
 * Find balanced CSS blocks with a deliberately small lexer. This is not a
 * formatter or validator: it only needs to distinguish braces in CSS syntax
 * from braces in comments, strings, escapes, and parenthesized expressions.
 */
export function scanCssBlocks(text) {
  const blocks = [];
  const stack = [];
  let statementStart = 0;
  let quote = null;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let offset = 0; offset < text.length; offset += 1) {
    const character = text[offset];

    if (quote) {
      if (character === "\\") {
        offset += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }

    if (text.startsWith("/*", offset)) {
      const commentEnd = text.indexOf("*/", offset + 2);
      if (commentEnd === -1) throw cssError("Unterminated CSS block comment");
      offset = commentEnd + 1;
      continue;
    }

    if (character === "\\") {
      offset += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === "[") {
      bracketDepth += 1;
      continue;
    }
    if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (character === ";" && parenDepth === 0 && bracketDepth === 0) {
      statementStart = offset + 1;
      continue;
    }

    if (character === "{" && parenDepth === 0 && bracketDepth === 0) {
      const startOffset = skipLeadingTrivia(text, statementStart, offset);
      const prelude = text.slice(startOffset, offset);
      if (!prelude.trim()) {
        throw cssError(`CSS block at offset ${offset} has no selector or at-rule prelude`);
      }
      const block = {
        startOffset,
        openOffset: offset,
        endOffset: null,
        prelude,
        isAtRule: /^@/.test(stripComments(prelude).trimStart()),
      };
      stack.push(block);
      statementStart = offset + 1;
      continue;
    }

    if (character === "}" && parenDepth === 0 && bracketDepth === 0) {
      const block = stack.pop();
      if (!block) throw cssError(`Unexpected CSS closing brace at offset ${offset}`);
      block.endOffset = offset + 1;
      blocks.push(block);
      statementStart = offset + 1;
    }
  }

  if (quote) throw cssError("Unterminated CSS string");
  if (stack.length) throw cssError("Unclosed CSS block while resolving a CSS reference");
  if (parenDepth || bracketDepth) throw cssError("Unclosed CSS grouping while resolving a CSS reference");
  return blocks;
}

function blockLines(block, starts) {
  return {
    startLine: lineAtOffset(starts, block.startOffset),
    endLine: lineAtOffset(starts, block.endOffset - 1),
  };
}

function containsLine(block, line, starts, text) {
  const bounds = lineBounds(starts, text, line);
  return Boolean(bounds && block.startOffset < bounds.end && block.endOffset > bounds.start);
}

function containsContextLines(block, contextLines, starts, text) {
  if (!contextLines) return false;
  const startBounds = lineBounds(starts, text, contextLines.startLine);
  const endBounds = lineBounds(starts, text, contextLines.endLine);
  if (!startBounds || !endBounds) return false;
  const blockRange = blockLines(block, starts);
  return blockRange.startLine <= contextLines.startLine && blockRange.endLine >= contextLines.endLine;
}

function selectorMatchesHint(block, hint) {
  const normalizedHint = normalizeForMatch(hint);
  if (!normalizedHint) return false;
  return normalizeForMatch(block.prelude).includes(normalizedHint);
}

function describeCandidate(block, starts) {
  const lines = blockLines(block, starts);
  const preview = normalizeForMatch(block.prelude);
  return `${lines.startLine}:${lines.endLine}${preview ? ` (${preview})` : ""}`;
}

function chooseRule({ blocks, text, line, hint, contextLines, starts }) {
  let candidates = blocks
    .filter((block) => !block.isAtRule)
    .filter((block) => containsLine(block, line, starts, text));

  if (!candidates.length) {
    throw cssError(`Could not find a concrete CSS rule containing line ${line}`);
  }

  const hinted = candidates.filter((block) => selectorMatchesHint(block, hint));
  if (hinted.length) candidates = hinted;

  const contextMatched = candidates.filter((block) => containsContextLines(block, contextLines, starts, text));
  if (contextMatched.length) candidates = contextMatched;

  candidates.sort((left, right) => {
    const leftSize = left.endOffset - left.startOffset;
    const rightSize = right.endOffset - right.startOffset;
    return leftSize - rightSize || left.startOffset - right.startOffset;
  });

  const smallestSize = candidates[0].endOffset - candidates[0].startOffset;
  const smallest = candidates.filter(
    (candidate) => candidate.endOffset - candidate.startOffset === smallestSize,
  );
  if (smallest.length > 1) {
    const descriptions = smallest.map((candidate) => describeCandidate(candidate, starts)).join(", ");
    throw cssError(
      `CSS reference at line ${line} is ambiguous; matching rules are ${descriptions}. `
      + "Move the cursor to a line unique to the rule or include a selector context.",
    );
  }
  return smallest[0];
}

async function ensureCssFile(filePath) {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    throw new Error(`Could not read CSS file ${filePath}: ${error.message}`, { cause: error });
  }
  if (stats.isSymbolicLink()) throw new Error(`Refusing to inspect symlinked CSS file: ${filePath}`);
  if (!stats.isFile()) throw new Error(`CSS target is not a regular file: ${filePath}`);
}

export async function resolveCssReference(reference, { cwd = process.cwd() } = {}) {
  const parsed = parseCssReference(reference);
  const filePath = path.resolve(cwd, parsed.file);
  await ensureCssFile(filePath);
  const text = await fs.readFile(filePath, "utf8");
  const starts = lineStarts(text);
  if (!lineBounds(starts, text, parsed.line)) {
    throw new Error(`CSS reference line ${parsed.line} is outside ${filePath}`);
  }

  const blocks = scanCssBlocks(text);
  const block = chooseRule({
    blocks,
    text,
    line: parsed.line,
    hint: parsed.hint,
    contextLines: parsed.contextLines,
    starts,
  });
  const lines = blockLines(block, starts);
  return {
    reference: parsed.raw,
    file: filePath,
    cursorLine: parsed.line,
    hint: parsed.hint,
    contextLines: parsed.contextLines,
    rule: {
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      startLine: lines.startLine,
      endLine: lines.endLine,
      prelude: normalizeForMatch(block.prelude),
    },
  };
}

export function formatResolvedRule(resolved) {
  const context = resolved.hint ? ` ${resolved.hint}` : "";
  return `${resolved.file}:${resolved.rule.startLine}:${resolved.rule.endLine}${context}`;
}
