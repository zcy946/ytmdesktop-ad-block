'use strict';

// Exercise AppWindow against the real Windows taskbar, without the music site or a user's profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  if (process.platform !== 'win32') {
    console.error(
      'Taskbar verification requires Windows and a running Explorer taskbar.',
    );
    process.exitCode = 1;
  } else {
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const scratch = fs.mkdtempSync(path.join(temporaryRoot, 'ytmd-taskbar-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      require('electron'),
      [__filename, `--user-data-dir=${scratch}`, '--disable-gpu'],
      { env, stdio: 'inherit' },
    );
    const cleanup = () => {
      assert.equal(path.dirname(fs.realpathSync(scratch)), temporaryRoot);
      assert.ok(path.basename(scratch).startsWith('ytmd-taskbar-'));
      fs.rmSync(scratch, { recursive: true, force: true });
    };
    child.once('error', (error) => {
      console.error(error);
      cleanup();
      process.exitCode = 1;
    });
    child.once('exit', (code) => {
      cleanup();
      process.exitCode = code ?? 1;
    });
  }
} else {
  const { app, BaseWindow, nativeImage } = require('electron');
  const ts = require('typescript');

  // AppWindow opens DevTools for unpackaged BrowserWindows; keep this fixture focused on the taskbar.
  app.on('web-contents-created', (_event, contents) => {
    contents.openDevTools = () => {};
  });

  // Load the actual window implementation; no dev server or mock of Electron's taskbar API.
  const source = path.join(
    root,
    'src/main/services/windowmanager/appwindow.ts',
  );
  const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(
    createRequire(source),
    loaded,
    loaded.exports,
  );
  const { AppWindow } = loaded.exports;

  const calls = [];
  const setThumbarButtons = BaseWindow.prototype.setThumbarButtons;
  BaseWindow.prototype.setThumbarButtons = function (buttons) {
    const succeeded = setThumbarButtons.call(this, buttons);
    calls.push({
      visible: this.isVisible(),
      tooltips: buttons.map((button) => button.tooltip),
      succeeded,
    });
    return succeeded;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const buttons = (playing) =>
    [
      ['Previous', 'play-previous-button.png'],
      [
        playing ? 'Pause' : 'Play',
        playing ? 'pause-button.png' : 'play-button.png',
      ],
      ['Next', 'play-next-button.png'],
    ].map(([tooltip, file]) => {
      const icon = nativeImage.createFromPath(
        path.join(root, 'src/assets/icons/controls', file),
      );
      assert.equal(icon.isEmpty(), false, `Missing taskbar icon: ${file}`);
      return { tooltip, icon, click() {} };
    });

  const failures = [];
  const check = (name, assertion) => {
    try {
      assertion();
      console.log(`PASS: ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.error(`FAIL: ${failures.at(-1)}`);
    }
  };
  const assertLastButtons = (expected) => {
    assert.ok(calls.length > 0, 'No native toolbar registration occurred');
    assert.equal(calls.at(-1).succeeded, true, 'Windows rejected the toolbar');
    assert.equal(
      calls.at(-1).visible,
      true,
      'Toolbar was registered before the window was visible',
    );
    assert.deepEqual(calls.at(-1).tooltips, expected);
  };

  const watchdog = setTimeout(() => {
    console.error('Taskbar verification timed out');
    app.exit(1);
  }, 15_000);

  app
    .whenReady()
    .then(async () => {
      const window = new AppWindow(
        'Browser',
        { destroyWindow() {} },
        {
          name: 'Taskbar verification',
          autoRecreate: false,
          waitForViews: false,
          electronOptions: {
            show: false,
            width: 400,
            height: 180,
            title: 'YTMDesktop taskbar verification',
          },
        },
      );
      check('creation does not register an empty hidden toolbar', () =>
        assert.equal(calls.length, 0),
      );

      window.setThumbarButtons(buttons(false));
      check('buttons are deferred while hidden', () =>
        assert.equal(calls.length, 0),
      );
      window.show();
      await sleep(500);
      check('first show registers Previous / Play / Next successfully', () =>
        assertLastButtons(['Previous', 'Play', 'Next']),
      );

      window.setThumbarButtons(buttons(true));
      check('visible playback changes update the toolbar', () =>
        assertLastButtons(['Previous', 'Pause', 'Next']),
      );

      window.hide();
      const callsBeforeHide = calls.length;
      window.setThumbarButtons(buttons(false));
      check('hidden playback changes do not touch the native toolbar', () =>
        assert.equal(calls.length, callsBeforeHide),
      );
      window.show();
      await sleep(500);
      check('returning from tray restores the latest paused buttons', () => {
        assert.ok(
          calls.length > callsBeforeHide,
          'No toolbar registration on show',
        );
        assertLastButtons(['Previous', 'Play', 'Next']);
      });

      window.hide();
      const callsBeforeRestore = calls.length;
      window.show();
      await sleep(500);
      check(
        'returning without a player event also restores the toolbar',
        () => {
          assert.ok(
            calls.length > callsBeforeRestore,
            'Restoration required a new player event',
          );
          assertLastButtons(['Previous', 'Play', 'Next']);
        },
      );

      window.destroyWindow();
      console.log(
        JSON.stringify(
          { passed: failures.length === 0, failures, calls },
          null,
          2,
        ),
      );
      clearTimeout(watchdog);
      app.exit(failures.length ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      clearTimeout(watchdog);
      app.exit(1);
    });
}
