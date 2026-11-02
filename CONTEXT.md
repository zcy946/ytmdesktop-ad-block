# Project context

This is an Electron/Vue YouTube Music desktop fork with built-in ad blocking. Electron Forge and Vite build the main process, sandboxed preloads and Vue windows. See [README.md](README.md) for build and startup-check commands.

## Startup and player integration

- `src/main/index.ts` owns the main window, configuration and IPC. The embedded YouTube Music view is a `WebContentsView` created by `YTMViewManager` (`src/main/services/ytmviewmanager/index.ts`) and wrapped by `AppView` (`src/main/services/windowmanager/appview.ts`). The host window is shown after its local page finishes loading (`src/main/services/windowmanager/appwindow.ts:447-449`); `ready-to-show` was observed never firing on Linux with software rendering, so `did-finish-load` is the fallback.
- The music preload (`src/renderer/ytmview/preload.ts`) bails on hosts other than `music.youtube.com` and otherwise injects the bundle `src/renderer/ytmview/scripts/index.ts` (`webFrame.executeJavaScript`, preload.ts:96). The bundle installs the fetch/XHR response filter (`setup/adblock.ts`) first, then waits for the YouTube hook and runs the styles, navigation, player-state, remote and extras setup. Each completed step sets a flag; the bundle's `finally` block reports `window.postMessage({ op: "ytmd-ready", completions })` (scripts/index.ts:90-96), which the preload forwards as `ytmView:ready` (preload.ts:31-32). `YTMViewManager` then sets `YTMViewStatus.Ready` and stores the flags (ytmviewmanager/index.ts:402-405). Failures arrive as `ytmd-errored` / `ytmView:errored`.
- Status flow: the view enters `YTMViewStatus.Hooking` when it reaches `music.youtube.com`, and `Ready` on `ytmView:ready`. Consent and Google account pages never post `ytmd-ready` because the preload bails there. Their `ready` event (dom-ready) marks the view `Ready` with the `LocationNotApplicable` flag instead (ytmviewmanager/index.ts:173-181).
- `src/renderer/ytmview/scripts/ytmhook.ts` wraps YouTube's dependency-injection `Map.set` to capture the player controller (`PLAYER_CONTROLLER_TOKEN`) and state store (`STATE_STORE_TOKEN`). The scripts see them as the frozen `window.__YTMD_HOOK__ = { ytmPlayerController, ytmStateStore }` (scripts/index.ts:25-29). Player commands and `playerApi` calls use `__YTMD_HOOK__.ytmPlayerController.playerApi`; state uses `ytmStateStore.store`. DOM insertion and events still use the elements themselves.
- The reproduction of the startup failure showed that the element-level `playerApi` was undefined while the player controller's `playerApi.isReady()` returned true, so the controller must be read from the hook.
- The loading view's 5-second timeout message (`src/renderer/components/YTMViewLoading.vue:24-27`) does not say which setup step is pending. The completion flags in `ytmd-ready` do.

## Ad blocking design

- `AdBlocker` (`src/main/integrations/ad-blocker/index.ts`) is always on and is deliberately not an `IntegrationManager` integration, because network blocking must be active before the view's first request.
- `src/main/index.ts` awaits `enable()` before `ytmViewManager.createView()` (index.ts:620-624). `enable()` fetches EasyList, EasyPrivacy and a server list, parses them into a network-only `@ghostery/adblocker` `FiltersEngine`, and attaches `onBeforeRequest` to the `persist:ytmview` session (`persist:ytmview-dev` in development, matching ytmviewmanager/index.ts:162).
- Cosmetic CSS is inserted on `Hooking`. The ad-skip, force-song-mode and auto-dismiss scripts run via `executeJavaScript` on `Ready`, unless the flags mark the page `LocationNotApplicable`. A change to the playing ad state re-runs the ad-skip script.
- The in-page fetch/XHR response filter (`src/renderer/ytmview/scripts/setup/adblock.ts`) is separate from the network engine. It strips ad fields from YouTube's responses before the player reads them: fetch filters player, next and browse responses; XHR filters only player and next.

## Verification boundaries

`scripts/test-startup.cjs` launches the packaged app built by `pnpm package` (`out/<productName>-<platform>-<arch>/`) with a fresh temporary profile and drives it over the Chromium DevTools protocol (`--remote-debugging-port`); it never touches the app's main process. It refuses an `out/` build older than `src`, `config`, `package.json` or `forge.config.mts`. On Linux, protocol and login-item registration are redirected into temporary XDG directories; on Windows and macOS it refuses to run unless `YTMD_TEST_ALLOW_PROTOCOL_REGISTRATION=1` is set. It does not run a dev server, install an update or use a signed-in account. It captures runtime errors and separate host/page screenshots. The check must observe music initialization after navigation, not just the earlier consent-page signal.

Live anonymous startup, visible music UI and desktop volume control have been verified on Linux with software rendering. Windows, signed-in playback, hardware acceleration, installation and updates require their own runtime verification. A live-site check can fail when YouTube or the network changes; retain the evidence rather than weakening the assertion.

## Release builds

The manual `Windows Release Build` workflow (`.github/workflows/publish.yml`) builds Windows x64 artifacts with the current Node.js LTS (24 at the time of writing) and the pnpm lockfile (`pnpm install --frozen-lockfile`). It points the compiled updater at the current fork (`YTMD_UPDATE_FEED_OWNER` / `YTMD_UPDATE_FEED_REPOSITORY` from the repository) and passes the Last.fm secrets to the build. It only uploads build artifacts; publishing a GitHub release is a separate authorized step. Tag pushes no longer invoke the old multi-platform publishing workflow. See the release section in [README.md](README.md).
