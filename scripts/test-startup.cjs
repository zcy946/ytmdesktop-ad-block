"use strict";
// Startup verification for the packaged desktop app.
//
// Upstream builds the windows' URLs from `app.isPackaged` (`ytmd-app://...` when packaged, `ALL_WINDOWS_VITE_DEV_SERVER_URL + ...` otherwise,
// src/main/index.ts:229). A non-packaged production run therefore loads `undefined/windows/main/index.html`, so this runner launches the real
// packaged binary produced by `pnpm package` (out/<productName>-<platform>-<arch>/) and drives it from the outside over the Chromium DevTools
// protocol (`--remote-debugging-port`). It never touches the app's main process; everything it knows comes from the renderers.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const STARTUP_TIMEOUT_MS = 60_000;
const WATCHDOG_MS = 90_000;
const POLL_MS = 200;
const CDP_TIMEOUT_MS = 5_000;

// Mirrors YTMViewSetupCompletionFlags (src/shared/types.ts:15-26). Every step of the music preload bundle must have completed.
const SETUP_FLAGS = { Early: 2, Styles: 4, Navigation: 8, Hooks: 16, Remote: 32, Extras: 64 };
const REQUIRED_SETUP_FLAGS = Object.values(SETUP_FLAGS).reduce((all, flag) => all | flag, 0);

// Installed in the main world of every page before its own scripts run (and immediately in the current document). The music preload bundle
// reports completion by `window.postMessage({ op: "ytmd-ready" | "ytmd-errored", ... })` (src/renderer/ytmview/scripts/index.ts:45-96) and the
// ytmview preload forwards it to the main process (src/renderer/ytmview/preload.ts:31-32). Only this message says which setup steps finished.
const RECORDER = `(() => {
  if (window.__YTMD_TEST_RECORDER__) return;
  const recorder = (window.__YTMD_TEST_RECORDER__ = { early: document.readyState === "loading", messages: [] });
  window.addEventListener("message", event => {
    const data = event.data;
    if (!data || (data.op !== "ytmd-ready" && data.op !== "ytmd-errored")) return;
    recorder.messages.push({
      op: data.op,
      completions: data.completions,
      error: data.error ? String(data.error.stack || data.error.message || data.error) : undefined
    });
  });
})()`;

const MUSIC_PROBE = `(() => {
  const recorder = window.__YTMD_TEST_RECORDER__;
  const hook = window.__YTMD_HOOK__;
  const api = hook && hook.ytmPlayerController && hook.ytmPlayerController.playerApi;
  return {
    url: location.origin + location.pathname,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    width: innerWidth,
    height: innerHeight,
    recorder: !!recorder,
    recorderEarly: !!(recorder && recorder.early),
    messages: recorder ? recorder.messages : [],
    hook: !!hook,
    store: !!(hook && hook.ytmStateStore && hook.ytmStateStore.store),
    search: !!document.querySelector("ytmusic-search-box"),
    playerBar: !!document.querySelector("ytmusic-player-bar"),
    playerReady: !!(api && typeof api.isReady === "function" && api.isReady() === true),
    volume: api && typeof api.getVolume === "function" ? api.getVolume() : null
  };
})()`;

const SHELL_PROBE = `({ url: location.href, readyState: document.readyState, visibility: document.visibilityState, width: innerWidth, height: innerHeight,
  loadingOverlay: !!document.querySelector(".ytmview-loading-container"), text: document.body ? document.body.innerText.slice(0, 500) : "" })`;

const CONSENT_REJECT = `(() => {
  if (document.readyState !== "complete") return false;
  const button = [...document.querySelectorAll("button")].find(candidate => candidate.innerText === "Reject all" && candidate.getClientRects().length);
  if (!button) return false;
  button.click();
  return true;
})()`;

const READ_VOLUME = `window.__YTMD_HOOK__.ytmPlayerController.playerApi.getVolume()`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Cdp {
  static connect(url, timeoutMs = CDP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const cdp = new Cdp(ws);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`DevTools connection timed out: ${url}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(cdp);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`DevTools connection failed: ${url}`));
      });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener("message", event => this.onMessage(event.data));
    ws.addEventListener("close", () => this.onClose());
  }

  onMessage(raw) {
    const message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    } else {
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
    }
  }

  onClose() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method}: DevTools connection closed`));
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error(`${method}: DevTools connection closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function evaluate(cdp, expression, timeoutMs = CDP_TIMEOUT_MS) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function newestMtime(entries) {
  const newest = { time: 0, file: "" };
  const visit = entry => {
    if (!fs.existsSync(entry)) return;
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) if (child !== "node_modules") visit(path.join(entry, child));
    } else if (stat.mtimeMs > newest.time) {
      newest.time = stat.mtimeMs;
      newest.file = entry;
    }
  };
  entries.forEach(visit);
  return newest;
}

// Locates the packaged binary and refuses a build that is older than the sources, so a stale out/ can never pass for the current code.
function resolveApp() {
  const appDir = path.join(root, "out", `${pkg.productName}-${process.platform}-${process.arch}`);
  // executableName from forge.config.mts; macOS keeps the product name.
  const executable =
    process.env.YTMD_TEST_EXECUTABLE ||
    (process.platform === "darwin"
      ? path.join(appDir, `${pkg.productName}.app`, "Contents", "MacOS", pkg.productName)
      : path.join(appDir, `youtube-music-desktop-app${process.platform === "win32" ? ".exe" : ""}`));
  if (!fs.existsSync(executable)) throw new Error(`Packaged app not found: ${executable}. Run "pnpm package" first.`);

  const asar = path.join(path.dirname(executable), process.platform === "darwin" ? "../Resources" : "resources", "app.asar");
  if (!fs.existsSync(asar)) throw new Error(`Packaged app has no app.asar: ${asar}`);
  const sources = ["src", "config", "package.json", "forge.config.mts"].map(entry => path.join(root, entry));
  const newest = newestMtime(sources);
  if (fs.statSync(asar).mtimeMs < newest.time) {
    throw new Error(`Packaged app is older than the sources (${path.relative(root, newest.file)} changed after ${asar}). Run "pnpm package" again.`);
  }
  return { executable, asar };
}

function preflight() {
  if (typeof WebSocket !== "function" || typeof fetch !== "function") throw new Error(`Node.js 22 or newer is required (running ${process.version})`);
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error("A graphical session is required (DISPLAY/WAYLAND_DISPLAY is not set)");
  // The packaged app registers the ytmd:// protocol handler (src/main/services/protocolmanager/index.ts:40-49) and applies login-item settings
  // (src/main/services/configstore/index.ts:209). On Linux both are redirected into temporary directories below; elsewhere they would land in
  // the registry/LaunchServices, which this runner will not touch unless it is explicitly allowed.
  if (process.platform !== "linux" && process.env.YTMD_TEST_ALLOW_PROTOCOL_REGISTRATION !== "1") {
    throw new Error(
      "Running the packaged app registers the ytmd:// protocol handler with the OS on this platform. Set YTMD_TEST_ALLOW_PROTOCOL_REGISTRATION=1 to allow it."
    );
  }
}

async function main() {
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  const output = fs.mkdtempSync(path.join(root, "out", "startup-"));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ytmd-startup-"));
  const profile = path.join(scratch, "profile");
  fs.mkdirSync(profile);
  const log = fs.createWriteStream(path.join(output, "electron.log"));

  const report = { passed: false, detail: "", errors: [], warnings: [], app: null, targets: [], music: null, shell: null, overlay: null, volume: null };
  const save = () => fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  const addError = message => {
    const text = String(message).slice(0, 1000);
    if (report.errors.length < 200 && !report.errors.includes(text)) report.errors.push(text);
  };
  const warn = message => {
    if (!report.warnings.includes(message)) report.warnings.push(message);
  };

  let child = null;
  let childExit = null;
  let finishing = false;
  let finished;
  const finishedPromise = new Promise(resolve => (finished = resolve));
  const targets = new Map();
  let base = "";
  let lastStatus = "app not started";
  let watchdog;
  let startupTimer;

  const killTree = signal => {
    if (!child || childExit) return;
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  };

  async function refreshTargets() {
    const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) });
    const list = await response.json();
    const seen = new Set();
    for (const info of list) {
      if (!["page", "webview"].includes(info.type) || !info.webSocketDebuggerUrl || info.url.startsWith("devtools://")) continue;
      seen.add(info.id);
      let target = targets.get(info.id);
      if (!target) {
        target = { id: info.id, wsUrl: info.webSocketDebuggerUrl, url: info.url, title: info.title, cdp: null, attached: false, attachedAt: 0, reloaded: false };
        targets.set(info.id, target);
        attach(target).catch(error => {
          addError(`Could not attach to ${target.url}: ${error.message}`);
          target.cdp?.close();
          targets.delete(target.id);
        });
      }
      target.url = info.url;
      target.title = info.title;
    }
    for (const [id, target] of targets) {
      if (seen.has(id)) continue;
      target.cdp?.close();
      targets.delete(id);
    }
    report.targets = [...targets.values()].map(target => target.url);
    for (const target of targets.values()) {
      if (target.url.startsWith("chrome-error://")) addError(`A page failed to load (${target.url})`);
    }
  }

  async function attach(target) {
    const cdp = await Cdp.connect(target.wsUrl);
    target.cdp = cdp;
    cdp.on("Runtime.consoleAPICalled", params => {
      if (params.type === "error") addError(`${target.url}: ${params.args.map(arg => arg.value ?? arg.description ?? "").join(" ")}`);
    });
    cdp.on("Runtime.exceptionThrown", params => addError(`${target.url}: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`));
    cdp.on("Inspector.targetCrashed", () => {
      addError(`Renderer crashed: ${target.url}`);
      report.crashed = true;
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Inspector.enable").catch(() => {});
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
    await evaluate(cdp, RECORDER);
    target.attachedAt = Date.now();
    target.attached = true;
  }

  const find = prefix => [...targets.values()].find(target => target.attached && (prefix instanceof RegExp ? prefix.test(target.url) : target.url.startsWith(prefix)));

  async function shutdown() {
    for (const target of targets.values()) target.cdp?.close();
    if (!child || childExit) return;
    // SIGTERM only the main process so the app quits through its own shutdown path; signalling the whole group also kills Chromium's
    // helper processes underneath it, which makes the browser process crash (SIGILL) instead of exiting cleanly.
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("close", resolve)), sleep(5000)]);
    report.exit = childExit ? { code: childExit.code, signal: childExit.signal } : "did not exit within 5s of SIGTERM";
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL"); // leftover helper processes, if any
      } catch {}
    } else killTree("SIGKILL");
  }

  async function screenshot(target, name) {
    const result = await target.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, 10_000);
    const png = Buffer.from(result.data, "base64");
    if (png.length < 24 || png.readUInt32BE(16) === 0 || png.readUInt32BE(20) === 0) throw new Error("Screenshot is empty");
    fs.writeFileSync(path.join(output, `${name}.png`), png);
  }

  async function finish(passed, detail) {
    if (finishing) return;
    finishing = true;
    clearTimeout(startupTimer);
    report.passed = passed;
    report.detail = detail;
    save();

    // Inspect and capture evidence. A failed capture fails the run, as before; failing runs capture best effort.
    const music = find(/^https:\/\/(music|consent)\.youtube\.com\//);
    const shell = find("ytmd-app://titlebar");
    const overlay = find("ytmd-app://main");
    for (const [key, target, expression] of [
      ["music", music, MUSIC_PROBE],
      ["shell", shell, SHELL_PROBE],
      ["overlay", overlay, SHELL_PROBE]
    ]) {
      if (!target) continue;
      try {
        report[key] = await evaluate(target.cdp, expression, 3000);
      } catch (error) {
        addError(`${key}: ${error.message}`);
        report.passed = false;
      }
    }
    save();
    for (const [name, target] of [
      ["shell", shell],
      ["page", music]
    ]) {
      if (!target) {
        if (passed) {
          addError(`${name}: no page to capture`);
          report.passed = false;
        }
        continue;
      }
      try {
        await screenshot(target, name);
      } catch (error) {
        addError(`${name}: ${error.message}`);
        report.passed = false;
      }
    }
    save();
    await shutdown();
    finished();
  }

  // Result of one music-view assessment: `fatal` ends the run, otherwise `waiting` lists what is still missing.
  function assessMusic(probe, shell, overlay) {
    const waiting = [];
    const errored = probe.messages.filter(message => message.op === "ytmd-errored");
    if (errored.length) return { fatal: `Music preload reported an error: ${errored.map(message => message.error).join(" | ")}`, waiting };
    const ready = probe.messages.find(message => message.op === "ytmd-ready");
    if (!ready) waiting.push("music preload has not reported ytmd-ready for this document");
    else if ((ready.completions & REQUIRED_SETUP_FLAGS) !== REQUIRED_SETUP_FLAGS) {
      const missing = Object.entries(SETUP_FLAGS).filter(([, flag]) => !(ready.completions & flag)).map(([name]) => name);
      return { fatal: `Music preload finished incomplete (completions ${ready.completions}); missing setup steps: ${missing.join(", ")}`, waiting };
    }
    if (probe.readyState !== "complete") waiting.push(`music document is ${probe.readyState}`);
    if (!probe.hook || !probe.store) waiting.push("__YTMD_HOOK__ is not set");
    if (!probe.search) waiting.push("search box is missing");
    if (!probe.playerBar) waiting.push("player bar is missing");
    if (!probe.playerReady) waiting.push("player API is not ready");
    if (probe.visibility !== "visible") waiting.push(`music view is ${probe.visibility}, not visible`);
    if (probe.width < 400 || probe.height < 200) waiting.push(`music view is ${probe.width}x${probe.height}`);
    if (!shell) waiting.push("main window (titlebar) page not found");
    else if (shell.visibility !== "visible") waiting.push(`main window is ${shell.visibility}, not visible`);
    if (overlay?.loadingOverlay) waiting.push("loading overlay is still showing");
    return { fatal: null, waiting };
  }

  async function inspectMusic(target) {
    const probe = await evaluate(target.cdp, MUSIC_PROBE, 3000);
    const shellTarget = find("ytmd-app://titlebar");
    const overlayTarget = find("ytmd-app://main");
    const shell = shellTarget && (await evaluate(shellTarget.cdp, SHELL_PROBE, 3000));
    const overlay = overlayTarget && (await evaluate(overlayTarget.cdp, SHELL_PROBE, 3000));
    return { probe, shell, overlay, ...assessMusic(probe, shell, overlay) };
  }

  async function waitFor(label, timeoutMs, check) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (finishing) throw new Error("Run finished early");
      await refreshTargets();
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await sleep(250);
    }
  }

  // Desktop volume path: titlebar button -> miniplayer window -> main process (src/main/index.ts remoteControl:execute handler)
  // -> ProtectedAPI RemoteControl -> ytmview remote.ts "setVolume" -> YouTube Music player. Read back from the player itself.
  async function volumeRoundTrip(music) {
    const original = await evaluate(music.cdp, READ_VOLUME);
    if (!Number.isInteger(original) || original < 0 || original > 100) throw new Error(`Unexpected initial player volume: ${original}`);
    const testVolume = original === 37 ? 63 : 37;
    const result = { original, testVolume, actual: null, restored: null };
    report.volume = result;

    const shell = find("ytmd-app://titlebar");
    if (!shell) throw new Error("Main window (titlebar) page not found");
    await evaluate(
      shell.cdp,
      `(() => { if (typeof window.ytmd?.openMiniplayerWindow !== "function") throw new Error("openMiniplayerWindow is not exposed"); window.ytmd.openMiniplayerWindow(); return true; })()`
    );
    const send = (miniplayer, volume) =>
      evaluate(
        miniplayer.cdp,
        `(() => { if (typeof window.ytmd?.executeCommandInYTMView !== "function") throw new Error("executeCommandInYTMView is not exposed"); window.ytmd.executeCommandInYTMView("setVolume", ${volume}); return true; })()`
      );
    const miniplayer = await waitFor("the miniplayer window", 15_000, () => find("ytmd-app://miniplayer"));
    const waitForVolume = (expected, label) =>
      waitFor(label, 8000, async () => (find(/^https:\/\/music\.youtube\.com\//) && (await evaluate(music.cdp, READ_VOLUME)) === expected) || false);
    try {
      await send(miniplayer, testVolume);
      await waitForVolume(testVolume, `desktop volume command to reach the player (${testVolume})`).then(
        () => (result.actual = testVolume),
        async () => {
          result.actual = await evaluate(music.cdp, READ_VOLUME).catch(() => null);
          throw new Error(`Desktop volume control did not reach the player (expected ${testVolume}, player reports ${result.actual})`);
        }
      );
    } finally {
      // Always try to put the original volume back, even when the check failed.
      try {
        await send(miniplayer, original);
        await waitForVolume(original, `volume restore (${original})`);
        result.restored = original;
      } catch (error) {
        result.restored = false;
        addError(`Volume restore failed: ${error.message}`);
      }
    }
    if (result.restored !== original) throw new Error(`Original player volume ${original} was not restored`);

    // Closing the miniplayer shows the main window again.
    await evaluate(miniplayer.cdp, `window.ytmd.closeWindow()`).catch(() => {});
    await waitFor("the miniplayer window to close", 15_000, () => !find("ytmd-app://miniplayer"));
  }

  async function runChecks() {
    let volumeDone = false;
    while (!finishing) {
      if (childExit) return finish(false, `App exited before the check completed (${childExit.signal ?? `code ${childExit.code}`})`);
      try {
        await refreshTargets();
        lastStatus = "waiting for the music view";

        const consent = find(/^https:\/\/consent\.youtube\.com\//);
        if (consent) {
          lastStatus = "consent page is showing";
          if (await evaluate(consent.cdp, CONSENT_REJECT, 3000).catch(() => false)) warn("A cookie consent page appeared; optional cookies were rejected");
        }

        const music = find(/^https:\/\/music\.youtube\.com\//);
        if (music && music.cdp.closed === false) {
          const inspected = await inspectMusic(music);
          if (inspected.fatal) return finish(false, inspected.fatal);
          lastStatus = inspected.waiting.join("; ") || "music view ready";

          // The recorder missed the start of this document, so a completed preload could have gone unnoticed: reload once to observe a full run.
          if (!inspected.probe.recorderEarly && !inspected.probe.messages.length && !music.reloaded && Date.now() - music.attachedAt > 15_000) {
            music.reloaded = true;
            warn("The music page was reloaded once because its start-up could not be observed from the beginning");
            await music.cdp.send("Page.reload");
          } else if (!inspected.waiting.length && !volumeDone) {
            report.music = inspected.probe;
            report.shell = inspected.shell;
            report.overlay = inspected.overlay;
            await volumeRoundTrip(music);
            volumeDone = true;
            // The window and view must be visible again after the miniplayer closed.
            const final = await waitFor("the music view to be visible again", 15_000, async () => {
              const again = find(/^https:\/\/music\.youtube\.com\//);
              if (!again) return false;
              const check = await inspectMusic(again);
              if (check.fatal) throw new Error(check.fatal);
              return check.waiting.length ? false : check;
            });
            report.music = final.probe;
            report.shell = final.shell;
            report.overlay = final.overlay;
            return finish(true, "Music initialization complete; view visible, search and player ready, desktop volume control working");
          }
        }
        if (report.crashed) return finish(false, "A renderer process crashed");
      } catch (error) {
        if (finishing) return;
        lastStatus = `${lastStatus} (${error.message})`;
        // A failure inside the volume stage is a real failure, not something to poll through.
        if (report.volume) return finish(false, error.message);
      }
      await sleep(POLL_MS);
    }
  }

  try {
    preflight();
    const app = resolveApp();
    report.app = { executable: app.executable, asar: app.asar, asarModified: fs.statSync(app.asar).mtime.toISOString() };

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.platform === "linux") {
      // Keep the OS-level side effects of the app (xdg protocol handler, autostart entry) away from the real user session.
      const xdg = path.join(scratch, "xdg");
      const bin = path.join(scratch, "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "xdg-settings"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      Object.assign(env, {
        XDG_CONFIG_HOME: path.join(xdg, "config"),
        XDG_DATA_HOME: path.join(xdg, "data"),
        XDG_STATE_HOME: path.join(xdg, "state"),
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`
      });
    }
    const args = [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      "--disable-gpu", // software rendering
      "--lang=en-US" // English consent UI
    ];
    child = spawn(app.executable, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        killTree("SIGKILL");
        process.exit(130);
      });
    }
    child.on("error", error => finish(false, `Could not start the app: ${error.message}`));
    child.on("close", (code, signal) => (childExit = { code, signal }));

    watchdog = setTimeout(() => {
      report.detail ||= "Watchdog: the check did not finish within 90 seconds";
      report.passed = false;
      save();
      killTree("SIGKILL");
      finished();
    }, WATCHDOG_MS);
    startupTimer = setTimeout(
      () => finish(false, `YouTube Music did not become visible and ready within ${STARTUP_TIMEOUT_MS / 1000} seconds; last state: ${lastStatus}`),
      STARTUP_TIMEOUT_MS
    );
    runChecks().catch(error => finish(false, String(error)));
    await finishedPromise;
  } catch (error) {
    report.passed = false;
    report.detail = String(error.message ?? error);
  } finally {
    clearTimeout(watchdog);
    clearTimeout(startupTimer);
    killTree("SIGKILL");
    for (const target of targets.values()) target.cdp?.close();
    if (!report.detail) report.detail = "Check ended without a result";
    save();
    log.end();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const passed = report.passed === true;
  console.log(`Startup ${passed ? "PASS" : "FAIL"}: ${output}${passed ? "" : `\n${report.detail}`}`);
  process.exitCode = passed ? 0 : 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
