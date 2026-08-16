#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  resolveConfigPath,
  resolveExecutionOptions,
  resolveStateRoot,
  validateProfileName,
} from "./lib/config.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "web-inspector-config-smoke-"));

async function writeConfig(name, value) {
  const filePath = path.join(tempRoot, name);
  await writeFile(filePath, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, "utf8");
  return filePath;
}

try {
  const explicitPath = path.join(tempRoot, "explicit.json");
  assert.equal(resolveConfigPath(explicitPath, {}, "/home/test"), explicitPath);
  assert.equal(resolveConfigPath(null, { WEB_INSPECTOR_CONFIG: "/tmp/from-env.json" }, "/home/test"), "/tmp/from-env.json");
  assert.equal(resolveConfigPath(null, { XDG_CONFIG_HOME: "/tmp/config-home" }, "/home/test"), "/tmp/config-home/web-inspector/config.json");
  assert.equal(resolveConfigPath(null, {}, "/home/test"), "/home/test/.config/web-inspector/config.json");
  assert.equal(resolveStateRoot({ WEB_INSPECTOR_STATE_DIR: "/tmp/state" }, "/home/test"), "/tmp/state");
  assert.equal(resolveStateRoot({ XDG_STATE_HOME: "/tmp/state-home" }, "/home/test"), "/tmp/state-home/web-inspector/profiles");
  assert.equal(resolveStateRoot({}, "/home/test"), "/home/test/.local/state/web-inspector/profiles");

  const missing = await loadConfig(path.join(tempRoot, "missing.json"), {}, "/home/test");
  assert.equal(missing.exists, false);
  assert.equal(missing.config.defaults.headed, false);

  const validPath = await writeConfig("valid.json", {
    version: 1,
    defaults: { headed: true },
    profiles: { local: { browser: "chromium" } },
  });
  const loaded = await loadConfig(validPath, {}, "/home/test");
  assert.equal(loaded.exists, true);
  const base = {
    browser: "chromium",
    browserExplicit: false,
    viewports: [],
    actions: [],
    fullPage: false,
    outputDir: null,
    device: null,
    profile: null,
    configPath: validPath,
    headedOverride: null,
    waitUntil: "load",
    waitMs: 0,
    timeout: 1000,
    localMap: true,
    failOnErrors: false,
    ignoreHttpsErrors: false,
    executablePath: null,
  };
  assert.equal((await resolveExecutionOptions(base, {}, "/home/test")).headed, true);
  assert.equal((await resolveExecutionOptions({ ...base, headedOverride: false }, {}, "/home/test")).headed, false);
  const profileOptions = await resolveExecutionOptions({ ...base, profile: "local" }, {}, "/home/test");
  assert.equal(profileOptions.browser, "chromium");
  assert.equal(profileOptions.profile, "local");

  const invalidJsonPath = await writeConfig("invalid-json.json", "{");
  const unknownKeyPath = await writeConfig("unknown-key.json", { version: 1, nope: true });
  const invalidTypePath = await writeConfig("invalid-type.json", { version: 1, defaults: { headed: "yes" } });
  const invalidProfilePath = await writeConfig("invalid-profile.json", { version: 1, profiles: { "../bad": { browser: "chromium" } } });
  await assert.rejects(() => loadConfig(invalidJsonPath, {}, "/home/test"), /Invalid JSON/);
  await assert.rejects(() => loadConfig(unknownKeyPath, {}, "/home/test"), /unsupported key/);
  await assert.rejects(() => loadConfig(invalidTypePath, {}, "/home/test"), /must be boolean/);
  await assert.rejects(() => loadConfig(invalidProfilePath, {}, "/home/test"), /Invalid profile name/);
  await assert.rejects(() => resolveExecutionOptions({ ...base, profile: "missing" }, {}, "/home/test"), /Unknown profile/);
  await assert.rejects(() => resolveExecutionOptions({ ...base, profile: "toString" }, {}, "/home/test"), /Unknown profile/);
  assert.throws(() => validateProfileName("../escape"), /Invalid profile name/);
  assert.throws(() => validateProfileName("a".repeat(65)), /Invalid profile name/);

  console.log("web-inspector config smoke test passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
