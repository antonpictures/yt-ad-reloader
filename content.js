// YouTube Ad Reloader — content script with ad history tracking
(function () {
  'use strict';

  const LOG = (...a) => console.log('[YT-AdReloader]', ...a);
  const MAX_HISTORY = 1000;

  // ---- Ad detection ----
  function isAdPlaying() {
    const player = document.querySelector('.html5-video-player');
    if (!player) return false;
    if (player.classList.contains('ad-showing')) return true;
    const skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if (skipBtn && skipBtn.offsetParent !== null) return true;
    const adOverlay = document.querySelector('.ytp-ad-overlay-container .ytp-ad-text, .ytp-ad-player-overlay, .ytp-ad-preview-container');
    if (adOverlay && adOverlay.offsetParent !== null) return true;
    return false;
  }

  // ---- Track last known content time ----
  let lastKnownTime = 0;
  let lastKnownVid = null;
  setInterval(() => {
    if (isAdPlaying()) return;
    const v = document.querySelector('video');
    if (v && v.currentTime > 0 && isFinite(v.currentTime)) {
      lastKnownTime = Math.floor(v.currentTime);
    }
    const vid = new URLSearchParams(location.search).get('v');
    if (vid && vid !== lastKnownVid) {
      lastKnownVid = vid;
      lastKnownTime = 0;   // never carry a position across videos
    }
  }, 500);

  new MutationObserver(() => {
    if (isAdPlaying()) return;
    const v = document.querySelector('video');
    if (v && v.currentTime > 0 && isFinite(v.currentTime)) {
      lastKnownTime = Math.floor(v.currentTime);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true });

  // ---- Capture ad metadata ----
  function captureAdInfo() {
    const info = {
      ts: Date.now(),
      pageUrl: location.href,
      videoId: new URLSearchParams(location.search).get('v') || null,
      videoTitle: document.title.replace(' - YouTube', '').trim(),
      videoTime: null,
      adVideoSrc: null,
      advertiser: null,
      adDuration: null,
      skipAvailable: false,
      skipButtonText: null,
    };

    let contentTime = null;
    if (isAdPlaying()) {
      if (lastKnownTime > 0) contentTime = lastKnownTime;
    } else {
      try {
        const player = document.querySelector('#movie_player');
        if (player && typeof player.getCurrentTime === 'function') {
          const t = player.getCurrentTime();
          if (t > 0 && isFinite(t)) contentTime = Math.floor(t);
        }
      } catch (e) {}
      if (contentTime === null && lastKnownTime > 0) contentTime = lastKnownTime;
      const v0 = document.querySelector('video');
      if (contentTime === null && v0 && v0.currentTime > 0) contentTime = Math.floor(v0.currentTime);
      // Never save a timestamp at the very end — seeking there looks like a bug.
      if (contentTime !== null && v0 && v0.duration && isFinite(v0.duration) && contentTime > v0.duration - 10) {
        contentTime = 0;
      }
    }

    const v = document.querySelector('video');
    if (v) {
      info.videoTime = contentTime;
      info.adVideoSrc = v.src || v.currentSrc || null;
      info.adDuration = v.duration && isFinite(v.duration) ? Math.floor(v.duration) : null;
    }

    const advSelectors = [
      '.ytp-ad-player-overlay-layout__advertiser',
      '.ytp-ad-text',
      '.ytp-ad-preview-text',
      '.ytp-ad-simple-ad-badge',
      '[class*="advertiser"]',
    ];
    for (const sel of advSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        info.advertiser = el.textContent.trim().slice(0, 100);
        break;
      }
    }

    const skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if (skipBtn) {
      info.skipAvailable = true;
      info.skipButtonText = skipBtn.textContent.trim().slice(0, 50);
    }

    if (info.adVideoSrc) {
      try {
        const u = new URL(info.adVideoSrc);
        info.adId = u.searchParams.get('adurl') || u.searchParams.get('adid') || u.searchParams.get('id') || null;
        if (!info.adId) {
          const m = info.adVideoSrc.match(/\/([^/]+)\.mp4/);
          if (m) info.adId = m[1].slice(0, 40);
        }
      } catch (e) {}
    }

    try {
      const pr = window.ytInitialPlayerResponse;
      if (pr && pr.adPlacements) {
        const ad = pr.adPlacements[0];
        if (ad) {
          info.adPlacementType = ad.adPlacementConfig?.adPlacementConfigType || null;
          const renderer = ad?.renderer?.companions?.[0] || ad?.renderer;
          if (renderer) {
            info.adTitle = renderer?.title || renderer?.headline || null;
          }
        }
      }
    } catch (e) {}

    return info;
  }

  // ---- Save to history ----
  function saveAdEvent(event) {
    try {
      chrome.storage.local.get('ad_history', (data) => {
        const history = data.ad_history || [];
        history.unshift(event);
        if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
        chrome.storage.local.set({ ad_history: history }, () => {
          LOG('Saved ad event. Total:', history.length);
        });
      });
    } catch (e) {
      LOG('Storage error:', e);
    }
  }

  // ---- Reload with timestamp preservation ----
  let reloadPending = false;
  let lastAdCheck = 0;
  const CHECK_INTERVAL = 150;
  const RELOAD_COOLDOWN = 1200;
  const MAX_RELOADS = 3;
  let reloadCount = 0;
  let tabSwitchAttempts = 0;
  const POST_RELOAD_GRACE = 2500;

  function recentlyReloaded() {
    try {
      const ts = sessionStorage.getItem('yt-ad-reloader-reloadts');
      if (ts && Date.now() - parseInt(ts, 10) < POST_RELOAD_GRACE) return true;
    } catch (e) {}
    return false;
  }

  function handleAd() {
    if (reloadPending) return;
    if (recentlyReloaded()) return;
    const now = Date.now();
    if (now - lastAdCheck < RELOAD_COOLDOWN) return;
    lastAdCheck = now;

    const adInfo = captureAdInfo();
    LOG('Ad detected!', adInfo.advertiser, 'videoTime:', adInfo.videoTime);

    let t = adInfo.videoTime;
    const vid = adInfo.videoId;
    if (t !== null && t > 0) {
      const v0 = document.querySelector('video');
      if (v0 && v0.duration && isFinite(v0.duration) && t > v0.duration - 10) t = 0;
    }

    if (reloadCount < MAX_RELOADS) {
      reloadCount++;
      saveAdEvent({ ...adInfo, action: 'reloaded', reloadedAt: Date.now(), attempt: reloadCount });
      if (t !== null && t > 0 && vid) {
        try {
          sessionStorage.setItem('yt-ad-reloader-time', String(t));
          sessionStorage.setItem('yt-ad-reloader-vid', vid);
          sessionStorage.setItem('yt-ad-reloader-reloadts', String(Date.now()));
        } catch (e) {}
        const url = new URL(location.href);
        url.searchParams.set('t', t + 's');
        LOG('Reloading to', url.toString(), '(attempt', reloadCount, ')');
        reloadPending = true;
        location.replace(url.toString());
      } else {
        LOG('No timestamp, plain reload (attempt', reloadCount, ')');
        try { sessionStorage.setItem('yt-ad-reloader-reloadts', String(Date.now())); } catch (e) {}
        reloadPending = true;
        location.reload();
      }
    } else if (tabSwitchAttempts < 1) {
      tabSwitchAttempts++;
      LOG('Max reloads reached — auto tab-switch escape');
      saveAdEvent({ ...adInfo, action: 'auto_tab_switch', reloadedAt: Date.now() });
      reloadPending = true;
      try { chrome.runtime.sendMessage({ type: 'escape-loop' }, (resp) => {
        LOG('Tab-switch done:', resp);
        reloadPending = false;
        reloadCount = 0;
        try { sessionStorage.setItem('yt-ad-reloader-reloadts', String(Date.now())); } catch (e) {}
        setTimeout(() => { if (!isAdPlaying()) handleAd(); }, 1000);
      }); } catch (e) {
        LOG('sendMessage error:', e);
        reloadPending = false;
      }
    } else {
      // Strategy 3: Redirect to yout-ube.com
      if (vid) {
        const youtUrl = 'https://www.yout-ube.com/watch?v=' + vid + (t > 0 ? '&t=' + t + 's' : '') + '&loop=0&autoplay=1';
        LOG('All strategies exhausted, redirecting to yout-ube.com:', youtUrl);
        saveAdEvent({ ...adInfo, action: 'redirected_to_yout_ube', reloadedAt: Date.now() });
        reloadPending = true;
        location.replace(youtUrl);
      } else {
        LOG('No video ID, waiting for ad to finish');
        reloadPending = false;
        reloadCount = 0;
      }
    }
  }

  // Reset reload count when an ad-free page loads
  setInterval(() => {
    if (!isAdPlaying()) reloadCount = 0;
  }, 2000);

  // When the tab regains focus after being backgrounded, reset the reload
  // counter and re-evaluate.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reloadCount = 0;
      LOG('Tab visible again — reset reload counter');
      setTimeout(() => { if (!isAdPlaying()) handleAd(); }, 500);
    }
  });

  // ---- Post-reload: seek to saved time ----
  function restoreAfterReload() {
    try {
      const savedTime = sessionStorage.getItem('yt-ad-reloader-time');
      const savedVid = sessionStorage.getItem('yt-ad-reloader-vid');
      const currentVid = new URLSearchParams(location.search).get('v');
      if (savedTime && savedVid && savedVid === currentVid) {
        const v = document.querySelector('video');
        let t = parseInt(savedTime, 10);
        if (!isFinite(t) || t < 0) t = 0;
        if (v && v.duration && isFinite(v.duration) && t > v.duration - 10) {
          LOG('Saved time', t, 'is at the end — starting from 0 instead');
          t = 0;
        }
        LOG('Restoring playback to', t, 's');
        if (!v) return;
        let attempts = 0;
        const seek = () => {
          attempts++;
          try {
            const player = document.querySelector('#movie_player');
            if (player && typeof player.seekTo === 'function') {
              player.seekTo(t, true);
              LOG('Seeked via player API to', t);
            }
          } catch (e) {}
          try { v.currentTime = t; } catch (e) {}
          v.play().catch(() => {});
          setTimeout(() => {
            if (Math.abs(v.currentTime - t) > 3 && attempts < 5) {
              LOG('Seek drift, retrying... (attempt', attempts, ')');
              seek();
            } else {
              LOG('Restored to', Math.floor(v.currentTime), 's');
              sessionStorage.removeItem('yt-ad-reloader-time');
              sessionStorage.removeItem('yt-ad-reloader-vid');
              // Leave no t= in the address bar: copied/reopened links start at 0.
              try {
                const clean = new URL(location.href);
                if (clean.searchParams.has('t')) {
                  clean.searchParams.delete('t');
                  history.replaceState(null, '', clean.toString());
                  LOG('Cleaned t= from URL');
                }
              } catch (e) {}
            }
          }, 1500);
        };
        if (v.readyState >= 2) {
          seek();
        } else {
          v.addEventListener('loadedmetadata', seek, { once: true });
          setTimeout(() => { if (v.readyState < 2) seek(); }, 3000);
        }
      }
    } catch (e) { LOG('restore error', e); }
  }

  // ---- Main loop ----
  function init() {
    restoreAfterReload();

    const observer = new MutationObserver(() => {
      if (isAdPlaying()) handleAd();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    setInterval(() => {
      if (isAdPlaying()) handleAd();
    }, CHECK_INTERVAL);

    LOG('Initialized. Watching for ads...');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
