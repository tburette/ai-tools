#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const skillDir = path.dirname(fileURLToPath(import.meta.url));

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage: node scripts/capture_page.mjs <url> [options]

Options:
  --browser <name>                Browser engine: chromium or firefox (default: chromium)
  --viewport <width>x<height>     Repeat for multiple viewports (default: 1440x1100)
  --device <name>                Emulate a Playwright device, e.g. "Pixel 5"
  --full-page                    Capture the full scrollable page
  --output-dir <path>             Output directory (default: /tmp/web-inspector/<timestamp>)
  --action <json>                 Repeatable interaction action
  --wait-until <event>            load, domcontentloaded, networkidle (default: networkidle)
  --wait-ms <milliseconds>        Extra wait after navigation/actions (default: 300)
  --timeout <milliseconds>        Navigation/action timeout (default: 30000)
  --executable-path <path>        Browser executable to launch (advanced)
  --ignore-https-errors            Ignore certificate errors
  --no-local-map                  Do not map localhost/*.test to 127.0.0.1
  --fail-on-errors                Exit non-zero when page/request/action errors occur
  --help                          Show this help
`);
  process.exit(message ? 2 : 0);
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (!match) throw new Error(`Invalid viewport "${value}"; expected WIDTHxHEIGHT`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) throw new Error(`Invalid viewport "${value}"`);
  return { width, height };
}

function parseArgs(argv) {
  const options = {
    browser: "chromium",
    viewports: [],
    actions: [],
    fullPage: false,
    outputDir: path.join(os.tmpdir(), "web-inspector", new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")),
    device: null,
    waitUntil: "networkidle",
    waitMs: 300,
    timeout: 30000,
    localMap: true,
    failOnErrors: false,
    ignoreHttpsErrors: false,
  };
  const positional = [];
  const valueOptions = new Set([
    "browser",
    "viewport",
    "device",
    "output-dir",
    "action",
    "wait-until",
    "wait-ms",
    "timeout",
    "executable-path",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "full-page") options.fullPage = true;
    else if (key === "no-local-map") options.localMap = false;
    else if (key === "fail-on-errors") options.failOnErrors = true;
    else if (key === "ignore-https-errors") options.ignoreHttpsErrors = true;
    else if (valueOptions.has(key)) {
      const value = argv[index + 1];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      index += 1;
      if (key === "browser") options.browser = value;
      else if (key === "viewport") options.viewports.push(parseViewport(value));
      else if (key === "device") options.device = value;
      else if (key === "action") options.actions.push(JSON.parse(value));
      else if (key === "wait-ms") options.waitMs = Number(value);
      else if (key === "timeout") options.timeout = Number(value);
      else if (key === "output-dir") options.outputDir = value;
      else if (key === "wait-until") options.waitUntil = value;
      else if (key === "executable-path") options.executablePath = value;
    } else throw new Error(`Unknown option --${key}`);
  }

  if (positional.length !== 1) throw new Error("Provide exactly one URL");
  if (!["chromium", "firefox"].includes(options.browser)) {
    throw new Error(`Unknown browser "${options.browser}"; expected chromium or firefox`);
  }
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0) throw new Error("--wait-ms must be a non-negative number");
  if (!Number.isFinite(options.timeout) || options.timeout < 1) throw new Error("--timeout must be positive");
  return { url: positional[0], ...options };
}

function addCandidate(candidates, seen, candidate) {
  if (!candidate || seen.has(candidate)) return;
  seen.add(candidate);
  candidates.push(candidate);
}

function addPackageRoot(candidates, seen, root) {
  if (!root) return;
  const packagePath = path.join(root, "playwright");
  if (fsSync.existsSync(path.join(packagePath, "package.json"))) {
    addCandidate(candidates, seen, packagePath);
  }
}

function addNestedPackageRoots(candidates, seen, parent, suffix) {
  try {
    for (const entry of fsSync.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) addPackageRoot(candidates, seen, path.join(parent, entry.name, ...suffix));
    }
  } catch {
    // Optional cache directories may not exist or may not be readable.
  }
}

function resolvePlaywright() {
  const candidates = [];
  const seen = new Set();
  if (process.env.PLAYWRIGHT_PACKAGE) addCandidate(candidates, seen, process.env.PLAYWRIGHT_PACKAGE);

  const cwdRequire = createRequire(path.join(process.cwd(), "__visual_web_qa__.cjs"));
  const scriptRequire = createRequire(path.join(skillDir, "__visual_web_qa__.cjs"));
  for (const resolver of [cwdRequire, scriptRequire]) {
    try {
      addCandidate(candidates, seen, resolver.resolve("playwright"));
    } catch {
      // Try the next resolution strategy.
    }
  }
  addCandidate(candidates, seen, "playwright");

  // Cover global Node installs without spawning npm, which may be blocked in a
  // restricted shell. This is the usual <node-prefix>/lib/node_modules path.
  const nodePrefix = path.dirname(path.dirname(process.execPath));
  const globalRoots = [
    ...String(process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(nodePrefix, "lib", "node_modules"),
  ];
  for (const root of globalRoots) addPackageRoot(candidates, seen, root);

  // Codex and npm may keep a usable Playwright package outside the project.
  addNestedPackageRoots(candidates, seen, path.join(os.homedir(), ".cache", "codex-runtimes"), ["dependencies", "node", "node_modules"]);
  addNestedPackageRoots(candidates, seen, path.join(os.homedir(), ".npm", "_npx"), ["node_modules"]);

  const errors = [];
  for (const candidate of candidates) {
    try {
      const resolver = createRequire(path.join(process.cwd(), "__visual_web_qa__.cjs"));
      return resolver(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(`Could not resolve Playwright. Install it in the project or set PLAYWRIGHT_PACKAGE to an existing package. Tried:\n${errors.join("\n")}`);
}

function safeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "screenshot";
}

function localLaunchArgs(url, enabled) {
  if (!enabled) return [];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const host = parsed.hostname;
  if (host === "localhost" || host.endsWith(".test")) return [`--host-resolver-rules=MAP ${host} 127.0.0.1`];
  return [];
}

function isUsableExecutable(executablePath) {
  try {
    return fsSync.statSync(executablePath).isFile();
  } catch {
    return false;
  }
}

function findPlaywrightFirefoxExecutable(browserType) {
  const preferred = browserType.executablePath();
  if (isUsableExecutable(preferred)) return preferred;

  // Playwright can be present while its exact browser revision is missing. A
  // compatible Firefox revision already cached by the runtime is preferable to
  // falling back to the system Snap, whose private /tmp hides Playwright's
  // temporary profile and juggler pipe.
  const browserRoot = path.dirname(path.dirname(path.dirname(preferred)));
  let entries;
  try {
    entries = fsSync.readdirSync(browserRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^firefox-/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const candidate = path.join(browserRoot, entry, "firefox", "firefox");
    if (isUsableExecutable(candidate)) return candidate;
  }
  return null;
}

function isSnapFirefoxExecutable(executablePath) {
  const normalized = path.resolve(executablePath);
  if (normalized === "/usr/bin/firefox" || normalized === "/snap/bin/firefox" || normalized.startsWith("/snap/firefox/")) return true;
  try {
    const resolved = fsSync.realpathSync(normalized);
    if (resolved === "/usr/bin/snap" || resolved.startsWith("/snap/firefox/")) return true;
  } catch {
    // Let the normal executable validation or browser launch report missing paths.
  }
  try {
    return fsSync.readFileSync(normalized, "utf8").includes("/snap/bin/firefox");
  } catch {
    return false;
  }
}

function resolveExecutablePath(browserType, browserName, explicitPath) {
  if (explicitPath) {
    const executablePath = path.resolve(explicitPath);
    if (browserName === "firefox" && isSnapFirefoxExecutable(executablePath)) {
      throw new Error(
        "The Firefox Snap is not supported by this Playwright runner: its private /tmp "
          + "hides Playwright's temporary profile and juggler pipe. Omit --executable-path "
          + "to use the cached Playwright Firefox runtime, or pass a non-Snap Firefox.",
      );
    }
    return executablePath;
  }
  if (browserName !== "firefox") return null;

  const executablePath = findPlaywrightFirefoxExecutable(browserType);
  if (executablePath) return executablePath;

  throw new Error(
    "No usable Firefox executable was found. Install or expose a compatible "
      + "Playwright Firefox runtime, or pass --executable-path to a non-Snap Firefox. "
      + "The system Snap Firefox is not a safe default here because its private /tmp "
      + "hides Playwright's temporary profile and juggler pipe.",
  );
}

async function runAction(page, action, outputDir, index, viewport) {
  if (!action || typeof action !== "object") throw new Error(`Action ${index + 1} must be a JSON object`);
  const type = action.type;
  const selector = action.selector;
  if (["click", "fill", "type", "hover", "press", "select", "assertVisible", "assertText"].includes(type) && !selector) {
    throw new Error(`Action ${index + 1} (${type}) requires selector`);
  }

  if (type === "click") await page.locator(selector).first().click();
  else if (type === "fill") await page.locator(selector).first().fill(String(action.value ?? ""));
  else if (type === "type") await page.locator(selector).first().pressSequentially(String(action.value ?? ""));
  else if (type === "hover") await page.locator(selector).first().hover();
  else if (type === "press") await page.locator(selector).first().press(String(action.key ?? action.value ?? "Enter"));
  else if (type === "select") await page.locator(selector).first().selectOption(action.value);
  else if (type === "scroll") await page.evaluate(({ x, y }) => window.scrollTo(x ?? 0, y ?? 0), { x: action.x, y: action.y });
  else if (type === "wait") await page.waitForTimeout(Number(action.ms ?? 300));
  else if (type === "assertVisible") await page.locator(selector).first().waitFor({ state: "visible" });
  else if (type === "assertText") {
    const text = String(action.text ?? action.value ?? "");
    const actual = await page.locator(selector).first().innerText();
    if (!actual.includes(text)) throw new Error(`Expected ${JSON.stringify(text)} in ${JSON.stringify(actual)}`);
  } else if (type === "screenshot") {
    const name = safeFileName(String(action.name ?? `action-${index + 1}`));
    const filePath = path.join(outputDir, `${viewport.width}x${viewport.height}-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: Boolean(action.fullPage) });
    return { type, screenshot: filePath };
  } else if (!["click", "fill", "type", "hover", "press", "select", "scroll", "wait", "assertVisible", "assertText", "screenshot"].includes(type)) {
    throw new Error(`Unsupported action type "${type}"`);
  }
  return { type };
}

async function collectDomSummary(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const links = [...document.querySelectorAll("a")].filter(visible).slice(0, 100).map((link) => ({
      text: (link.innerText || link.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 160),
      href: link.href,
    }));
    return {
      bodyText: (document.body?.innerText || "").trim().replace(/\s+/g, " ").slice(0, 5000),
      visibleLinks: links,
      forms: document.querySelectorAll("form").length,
      images: [...document.images].map((image) => ({ src: image.currentSrc || image.src, alt: image.alt, complete: image.complete, naturalWidth: image.naturalWidth })).slice(0, 100),
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
    };
  });
}

async function collectRuntimeSummary(page) {
  return page.evaluate(() => ({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: window.screen.width, height: window.screen.height },
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(options.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const playwright = resolvePlaywright();
  const deviceDescriptor = options.device ? playwright.devices[options.device] : null;
  if (options.device && !deviceDescriptor) {
    const availableDevices = Object.keys(playwright.devices).sort().join(", ");
    throw new Error(`Unknown device "${options.device}". Available Playwright devices: ${availableDevices}`);
  }
  if (!options.viewports.length) options.viewports.push(deviceDescriptor?.viewport ?? { width: 1440, height: 1100 });
  const browserType = playwright[options.browser];
  if (!browserType?.launch) throw new Error(`Playwright does not expose the ${options.browser} browser type`);
  const executablePath = resolveExecutablePath(browserType, options.browser, options.executablePath);
  const launchArgs = options.browser === "chromium"
    ? ["--no-sandbox", ...localLaunchArgs(options.url, options.localMap)]
    : [];
  const launchOptions = { headless: true, args: launchArgs };
  if (executablePath) launchOptions.executablePath = executablePath;

  const browser = await browserType.launch(launchOptions);
  const report = {
    url: options.url,
    outputDir,
    startedAt: new Date().toISOString(),
    options: {
      browser: options.browser,
      viewports: options.viewports,
      device: options.device,
      fullPage: options.fullPage,
      waitUntil: options.waitUntil,
      waitMs: options.waitMs,
      timeout: options.timeout,
      executablePath,
      localMap: options.localMap,
      ignoreHttpsErrors: options.ignoreHttpsErrors,
      failOnErrors: options.failOnErrors,
    },
    viewports: [],
    errors: [],
  };

  try {
    for (const viewport of options.viewports) {
      const { defaultBrowserType: _defaultBrowserType, ...deviceContextOptions } = deviceDescriptor ?? {};
      const context = await browser.newContext({ ...deviceContextOptions, viewport, ignoreHTTPSErrors: options.ignoreHttpsErrors });
      const page = await context.newPage();
      page.setDefaultTimeout(options.timeout);
      const item = { viewport, screenshot: null, title: null, finalUrl: null, status: null, console: [], pageErrors: [], failedRequests: [], failedResponses: [], actionResults: [], navigationError: null, runtime: null, domSummary: null };
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type())) item.console.push({ type: message.type(), text: message.text() });
      });
      page.on("pageerror", (error) => item.pageErrors.push(String(error.message || error)));
      page.on("requestfailed", (request) => item.failedRequests.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText || "unknown" }));
      page.on("response", (response) => {
        if (response.status() >= 400) item.failedResponses.push({ url: response.url(), status: response.status() });
      });

      try {
        const response = await page.goto(options.url, { waitUntil: options.waitUntil, timeout: options.timeout });
        item.status = response?.status() ?? null;
      } catch (error) {
        item.navigationError = String(error.message || error);
      }
      if (options.waitMs) await page.waitForTimeout(options.waitMs);

      for (let index = 0; index < options.actions.length; index += 1) {
        try {
          item.actionResults.push({ index: index + 1, ...await runAction(page, options.actions[index], outputDir, index, viewport) });
        } catch (error) {
          const actionError = String(error.message || error);
          item.actionResults.push({ index: index + 1, type: options.actions[index]?.type, error: actionError });
          item.pageErrors.push(`action ${index + 1}: ${actionError}`);
        }
      }
      if (options.waitMs) await page.waitForTimeout(options.waitMs);

      const screenshotName = `${viewport.width}x${viewport.height}${options.fullPage ? "-full" : ""}.png`;
      const screenshotPath = path.join(outputDir, screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: options.fullPage });
      item.screenshot = screenshotPath;
      item.title = await page.title().catch(() => null);
      item.finalUrl = page.url();
      item.runtime = await collectRuntimeSummary(page).catch((error) => ({ error: String(error.message || error) }));
      item.domSummary = await collectDomSummary(page).catch((error) => ({ error: String(error.message || error) }));
      report.viewports.push(item);
      await context.close();
    }
  } finally {
    await browser.close();
  }

  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(outputDir, "report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));

  const errorCount = report.viewports.reduce((count, item) => count + item.console.filter(({ type }) => type === "error").length + item.pageErrors.length + item.failedRequests.length + item.failedResponses.length + (item.navigationError ? 1 : 0), 0);
  if (options.failOnErrors && errorCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
