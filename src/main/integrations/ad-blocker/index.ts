import { app, session } from "electron";
import { FiltersEngine, Request } from "@ghostery/adblocker";
import log from "electron-log";

import YTMViewManager from "../../services/ytmviewmanager";
import PlayerStateStore from "../../services/playerstatestore";
import { PlayerState } from "~shared/playerstatestore/types";
import { YTMViewSetupCompletionFlags, YTMViewStatus } from "~shared/types";

// EasyList + EasyPrivacy filter list URLs (same lists used by uBlock Origin / Brave)
const FILTER_LISTS = [
  "https://easylist.to/easylist/easylist.txt",
  "https://easylist.to/easylist/easyprivacy.txt",
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext"
];

// CSS to hide ad-related UI elements in YouTube Music
const AD_HIDE_CSS = `
  /* Hide ad overlays in the video player */
  .ytp-ad-overlay-container,
  .ytp-ad-message-container,
  .ytp-ad-overlay-slot,
  .ytp-paid-content-overlay,
  .ytp-ad-skip-button-slot,
  .ytp-ad-module {
    display: none !important;
  }

  /* Hide promotional banners and upsell prompts */
  ytmusic-promoted-sparkles-web-renderer,
  ytmusic-promoted-sparkles-text-search-renderer,
  ytmusic-statement-banner-renderer,
  .ytmusic-mealbar-promo-renderer,
  tp-yt-paper-dialog:has(.ytmusic-mealbar-promo-renderer) {
    display: none !important;
  }

  /* Force audio-only: hide the video element in the player.
     The Song mode script handles switching to audio counterparts,
     but for tracks without a Song version this CSS hides the video
     so the album art / thumbnail is visible instead. */
  #movie_player .html5-video-container video {
    visibility: hidden !important;
  }
`;

// Script injected into YTM to force "Song" mode instead of "Video" mode.
// When a music video (OMV/UGC) starts playing, this detects it via the playerApi
// and navigates to the audio-only counterpart (ATV) if available.
// This saves significant CPU/GPU resources by avoiding video decode entirely.
const FORCE_SONG_MODE_SCRIPT = `
(function() {
  'use strict';

  if (window.__YTMD_FORCE_SONG_MODE__) return;
  window.__YTMD_FORCE_SONG_MODE__ = true;

  var hook = window.__YTMD_HOOK__;
  var ytmStore = hook && hook.ytmStateStore && hook.ytmStateStore.store;
  if (!ytmStore) return;

  var playerBar = hook.ytmPlayerController;
  if (!playerBar || !playerBar.playerApi) return;

  var lastHandledVideoId = '';
  var isSwitching = false;

  playerBar.playerApi.addEventListener("onVideoDataChange", function(event) {
    if (event.playertype !== 1 || event.type !== 'dataloaded') return;
    if (isSwitching) return;

    var response = playerBar.playerApi.getPlayerResponse();
    if (!response || !response.videoDetails) return;

    var musicVideoType = response.videoDetails.musicVideoType;
    var videoId = response.videoDetails.videoId;

    // Only switch for actual music videos, not audio tracks / uploads / podcasts
    if (musicVideoType !== 'MUSIC_VIDEO_TYPE_OMV' &&
        musicVideoType !== 'MUSIC_VIDEO_TYPE_UGC') {
      lastHandledVideoId = videoId;
      return;
    }

    // Don't re-trigger for the same video
    if (videoId === lastHandledVideoId) return;
    lastHandledVideoId = videoId;

    // Look for the Song counterpart in the queue
    var state = ytmStore.getState();
    if (!state.queue || !state.queue.items) return;

    var idx = state.queue.selectedItemIndex;
    if (idx === undefined || idx === null || !state.queue.items[idx]) return;

    var counterparts = state.queue.items[idx].counterparts;
    if (!counterparts || counterparts.length === 0) return;

    // Find a counterpart with a different videoId (the Song/ATV version)
    var songId = null;
    for (var i = 0; i < counterparts.length; i++) {
      if (counterparts[i].videoId && counterparts[i].videoId !== videoId) {
        songId = counterparts[i].videoId;
        break;
      }
    }

    if (!songId) return;

    // Mark as handled to prevent re-triggering when the Song version loads
    lastHandledVideoId = songId;
    isSwitching = true;

    var playlistId = playerBar.playerApi.getPlaylistId() || '';
    document.dispatchEvent(new CustomEvent('yt-navigate', {
      detail: {
        endpoint: {
          watchEndpoint: {
            videoId: songId,
            playlistId: playlistId
          }
        }
      },
      bubbles: true,
      composed: true
    }));

    // Reset switching flag after navigation completes
    setTimeout(function() { isSwitching = false; }, 3000);
  });
})
`;

// Script injected into YTM to auto-dismiss the "Are you still listening?" popup.
// YouTube Music pauses playback after long idle periods and shows a confirmation dialog.
// Simply hiding it with CSS is not enough — the music stays paused. This observer
// detects the popup and clicks the dismiss button automatically, resuming playback.
const AUTO_DISMISS_YOU_THERE_SCRIPT = `
(function() {
  'use strict';

  if (window.__YTMD_YOU_THERE_DISMISS__) return;
  window.__YTMD_YOU_THERE_DISMISS__ = true;

  // Check if the "you there" dialog is actually visible and active
  function isYouThereActive() {
    var dialog = document.querySelector('ytmusic-you-there-renderer');
    if (!dialog) return false;

    // Check if it's part of an open paper-dialog
    var paperDialog = dialog.closest('tp-yt-paper-dialog');
    if (paperDialog && paperDialog.style.display === 'none') return false;

    // Check if the element itself is visible (has dimensions)
    var rect = dialog.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function dismissYouThere() {
    if (!isYouThereActive()) return false;

    var dialog = document.querySelector('ytmusic-you-there-renderer');
    var button = dialog.querySelector('#button button, tp-yt-paper-button#button, .yt-spec-button-shape-next');
    if (!button) {
      button = dialog.querySelector('button, tp-yt-paper-button, a[role="button"]');
    }

    if (button) {
      button.click();

      // Resume playback after dismissing — the popup pauses the player
      setTimeout(function() {
        var controller = window.__YTMD_HOOK__ && window.__YTMD_HOOK__.ytmPlayerController;
        var playerApi = controller && controller.playerApi;
        // 1 = playing (same check as the RemoteControl playPause command)
        if (playerApi && playerApi.getPlayerState() !== 1) {
          playerApi.playVideo();
        }
      }, 500);

      return true;
    }

    return false;
  }

  // Watch for the dialog appearing in the DOM
  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var mutation = mutations[i];
      for (var j = 0; j < mutation.addedNodes.length; j++) {
        var node = mutation.addedNodes[j];
        if (node.nodeType !== 1) continue;

        if (node.tagName === 'YTMUSIC-YOU-THERE-RENDERER' ||
            (node.querySelector && node.querySelector('ytmusic-you-there-renderer'))) {
          setTimeout(dismissYouThere, 200);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Polling as safety net — only acts when popup is actually visible
  setInterval(function() {
    if (isYouThereActive()) {
      dismissYouThere();
    }
  }, 1000);
})
`;

// Script injected into YTM's main world to instantly skip video ads.
// Hooks directly into YTM's internal Redux store for real-time ad detection,
// then mutes + seeks to end of the ad video.
const AD_SKIP_SCRIPT = `
(function() {
  'use strict';

  if (window.__YTMD_AD_SKIP_ACTIVE__) return;
  window.__YTMD_AD_SKIP_ACTIVE__ = true;

  var savedVolume = -1;
  var adActive = false;

  function killAd() {
    var video = document.querySelector('video');
    if (!video) return;

    // Mute immediately so user hears nothing
    if (!adActive) {
      savedVolume = video.volume;
      adActive = true;
    }
    video.volume = 0;

    // Speed up to max so ad ends ASAP
    try { video.playbackRate = 16; } catch(e) {}

    // Seek to end
    if (video.duration && isFinite(video.duration) && video.duration > 0) {
      video.currentTime = video.duration;
    }

    // Click any skip button
    var skip = document.querySelector(
      '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, ' +
      '.ytp-ad-skip-button-slot button, .ytp-ad-skip-button-container button'
    );
    if (skip) skip.click();

    // Close overlay ads
    document.querySelectorAll(
      '.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container'
    ).forEach(function(btn) { btn.click(); });
  }

  function restoreAfterAd() {
    if (!adActive) return;
    adActive = false;

    var video = document.querySelector('video');
    if (video) {
      video.volume = savedVolume >= 0 ? savedVolume : 1;
      try { video.playbackRate = 1; } catch(e) {}
    }
    savedVolume = -1;
  }

  // PRIMARY: Subscribe to YTM's internal store for instant adPlaying detection
  // This fires the moment YouTube flags an ad — zero delay.
  if (window.__YTMD_HOOK__ && window.__YTMD_HOOK__.ytmStateStore) {
    var store = window.__YTMD_HOOK__.ytmStateStore.store;
    var wasAdPlaying = false;

    store.subscribe(function() {
      var state = store.getState();
      var isAd = state.player && state.player.adPlaying;

      if (isAd && !wasAdPlaying) {
        killAd();
        // Keep hammering in case seek/skip doesn't work first try
        var hammer = setInterval(function() {
          var s = store.getState();
          if (s.player && s.player.adPlaying) {
            killAd();
          } else {
            clearInterval(hammer);
            restoreAfterAd();
          }
        }, 50);
      }
      wasAdPlaying = isAd;
    });
  }

  // SECONDARY: Fast interval as fallback for ads the store might miss
  setInterval(function() {
    // Check via DOM: .ad-showing class on the player
    var player = document.querySelector('#movie_player');
    var isAd = player && player.classList.contains('ad-showing');

    if (isAd) {
      killAd();
    } else if (adActive) {
      // Also check store if available
      var storeAd = false;
      if (window.__YTMD_HOOK__ && window.__YTMD_HOOK__.ytmStateStore) {
        var state = window.__YTMD_HOOK__.ytmStateStore.store.getState();
        storeAd = state.player && state.player.adPlaying;
      }
      if (!storeAd) {
        restoreAfterAd();
      }
    }
  }, 100);
})
`;

// Always on, so deliberately not an IntegrationManager integration: integrations are toggled by a store property and are only
// enabled after the YTM view has started loading, while network blocking must be active before its first request.
export default class AdBlocker {
  private adPlaying = false;

  constructor(
    private readonly ytmViewManager: YTMViewManager,
    private readonly playerStateStore: PlayerStateStore
  ) {}

  public async enable(): Promise<void> {
    log.info("Ad Blocker: Initializing...");

    try {
      // Download and parse filter lists into a network-only blocking engine.
      // We skip cosmetic filters entirely — CSS hiding and ad-skip are handled
      // by our own injection to avoid conflicts with YTM's Polymer framework.
      const lists = await Promise.all(
        FILTER_LISTS.map(url =>
          fetch(url)
            .then(r => r.text())
            .catch(e => {
              log.warn(`Ad Blocker: Failed to fetch ${url}`, e);
              return "";
            })
        )
      );

      const engine = FiltersEngine.parse(lists.join("\n"), {
        loadCosmeticFilters: false,
        loadNetworkFilters: true
      });

      // Must match the partition YTMViewManager.createView() assigns to the YTM view
      session.fromPartition(app.isPackaged ? "persist:ytmview" : "persist:ytmview-dev").webRequest.onBeforeRequest((details, callback) => {
        const { match } = engine.match(
          Request.fromRawDetails({
            url: details.url,
            sourceUrl: details.referrer || details.url,
            type: details.resourceType
          })
        );

        if (match) {
          log.debug(`Ad Blocker: Blocked ${details.url.substring(0, 80)}`);
        }
        callback({ cancel: match });
      });
      log.info("Ad Blocker: Network-level blocking enabled on ytmview session");
    } catch (error) {
      log.error("Ad Blocker: Failed to initialize network blocking", error);
    }

    this.ytmViewManager.on("status-changed", this.ytmViewStatusChanged);
    this.playerStateStore.on("state-changed", this.playerStateChanged);
    log.info("Ad Blocker: Fully initialized and active");
  }

  private ytmViewStatusChanged = () => {
    const webContents = this.ytmViewManager.getView()?.webContents;
    if (!webContents) return;

    switch (this.ytmViewManager.status) {
      // Entered once per loaded music.youtube.com document; inserted CSS only lasts for that document
      case YTMViewStatus.Hooking: {
        webContents.insertCSS(AD_HIDE_CSS).then(
          () => log.info("Ad Blocker: Cosmetic CSS injected"),
          error => log.error("Ad Blocker: Failed to inject cosmetic CSS", error)
        );
        break;
      }

      // YTM hooks are installed (window.__YTMD_HOOK__); the scripts guard against running twice per page
      case YTMViewStatus.Ready: {
        if (this.ytmViewManager.getSetupFlags() & YTMViewSetupCompletionFlags.LocationNotApplicable) return;
        for (const script of [AD_SKIP_SCRIPT, FORCE_SONG_MODE_SCRIPT, AUTO_DISMISS_YOU_THERE_SCRIPT]) {
          this.executeScript(script);
        }
        break;
      }
    }
  };

  private playerStateChanged = (state: PlayerState) => {
    // Run the ad skip script when YTM reports an ad starting; a no-op if it is already active in the page
    if (state.adPlaying && !this.adPlaying) this.executeScript(AD_SKIP_SCRIPT);
    this.adPlaying = state.adPlaying;
  };

  private executeScript(script: string) {
    this.ytmViewManager
      .getView()
      ?.webContents?.executeJavaScript(`(${script})()`)
      .catch(error => log.error("Ad Blocker: Failed to execute YTM script", error));
  }
}
