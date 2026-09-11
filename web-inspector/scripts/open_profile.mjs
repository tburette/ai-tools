#!/usr/bin/env node

import path from "node:path";
import {
  DEFAULT_PROFILE_NAME,
  prepareProfileDirectory,
  profileLaunchError,
  resolveStateRoot,
  validateProfileName,
} from "./lib/profiles.mjs";
import {
  assertHeadedEnvironment,
  codexProxyForUrl,
  localLaunchArgs,
  persistentProfileArgs,
  resolveExecutablePath,
  resolvePlaywright,
} from "./lib/playwright.mjs";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage: node scripts/open_profile.mjs <url> [options]

Options:
  --profile <name>                Named persistent browser profile (default: default)
  --timeout <milliseconds>        Close after this time; exits non-zero if reached (optional)
  --success-selector <selector>   Close successfully when this selector becomes visible (optional)
  --executable-path <path>        Browser executable to launch (advanced)
  --ignore-https-errors            Ignore certificate errors
  --no-local-map                  Do not map localhost/*.test to 127.0.0.1
  --help                          Show this help
`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const options = {
    profile: DEFAULT_PROFILE_NAME,
    timeout: null,
    successSelector: null,
    executablePath: null,
    localMap: true,
    ignoreHttpsErrors: false,
  };
  const positional = [];
  const valueOptions = new Set(["profile", "timeout", "success-selector", "executable-path"]);
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
      else if (key === "timeout") options.timeout = Number(value);
      else if (key === "success-selector") options.successSelector = value;
      else if (key === "executable-path") options.executablePath = value;
    } else throw new Error(`Unknown option --${key}`);
  }
  if (positional.length !== 1) throw new Error("Provide exactly one URL");
  if (options.timeout !== null && (!Number.isFinite(options.timeout) || options.timeout < 1)) {
    throw new Error("--timeout must be positive");
  }
  return { url: positional[0], ...options };
}

const BROWSER_CONNECTION_POLL_MS = 200;

function writeStdoutLine(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${value}\n`, (error) => error ? reject(error) : resolve());
  });
}

function waitForClose(context, page, timeout, lifecycle, successSelector) {
  const browser = typeof context.browser === "function" ? context.browser() : null;
  return new Promise((resolve, reject) => {
    let timer = null;
    let browserPoller = null;
    let settled = false;
    let requestedReason = null;
    let contextClosePromise = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (browserPoller) clearInterval(browserPoller);
      context.removeListener("close", onContextClose);
      page.removeListener("close", onPageClose);
      browser?.removeListener("disconnected", onBrowserDisconnected);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    const finish = (reason = null) => {
      if (settled) return;
      if (reason && !requestedReason) requestedReason = reason;
      settled = true;
      cleanup();
      resolve(requestedReason || "window-closed");
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const requestContextClose = (reason) => {
      if (!requestedReason) requestedReason = reason;
      lifecycle.contextCloseRequested = true;
      if (!contextClosePromise) {
        contextClosePromise = Promise.resolve().then(() => context.close());
        contextClosePromise.then(() => finish()).catch(fail);
      }
      return contextClosePromise;
    };
    const onContextClose = () => {
      lifecycle.contextClosed = true;
      finish("window-closed");
    };
    const onPageClose = () => finish("window-closed");
    const onBrowserDisconnected = () => {
      lifecycle.browserDisconnected = true;
      finish("window-closed");
    };
    const onSigint = () => requestContextClose("SIGINT");
    const onSigterm = () => requestContextClose("SIGTERM");
    const onTimeout = () => requestContextClose("timeout");
    context.once("close", onContextClose);
    page.once("close", onPageClose);
    browser?.once("disconnected", onBrowserDisconnected);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    if (timeout !== null) {
      timer = setTimeout(onTimeout, timeout);
    }
    if (browser && typeof browser.isConnected === "function") {
      browserPoller = setInterval(() => {
        try {
          if (!browser.isConnected()) onBrowserDisconnected();
        } catch (error) {
          fail(error);
        }
      }, BROWSER_CONNECTION_POLL_MS);
    }
    if (successSelector) {
      page.locator(successSelector).first().waitFor({ state: "visible", timeout: 0 })
        .then(() => requestContextClose("success"))
        .catch((error) => {
          if (!settled) fail(error);
        });
    }
  });
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const options = {
    browser: "chromium",
    profile: cliOptions.profile,
    stateRoot: resolveStateRoot(),
  };
  assertHeadedEnvironment();

  const playwright = resolvePlaywright();
  const browserType = playwright[options.browser];
  const executablePath = resolveExecutablePath(browserType, options.browser, cliOptions.executablePath);
  const profileDirectory = await prepareProfileDirectory(options.stateRoot, options.profile);
  // --host-resolver-rules and --persist-session-cookies are Chromium-only
  // arguments; passing them to the Firefox binary aborts the launch.
  const chromiumArgs = options.browser === "chromium"
    ? ["--no-sandbox", ...persistentProfileArgs(options.browser), ...localLaunchArgs(cliOptions.url, cliOptions.localMap)]
    : [];
  const browserProxy = codexProxyForUrl(cliOptions.url);
  const launchOptions = {
    headless: false,
    args: chromiumArgs,
    ...(browserProxy ? { proxy: browserProxy } : {}),
    ignoreHTTPSErrors: cliOptions.ignoreHttpsErrors,
  };
  if (executablePath) launchOptions.executablePath = executablePath;

  let context;
  try {
    context = await browserType.launchPersistentContext(profileDirectory, launchOptions);
  } catch (error) {
    throw profileLaunchError(options.profile, error);
  }

  const lifecycle = {
    contextCloseRequested: false,
    contextClosed: false,
    browserDisconnected: false,
  };
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeout);
    await page.goto(cliOptions.url, { waitUntil: "domcontentloaded", timeout: options.timeout });
    console.log(`Opened ${cliOptions.url} in dedicated Web Inspector profile "${options.profile}".`);
    if (cliOptions.successSelector) {
      console.log("Complete any authorized interactive setup; the session will finish automatically when the success selector is visible, or close the browser window manually.");
    } else {
      console.log("Complete any authorized interactive setup, then close the browser window to finish.");
    }
    if (cliOptions.timeout !== null) console.log(`The session will close automatically after ${cliOptions.timeout} ms.`);
    const closeReason = await waitForClose(context, page, cliOptions.timeout, lifecycle, cliOptions.successSelector);
    await writeStdoutLine(`Interactive session ended: ${closeReason}.`);
    await writeStdoutLine(JSON.stringify({ event: "interactive-session-ended", sessionEndReason: closeReason }));
    if (!["window-closed", "success"].includes(closeReason)) process.exitCode = 1;
  } finally {
    if (!context.isClosed() && !lifecycle.contextCloseRequested && !lifecycle.contextClosed && !lifecycle.browserDisconnected) await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
