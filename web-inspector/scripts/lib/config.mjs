import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONFIG_VERSION = 1;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported key "${key}"`);
  }
}

export function validateProfileName(name) {
  if (typeof name !== "string" || !PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid profile name "${name}"; use 1-64 characters matching `
        + "[A-Za-z0-9][A-Za-z0-9._-]{0,63}",
    );
  }
  return name;
}

export function resolveConfigPath(explicitPath, env = process.env, home = os.homedir()) {
  if (explicitPath) return path.resolve(explicitPath);
  if (env.WEB_INSPECTOR_CONFIG) return path.resolve(env.WEB_INSPECTOR_CONFIG);
  const configHome = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(home, ".config");
  return path.join(configHome, "web-inspector", "config.json");
}

export function resolveStateRoot(env = process.env, home = os.homedir()) {
  if (env.WEB_INSPECTOR_STATE_DIR) return path.resolve(env.WEB_INSPECTOR_STATE_DIR);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, ".local", "state");
  return path.join(stateHome, "web-inspector", "profiles");
}

function validateConfig(value, configPath) {
  if (!isPlainObject(value)) throw new Error(`Web Inspector config must be a JSON object: ${configPath}`);
  assertOnlyKeys(value, new Set(["version", "defaults", "profiles"]), "Web Inspector config");
  if (value.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported Web Inspector config version in ${configPath}; expected ${CONFIG_VERSION}`);
  }

  const defaults = value.defaults ?? {};
  if (!isPlainObject(defaults)) throw new Error(`Web Inspector config defaults must be an object: ${configPath}`);
  assertOnlyKeys(defaults, new Set(["headed"]), "Web Inspector config defaults");
  if (defaults.headed !== undefined && typeof defaults.headed !== "boolean") {
    throw new Error(`Web Inspector config defaults.headed must be boolean: ${configPath}`);
  }

  const profiles = value.profiles ?? {};
  if (!isPlainObject(profiles)) throw new Error(`Web Inspector config profiles must be an object: ${configPath}`);
  for (const [name, profile] of Object.entries(profiles)) {
    validateProfileName(name);
    if (!isPlainObject(profile)) throw new Error(`Profile "${name}" must be an object: ${configPath}`);
    assertOnlyKeys(profile, new Set(["browser"]), `Profile "${name}"`);
    if (profile.browser !== "chromium") {
      throw new Error(`Profile "${name}" must declare browser "chromium" in the MVP: ${configPath}`);
    }
  }

  return {
    version: CONFIG_VERSION,
    defaults: { headed: defaults.headed ?? false },
    profiles,
  };
}

export async function loadConfig(explicitPath, env = process.env, home = os.homedir()) {
  const configPath = resolveConfigPath(explicitPath, env, home);
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: configPath,
        exists: false,
        config: { version: CONFIG_VERSION, defaults: { headed: false }, profiles: {} },
      };
    }
    throw new Error(`Could not read Web Inspector config ${configPath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in Web Inspector config ${configPath}: ${error.message}`);
  }
  return { path: configPath, exists: true, config: validateConfig(parsed, configPath) };
}

export async function resolveExecutionOptions(cliOptions, env = process.env, home = os.homedir()) {
  const loaded = await loadConfig(cliOptions.configPath, env, home);
  const profileName = cliOptions.profile ?? null;
  let profileConfig = null;
  if (profileName) {
    validateProfileName(profileName);
    profileConfig = Object.hasOwn(loaded.config.profiles, profileName)
      ? loaded.config.profiles[profileName]
      : null;
    if (!profileConfig) throw new Error(`Unknown profile "${profileName}"; declare it in ${loaded.path}`);
  }

  const configuredBrowser = profileConfig?.browser ?? cliOptions.browser;
  if (cliOptions.browserExplicit && profileConfig && cliOptions.browser !== configuredBrowser) {
    throw new Error(
      `Profile "${profileName}" is configured for ${configuredBrowser}, `
        + `but --browser ${cliOptions.browser} was requested`,
    );
  }
  if (profileName && configuredBrowser !== "chromium") {
    throw new Error(`Persistent profile "${profileName}" is only supported with Chromium`);
  }

  const headed = cliOptions.headedOverride ?? loaded.config.defaults.headed;
  return {
    ...cliOptions,
    browser: configuredBrowser,
    headed,
    profile: profileName,
    profileConfig,
    configPath: loaded.path,
    configExists: loaded.exists,
    stateRoot: resolveStateRoot(env, home),
  };
}

export { CONFIG_VERSION, PROFILE_NAME_PATTERN };
