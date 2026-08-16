#!/usr/bin/env node

import path from "node:path";
import { resolveExecutionOptions, validateProfileName } from "./lib/config.mjs";
import { prepareProfileDirectory, profileLaunchError } from "./lib/profiles.mjs";
import {
  assertHeadedEnvironment,
  localLaunchArgs,
  persistentProfileArgs,
  resolveExecutablePath,
  resolvePlaywright,
} from "./lib/playwright.mjs";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage: node scripts/open_profile.mjs <url> --profile <name> [options]

Options:
  --profile <name>                Declared persistent Chromium profile (required)
  --config <path>                 Read generic Web Inspector configuration from this path
  --timeout <milliseconds>        Close after this time (optional)
  --executable-path <path>        Chromium executable to launch (advanced)
  --ignore-https-errors            Ignore certificate errors
  --no-local-map                  Do not map localhost/*.test to 127.0.0.1
  --help                          Show this help
`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const options = {
    profile: null,
    configPath: null,
    timeout: null,
    executablePath: null,
    localMap: true,
    ignoreHttpsErrors: false,
  };
  const positional = [];
  const valueOptions = new Set(["profile", "config", "timeout", "executable-path"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "no-local-map") options.localMap = false;
    else if (key === "ignore-https-errors") options.ignoreHttpsErrors = true;
    else if (valueOptions.has(key)) {
      const value = argv[index + 1];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      index += 1;
      if (key === "profile") options.profile = validateProfileName(value);
      else if (key === "config") options.configPath = value;
      else if (key === "timeout") options.timeout = Number(value);
      else if (key === "executable-path") options.executablePath = value;
    } else throw new Error(`Unknown option --${key}`);
  }
  if (positional.length !== 1) throw new Error("Provide exactly one URL");
  if (!options.profile) throw new Error("--profile is required");
  if (options.timeout !== null && (!Number.isFinite(options.timeout) || options.timeout < 1)) {
    throw new Error("--timeout must be positive");
  }
  return { url: positional[0], ...options };
}

function waitForClose(context, timeout) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    let requestedReason = null;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      if (error) reject(error);
      else resolve(requestedReason || "closed");
    };
    const onSignal = () => {
      requestedReason = "signal";
      context.close().then(() => finish()).catch(finish);
    };
    context.once("close", () => finish());
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    if (timeout !== null) {
      timer = setTimeout(() => {
        requestedReason = "timeout";
        context.close().then(() => finish()).catch(finish);
      }, timeout);
    }
  });
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const options = await resolveExecutionOptions({
    browser: "chromium",
    browserExplicit: false,
    viewports: [],
    actions: [],
    fullPage: false,
    outputDir: null,
    device: null,
    profile: cliOptions.profile,
    configPath: cliOptions.configPath,
    headedOverride: true,
    waitUntil: "domcontentloaded",
    waitMs: 0,
    timeout: cliOptions.timeout ?? 30000,
    localMap: cliOptions.localMap,
    failOnErrors: false,
    ignoreHttpsErrors: cliOptions.ignoreHttpsErrors,
    executablePath: cliOptions.executablePath,
  });
  assertHeadedEnvironment();

  const playwright = resolvePlaywright();
  const browserType = playwright.chromium;
  const executablePath = resolveExecutablePath(browserType, "chromium", cliOptions.executablePath);
  const profileDirectory = await prepareProfileDirectory(options.stateRoot, options.profile);
  const launchOptions = {
    headless: false,
    args: ["--no-sandbox", ...persistentProfileArgs(), ...localLaunchArgs(cliOptions.url, cliOptions.localMap)],
    ignoreHTTPSErrors: cliOptions.ignoreHttpsErrors,
  };
  if (executablePath) launchOptions.executablePath = executablePath;

  let context;
  try {
    context = await browserType.launchPersistentContext(profileDirectory, launchOptions);
  } catch (error) {
    throw profileLaunchError(options.profile, error);
  }

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeout);
    await page.goto(cliOptions.url, { waitUntil: "domcontentloaded", timeout: options.timeout });
    console.log(`Opened ${cliOptions.url} in dedicated Web Inspector profile "${options.profile}".`);
    console.log("Complete any authorized interactive setup, then close the browser window to finish.");
    if (cliOptions.timeout !== null) console.log(`The session will close automatically after ${cliOptions.timeout} ms.`);
    const closeReason = await waitForClose(context, cliOptions.timeout);
    console.log(`Interactive session ended: ${closeReason}.`);
  } finally {
    if (!context.isClosed()) await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
