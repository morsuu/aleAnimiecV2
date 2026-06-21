/* viewer.js – synchronised video playback for viewers */
'use strict';

(function () {
  const player    = document.getElementById('player');
  const placeholder = document.getElementById('placeholder');

  // connection UI
  const connDot   = document.getElementById('conn-dot');
  const connLabel = document.getElementById('conn-label');

  // sync UI
  const syncDot   = document.getElementById('sync-dot');
  const syncLabel = document.getElementById('sync-label');
  const pillDot   = document.getElementById('pill-dot');
  const pillLabel = document.getElementById('pill-label');

  // ── Socket ──────────────────────────────────────────────────────────────────

  const socket = io();

  socket.on('connect', () => {
    connDot.className   = 'dot green';
    connLabel.textContent = 'Połączono';
  });

  socket.on('disconnect', () => {
    connDot.className   = 'dot red';
    connLabel.textContent = 'Rozłączono';
    setSyncStatus('lost');
  });

  // ── Video load ───────────────────────────────────────────────────────────────

  /**
   * Load a new video src (if different from current).
   * Returns a promise that resolves when the video is ready to seek.
   */
  function loadVideo(filename) {
    const src = `/uploads/${encodeURIComponent(filename)}`;
    if (player.src !== src) {
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

  const DRIFT_THRESHOLD = 0.25; // seconds – tolerated drift before hard-seeking

  /**
   * Apply the server state to the local player.
   * `state.serverTime` is the UTC ms timestamp of when the state was recorded.
   * `state.currentTime` is the video time (seconds) at that moment.
   */
  async function applyState(state) {
    if (!state.filename) {
      setSyncStatus('waiting');
      return;
    }

    await loadVideo(state.filename);

    // Calculate the target playback position accounting for elapsed time
    const lag = (Date.now() - state.serverTime) / 1000;
    const targetTime = state.playing ? state.currentTime + lag : state.currentTime;

    const drift = Math.abs(player.currentTime - targetTime);

    if (drift > DRIFT_THRESHOLD) {
      player.currentTime = targetTime;
    }

    if (state.playing) {
      if (player.paused) {
        try { await player.play(); } catch (_) { /* autoplay policy – user must interact */ }
      }
      setSyncStatus('synced');
    } else {
      if (!player.paused) player.pause();
      setSyncStatus('paused');
    }
  }

  // ── Periodic drift correction ────────────────────────────────────────────────

  let lastState = null;

  setInterval(() => {
    if (!lastState || !lastState.playing || !lastState.filename) return;

    const lag = (Date.now() - lastState.serverTime) / 1000;
    const expected = lastState.currentTime + lag;
    const drift = Math.abs(player.currentTime - expected);

    if (drift > DRIFT_THRESHOLD) {
      player.currentTime = expected;
      setSyncStatus('corrected');
      setTimeout(() => setSyncStatus('synced'), 1500);
    }
  }, 2000);

  // ── Socket events ────────────────────────────────────────────────────────────

  socket.on('sync:state', (state) => {
    lastState = state;
    applyState(state);
  });

  socket.on('video:loaded', ({ filename }) => {
    const src = `/uploads/${encodeURIComponent(filename)}`;
    player.src = src;
    placeholder.classList.add('hidden');
    player.pause();
    player.currentTime = 0;
    setSyncStatus('loaded');
  });

  // ── Status helpers ───────────────────────────────────────────────────────────

  const STATUS = {
    waiting:   { dot: 'yellow', text: 'Czekam na film…'       },
    loaded:    { dot: 'yellow', text: 'Film załadowany'        },
    synced:    { dot: 'green',  text: 'Zsynchronizowano ✓'     },
    paused:    { dot: 'yellow', text: 'Wstrzymano (admin)'     },
    corrected: { dot: 'yellow', text: 'Korekcja synchronizacji…'},
    lost:      { dot: 'red',    text: 'Brak połączenia'        },
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
