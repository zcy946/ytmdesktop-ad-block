// Fork (ytmdesktop-ad-block): strip ad data from YouTube Music's InnerTube responses
// before the player sees them (ReVanced/Brave approach). Must run before YTM's own scripts.
const AD_FIELDS = ["adPlacements", "adSlots", "playerAds", "adParams", "adBreakParams", "adBreakHeartbeatParams"];

function stripAdFields(json: any) {
  for (const field of AD_FIELDS) delete json[field];
  if (json.playerConfig) delete json.playerConfig.adRequestConfig;
}

export function installAdResponseFilter() {
  const win: any = window;
  const originalFetch = win.fetch;
  win.fetch = function (this: unknown, ...args: any[]) {
    const input = args[0];
    const url: string = typeof input === "string" ? input : (input?.url ?? "");
    const isPlayerApi = url.includes("/youtubei/v1/player");
    const isNextApi = url.includes("/youtubei/v1/next");
    const isBrowseApi = url.includes("/youtubei/v1/browse");
    if (!isPlayerApi && !isNextApi && !isBrowseApi) return originalFetch.apply(this, args);

    return originalFetch.apply(this, args).then((response: Response) =>
      response
        .clone()
        .text()
        .then(bodyText => {
          try {
            const json = JSON.parse(bodyText);
            stripAdFields(json);
            if (json.playbackTracking) {
              delete json.playbackTracking.ptrackingUrl;
              delete json.playbackTracking.qoeUrl;
              delete json.playbackTracking.atrUrl;
            }
            if (json.contents) {
              let contents = JSON.stringify(json.contents);
              if (contents.includes("promoted") || contents.includes("adSlot")) {
                contents = contents.replace(/"adSlot[^}]*}/g, "");
                try {
                  json.contents = JSON.parse(contents);
                } catch {
                  // Keep the original contents when the scrub produced invalid JSON
                }
              }
            }
            return new Response(JSON.stringify(json), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          } catch {
            return response; // Not JSON
          }
        })
    );
  };

  const xhrProto: any = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  const originalSend = xhrProto.send;
  xhrProto.open = function (this: any, ...args: any[]) {
    this.__ytmd_url = String(args[1] ?? "");
    return originalOpen.apply(this, args);
  };
  xhrProto.send = function (this: any, ...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const xhr = this;
    const url: string = xhr.__ytmd_url || "";
    if (url.includes("/youtubei/v1/player") || url.includes("/youtubei/v1/next")) {
      const originalOnReadyStateChange = xhr.onreadystatechange;
      xhr.onreadystatechange = function (...stateArgs: any[]) {
        if (xhr.readyState === 4) {
          try {
            const json = JSON.parse(xhr.responseText);
            stripAdFields(json);
            const patched = JSON.stringify(json);
            Object.defineProperty(xhr, "responseText", { writable: true, value: patched });
            Object.defineProperty(xhr, "response", { writable: true, value: patched });
          } catch {
            // Not JSON; leave the response untouched
          }
        }
        if (originalOnReadyStateChange) originalOnReadyStateChange.apply(xhr, stateArgs);
      };
    }
    return originalSend.apply(this, args);
  };
}
