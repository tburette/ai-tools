import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultWebInspectorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web-inspector");

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
      resolve({
        code,
        signal,
        timedOut,
        sessionEndedByTimeout: /Interactive session ended: timeout\b/i.test(stdout),
        stdout,
        stderr,
        report,
        reportPath,
        scriptPath,
      });
    });
  });
}

export function captureArgs({ url, profile, configPath, outputDir, timeout, headed, headless, actions = [], collectorPath = null, waitUntil = "domcontentloaded", waitMs = 0, failOnErrors = true }) {
  const args = [url, "--output-dir", outputDir, "--timeout", String(timeout), "--wait-until", waitUntil, "--wait-ms", String(waitMs)];
  if (profile) args.push("--profile", profile);
  if (configPath) args.push("--config", configPath);
  if (collectorPath) args.push("--collector", collectorPath);
  if (headed) args.push("--headed");
  if (headless) args.push("--headless");
  if (failOnErrors) args.push("--fail-on-errors");
  for (const action of actions) args.push("--action", JSON.stringify(action));
  return args;
}

export function openProfileArgs({ url, profile, configPath, timeout = null }) {
  const args = [url, "--profile", profile];
  if (configPath) args.push("--config", configPath);
  if (timeout !== null) args.push("--timeout", String(timeout));
  return args;
}
