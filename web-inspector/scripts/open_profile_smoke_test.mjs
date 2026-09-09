#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const openProfileScript = path.join(scriptDir, "open_profile.mjs");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "web-inspector-open-profile-smoke-"));
const stateRoot = path.join(tempRoot, "state");
const fakePlaywright = path.join(tempRoot, "fake-playwright");
await mkdir(fakePlaywright, { recursive: true });
await writeFile(path.join(fakePlaywright, "package.json"), JSON.stringify({
  name: "fake-playwright-for-open-profile-smoke",
  main: "index.cjs",
}), "utf8");
await writeFile(path.join(fakePlaywright, "index.cjs"), `
const { EventEmitter } = require("node:events");
const { writeFileSync } = require("node:fs");

class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
  }

  isConnected() {
    return this.connected;
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.emit("disconnected");
  }
}

class FakePage extends EventEmitter {
  setDefaultTimeout() {}

  locator(selector) {
    return {
      first: () => ({
        waitFor: async () => {
          if (selector !== "#wpcontent" || process.env.FAKE_CLOSE_MODE !== "success") {
            await new Promise(() => {});
          }
        },
      }),
    };
  }

  async goto() {
    const mode = process.env.FAKE_CLOSE_MODE;
    if (mode === "browser-disconnect") setTimeout(() => this.browser.disconnect(), 25);
    if (mode === "page-close") setTimeout(() => this.emit("close"), 25);
  }
}

class FakeContext extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.closeCount = 0;
    this.browserInstance = new FakeBrowser();
    this.page = new FakePage();
    this.page.browser = this.browserInstance;
  }

  browser() {
    return this.browserInstance;
  }

  async newPage() {
    return this.page;
  }

  isClosed() {
    return this.closed;
  }

  async close() {
    this.closeCount += 1;
    if (process.env.FAKE_CLOSE_COUNT_FILE) writeFileSync(process.env.FAKE_CLOSE_COUNT_FILE, String(this.closeCount));
    this.closed = true;
    this.browserInstance.disconnect();
    this.emit("close");
  }
}

module.exports = {
  chromium: {
    async launchPersistentContext() {
      return new FakeContext();
    },
  },
};
`, "utf8");

function runOpenProfile(mode, { signal = null, timeout = null, successSelector = null } = {}) {
  return new Promise((resolve, reject) => {
    const closeCountFile = path.join(tempRoot, `${mode}-close-count.txt`);
    const stdoutFile = path.join(tempRoot, `${mode}-stdout.txt`);
    const stderrFile = path.join(tempRoot, `${mode}-stderr.txt`);
    const stdoutFd = openSync(stdoutFile, "w");
    const stderrFd = openSync(stderrFile, "w");
    const args = [openProfileScript, "http://fake.test/", "--profile", mode];
    if (timeout !== null) args.push("--timeout", String(timeout));
    if (successSelector !== null) args.push("--success-selector", successSelector);
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: path.dirname(scriptDir),
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":99",
        PLAYWRIGHT_PACKAGE: fakePlaywright,
        WEB_INSPECTOR_STATE_DIR: stateRoot,
        FAKE_CLOSE_MODE: mode,
        FAKE_CLOSE_COUNT_FILE: closeCountFile,
      },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    let signalSent = false;
    let signalPoller = null;
    const guard = setTimeout(() => child.kill("SIGKILL"), 4000);
    if (signal) {
      signalPoller = setInterval(async () => {
        if (signalSent) return;
        try {
          if ((await readFile(stdoutFile, "utf8")).includes("Opened ")) {
            signalSent = true;
            setTimeout(() => child.kill(signal), 100);
          }
        } catch {
          // The child has not written its startup message yet.
        }
      }, 10);
    }
    child.once("error", reject);
    child.once("close", async (code, childSignal) => {
      clearTimeout(guard);
      if (signalPoller) clearInterval(signalPoller);
      closeSync(stdoutFd);
      closeSync(stderrFd);
      const stdout = await readFile(stdoutFile, "utf8").catch(() => "");
      const stderr = await readFile(stderrFile, "utf8").catch(() => "");
      let closeCount = null;
      try {
        closeCount = Number(await readFile(closeCountFile, "utf8"));
      } catch {
        // Browser-disconnect leaves no live context for a cleanup close.
      }
      resolve({ code, signal: childSignal, stdout, stderr, closeCount, elapsedMs: Date.now() - startedAt });
    });
  });
}

function endRecord(stdout) {
  return stdout.split(/\r?\n/).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).find((record) => record?.event === "interactive-session-ended");
}

try {
  for (const testCase of [
    { mode: "success", successSelector: "#wpcontent", expectedReason: "success", expectedCode: 0, expectedCloseCount: 1 },
    { mode: "browser-disconnect", expectedReason: "window-closed", expectedCode: 0, expectedCloseCount: null },
    { mode: "page-close", expectedReason: "window-closed", expectedCode: 0, expectedCloseCount: 1 },
    { mode: "timeout", timeout: 100, expectedReason: "timeout", expectedCode: 1, expectedCloseCount: 1 },
    { mode: "signal-SIGINT", signal: "SIGINT", expectedReason: "SIGINT", expectedCode: 1, expectedCloseCount: 1 },
    { mode: "signal-SIGTERM", signal: "SIGTERM", expectedReason: "SIGTERM", expectedCode: 1, expectedCloseCount: 1 },
  ]) {
    const result = await runOpenProfile(testCase.mode, testCase);
    assert.equal(result.code, testCase.expectedCode, result.stderr || result.stdout);
    assert.equal(result.signal, null, result.stderr || result.stdout);
    assert.ok(result.elapsedMs < 2000, `${testCase.mode} took ${result.elapsedMs} ms`);
    assert.deepEqual(endRecord(result.stdout), {
      event: "interactive-session-ended",
      sessionEndReason: testCase.expectedReason,
    }, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.closeCount, testCase.expectedCloseCount);
  }
  console.log("web-inspector open_profile smoke test passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
