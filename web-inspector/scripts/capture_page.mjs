#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_PROFILE_NAME,
  prepareProfileDirectory,
  profileLaunchError,
  resolveStateRoot,
  validateProfileName,
} from "./lib/profiles.mjs";
import {
  assertHeadedEnvironment,
  localLaunchArgs,
  persistentProfileArgs,
  resolveExecutablePath,
  resolvePlaywright,
} from "./lib/playwright.mjs";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage: node scripts/capture_page.mjs <url> [options]

Options:
  --browser <name>                Browser engine: chromium or firefox (default: chromium)
  --viewport <width>x<height>     Repeat for multiple viewports (default: 1440x1100)
  --device <name>                 Emulate a Playwright device, e.g. "Pixel 5"
  --profile <name>                Use a named persistent browser profile (default: default)
  --headed                        Launch with a visible browser window
  --headless                      Force headless mode
  --full-page                    Capture the full scrollable page
  --screenshot-prefix <prefix>   Prefix the automatic viewport screenshot filename
  --output-dir <path>             Output directory (default: /tmp/web-inspector/<timestamp>)
  --action <json>                 Repeatable interaction action
  --collector <path>              Read-only post-load collector module (advanced)
  --wait-until <event>            load, domcontentloaded, networkidle (default: networkidle)
  --wait-ms <milliseconds>        Extra wait after navigation/actions (default: 300)
  --timeout <milliseconds>        Navigation/action timeout (default: 30000)
  --executable-path <path>        Browser executable to launch (advanced)
  --ignore-https-errors            Ignore certificate errors
  --no-local-map                  Do not map localhost/*.test to 127.0.0.1
  --full-text                     Do not truncate domSummary.bodyText (default: first 200 chars + marker)
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

function normalizeScreenshotPrefix(value) {
  const normalized = String(value ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("--screenshot-prefix must contain at least one filename-safe character");
  return `${normalized}-`;
}

function parseArgs(argv) {
  const options = {
    browser: "chromium",
    viewports: [],
    actions: [],
    collectorPath: null,
    fullPage: false,
    screenshotPrefix: "",
    outputDir: path.join(os.tmpdir(), "web-inspector", new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")),
    device: null,
    profile: DEFAULT_PROFILE_NAME,
    headedOverride: null,
    waitUntil: "networkidle",
    waitMs: 300,
    timeout: 30000,
    localMap: true,
    fullText: false,
    failOnErrors: false,
    ignoreHttpsErrors: false,
    executablePath: null,
  };
  const positional = [];
  // NOTE: custom HTTP request headers (--header) are intentionally unsupported for now.
  const valueOptions = new Set([
    "browser",
    "viewport",
    "device",
    "profile",
    "output-dir",
    "screenshot-prefix",
    "action",
    "collector",
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
    else if (key === "full-text") options.fullText = true;
    else if (key === "fail-on-errors") options.failOnErrors = true;
    else if (key === "ignore-https-errors") options.ignoreHttpsErrors = true;
    else if (key === "headed" || key === "headless") {
      const headed = key === "headed";
      if (options.headedOverride !== null && options.headedOverride !== headed) {
        throw new Error("--headed and --headless are mutually exclusive");
      }
      options.headedOverride = headed;
    } else if (valueOptions.has(key)) {
      const value = argv[index + 1];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      index += 1;
      if (key === "browser") {
        options.browser = value;
      } else if (key === "viewport") options.viewports.push(parseViewport(value));
      else if (key === "device") options.device = value;
      else if (key === "profile") options.profile = validateProfileName(value);
      else if (key === "screenshot-prefix") options.screenshotPrefix = normalizeScreenshotPrefix(value);
      else if (key === "action") {
        try {
          options.actions.push(JSON.parse(value));
        } catch (error) {
          throw new Error(`Invalid JSON for --action #${options.actions.length + 1}: ${error.message}`);
        }
      }
      else if (key === "collector") options.collectorPath = value;
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

async function loadCollector(collectorPath) {
  if (!collectorPath) return null;
  const resolvedPath = path.resolve(collectorPath);
  let module;
  try {
    module = await import(pathToFileURL(resolvedPath).href);
  } catch (error) {
    throw new Error(`Could not load Web Inspector collector ${resolvedPath}: ${error.message}`, { cause: error });
  }
  if (typeof module.collect !== "function") {
    throw new Error(`Web Inspector collector ${resolvedPath} must export collect()`);
  }
  return { path: resolvedPath, collect: module.collect };
}

function serializedCollectorError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "COLLECTOR_ERROR",
    message: String(error?.message || error),
  };
}

function safeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "screenshot";
}

async function runAction(page, action, outputDir, index, viewport) {
  if (!action || typeof action !== "object") throw new Error(`Action ${index + 1} must be a JSON object`);
  const type = action.type;
  const selector = action.selector;
  const selectorActions = ["click", "fill", "type", "hover", "press", "select", "assertVisible", "assertNotVisible", "assertText", "clickIfVisible"];
  if (selectorActions.includes(type) && !selector) throw new Error(`Action ${index + 1} (${type}) requires selector`);

  if (type === "click") await page.locator(selector).first().click();
  else if (type === "fill") await page.locator(selector).first().fill(String(action.value ?? ""));
  else if (type === "type") await page.locator(selector).first().pressSequentially(String(action.value ?? ""));
  else if (type === "hover") await page.locator(selector).first().hover();
  else if (type === "press") await page.locator(selector).first().press(String(action.key ?? action.value ?? "Enter"));
  else if (type === "select") await page.locator(selector).first().selectOption(action.value);
  else if (type === "scroll") await page.evaluate(({ x, y }) => window.scrollTo(x ?? 0, y ?? 0), { x: action.x, y: action.y });
  else if (type === "wait") await page.waitForTimeout(Number(action.ms ?? 300));
  else if (type === "assertVisible") await page.locator(selector).first().waitFor({ state: "visible" });
  else if (type === "assertNotVisible") {
    const matches = page.locator(selector);
    const assertionWindowMs = Number(action.windowMs ?? 250);
    if (!Number.isFinite(assertionWindowMs) || assertionWindowMs < 0) {
      throw new Error(`Action ${index + 1} (assertNotVisible) windowMs must be non-negative`);
    }
    const deadline = Date.now() + assertionWindowMs;
    while (true) {
      const count = await matches.count();
      for (let matchIndex = 0; matchIndex < count; matchIndex += 1) {
        if (await matches.nth(matchIndex).isVisible()) {
          throw new Error(`Expected no visible element matching ${JSON.stringify(selector)}`);
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await page.waitForTimeout(Math.min(50, remaining));
    }
    return { type, visible: false, windowMs: assertionWindowMs };
  } else if (type === "clickIfVisible") {
    const matches = page.locator(selector);
    const count = await matches.count();
    for (let matchIndex = 0; matchIndex < count; matchIndex += 1) {
      const locator = matches.nth(matchIndex);
      if (await locator.isVisible()) {
        await locator.click();
        return { type, clicked: true };
      }
    }
    return { type, clicked: false };
  } else if (type === "assertText") {
    const text = String(action.text ?? action.value ?? "");
    const actual = await page.locator(selector).first().innerText();
    if (!actual.includes(text)) throw new Error(`Expected ${JSON.stringify(text)} in ${JSON.stringify(actual)}`);
  } else if (type === "screenshot") {
    const name = safeFileName(String(action.name ?? `action-${index + 1}`));
    const filePath = path.join(outputDir, `${viewport.width}x${viewport.height}-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: Boolean(action.fullPage) });
    return { type, screenshot: filePath };
  } else if (![
    "click", "fill", "type", "hover", "press", "select", "scroll", "wait",
    "assertVisible", "assertNotVisible", "assertText", "clickIfVisible", "screenshot",
  ].includes(type)) {
    throw new Error(`Unsupported action type "${type}"`);
  }
  return { type };
}

const BODY_TEXT_PREVIEW_LENGTH = 200;
const TRUNCATION_MARKER = " …[TRUNCATED]";
const LINK_IMAGE_LIMIT = 100;

async function collectDomSummary(page, { fullText }) {
  return page.evaluate(({ bodyTextLimit, linkImageLimit, fullText }) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const allLinks = [...document.querySelectorAll("a")].filter(visible);
    const links = allLinks.slice(0, linkImageLimit).map((link) => ({
      text: (link.innerText || link.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 160),
      href: link.href,
    }));
    const rawBodyText = (document.body?.innerText || "").trim().replace(/\s+/g, " ");
    const bodyTextTruncated = !fullText && rawBodyText.length > bodyTextLimit;
    const bodyText = fullText
      ? rawBodyText
      : rawBodyText.slice(0, bodyTextLimit).trimEnd() + (bodyTextTruncated ? " …[TRUNCATED]" : "");
    const allImages = [...document.images];
    return {
      bodyText,
      bodyTextTruncated,
      visibleLinks: links,
      visibleLinksOmitted: Math.max(0, allLinks.length - links.length),
      forms: document.querySelectorAll("form").length,
      images: allImages.slice(0, linkImageLimit).map((image) => ({ src: image.currentSrc || image.src, alt: image.alt, complete: image.complete, naturalWidth: image.naturalWidth })),
      imagesOmitted: Math.max(0, allImages.length - linkImageLimit),
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
    };
  }, { bodyTextLimit: BODY_TEXT_PREVIEW_LENGTH, linkImageLimit: LINK_IMAGE_LIMIT, fullText });
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
  const cliOptions = parseArgs(process.argv.slice(2));
  const options = {
    ...cliOptions,
    headed: cliOptions.headedOverride ?? false,
    stateRoot: resolveStateRoot(),
  };
  const collector = await loadCollector(options.collectorPath);
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
  if (options.headed) assertHeadedEnvironment();
  // Hostname mapping relies on --host-resolver-rules, which only exists in
  // Chromium; Firefox must rely on the operating system's name resolution.
  const localArgs = options.browser === "chromium" ? localLaunchArgs(options.url, options.localMap) : [];
  const launchArgs = [
    ...(options.browser === "chromium" ? ["--no-sandbox"] : []),
    ...(options.profile ? persistentProfileArgs(options.browser) : []),
    ...localArgs,
  ];
  const launchOptions = { headless: !options.headed, args: launchArgs };
  if (executablePath) launchOptions.executablePath = executablePath;

  const { defaultBrowserType: _defaultBrowserType, ...deviceContextOptions } = deviceDescriptor ?? {};
  const contextOptions = {
    ...deviceContextOptions,
    viewport: options.viewports[0],
    ignoreHTTPSErrors: options.ignoreHttpsErrors,
  };
  let browser = null;
  let persistentContext = null;
  let profileDirectory = null;
  if (options.profile) {
    profileDirectory = await prepareProfileDirectory(options.stateRoot, options.profile);
    try {
      persistentContext = await browserType.launchPersistentContext(profileDirectory, { ...launchOptions, ...contextOptions });
    } catch (error) {
      throw profileLaunchError(options.profile, error);
    }
  } else {
    browser = await browserType.launch(launchOptions);
  }

  const report = {
    url: options.url,
    outputDir,
    startedAt: new Date().toISOString(),
    options: {
      browser: options.browser,
      viewports: options.viewports,
      device: options.device,
      fullPage: options.fullPage,
      screenshotPrefix: options.screenshotPrefix,
      waitUntil: options.waitUntil,
      waitMs: options.waitMs,
      timeout: options.timeout,
      executablePath,
      localMapRequested: options.localMap,
      localMapApplied: localArgs.length > 0,
      fullText: options.fullText,
      ignoreHttpsErrors: options.ignoreHttpsErrors,
      failOnErrors: options.failOnErrors,
      headed: options.headed,
      profile: options.profile,
      persistentContext: Boolean(options.profile),
      collector: collector ? path.basename(collector.path) : null,
    },
    viewports: [],
  };

  try {
    for (const viewport of options.viewports) {
      const context = persistentContext ?? await browser.newContext({ ...deviceContextOptions, viewport, ignoreHTTPSErrors: options.ignoreHttpsErrors });
      const page = await context.newPage();
      if (persistentContext && (viewport.width !== options.viewports[0].width || viewport.height !== options.viewports[0].height)) {
        await page.setViewportSize(viewport);
      }
      page.setDefaultTimeout(options.timeout);
      const item = { viewport, screenshot: null, title: null, finalUrl: null, status: null, console: [], pageErrors: [], failedRequests: [], failedResponses: [], actionResults: [], navigationError: null, collector: null, collectorError: null, runtime: null, domSummary: null };
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

      if (collector) {
        try {
          item.collector = await collector.collect({
            page,
            viewport,
            outputDir,
            timeout: options.timeout,
          });
        } catch (error) {
          item.collectorError = serializedCollectorError(error);
        }
      }

      const screenshotName = `${options.screenshotPrefix}${viewport.width}x${viewport.height}${options.fullPage ? "-full" : ""}.png`;
      const screenshotPath = path.join(outputDir, screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: options.fullPage });
      item.screenshot = screenshotPath;
      item.title = await page.title().catch(() => null);
      item.finalUrl = page.url();
      item.runtime = await collectRuntimeSummary(page).catch((error) => ({ error: String(error.message || error) }));
      item.domSummary = await collectDomSummary(page, { fullText: options.fullText }).catch((error) => ({ error: String(error.message || error) }));
      report.viewports.push(item);
      await page.close();
      if (!persistentContext) await context.close();
    }
  } finally {
    if (persistentContext) await persistentContext.close();
    else if (browser) await browser.close();
  }

  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(outputDir, "report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));

  const errorCount = report.viewports.reduce((count, item) => count + item.console.filter(({ type }) => type === "error").length + item.pageErrors.length + item.failedRequests.length + item.failedResponses.length + (item.navigationError ? 1 : 0) + (item.collectorError ? 1 : 0), 0);
  if (options.failOnErrors && errorCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
