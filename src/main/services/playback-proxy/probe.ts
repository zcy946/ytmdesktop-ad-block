import { BrowserWindow, type Session } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import type { ProxyNodeStatus, ProxyTestStatus } from "~shared/playback-proxy";

type Result = Pick<ProxyNodeStatus, "status" | "loadTime">;

// One public song is enough to distinguish a working audio stream from a page that only loads.
const sampleId = "5NV6Rdv1a3I";
const sampleUrl = `https://music.youtube.com/watch?v=${sampleId}&hl=en`;

function inspectPlayer(expectedVideo: string) {
  const text = document.body?.innerText ?? "";
  const player = document.querySelector("#movie_player") as (HTMLElement & { getVideoData?(): { video_id?: string } }) | null;
  const videoId = player?.getVideoData?.()?.video_id ?? new URLSearchParams(location.search).get("v");
  const video = document.querySelector("video");
  if (video?.paused) void video.play().catch(() => {});
  return {
    blocked: /sign in to confirm you.re not a bot/i.test(text),
    unavailable: /not available in your (country|region)|youtube music is not available|video is unavailable/i.test(text),
    ad: player?.classList.contains("ad-showing") || player?.classList.contains("ad-interrupting"),
    playing: player && videoId === expectedVideo && video && !video.paused && video.readyState >= 2,
    time: video?.currentTime ?? 0,
    audioBytes: (video as (HTMLVideoElement & { webkitAudioDecodedByteCount?: number }) | null)?.webkitAudioDecodedByteCount ?? 0,
  };
}

function redirectStatus(url: string): ProxyTestStatus | undefined {
  if (!url) return;
  const { hostname, pathname } = new URL(url);
  if (hostname === "consent.youtube.com" || hostname === "consent.google.com") return "consent";
  if (hostname === "accounts.google.com" || pathname === "/signin" || pathname === "/signin_prompt") return "sign-in";
  if (hostname === "www.google.com" && pathname.startsWith("/sorry")) return "verification";
  if ((hostname === "youtube.com" || hostname === "www.youtube.com") && pathname.includes("premium")) return "unavailable";
  if (hostname !== "music.youtube.com") return "unreachable";
}

export async function probePlayback(network: Session, cancellation: AbortSignal): Promise<Result> {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(18_000)]);
  signal.throwIfAborted();
  const probe = new BrowserWindow({
    show: false,
    webPreferences: {
      session: network,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  const contents = probe.webContents;
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));

  const start = Date.now();
  let loadTime: number | undefined;
  let redirected: ProxyTestStatus | undefined;
  contents.on("will-redirect", event => {
    redirected = redirectStatus(event.url);
    if (redirected) event.preventDefault();
  });
  const destroy = () => { if (!probe.isDestroyed()) probe.destroy(); };
  signal.addEventListener("abort", destroy, { once: true });
  try {
    await contents.loadURL(sampleUrl);
    const status = redirectStatus(contents.getURL());
    if (status) return { status };
    loadTime = Date.now() - start;

    let firstTime: number | undefined;
    while (!signal.aborted) {
      const state: ReturnType<typeof inspectPlayer> = await contents.executeJavaScript(`(${inspectPlayer.toString()})(${JSON.stringify(sampleId)})`);
      if (state.blocked) return { status: "sign-in", loadTime };
      if (state.unavailable) return { status: "unavailable", loadTime };
      if (!state.ad && state.playing && state.audioBytes > 0) {
        firstTime ??= state.time;
        if (state.time - firstTime >= 1.5) return { status: "playable", loadTime };
      } else {
        firstTime = undefined;
      }
      await delay(350, undefined, { signal });
    }
  } catch {
    cancellation.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", destroy);
    destroy();
  }
  return { status: redirected ?? (loadTime === undefined ? "unreachable" : "reachable"), loadTime };
}
