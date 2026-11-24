import { app, session, shell, webFrameMain, type BrowserWindow, type WebContents } from 'electron';
import { join } from 'node:path';

// The official YouTube IFrame player, shown (≥ 200×200, nothing drawn over it) in the
// sidebar's living cover. It lives in a <webview> on its own session partition, so the
// Referer rule and the ad blocker apply to YouTube only, never to the rest of the app.
//
//   renderer <webview src="chud-yt://player/"> ── session persist:youtube
//     └ our page (served from memory below) → https://www.youtube.com/iframe_api → YT.Player
//
// The page talks to the renderer through a tiny preload (yt-guest): commands in, state out.

export const YT_SCHEME = 'chud-yt';
export const YT_PARTITION = 'persist:youtube';
export const YT_PLAYER_URL = `${YT_SCHEME}://player/`;
// YouTube's Required Minimum Functionality: embedded clients send an identifying Referer.
const APP_REFERER = 'https://app.chudmusic/';

const PLAYER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>YouTube</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}#yt{position:absolute;inset:0;width:100%;height:100%}</style>
</head><body><div id="yt"></div>
<script>
  const host = window.chudHost;
  let player = null, ready = false, pending = null, volume = 80, muted = false, timer = 0, rate = 1;
  const emit = (m) => host.send(m);
  const tick = () => {
    if (!player || !player.getCurrentTime) return;
    emit({ type: 'time', t: player.getCurrentTime() || 0, d: player.getDuration() || 0, loaded: player.getVideoLoadedFraction() || 0 });
  };
  const applyVolume = () => { player.setVolume(volume); if (muted || volume === 0) player.mute(); else player.unMute(); };
  // subtitles always off, whatever the video or YouTube's own defaults ask for
  const noCaptions = () => {
    try { player.setOption('captions', 'track', {}); } catch {}
    try { player.unloadModule('captions'); } catch {}
    try { player.unloadModule('cc'); } catch {}
  };
  const applyRate = () => { try { if (player.getPlaybackRate() !== rate) player.setPlaybackRate(rate); } catch {} };
  function run(c) {
    switch (c.op) {
      case 'load': player.loadVideoById({ videoId: c.id, startSeconds: c.start || 0 }); applyVolume(); noCaptions(); break;
      case 'play': player.playVideo(); break;
      case 'pause': player.pauseVideo(); break;
      case 'stop': player.stopVideo(); break;
      case 'seek': player.seekTo(c.t, true); setTimeout(tick, 50); break;
      case 'volume': volume = c.v; muted = c.muted; applyVolume(); break;
      case 'rate': rate = c.rate; applyRate(); break;
    }
  }
  host.onCommand((c) => {
    if (c.op === 'volume') { volume = c.v; muted = c.muted; }
    if (c.op === 'rate') rate = c.rate;
    if (ready) run(c);
    else if (c.op === 'load') pending = c;
    else if (c.op === 'stop' || c.op === 'pause') pending = null;
  });
  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('yt', {
      width: '100%', height: '100%',
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, playsinline: 1, rel: 0, iv_load_policy: 3, cc_load_policy: 0, origin: location.origin },
      events: {
        onReady: () => { ready = true; applyVolume(); emit({ type: 'ready' }); if (pending) { run(pending); pending = null; } },
        onStateChange: (e) => { if (e.data === 1 || e.data === 3) { noCaptions(); applyRate(); if (e.data === 1) { setTimeout(noCaptions, 1500); setTimeout(noCaptions, 5000); } } emit({ type: 'state', state: e.data }); clearInterval(timer); if (e.data === 1) timer = setInterval(tick, 250); tick(); },
        // the captions module loads after playback starts (or when a video forces it): off again
        onApiChange: () => noCaptions(),
        onError: (e) => emit({ type: 'error', code: e.data }),
      },
    });
  };
  window.addEventListener('error', (e) => emit({ type: 'log', message: String(e.message) }));
  // sound levels measured inside the YouTube frame (METER_JS), for the player bar's spectrum
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (/^https:\\/\\/(www\\.)?youtube(-nocookie)?\\.com$/.test(e.origin) && d && typeof d === 'object' && Array.isArray(d.chudLevels)) emit({ type: 'levels', l: d.chudLevels });
  });
</script>
<script src="https://www.youtube.com/iframe_api"></script>
</body></html>`;

/**
 * Runs inside YouTube's own player frame: measures the sound of its <video> for the spectrum of
 * the player bar. It listens to a copy of the stream (captureStream → AnalyserNode, connected to
 * nothing): playback, volume and output device are untouched, nothing is recorded or kept. Only
 * 22 band levels (0–255) leave the frame, ~30 times a second while the video plays.
 */
const METER_JS = `(() => {
  if (window.__chudMeter) return 'present';
  window.__chudMeter = true;
  const BANDS = 22;
  let ctx = null, an = null, bins = null, src = null, track = null, quiet = 0;
  const out = new Array(BANDS).fill(0);
  const hook = (v) => {
    const t = v.captureStream ? v.captureStream().getAudioTracks()[0] : null;
    if (!t) return false;
    if (!ctx) {
      ctx = new AudioContext();
      an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.7;
      bins = new Uint8Array(an.frequencyBinCount);
    }
    if (src) try { src.disconnect(); } catch {}
    src = ctx.createMediaStreamSource(new MediaStream([t]));
    src.connect(an);
    track = t;
    return true;
  };
  setInterval(() => {
    const v = document.querySelector('video');
    if (!v || v.paused || v.readyState < 2) {
      if (quiet++ === 0) parent.postMessage({ chudLevels: out.map(() => 0) }, '*');
      return;
    }
    quiet = 0;
    try {
      if ((!track || track.readyState === 'ended') && !hook(v)) return;
    } catch { return; }
    if (ctx.state === 'suspended') ctx.resume();
    an.getByteFrequencyData(bins);
    const nyquist = ctx.sampleRate / 2, n = an.frequencyBinCount;
    for (let i = 0; i < BANDS; i++) {
      // log-spaced bands from 40 Hz to 16 kHz, as the spectrum for local files
      const f0 = 40 * Math.pow(400, i / BANDS), f1 = 40 * Math.pow(400, (i + 1) / BANDS);
      const a = Math.floor((f0 / nyquist) * n), b = Math.max(a + 1, Math.floor((f1 / nyquist) * n));
      let m = 0;
      for (let k = a; k < b; k++) m = Math.max(m, bins[k]);
      out[i] = m;
    }
    parent.postMessage({ chudLevels: out.slice() }, '*');
  }, 33);
  return 'installed';
})()`;

/** Hides YouTube's subtitle layer inside its player frame (the player API turns them off too). */
const NO_CAPTIONS_JS = `(() => {
  if (document.getElementById('chud-no-cc')) return;
  const s = document.createElement('style');
  s.id = 'chud-no-cc';
  s.textContent = '.ytp-caption-window-container,.caption-window,.ytp-caption-segment{display:none!important}';
  (document.head || document.documentElement).appendChild(s);
  // a video that turns them on again (creator default, forced track) is switched off within a second
  setInterval(() => {
    const m = document.getElementById('movie_player');
    try { if (m && m.isSubtitlesOn && m.isSubtitlesOn()) m.toggleSubtitles(); } catch {}
    if (!document.getElementById('chud-no-cc')) (document.head || document.documentElement).appendChild(s);
  }, 1000);
})()`;

/**
 * Asks the official player, in its own frame and through its own quality setting (the one behind
 * its gear menu), for at most `cap` — or for its automatic choice again (null). Nothing of the
 * player is replaced or hidden; YouTube keeps the last word (a video without that quality, an ad).
 * Answers the quality the player reports afterwards.
 */
const qualityJs = (cap: string | null) => `(() => {
  const p = document.getElementById('movie_player');
  if (!p || !p.setPlaybackQualityRange) return null;
  try {
    if (${JSON.stringify(cap)}) p.setPlaybackQualityRange('tiny', ${JSON.stringify(cap)});
    else p.setPlaybackQualityRange('auto', 'auto');
  } catch { return null; }
  return p.getPlaybackQuality ? p.getPlaybackQuality() : null;
})()`;

export async function setYtQuality(cap: 'large' | null): Promise<string | null> {
  const frame = ytGuest()?.mainFrame.framesInSubtree.find((f) => /youtube(-nocookie)?\.com\/embed\//.test(f.url));
  if (!frame) return null;
  const now: unknown = await frame.executeJavaScript(qualityJs(cap === 'large' ? 'large' : null)).catch(() => null);
  return typeof now === 'string' ? now : null;
}

/**
 * Read-only look at YouTube's own player frame, when it does not play: does it show its error
 * screen, and does that screen ask to sign in ("Sign in to confirm you're not a bot")? Nothing is
 * clicked, hidden or changed; Chud Music never signs in (no Google account, by design).
 */
const BLOCKED_JS = `(() => {
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  let status = null;
  try {
    const p = document.getElementById('movie_player');
    const r = p && p.getPlayerResponse ? p.getPlayerResponse() : null;
    status = r && r.playabilityStatus ? r.playabilityStatus.status : null;
  } catch {}
  if (status === 'LOGIN_REQUIRED') return 'signin';
  const signin = [...document.querySelectorAll('a[href*="accounts.google."], a[href*="ServiceLogin"], a[href*="/signin"]')].some(shown);
  const error = [...document.querySelectorAll('.ytp-error, .ytp-error-content, [class*="error-screen"]')].some(shown);
  if (signin) return 'signin';
  if (error || status === 'ERROR' || status === 'UNPLAYABLE') return 'error';
  return null;
})()`;

export async function ytBlocked(): Promise<'signin' | 'error' | null> {
  // tests: the answer YouTube would give, without having to be refused for real
  const fake = process.env.CHUD_TEST_YT_BLOCKED;
  if (fake === 'signin' || fake === 'error') return fake;
  const frame = ytGuest()?.mainFrame.framesInSubtree.find((f) => /youtube(-nocookie)?\.com\/embed\//.test(f.url));
  if (!frame) return null;
  const v: unknown = await frame.executeJavaScript(BLOCKED_JS).catch(() => null);
  return v === 'signin' || v === 'error' ? v : null;
}

export const ytSchemePrivilege ={ scheme: YT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } };

let guest: WebContents | null = null;
export const ytGuest = () => (guest && !guest.isDestroyed() ? guest : null);

export function initYouTubeSession(win: BrowserWindow): Electron.Session {
  const ses = session.fromPartition(YT_PARTITION);
  ses.protocol.handle(YT_SCHEME, (req) => {
    const url = new URL(req.url);
    if (url.host !== 'player') return new Response('Not found', { status: 404 });
    return new Response(PLAYER_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] }, (d, cb) => {
    d.requestHeaders.Referer = APP_REFERER;
    cb({ requestHeaders: d.requestHeaders });
  });
  // No camera, microphone, notifications… for anything loaded in the player.
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));

  // Only our player page may be attached as a <webview>, always on the YouTube partition,
  // sandboxed, with our guest preload.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    if (!params.src?.startsWith(YT_PLAYER_URL)) {
      e.preventDefault();
      return;
    }
    params.partition = YT_PARTITION;
    prefs.preload = join(__dirname, '../preload/yt-guest.js');
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.autoplayPolicy = 'no-user-gesture-required';
    prefs.backgroundThrottling = false;
  });
  win.webContents.on('did-attach-webview', (_e, wc) => {
    guest = wc;
    // A click on the YouTube logo or title opens YouTube in the user's browser, never inside the app.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\/(www\.|music\.)?youtube\.com\//.test(url) || /^https:\/\/youtu\.be\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (ev, url) => {
      if (!url.startsWith(YT_PLAYER_URL)) ev.preventDefault();
    });
    if (!app.isPackaged) wc.on('console-message', (ev) => console.log('[yt-player]', ev.message));
    // the spectrum: a level meter in each YouTube player frame once it has loaded
    wc.on('did-frame-finish-load', (_ev, isMainFrame, processId, routingId) => {
      if (isMainFrame) return;
      const frame = webFrameMain.fromId(processId, routingId);
      if (frame && /^https:\/\/(www\.)?youtube(-nocookie)?\.com\/embed\//.test(frame.url)) {
        frame.executeJavaScript(METER_JS).catch(() => {});
        // and no subtitles ever drawn, even if a video forces them on
        frame.executeJavaScript(NO_CAPTIONS_JS).catch(() => {});
      }
    });
  });
  return ses;
}
