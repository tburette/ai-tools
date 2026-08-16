import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function addCandidate(candidates, seen, candidate) {
  if (!candidate || seen.has(candidate)) return;
  seen.add(candidate);
  candidates.push(candidate);
}

function addPackageRoot(candidates, seen, root) {
  if (!root) return;
  const packagePath = path.join(root, "playwright");
  if (fsSync.existsSync(path.join(packagePath, "package.json"))) addCandidate(candidates, seen, packagePath);
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

export function resolvePlaywright() {
  const candidates = [];
  const seen = new Set();
  if (process.env.PLAYWRIGHT_PACKAGE) addCandidate(candidates, seen, process.env.PLAYWRIGHT_PACKAGE);

  const cwdRequire = createRequire(path.join(process.cwd(), "__visual_web_qa__.cjs"));
  const scriptRequire = createRequire(path.join(scriptsDir, "__visual_web_qa__.cjs"));
  for (const resolver of [cwdRequire, scriptRequire]) {
    try {
      addCandidate(candidates, seen, resolver.resolve("playwright"));
    } catch {
      // Try the next resolution strategy.
    }
  }
  addCandidate(candidates, seen, "playwright");

  const nodePrefix = path.dirname(path.dirname(process.execPath));
  const globalRoots = [
    ...String(process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(nodePrefix, "lib", "node_modules"),
  ];
  for (const root of globalRoots) addPackageRoot(candidates, seen, root);

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

export function localLaunchArgs(url, enabled) {
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

export function persistentProfileArgs() {
  // Chromium normally discards session cookies when a persistent context exits.
  // Keep session state in an explicitly selected persistent profile while still
  // keeping the profile opt-in.
  return ["--persist-session-cookies"];
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

export function resolveExecutablePath(browserType, browserName, explicitPath) {
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

export function assertHeadedEnvironment() {
  if (process.platform !== "linux") return;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "Headed browser launch requires a graphical display. Set DISPLAY or WAYLAND_DISPLAY "
        + "on a desktop session, or use --headless in this environment.",
    );
  }
}
