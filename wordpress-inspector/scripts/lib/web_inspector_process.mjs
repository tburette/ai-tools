import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultWebInspectorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web-inspector");

export const DEFAULT_PROFILE_NAME = "default";

export function resolveWebInspectorDir(env = process.env) {
  const candidate = path.resolve(env.WEB_INSPECTOR_SKILL_DIR || defaultWebInspectorDir);
  return candidate;
}

async function ensureScriptExists(webInspectorDir, scriptName) {
  const scriptPath = path.join(webInspectorDir, "scripts", scriptName);
  try {
    await fs.access(scriptPath);
  } catch {
    throw new Error(
      `Could not find Web Inspector script ${scriptPath}. `
        + "Set WEB_INSPECTOR_SKILL_DIR to the installed web-inspector skill directory.",
    );
  }
  return scriptPath;
}

function parseSessionEndReason(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.event === "interactive-session-ended" && typeof record.sessionEndReason === "string") {
        return record.sessionEndReason;
      }
    } catch {
      // Ignore normal human-readable runner output and inspect the next line.
    }
  }
  const legacyReason = /Interactive session ended:\s*(closed|window-closed|timeout|SIGINT|SIGTERM|signal)\./i.exec(String(stdout ?? ""))?.[1]?.toLowerCase();
  if (legacyReason === "closed" || legacyReason === "window-closed") return "window-closed";
  if (legacyReason === "sigint") return "SIGINT";
  if (legacyReason === "sigterm") return "SIGTERM";
  return legacyReason;
}

export async function runWebInspectorScript(scriptName, args, { env = process.env, timeout = null } = {}) {
  // The WordPress adapter delegates browser work to the sibling Web Inspector
  // as a child process, then loads its JSON report instead of parsing terminal
  // prose. This keeps Playwright behavior shared by both tools.
  const webInspectorDir = resolveWebInspectorDir(env);
  const scriptPath = await ensureScriptExists(webInspectorDir, scriptName);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: webInspectorDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;
    if (timeout !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      if (timer) clearTimeout(timer);
      let report = null;
      let reportPath = null;
      const outputDirIndex = args.indexOf("--output-dir");
      if (outputDirIndex >= 0 && args[outputDirIndex + 1]) {
        reportPath = path.join(path.resolve(args[outputDirIndex + 1]), "report.json");
        try {
          report = JSON.parse(await fs.readFile(reportPath, "utf8"));
        } catch {
          // Configuration or launch failures may happen before a report exists.
        }
      }
      const sessionEndReason = parseSessionEndReason(stdout);
      resolve({
        code,
        signal,
        timedOut,
        sessionEndReason,
        sessionEndedByTimeout: sessionEndReason === "timeout",
        stdout,
        stderr,
        report,
        reportPath,
        scriptPath,
      });
    });
  });
}

export function captureArgs({ url, profile = DEFAULT_PROFILE_NAME, outputDir, timeout, headed, headless, actions = [], collectorPath = null, waitUntil = "domcontentloaded", waitMs = 0, failOnErrors = true, fullText = false }) {
  const args = [url, "--output-dir", outputDir, "--timeout", String(timeout), "--wait-until", waitUntil, "--wait-ms", String(waitMs)];
  if (profile) args.push("--profile", profile);
  if (collectorPath) args.push("--collector", collectorPath);
  if (headed) args.push("--headed");
  if (headless) args.push("--headless");
  if (failOnErrors) args.push("--fail-on-errors");
  if (fullText) args.push("--full-text");
  for (const action of actions) args.push("--action", JSON.stringify(action));
  return args;
}

export function openProfileArgs({ url, profile = DEFAULT_PROFILE_NAME, timeout = null, successSelector = null }) {
  const args = [url, "--profile", profile];
  if (timeout !== null) args.push("--timeout", String(timeout));
  if (successSelector) args.push("--success-selector", successSelector);
  return args;
}
