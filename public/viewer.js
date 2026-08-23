/* viewer.js – synchronised video playback for viewers (v2 – improved sync) */
'use strict';

(function () {
  const player      = document.getElementById('player');
  const embedPlayer = document.getElementById('embed-player');
  const placeholder = document.getElementById('placeholder');
  const placeholderText = placeholder.querySelector('span');
  const videoWrap   = document.getElementById('video-wrap');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const videoControls = document.getElementById('video-controls');
  const btnMute       = document.getElementById('btn-mute');
  const volIconOn     = document.getElementById('vol-icon-on');
  const volIconOff    = document.getElementById('vol-icon-off');
  const volumeSlider  = document.getElementById('volume-slider');
  const tapOverlay    = document.getElementById('tap-overlay');
  const embedFallback = document.getElementById('embed-fallback');
  const embedFallbackLink = document.getElementById('embed-fallback-link');
  const subtitleLayer = document.getElementById('subtitle-layer');
  const btnCc         = document.getElementById('btn-cc');
  const btnCast       = document.getElementById('btn-cast');
  const btnSubs       = document.getElementById('btn-subs');
  const subsPanel     = document.getElementById('subs-panel');
  const subsSmaller   = document.getElementById('subs-smaller');
  const subsBigger    = document.getElementById('subs-bigger');
  const subsScaleLabel= document.getElementById('subs-scale-label');
  const subsBgGroup   = document.getElementById('subs-bg-group');
  const subsReset     = document.getElementById('subs-reset');
  const castBanner    = document.getElementById('cast-banner');
  const castDevice    = document.getElementById('cast-device');
  const castNote      = document.getElementById('cast-note');
  const castStop      = document.getElementById('cast-stop');

  // connection UI
  const connDot   = document.getElementById('conn-dot');
  const connLabel = document.getElementById('conn-label');
  const viewersCount = document.getElementById('viewers-count');

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

  const DEFAULT_PLACEHOLDER = placeholderText ? placeholderText.textContent : '';

  // The socket.io client is injected by a <script> tag pointing at the backend.
  // If the backend is asleep or unreachable that tag 404s and `io` is undefined,
  // which used to leave the page silently dead.
  if (typeof io === 'undefined') {
    connDot.className = 'dot red';
    connLabel.textContent = 'Brak serwera';
    if (placeholderText) placeholderText.textContent = 'Nie można połączyć się z serwerem. Odśwież stronę za chwilę.';
    return;
  }

  // ── Fullscreen ───────────────────────────────────────────────────────────────

  btnFullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      videoWrap.requestFullscreen().catch(() => {});
    }
  });

  // ── Volume control ─────────────────────────────────────────────────────────

  let savedVolume = 1;

  volumeSlider.addEventListener('input', () => {
    const vol = parseFloat(volumeSlider.value);
    player.volume = vol;
    // Touching the slider is a user gesture, so it also lifts the mute we may
    // have applied to get past the autoplay policy.
    if (vol > 0) player.muted = false;
    savedVolume = vol > 0 ? vol : savedVolume;
    updateVolumeIcon();
  });

  btnMute.addEventListener('click', () => {
    if (player.muted || player.volume === 0) {
      player.muted = false;
      player.volume = savedVolume || 1;
      volumeSlider.value = player.volume;
    } else {
      savedVolume = player.volume;
      player.muted = true;
      volumeSlider.value = 0;
    }
    updateVolumeIcon();
  });

  function updateVolumeIcon() {
    if (player.muted || player.volume === 0) {
      volIconOn.classList.add('hidden');
      volIconOff.classList.remove('hidden');
    } else {
      volIconOn.classList.remove('hidden');
      volIconOff.classList.add('hidden');
    }
  }

  player.addEventListener('volumechange', updateVolumeIcon);

  // ── Auto-hide controls after 3 seconds ─────────────────────────────────────

  let hideTimer = null;

  function showControls() {
    videoWrap.classList.remove('controls-hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      videoWrap.classList.add('controls-hidden');
    }, 3000);
  }

  videoWrap.addEventListener('mousemove', showControls);
  videoWrap.addEventListener('mouseenter', showControls);
  videoWrap.addEventListener('mouseleave', () => {
    clearTimeout(hideTimer);
    videoWrap.classList.add('controls-hidden');
  });
  videoWrap.addEventListener('touchstart', showControls);

  // Start hidden after initial 3s
  showControls();

  // ── Autoplay policy ────────────────────────────────────────────────────────
  // Browsers refuse to start audible playback without a user gesture. Previously
  // the rejection was swallowed and the viewer sat on a frozen frame while the
  // status still claimed "zsynchronizowano".

  let autoplayBlocked = false;

  function showTapOverlay() {
    autoplayBlocked = true;
    tapOverlay.classList.remove('hidden');
  }

  function hideTapOverlay() {
    autoplayBlocked = false;
    tapOverlay.classList.add('hidden');
  }

  /** Start playback, falling back to muted playback, then to a tap prompt. */
  async function ensurePlaying() {
    try {
      await player.play();
      hideTapOverlay();
      return true;
    } catch (_) {
      if (!player.muted) {
        // Muted autoplay is allowed almost everywhere – take it and tell the
        // viewer how to get the sound back.
        player.muted = true;
        updateVolumeIcon();
        try {
          await player.play();
          showTapOverlay();
          return true;
        } catch (__) { /* fall through */ }
      }
      showTapOverlay();
      return false;
    }
  }

  tapOverlay.addEventListener('click', () => {
    player.muted = false;
    player.volume = savedVolume || 1;
    volumeSlider.value = player.volume;
    updateVolumeIcon();
    hideTapOverlay();
    if (lastState && lastState.playing) player.play().catch(() => {});
  });

  // ── Buffering ──────────────────────────────────────────────────────────────
  // A viewer on a thin connection would just silently fall behind and then get
  // yanked forward by the drift correction, with the status still claiming
  // "zsynchronizowano". Say what is actually happening instead.

  let buffering = false;

  function setBuffering(on) {
    if (buffering === on) return;
    buffering = on;
    setSyncStatus(lastStatusKey);   // re-render whatever state we were in
  }

  player.addEventListener('waiting', () => { if (currentSrcKey) setBuffering(true); });
  player.addEventListener('stalled', () => { if (currentSrcKey && !player.paused) setBuffering(true); });
  player.addEventListener('playing', () => setBuffering(false));
  player.addEventListener('canplay', () => setBuffering(false));
  player.addEventListener('emptied', () => setBuffering(false));

  // ── Subtitles ──────────────────────────────────────────────────────────────
  // The admin picks the track and its offset; both arrive in `sync:state`, so
  // every viewer sees the same lines at the same moment.

  const CC_PREF_KEY = 'aleanimiec.cc';
  const subs = window.Subtitles.createRenderer(subtitleLayer);
  let currentSubtitleFile = null;

  try {
    if (localStorage.getItem(CC_PREF_KEY) === '0') subs.setVisible(false);
  } catch (_) {}

  function updateCcButton() {
    btnCc.setAttribute('aria-pressed', subs.isVisible() ? 'true' : 'false');
    btnCc.title = subs.isVisible() ? 'Wyłącz napisy' : 'Włącz napisy';
  }

  btnCc.addEventListener('click', () => {
    subs.setVisible(!subs.isVisible());
    updateCcButton();
    try { localStorage.setItem(CC_PREF_KEY, subs.isVisible() ? '1' : '0'); } catch (_) {}
  });

  /** Fetch and parse the track the admin selected. */
  async function loadSubtitle(file) {
    if ((file || null) === currentSubtitleFile) return;
    currentSubtitleFile = file || null;

    if (!currentSubtitleFile) {
      subs.clear();
      btnCc.classList.add('hidden');
      btnSubs.classList.add('hidden');
      toggleSubsPanel(false);
      return;
    }

    try {
      const res = await fetch(`${BACKEND}/uploads/${encodeURIComponent(currentSubtitleFile)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cues = window.Subtitles.parse(await res.text());
      if (currentSubtitleFile !== file) return;   // a newer track won the race
      subs.setCues(cues);
      btnCc.classList.toggle('hidden', cues.length === 0);
      btnSubs.classList.toggle('hidden', cues.length === 0);
      updateCcButton();
    } catch (_) {
      subs.clear();
      btnCc.classList.add('hidden');
      btnSubs.classList.add('hidden');
    }
  }

  function dropSubtitles() {
    currentSubtitleFile = null;
    subs.clear();
    btnCc.classList.add('hidden');
    btnSubs.classList.add('hidden');
    toggleSubsPanel(false);
  }

  // A timer rather than requestAnimationFrame: rAF is suspended while the tab is
  // hidden, and 100 ms is well below the threshold where a cue change is visible.
  setInterval(() => {
    if (currentSrcKey && !isEmbedMode) subs.update(player.currentTime);
  }, 100);

  // ── Wygląd napisów ─────────────────────────────────────────────────────────
  // Czysto lokalne ustawienia widza – nic z tego nie leci do serwera ani do
  // pozostałych. Każdy ogląda na innym ekranie i z innej odległości.

  const LOOK_KEY = 'aleanimiec.subsLook';
  const SCALE_MIN = 0.6;
  const SCALE_MAX = 2.2;
  const SCALE_STEP = 0.1;
  const BACKGROUNDS = ['solid', 'soft', 'none'];
  const LOOK_DEFAULT = { scale: 1, bg: 'soft' };

  let look = loadLook();

  function loadLook() {
    try {
      const raw = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}');
      const scale = Number(raw.scale);
      return {
        scale: Number.isFinite(scale) ? clampScale(scale) : LOOK_DEFAULT.scale,
        bg: BACKGROUNDS.includes(raw.bg) ? raw.bg : LOOK_DEFAULT.bg,
      };
    } catch (_) {
      return { ...LOOK_DEFAULT };
    }
  }

  function saveLook() {
    try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch (_) {}
  }

  function clampScale(value) {
    // Zaokrąglenie do kroku – inaczej zmiennoprzecinkowe resztki dają 109.99999%.
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(value * 10) / 10));
  }

  function applyLook() {
    subtitleLayer.style.setProperty('--sub-scale', look.scale);
    subtitleLayer.dataset.bg = look.bg;

    subsScaleLabel.textContent = `${Math.round(look.scale * 100)}%`;
    subsSmaller.disabled = look.scale <= SCALE_MIN;
    subsBigger.disabled = look.scale >= SCALE_MAX;

    subsBgGroup.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.bg === look.bg ? 'true' : 'false');
    });
  }

  function nudgeScale(delta) {
    look.scale = clampScale(look.scale + delta);
    applyLook();
    saveLook();
  }

  subsSmaller.addEventListener('click', () => nudgeScale(-SCALE_STEP));
  subsBigger.addEventListener('click', () => nudgeScale(SCALE_STEP));

  subsBgGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bg]');
    if (!btn) return;
    look.bg = btn.dataset.bg;
    applyLook();
    saveLook();
  });

  subsReset.addEventListener('click', () => {
    look = { ...LOOK_DEFAULT };
    applyLook();
    saveLook();
  });

  function toggleSubsPanel(open) {
    const show = open === undefined ? subsPanel.classList.contains('hidden') : open;
    subsPanel.classList.toggle('hidden', !show);
    btnSubs.setAttribute('aria-expanded', show ? 'true' : 'false');
  }

  btnSubs.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSubsPanel();
  });

  // Klik poza panelem go zamyka; klik w środku nie.
  subsPanel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleSubsPanel(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSubsPanel(false); });

  applyLook();

  // ── Embed helpers ──────────────────────────────────────────────────────────

  /**
   * Extract YouTube video ID from a URL. Returns null if not a YouTube URL.
   */
  function extractYouTubeId(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com' || u.hostname === 'youtu.be' || u.hostname === 'm.youtube.com') {
        if (u.hostname === 'youtu.be') return u.pathname.slice(1);
        if (u.pathname.startsWith('/watch')) return u.searchParams.get('v');
        if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/shorts/')[1].split('/')[0];
        if (u.pathname.startsWith('/live/')) return u.pathname.split('/live/')[1].split('/')[0];
        if (u.pathname.startsWith('/embed/')) return u.pathname.split('/embed/')[1].split('?')[0];
      }
    } catch (_) {}
    return null;
  }

  /**
   * Convert a Twitch URL into an embeddable iframe URL.
   */
  function toTwitchEmbedUrl(url) {
    try {
      const u = new URL(url);
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
    } catch (_) {}
    return null;
  }

  let isEmbedMode = false;
  let currentEmbedUrl = null;   // so switching to another embed actually reloads
  let ytPlayer = null;
  let ytReady = false;
  let ytVideoId = null;
  let ytWaitTimer = null;

  // YouTube IFrame API ready callback
  window.onYouTubeIframeAPIReady = window.onYouTubeIframeAPIReady || function() {};
  const origYTCallback = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function() {
    origYTCallback();
    ytReady = true;
  };

  // If API already loaded
  if (window.YT && window.YT.Player) {
    ytReady = true;
  }

  function createYTPlayer(videoId, startTime) {
    ytVideoId = videoId;
    embedPlayer.innerHTML = '';
    embedPlayer.classList.remove('hidden');
    embedPlayer.classList.add('no-interact');
    const playerDiv = document.createElement('div');
    playerDiv.id = 'yt-player-viewer';
    embedPlayer.appendChild(playerDiv);

    ytPlayer = new YT.Player('yt-player-viewer', {
      videoId: videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 0,        // Hide controls
        disablekb: 1,       // Disable keyboard
        modestbranding: 1,
        rel: 0,
        fs: 0,              // Disable fullscreen button
        iv_load_policy: 3,  // Disable annotations
        playsinline: 1,
        start: Math.floor(startTime || 0),
      },
      events: {
        onReady: function() {
          // Apply current state once player is ready
          if (lastState && lastState.isEmbed) {
            applyYTState(lastState);
          }
        },
      },
    });
  }

  const YT_DRIFT_THRESHOLD = 2; // seconds

  function applyYTState(state) {
    if (!ytPlayer || !ytPlayer.seekTo) return;

    const target = state.playing
      ? state.currentTime + (serverNow() - state.serverTime) / 1000
      : state.currentTime;

    const currentYTTime = ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0;
    const drift = Math.abs(currentYTTime - target);
    const playerState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;

    // Seek only when actually off – re-seeking on every 3s heartbeat made the
    // paused player flicker and re-buffer.
    if (drift > YT_DRIFT_THRESHOLD) {
      ytPlayer.seekTo(target, true);
    }

    if (state.playing) {
      if (playerState !== YT.PlayerState.PLAYING && playerState !== YT.PlayerState.BUFFERING) {
        ytPlayer.playVideo();
      }
    } else if (playerState === YT.PlayerState.PLAYING) {
      ytPlayer.pauseVideo();
    }
  }

  function showEmbed(url) {
    isEmbedMode = true;
    currentEmbedUrl = url;
    currentSrcKey = null;
    player.classList.add('hidden');
    player.pause();
    player.removeAttribute('src');
    placeholder.classList.add('hidden');
    hideTapOverlay();
    videoWrap.classList.remove('hidden');
    clearInterval(ytWaitTimer);

    const ytId = extractYouTubeId(url);
    if (ytId) {
      // Use YouTube IFrame Player API
      hideEmbedFallback();
      if (ytReady || (window.YT && window.YT.Player)) {
        ytReady = true;
        if (ytVideoId !== ytId) createYTPlayer(ytId, 0);
      } else {
        // Wait for API to load. Tracked in ytWaitTimer so a second load()
        // before the API arrives can't spawn a second player.
        ytWaitTimer = setInterval(() => {
          if (ytReady || (window.YT && window.YT.Player)) {
            ytReady = true;
            clearInterval(ytWaitTimer);
            createYTPlayer(ytId, 0);
          }
        }, 100);
      }
    } else {
      // Non-YouTube embed (e.g., Twitch) – use iframe fallback
      const twitchUrl = toTwitchEmbedUrl(url);
      renderIframe(twitchUrl || url);
      // Twitch's player URL is made for framing; anything else may be refused.
      if (twitchUrl) hideEmbedFallback();
      else showEmbedFallback(url);
      ytPlayer = null;
      ytVideoId = null;
    }
  }

  function renderIframe(src) {
    embedPlayer.innerHTML = '';
    embedPlayer.classList.remove('hidden');
    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.allowFullscreen = true;
    iframe.allow = 'autoplay; encrypted-media; fullscreen';
    iframe.style.cssText = 'width:100%;height:100%;border:none;';
    embedPlayer.appendChild(iframe);
  }

  /**
   * A cross-origin frame that answers with X-Frame-Options / frame-ancestors
   * renders as an empty black box and there is no event we can catch for it.
   * Sites that refuse framing are exactly that case, so always offer a way out
   * instead of leaving the viewer staring at nothing.
   */
  function showEmbedFallback(url) {
    embedFallbackLink.href = url;
    embedFallback.classList.remove('hidden');
  }

  function hideEmbedFallback() {
    embedFallback.classList.add('hidden');
  }

  function showVideo() {
    isEmbedMode = false;
    currentEmbedUrl = null;
    hideEmbedFallback();
    clearInterval(ytWaitTimer);
    embedPlayer.classList.add('hidden');
    embedPlayer.classList.remove('no-interact');
    embedPlayer.innerHTML = '';
    player.classList.remove('hidden');
    ytPlayer = null;
    ytVideoId = null;
    // Show video wrap
    videoWrap.classList.remove('hidden');
  }

  /** Back to the "nothing is playing" state. */
  function clearAll() {
    showVideo();
    dropSubtitles();
    player.removeAttribute('src');
    player.load();
    currentSrcKey = null;
    lastState = null;
    hideTapOverlay();
    if (placeholderText) placeholderText.textContent = DEFAULT_PLACEHOLDER;
    placeholder.classList.remove('hidden');
    setSyncStatus('waiting');
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
      if (!response || typeof response.serverTime !== 'number') return;
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

  socket.on('connect_error', () => {
    connDot.className   = 'dot red';
    connLabel.textContent = 'Brak połączenia';
  });

  socket.on('disconnect', () => {
    connDot.className   = 'dot red';
    connLabel.textContent = 'Rozłączono';
    setSyncStatus('lost');
  });

  // Everyone connected to the room, the admin included – they are watching too.
  socket.on('viewers:count', (n) => {
    viewersCount.textContent = Number.isFinite(n) ? n : 0;
  });

  // Periodically recalibrate clock offset
  setInterval(measureOffset, 10000);

  // ── Video load ───────────────────────────────────────────────────────────────

  const LOAD_TIMEOUT_MS = 20000;

  /** Key of the source currently attached to <video>; null when nothing is loaded. */
  let currentSrcKey = null;
  let loadFailed = false;

  function srcFor(filename, isExternal) {
    return isExternal
      ? `${BACKEND}/proxy?url=${encodeURIComponent(filename)}`
      : `${BACKEND}/uploads/${encodeURIComponent(filename)}`;
  }

  function showLoadError() {
    loadFailed = true;
    if (placeholderText) placeholderText.textContent = 'Nie udało się załadować filmu. Kliknij „Synchronizuj”, aby spróbować ponownie.';
    placeholder.classList.remove('hidden');
    setSyncStatus('error');
  }

  /**
   * Point <video> at the requested source. Resolves once the media is playable,
   * on error, or after a timeout – an unresolved promise used to wedge applyState
   * forever, leaving the viewer stuck with no explanation.
   */
  function loadVideo(filename, isExternal) {
    // Only allow http/https for external URLs
    if (isExternal && !filename.startsWith('http://') && !filename.startsWith('https://')) {
      return Promise.resolve();
    }

    // Compare against a stored key rather than re-parsing player.src, whose
    // escaping doesn't always round-trip and caused constant reloads.
    const key = (isExternal ? 'ext:' : 'up:') + filename;
    if (key === currentSrcKey) return Promise.resolve();

    currentSrcKey = key;
    loadFailed = false;
    if (placeholderText) placeholderText.textContent = 'Ładowanie…';
    placeholder.classList.remove('hidden');
    player.src = srcFor(filename, isExternal);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        player.removeEventListener('canplay', onCanPlay);
        player.removeEventListener('error', onError);
        if (ok) {
          placeholder.classList.add('hidden');
          if (placeholderText) placeholderText.textContent = DEFAULT_PLACEHOLDER;
        } else {
          showLoadError();
        }
        resolve(ok);
      };
      const onCanPlay = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);

      player.addEventListener('canplay', onCanPlay);
      player.addEventListener('error', onError);
      player.load();
    });
  }

  // A source can also fail after it started loading (proxy drops, 502 mid-stream).
  player.addEventListener('error', () => {
    if (currentSrcKey) showLoadError();
  });

  // ── Cast (Chromecast) ──────────────────────────────────────────────────────
  // Only the viewer casts. The admin's player is what the server takes its
  // timeline from, so a receiver's laggy position would drag the whole room.

  // Well above the local 150 ms threshold: a seek on a TV is a visible jump,
  // and there is no playbackRate trim to smooth things out remotely.
  const CAST_DRIFT_THRESHOLD = 2;   // seconds
  const CAST_SYNC_INTERVAL = 2000;  // ms

  // Chrome plays these happily; a Chromecast will not.
  const CAST_UNSUPPORTED = /\.(mkv|avi|ogv)$/i;

  const CONTENT_TYPES = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.ogg': 'video/ogg', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  };

  let casting = false;
  let castAvailable = false;
  let castLoading = false;

  const castPlayer = window.CastPlayer ? window.CastPlayer.create({
    onAvailabilityChange(available) {
      castAvailable = available;
      updateCastButton();
    },
    onConnected(name) {
      casting = true;
      castDevice.textContent = name;
      castBanner.classList.remove('hidden');
      updateCastButton();

      // Stop pulling the file locally – the receiver fetches it itself.
      player.pause();
      subs.setVisible(false);
      currentSrcKey = null;
      player.removeAttribute('src');
      player.load();

      if (lastState) castApply(lastState);
      setSyncStatus('casting');
    },
    onDisconnected() {
      casting = false;
      castLoading = false;
      castBanner.classList.add('hidden');
      castNote.textContent = '';
      updateCastButton();

      // Reload locally and pick the room's position back up.
      currentSrcKey = null;
      try { if (localStorage.getItem(CC_PREF_KEY) !== '0') subs.setVisible(true); } catch (_) { subs.setVisible(true); }
      if (lastState) applyState(lastState);
    },
  }) : null;

  if (castPlayer) castPlayer.load();

  /** Cast makes sense only for a real video file we serve, never for embeds. */
  function castPossible() {
    return !!castPlayer && castAvailable && !!lastState && !!lastState.filename && !lastState.isEmbed;
  }

  function updateCastButton() {
    btnCast.classList.toggle('hidden', !castPossible() && !casting);
    btnCast.classList.toggle('is-active', casting);
    btnCast.title = casting ? 'Zatrzymaj odtwarzanie na telewizorze' : 'Rzuć na telewizor (Chromecast)';
  }

  btnCast.addEventListener('click', () => {
    if (!castPlayer) return;
    if (casting) { castPlayer.stop(); return; }
    castPlayer.requestSession().catch(() => { /* user dismissed the picker */ });
  });

  castStop.addEventListener('click', () => { if (castPlayer) castPlayer.stop(); });

  /** Absolute URL – the receiver resolves nothing relative to our page. */
  function absoluteUrl(relative) {
    try { return new URL(relative, location.href).href; } catch (_) { return relative; }
  }

  function contentTypeFor(name) {
    const dot = name.lastIndexOf('.');
    const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
    return CONTENT_TYPES[ext] || 'video/mp4';
  }

  /** Load (or reload) the room's media on the receiver when it changed. */
  function castApply(state) {
    if (!casting || !castPlayer || castLoading) return;
    if (!state.filename || state.isEmbed) return;

    const offset = state.subtitleOffset || 0;
    const key = `${state.filename}|${state.subtitle || ''}|${offset}`;
    if (key === castPlayer.currentKey()) return;

    const mediaUrl = absoluteUrl(srcFor(state.filename, !!state.isExternal));
    let subtitleUrl = null;
    if (state.subtitle) {
      const base = `${BACKEND}/uploads/${encodeURIComponent(state.subtitle)}`;
      // The offset has to be baked into the file – the receiver can't shift it.
      subtitleUrl = absoluteUrl(offset ? `${base}?offset=${encodeURIComponent(offset)}` : base);
    }

    castNote.textContent = CAST_UNSUPPORTED.test(state.filename)
      ? 'Ten format może nie działać na telewizorze.'
      : '';

    castLoading = true;
    castPlayer.loadMedia({
      key,
      url: mediaUrl,
      contentType: contentTypeFor(state.isExternal ? '.mp4' : state.filename),
      title: 'aleAnimiec',
      subtitleUrl,
      startTime: castTarget(state),
      playing: !!state.playing,
    }).then(() => {
      castLoading = false;
    }).catch(() => {
      castLoading = false;
      castNote.textContent = 'Nie udało się uruchomić na telewizorze.';
    });
  }

  function castTarget(state) {
    if (!state || !state.filename) return 0;
    return state.playing
      ? state.currentTime + (serverNow() - state.serverTime) / 1000
      : state.currentTime;
  }

  // Keep the receiver roughly in step with the room.
  setInterval(() => {
    if (!casting || !castPlayer || castLoading) return;
    if (!lastState || !lastState.filename || lastState.isEmbed) return;
    if (!castPlayer.isConnected()) return;

    castApply(lastState);
    if (castLoading) return;

    const target = castTarget(lastState);
    const drift = castPlayer.currentTime() - target;

    if (Math.abs(drift) > CAST_DRIFT_THRESHOLD) castPlayer.seek(target);

    if (lastState.playing && castPlayer.isPaused()) castPlayer.play();
    else if (!lastState.playing && !castPlayer.isPaused()) castPlayer.pause();
  }, CAST_SYNC_INTERVAL);

  // ── Sync logic ───────────────────────────────────────────────────────────────

  const DRIFT_THRESHOLD_HARD = 0.15; // >150ms → hard seek
  const DRIFT_THRESHOLD_SOFT = 0.04; // >40ms → adjust playbackRate

  let lastState = null;
  let applySeq = 0;
  let lastStatusKey = 'waiting';

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
    // Heartbeats arrive every 3s while loadVideo may still be awaiting; without
    // this guard an older state could land after a newer one.
    const seq = ++applySeq;

    if (!state.filename) {
      if (isEmbedMode || currentSrcKey) clearAll();
      updateCastButton();
      setSyncStatus('waiting');
      return;
    }

    // Embed mode (YouTube, Twitch, etc.) – we don't own that player's surface,
    // so there is nowhere to draw subtitles.
    if (state.isEmbed) {
      dropSubtitles();
      updateCastButton();
      if (!isEmbedMode || currentEmbedUrl !== state.filename) showEmbed(state.filename);
      const ytId = extractYouTubeId(state.filename);
      if (ytId && ytPlayer && ytPlayer.seekTo) {
        applyYTState(state);
        setSyncStatus('synced');
        return;
      }
      // Only the YouTube IFrame API gives us playback control – for every other
      // embed the old code still claimed "zsynchronizowano", which was a lie.
      setSyncStatus(ytId ? 'loaded' : 'embed');
      return;
    }

    // Normal video mode
    if (isEmbedMode) showVideo();

    loadSubtitle(state.subtitle);
    subs.setOffset(state.subtitleOffset || 0);
    updateCastButton();

    // While casting, the receiver owns playback – don't also buffer and drive
    // the local element.
    if (casting) {
      castApply(state);
      setSyncStatus('casting');
      return;
    }

    const ok = await loadVideo(state.filename, !!state.isExternal);
    if (seq !== applySeq) return;      // superseded by a newer state
    if (ok === false) return;          // load failed, error already shown

    const target = state.playing
      ? state.currentTime + (serverNow() - state.serverTime) / 1000
      : state.currentTime;

    // Past the end: calling play() here would restart the film from zero.
    if (Number.isFinite(player.duration) && target >= player.duration - 0.05) {
      if (!player.paused) player.pause();
      setSyncStatus('ended');
      return;
    }

    const drift = Math.abs(player.currentTime - target);

    if (drift > DRIFT_THRESHOLD_HARD) {
      player.currentTime = target;
    }

    if (state.playing) {
      if (player.paused) {
        const started = await ensurePlaying();
        if (seq !== applySeq) return;
        setSyncStatus(started ? (autoplayBlocked ? 'muted' : 'synced') : 'blocked');
        return;
      }
      setSyncStatus(autoplayBlocked ? 'muted' : 'synced');
    } else {
      if (!player.paused) player.pause();
      player.currentTime = target;
      setSyncStatus('paused');
    }
  }

  // ── Continuous drift correction (every 500ms) ───────────────────────────────

  let lastProgressAt = -1;

  setInterval(() => {
    // Safety net for a `buffering` flag that never got cleared by an event:
    // if the picture is actually moving, we are not buffering.
    if (buffering && !player.paused && player.currentTime > lastProgressAt + 0.05) {
      setBuffering(false);
    }
    lastProgressAt = player.currentTime;

    if (casting) return;   // the receiver has its own, looser correction loop

    if (!lastState || !lastState.filename || loadFailed) {
      player.playbackRate = 1.0;
      return;
    }

    // YouTube embed sync
    if (lastState.isEmbed && ytPlayer && ytPlayer.getCurrentTime && ytPlayer.seekTo) {
      if (lastState.playing) applyYTState(lastState);
      return;
    }

    if (lastState.isEmbed) return;

    if (!lastState.playing) {
      player.playbackRate = 1.0;
      return;
    }

    const target = expectedTime();
    if (target === null) return;

    // Past the end there is nothing to chase – the server clock keeps running,
    // which otherwise left the viewer stuck "correcting" forever.
    if (player.ended || (Number.isFinite(player.duration) && target >= player.duration - 0.05)) {
      player.playbackRate = 1.0;
      setSyncStatus('ended');
      return;
    }

    // Nothing to correct while playback is blocked by the autoplay policy.
    if (player.paused) return;

    const drift = player.currentTime - target; // positive = ahead, negative = behind
    const absDrift = Math.abs(drift);

    if (absDrift > DRIFT_THRESHOLD_HARD) {
      // Hard seek for large drift
      player.currentTime = target;
      player.playbackRate = 1.0;
      setSyncStatus('corrected');
      setTimeout(() => {
        if (lastState && lastState.playing && !player.paused) setSyncStatus(autoplayBlocked ? 'muted' : 'synced');
      }, 1000);
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
    if (!state) return;
    lastState = state;
    applyState(state);
  });

  socket.on('video:loaded', (payload) => {
    if (!payload) return;
    const { filename, isExternal, isEmbed } = payload;

    if (isEmbed) {
      showEmbed(filename);
      setSyncStatus('loaded');
      return;
    }
    if (isEmbedMode) showVideo();

    // Drop the old source and let the `sync:state` that follows drive the load,
    // so we never have two loads racing for the same element.
    currentSrcKey = null;
    loadFailed = false;
    lastState = null;
    player.pause();
    if (placeholderText) placeholderText.textContent = 'Ładowanie…';
    placeholder.classList.remove('hidden');
    setSyncStatus('loaded');
  });

  socket.on('video:cleared', clearAll);

  // Offset nudges arrive on their own channel so dragging the control doesn't
  // trigger a full state broadcast (and a re-seek) for every viewer.
  socket.on('subtitles:offset', ({ offset }) => {
    subs.setOffset(offset);
    if (lastState) lastState.subtitleOffset = offset;
  });

  // ── Manual resync button ────────────────────────────────────────────────────

  btnResync.addEventListener('click', () => {
    // Recalibrate clock
    measureOffset();
    // A failed source is retried from scratch
    if (loadFailed) {
      currentSrcKey = null;
      loadFailed = false;
    }
    // Ask server for fresh state
    socket.emit('viewer:resync');
    setSyncStatus('corrected');
    setTimeout(() => {
      if (lastState && lastState.playing && !loadFailed) setSyncStatus(autoplayBlocked ? 'muted' : 'synced');
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
    if (target !== null && lastState && lastState.playing && !lastState.isEmbed && !player.ended) {
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
    muted:     { dot: 'green',  text: 'Gra bez dźwięku – kliknij film' },
    blocked:   { dot: 'yellow', text: 'Kliknij film, aby zacząć' },
    paused:    { dot: 'yellow', text: 'Wstrzymano (admin)'      },
    ended:     { dot: 'yellow', text: 'Koniec filmu'            },
    embed:     { dot: 'yellow', text: 'Osadzony player – bez synchronizacji' },
    casting:   { dot: 'green',  text: 'Odtwarzanie na telewizorze'  },
    corrected: { dot: 'yellow', text: 'Korekcja synchronizacji…'},
    buffering: { dot: 'yellow', text: 'Buforowanie…'            },
    error:     { dot: 'red',    text: 'Błąd ładowania filmu'    },
    lost:      { dot: 'red',    text: 'Brak połączenia'         },
  };

  /** States that "buforowanie" is allowed to mask – errors and pauses win. */
  const BUFFERABLE = new Set(['synced', 'muted', 'corrected', 'loaded']);

  function setSyncStatus(key) {
    lastStatusKey = key;
    const effective = buffering && BUFFERABLE.has(key) ? 'buffering' : key;
    const s = STATUS[effective] || STATUS.waiting;
    syncDot.className   = `dot ${s.dot}`;
    syncLabel.textContent = s.text;
    pillDot.className   = `dot ${s.dot}`;
    pillLabel.textContent = s.text;
  }

  setSyncStatus('waiting');
  updateVolumeIcon();
}());
