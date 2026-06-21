/* viewer.js – synchronised video playback for viewers (v2 – improved sync) */
'use strict';

(function () {
  const player      = document.getElementById('player');
  const embedPlayer = document.getElementById('embed-player');
  const placeholder = document.getElementById('placeholder');
  const videoWrap   = document.getElementById('video-wrap');
  const btnFullscreen = document.getElementById('btn-fullscreen');

  // connection UI
  const connDot   = document.getElementById('conn-dot');
  const connLabel = document.getElementById('conn-label');

  // sync UI
  const syncDot   = document.getElementById('sync-dot');
  const syncLabel = document.getElementById('sync-label');
  const pillDot   = document.getElementById('pill-dot');
  const pillLabel = document.getElementById('pill-label');

  // timer bar
  const timerCurrent  = document.getElementById('timer-current');
  const timerDuration = document.getElementById('timer-duration');
  const timerDrift    = document.getElementById('timer-drift');
  const btnResync     = document.getElementById('btn-resync');

  // ── Fullscreen ───────────────────────────────────────────────────────────────

  btnFullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      videoWrap.requestFullscreen().catch(() => {});
    }
  });

  // ── Embed helpers ──────────────────────────────────────────────────────────

  /**
   * Convert a YouTube / Twitch URL into an embeddable iframe URL.
   * Returns null if the URL is not a recognised embed-able service.
   */
  function toEmbedUrl(url) {
    try {
      const u = new URL(url);

      // YouTube: youtube.com/watch?v=ID | youtu.be/ID | youtube.com/live/ID
      if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com' || u.hostname === 'youtu.be' || u.hostname === 'm.youtube.com') {
        let vid = null;
        if (u.hostname === 'youtu.be') {
          vid = u.pathname.slice(1);
        } else if (u.pathname.startsWith('/watch')) {
          vid = u.searchParams.get('v');
        } else if (u.pathname.startsWith('/live/')) {
          vid = u.pathname.split('/live/')[1];
        } else if (u.pathname.startsWith('/embed/')) {
          return url; // already embed
        }
        if (vid) return `https://www.youtube.com/embed/${vid}?autoplay=1`;
      }

      // Twitch: twitch.tv/CHANNEL | twitch.tv/videos/ID
      if (u.hostname === 'www.twitch.tv' || u.hostname === 'twitch.tv' || u.hostname === 'm.twitch.tv') {
        if (u.pathname.startsWith('/videos/')) {
          const videoId = u.pathname.split('/videos/')[1];
          return `https://player.twitch.tv/?video=${videoId}&parent=${location.hostname}&autoplay=true`;
        }
        const channel = u.pathname.replace(/^\//, '').split('/')[0];
        if (channel) {
          return `https://player.twitch.tv/?channel=${channel}&parent=${location.hostname}&autoplay=true`;
        }
      }

      // Fallback: return url as-is (let iframe try)
      return url;
    } catch (_) {
      return url;
    }
  }

  let isEmbedMode = false;

  function showEmbed(url) {
    isEmbedMode = true;
    const embedUrl = toEmbedUrl(url);
    player.classList.add('hidden');
    player.pause();
    embedPlayer.classList.remove('hidden');
    embedPlayer.src = embedUrl;
    placeholder.classList.add('hidden');
  }

  function showVideo() {
    isEmbedMode = false;
    embedPlayer.classList.add('hidden');
    embedPlayer.src = '';
    player.classList.remove('hidden');
  }

  // ── Socket ──────────────────────────────────────────────────────────────────

  const BACKEND = window.BACKEND_URL || '';
  const socket = io(BACKEND || undefined);

  // ── Clock offset (NTP-style) ────────────────────────────────────────────────
  // We measure the difference between server clock and client clock so that
  // we can accurately compute "what time the server thinks it is right now"
  // without relying on the clocks being in sync.

  let serverOffset = 0; // ms; serverNow ≈ Date.now() + serverOffset
  let offsetSamples = [];
  const OFFSET_SAMPLE_COUNT = 5;

  function measureOffset() {
    const t0 = Date.now();
    socket.emit('ping:time', t0, (response) => {
      const t3 = Date.now();
      const rtt = t3 - t0;
      // offset = serverTime - clientTime (adjusted for half RTT)
      const offset = response.serverTime - t0 - (rtt / 2);
      offsetSamples.push(offset);
      if (offsetSamples.length > OFFSET_SAMPLE_COUNT) offsetSamples.shift();
      // Use median for robustness
      const sorted = [...offsetSamples].sort((a, b) => a - b);
      serverOffset = sorted[Math.floor(sorted.length / 2)];
    });
  }

  /** Get what we believe is the current server time. */
  function serverNow() {
    return Date.now() + serverOffset;
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  socket.on('connect', () => {
    connDot.className   = 'dot green';
    connLabel.textContent = 'Połączono';
    // Immediately calibrate clock
    measureOffset();
    setTimeout(measureOffset, 500);
    setTimeout(measureOffset, 1500);
  });

  socket.on('disconnect', () => {
    connDot.className   = 'dot red';
    connLabel.textContent = 'Rozłączono';
    setSyncStatus('lost');
  });

  // Periodically recalibrate clock offset
  setInterval(measureOffset, 10000);

  // ── Video load ───────────────────────────────────────────────────────────────

  function loadVideo(filename, isExternal) {
    // Only allow http/https for external URLs
    if (isExternal && !filename.startsWith('http://') && !filename.startsWith('https://')) {
      return Promise.resolve();
    }
    const src = isExternal ? `${BACKEND}/proxy?url=${encodeURIComponent(filename)}` : `${BACKEND}/uploads/${encodeURIComponent(filename)}`;
    const alreadyLoaded = isExternal
      ? player.src.includes(encodeURIComponent(filename))
      : player.src.endsWith(encodeURIComponent(filename));
    if (!alreadyLoaded) {
      player.src = src;
      placeholder.classList.add('hidden');
      return new Promise((resolve) => {
        player.oncanplay = () => { player.oncanplay = null; resolve(); };
        player.load();
      });
    }
    return Promise.resolve();
  }

  // ── Sync logic ───────────────────────────────────────────────────────────────

  const DRIFT_THRESHOLD_HARD = 0.15; // >150ms → hard seek
  const DRIFT_THRESHOLD_SOFT = 0.04; // >40ms → adjust playbackRate

  let lastState = null;

  /**
   * Compute where the video *should* be right now based on last known server state.
   */
  function expectedTime() {
    if (!lastState || !lastState.filename) return null;
    if (lastState.playing) {
      const elapsed = (serverNow() - lastState.serverTime) / 1000;
      return lastState.currentTime + elapsed;
    }
    return lastState.currentTime;
  }

  /**
   * Apply the server state to the local player.
   */
  async function applyState(state) {
    if (!state.filename) {
      setSyncStatus('waiting');
      return;
    }

    // Embed mode (YouTube, Twitch, etc.)
    if (state.isEmbed) {
      showEmbed(state.filename);
      setSyncStatus('synced');
      return;
    }

    // Normal video mode
    if (isEmbedMode) showVideo();

    await loadVideo(state.filename, !!state.isExternal);

    const target = state.playing
      ? state.currentTime + (serverNow() - state.serverTime) / 1000
      : state.currentTime;

    const drift = Math.abs(player.currentTime - target);

    if (drift > DRIFT_THRESHOLD_HARD) {
      player.currentTime = target;
    }

    if (state.playing) {
      if (player.paused) {
        try { await player.play(); } catch (_) { /* autoplay policy */ }
      }
      setSyncStatus('synced');
    } else {
      if (!player.paused) player.pause();
      player.currentTime = target;
      setSyncStatus('paused');
    }
  }

  // ── Continuous drift correction (every 500ms) ───────────────────────────────

  setInterval(() => {
    if (!lastState || !lastState.playing || !lastState.filename) {
      player.playbackRate = 1.0;
      return;
    }

    const target = expectedTime();
    if (target === null) return;

    const drift = player.currentTime - target; // positive = ahead, negative = behind
    const absDrift = Math.abs(drift);

    if (absDrift > DRIFT_THRESHOLD_HARD) {
      // Hard seek for large drift
      player.currentTime = target;
      player.playbackRate = 1.0;
      setSyncStatus('corrected');
      setTimeout(() => setSyncStatus('synced'), 1000);
    } else if (absDrift > DRIFT_THRESHOLD_SOFT) {
      // Gentle speed adjustment to catch up / slow down
      // If behind (drift < 0), speed up slightly; if ahead, slow down
      player.playbackRate = drift < 0 ? 1.03 : 0.97;
    } else {
      // In tolerance – normal speed
      if (player.playbackRate !== 1.0) player.playbackRate = 1.0;
    }
  }, 500);

  // ── Socket events ────────────────────────────────────────────────────────────

  socket.on('sync:state', (state) => {
    lastState = state;
    applyState(state);
  });

  socket.on('video:loaded', ({ filename, isExternal, isEmbed }) => {
    if (isEmbed) {
      showEmbed(filename);
      setSyncStatus('loaded');
      return;
    }
    if (isEmbedMode) showVideo();
    const src = isExternal ? `${BACKEND}/proxy?url=${encodeURIComponent(filename)}` : `${BACKEND}/uploads/${encodeURIComponent(filename)}`;
    const alreadyLoaded = isExternal
      ? player.src.includes(encodeURIComponent(filename))
      : player.src.endsWith(encodeURIComponent(filename));
    if (!alreadyLoaded) {
      player.src = src;
      placeholder.classList.add('hidden');
      player.pause();
      player.currentTime = 0;
    }
    setSyncStatus('loaded');
  });

  // ── Manual resync button ────────────────────────────────────────────────────

  btnResync.addEventListener('click', () => {
    // Recalibrate clock
    measureOffset();
    // Ask server for fresh state
    socket.emit('viewer:resync');
    setSyncStatus('corrected');
    setTimeout(() => {
      if (lastState && lastState.playing) setSyncStatus('synced');
    }, 1500);
  });

  // ── Timer display (requestAnimationFrame for smooth updates) ────────────────

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  function updateTimer() {
    timerCurrent.textContent = formatTime(player.currentTime);
    timerDuration.textContent = formatTime(player.duration || 0);

    // Show drift
    const target = expectedTime();
    if (target !== null && lastState && lastState.playing) {
      const driftMs = Math.round((player.currentTime - target) * 1000);
      timerDrift.textContent = (driftMs >= 0 ? '+' : '') + driftMs;
      timerDrift.style.color = Math.abs(driftMs) > 150 ? '#e94560' : Math.abs(driftMs) > 40 ? '#ffb300' : '#4caf50';
    } else {
      timerDrift.textContent = '0';
      timerDrift.style.color = '';
    }

    requestAnimationFrame(updateTimer);
  }
  requestAnimationFrame(updateTimer);

  // ── Status helpers ───────────────────────────────────────────────────────────

  const STATUS = {
    waiting:   { dot: 'yellow', text: 'Czekam na film…'        },
    loaded:    { dot: 'yellow', text: 'Film załadowany'         },
    synced:    { dot: 'green',  text: 'Zsynchronizowano ✓'      },
    paused:    { dot: 'yellow', text: 'Wstrzymano (admin)'      },
    corrected: { dot: 'yellow', text: 'Korekcja synchronizacji…'},
    lost:      { dot: 'red',    text: 'Brak połączenia'         },
  };

  function setSyncStatus(key) {
    const s = STATUS[key] || STATUS.waiting;
    syncDot.className   = `dot ${s.dot}`;
    syncLabel.textContent = s.text;
    pillDot.className   = `dot ${s.dot}`;
    pillLabel.textContent = s.text;
  }

  setSyncStatus('waiting');
}());
