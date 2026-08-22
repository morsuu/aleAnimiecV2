/* admin.js – admin panel: upload, load & control video for all viewers */
'use strict';

(function () {

  // ── DOM refs ─────────────────────────────────────────────────────────────────

  const loginOverlay   = document.getElementById('login-overlay');
  const mainContent    = document.getElementById('main-content');
  const pwInput        = document.getElementById('pw-input');
  const pwSubmit       = document.getElementById('pw-submit');
  const pwError        = document.getElementById('pw-error');

  const connDot        = document.getElementById('conn-dot');
  const connLabel      = document.getElementById('conn-label');
  const viewersCount   = document.getElementById('viewers-count');

  const dropZone       = document.getElementById('drop-zone');
  const fileInput      = document.getElementById('file-input');
  const dropFilename   = document.getElementById('drop-filename');
  const uploadControls = document.getElementById('upload-controls');
  const uploadBtn      = document.getElementById('upload-btn');
  const uploadStatus   = document.getElementById('upload-status');
  const progressWrap   = document.getElementById('progress-wrap');
  const progressBar    = document.getElementById('progress-bar');

  const libraryCard    = document.getElementById('library-card');
  const libraryList    = document.getElementById('library-list');
  const libraryRefresh = document.getElementById('library-refresh');

  const urlInput       = document.getElementById('url-input');
  const urlLoadBtn     = document.getElementById('url-load-btn');
  const urlStatus      = document.getElementById('url-status');

  const embedInput     = document.getElementById('embed-input');
  const embedLoadBtn   = document.getElementById('embed-load-btn');
  const embedStatus    = document.getElementById('embed-status');

  const subDropZone    = document.getElementById('sub-drop-zone');
  const subFileInput   = document.getElementById('sub-file-input');
  const subDropName    = document.getElementById('sub-drop-filename');
  const subUploadStatus= document.getElementById('sub-upload-status');
  const subList        = document.getElementById('sub-list');
  const subSyncPanel   = document.getElementById('sub-sync-panel');
  const subOffsetInput = document.getElementById('sub-offset-input');
  const subOffsetMinus = document.getElementById('sub-offset-minus');
  const subOffsetPlus  = document.getElementById('sub-offset-plus');
  const subOffsetReset = document.getElementById('sub-offset-reset');
  const subtitleLayer  = document.getElementById('subtitle-layer');
  const btnCc          = document.getElementById('btn-cc');

  const placeholder    = document.getElementById('placeholder');
  const player         = document.getElementById('player');
  const embedPlayer    = document.getElementById('embed-player');
  const videoWrap      = document.getElementById('video-wrap');
  const btnFullscreen  = document.getElementById('btn-fullscreen');
  const videoControls  = document.getElementById('video-controls');
  const btnMute        = document.getElementById('btn-mute');
  const volIconOn      = document.getElementById('vol-icon-on');
  const volIconOff     = document.getElementById('vol-icon-off');
  const volumeSlider   = document.getElementById('volume-slider');
  const playbackControls = document.getElementById('playback-controls');
  const btnPlay        = document.getElementById('btn-play');
  const btnPause       = document.getElementById('btn-pause');
  const btnRestart     = document.getElementById('btn-restart');
  const btnBack10      = document.getElementById('btn-back10');
  const btnFwd10       = document.getElementById('btn-fwd10');
  const btnClear       = document.getElementById('btn-clear');
  const seekBar        = document.getElementById('seek-bar');
  const seekTrack      = document.getElementById('seek-track');
  const seekBuffered   = document.getElementById('seek-buffered');
  const seekPlayed     = document.getElementById('seek-played');
  const seekThumb      = document.getElementById('seek-thumb');
  const seekCurrent    = document.getElementById('seek-current');
  const seekDuration   = document.getElementById('seek-duration');
  const stateDot       = document.getElementById('state-dot');
  const stateLabel     = document.getElementById('state-label');

  // ── State ─────────────────────────────────────────────────────────────────────

  const BACKEND = window.BACKEND_URL || '';
  const LINKS_KEY = 'aleanimiec.links';
  const PW_KEY = 'aleanimiec.pw';

  let adminPassword = '';
  let socket        = null;
  let selectedFile  = null;
  let maxUploadBytes = 0;   // dostarczany razem z listą w /videos

  /** Files that live in uploads/ on the server (fetched from /videos). */
  let serverFiles = [];
  /** URLs / embeds pasted during earlier sessions, kept in localStorage. */
  let linkEntries = loadLinks();

  if (typeof io === 'undefined') {
    pwError.textContent = 'Nie można załadować klienta socket.io – serwer jest niedostępny.';
    connDot.className = 'dot red';
    connLabel.textContent = 'Brak serwera';
    return;
  }

  function loadLinks() {
    try {
      const raw = localStorage.getItem(LINKS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      // 'cineby' entries come from an older build and no longer play.
      return Array.isArray(parsed)
        ? parsed.filter((e) => e && typeof e.url === 'string' && e.kind !== 'cineby')
        : [];
    } catch (_) {
      return [];
    }
  }

  function saveLinks() {
    try { localStorage.setItem(LINKS_KEY, JSON.stringify(linkEntries.slice(0, 30))); } catch (_) {}
  }

  function rememberLink(url, kind) {
    const existing = linkEntries.findIndex((e) => e.url === url);
    if (existing !== -1) linkEntries.splice(existing, 1);
    linkEntries.unshift({ url, kind });
    saveLinks();
    renderLibrary();
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────────

  btnFullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      videoWrap.requestFullscreen().catch(() => {});
    }
  });

  // ── Volume control ──────────────────────────────────────────────────────────

  let savedVolume = 1;

  volumeSlider.addEventListener('input', () => {
    const vol = parseFloat(volumeSlider.value);
    setVolume(vol);
    savedVolume = vol > 0 ? vol : savedVolume;
  });

  btnMute.addEventListener('click', () => {
    if (currentVolume() > 0) {
      savedVolume = currentVolume();
      setVolume(0);
      volumeSlider.value = 0;
    } else {
      setVolume(savedVolume || 1);
      volumeSlider.value = savedVolume || 1;
    }
  });

  function currentVolume() {
    if (isEmbedMode && ytPlayer && ytPlayer.getVolume) {
      return ytPlayer.isMuted && ytPlayer.isMuted() ? 0 : ytPlayer.getVolume() / 100;
    }
    return player.muted ? 0 : player.volume;
  }

  /** Route volume to whichever player is on screen – the slider used to be inert in embed mode. */
  function setVolume(vol) {
    player.muted = vol === 0;
    player.volume = vol;
    if (ytPlayer && ytPlayer.setVolume) {
      ytPlayer.setVolume(Math.round(vol * 100));
      if (vol === 0 && ytPlayer.mute) ytPlayer.mute();
      else if (ytPlayer.unMute) ytPlayer.unMute();
    }
    updateVolumeIcon(vol);
  }

  function updateVolumeIcon(vol) {
    const v = typeof vol === 'number' ? vol : currentVolume();
    if (v === 0) {
      volIconOn.classList.add('hidden');
      volIconOff.classList.remove('hidden');
    } else {
      volIconOn.classList.remove('hidden');
      volIconOff.classList.add('hidden');
    }
  }

  // ── Auto-hide controls after 3 seconds ──────────────────────────────────────

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

  showControls();

  // ── Embed helpers ─────────────────────────────────────────────────────────────

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

  function toTwitchEmbedUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'www.twitch.tv' || u.hostname === 'twitch.tv' || u.hostname === 'm.twitch.tv') {
        if (u.pathname.startsWith('/videos/')) {
          const videoId = u.pathname.split('/videos/')[1];
          return `https://player.twitch.tv/?video=${videoId}&parent=${location.hostname}&autoplay=true`;
        }
        const channel = u.pathname.replace(/^\//, '').split('/')[0];
        if (channel) return `https://player.twitch.tv/?channel=${channel}&parent=${location.hostname}&autoplay=true`;
      }
    } catch (_) {}
    return null;
  }

  let isEmbedMode = false;
  let currentEmbedUrl = null;
  let currentSrcKey = null;
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
  if (window.YT && window.YT.Player) {
    ytReady = true;
  }

  function createYTPlayerAdmin(videoId) {
    ytVideoId = videoId;
    embedPlayer.innerHTML = '';
    embedPlayer.classList.remove('hidden');
    const playerDiv = document.createElement('div');
    playerDiv.id = 'yt-player-admin';
    embedPlayer.appendChild(playerDiv);

    ytPlayer = new YT.Player('yt-player-admin', {
      videoId: videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 1,        // Admin can see controls for reference
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
      },
      events: {
        onStateChange: function(event) {
          // When admin plays/pauses via YT player, sync to viewers
          if (!socket) return;
          const currentTime = ytTime();
          if (event.data === YT.PlayerState.PLAYING) {
            socket.emit('admin:play', { password: adminPassword, currentTime: currentTime });
            setStateUI(true);
          } else if (event.data === YT.PlayerState.PAUSED) {
            socket.emit('admin:pause', { password: adminPassword, currentTime: currentTime });
            setStateUI(false);
          }
        },
      },
    });
  }

  /** YT returns undefined/NaN before it is ready; a NaN time desyncs every viewer. */
  function ytTime() {
    if (!ytPlayer || !ytPlayer.getCurrentTime) return 0;
    const t = ytPlayer.getCurrentTime();
    return Number.isFinite(t) && t >= 0 ? t : 0;
  }

  function showEmbed(url) {
    isEmbedMode = true;
    currentEmbedUrl = url;
    currentSrcKey = null;
    player.classList.add('hidden');
    player.pause();
    placeholder.classList.add('hidden');
    showSeekBar(false);
    clearInterval(ytWaitTimer);

    const ytId = extractYouTubeId(url);
    if (ytId) {
      if (ytReady || (window.YT && window.YT.Player)) {
        ytReady = true;
        if (ytVideoId !== ytId) createYTPlayerAdmin(ytId);
      } else {
        // Tracked so a second load before the API arrives can't create two players.
        ytWaitTimer = setInterval(() => {
          if (ytReady || (window.YT && window.YT.Player)) {
            ytReady = true;
            clearInterval(ytWaitTimer);
            createYTPlayerAdmin(ytId);
          }
        }, 100);
      }
      // Show playback controls for admin YouTube sync
      playbackControls.classList.remove('hidden');
    } else {
      // Non-YouTube embed (Twitch, …) – plain iframe, no sync possible
      const twitchUrl = toTwitchEmbedUrl(url);
      embedPlayer.innerHTML = '';
      embedPlayer.classList.remove('hidden');
      const iframe = document.createElement('iframe');
      iframe.src = twitchUrl || url;
      iframe.allowFullscreen = true;
      iframe.allow = 'autoplay; encrypted-media; fullscreen';
      iframe.style.cssText = 'width:100%;height:100%;border:none;';
      embedPlayer.appendChild(iframe);
      ytPlayer = null;
      ytVideoId = null;
      // Hide standard playback controls for non-YT embeds, but keep "clear".
      playbackControls.classList.remove('hidden');
      btnPlay.classList.add('hidden');
      btnPause.classList.add('hidden');
      btnRestart.classList.add('hidden');
    }
  }

  function showVideo() {
    isEmbedMode = false;
    currentEmbedUrl = null;
    clearInterval(ytWaitTimer);
    embedPlayer.classList.add('hidden');
    embedPlayer.innerHTML = '';
    player.classList.remove('hidden');
    ytPlayer = null;
    ytVideoId = null;
    btnPlay.classList.remove('hidden');
    btnPause.classList.remove('hidden');
    btnRestart.classList.remove('hidden');
  }

  function clearPlayer() {
    showVideo();
    player.pause();
    player.removeAttribute('src');
    player.load();
    currentSrcKey = null;
    placeholder.classList.remove('hidden');
    playbackControls.classList.add('hidden');
    showSeekBar(false);
    stateDot.className = 'dot';
    stateLabel.textContent = 'Brak aktywnego filmu';
  }

  // ── Login flow ────────────────────────────────────────────────────────────────
  // Hasło nie jest tu weryfikowane – nie ma endpointu, który mógłby to zrobić.
  // Panel przyjmuje je na słowo i dopiero serwer odrzuca komendy przy złym haśle.

  pwSubmit.addEventListener('click', () => attemptLogin(pwInput.value.trim()));
  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pwSubmit.click(); });

  function attemptLogin(pw) {
    if (!pw) { pwError.textContent = 'Podaj hasło.'; return false; }

    adminPassword = pw;
    try { sessionStorage.setItem(PW_KEY, pw); } catch (_) {}
    pwError.textContent = '';
    loginOverlay.style.display = 'none';
    mainContent.style.display  = 'block';
    initSocket();
    refreshLibrary();
    refreshSubtitles();
    return true;
  }

  // Resume the session after a page reload instead of asking again.
  (function autoLogin() {
    let saved = null;
    try { saved = sessionStorage.getItem(PW_KEY); } catch (_) {}
    if (saved) attemptLogin(saved);
  }());

  // ── Socket ────────────────────────────────────────────────────────────────────

  function initSocket() {
    if (socket) return;
    socket = io(BACKEND || undefined);

    socket.on('connect', () => {
      connDot.className   = 'dot green';
      connLabel.textContent = 'Połączono';
    });

    socket.on('connect_error', () => {
      connDot.className   = 'dot red';
      connLabel.textContent = 'Brak połączenia';
    });

    socket.on('disconnect', () => {
      connDot.className   = 'dot red';
      connLabel.textContent = 'Rozłączono';
    });

    socket.on('viewers:count', (n) => { viewersCount.textContent = n; });

    socket.on('sync:state', updatePlayerState);

    socket.on('video:loaded', ({ filename, isExternal, isEmbed }) => {
      if (isExternal) rememberLink(filename, isEmbed ? 'embed' : 'url');
      else refreshLibrary();
    });

    socket.on('video:cleared', clearPlayer);

    socket.on('subtitles:changed', refreshSubtitles);

    socket.on('subtitles:offset', ({ offset }) => applyOffset(offset, { broadcast: false }));

    socket.on('admin:error', ({ message }) => {
      stateDot.className = 'dot red';
      stateLabel.textContent = message || 'Błąd';
    });
  }

  // ── Upload ────────────────────────────────────────────────────────────────────

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) setSelectedFile(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setSelectedFile(fileInput.files[0]);
  });

  function setSelectedFile(file) {
    selectedFile = file;
    dropFilename.textContent = `${file.name} (${formatSize(file.size)})`;
    uploadControls.style.display = 'flex';

    // Catch an oversized file here – once the stream is rejected mid-upload the
    // browser usually reports a bare network error instead of the real reason.
    if (maxUploadBytes && file.size > maxUploadBytes) {
      uploadStatus.textContent = `Plik jest za duży (limit ${formatSize(maxUploadBytes)}).`;
      uploadBtn.disabled = true;
      selectedFile = null;
      return;
    }
    uploadBtn.disabled = false;
    uploadStatus.textContent = '';
  }

  uploadBtn.addEventListener('click', () => {
    if (!selectedFile) return;
    doUpload(selectedFile);
  });

  /** Pull the server's JSON error message out of a failed upload response. */
  function errorMessage(xhr) {
    try {
      const data = JSON.parse(xhr.responseText);
      if (data && data.error) return data.error;
    } catch (_) {}
    if (xhr.status === 403) return 'Brak autoryzacji – zaloguj się ponownie.';
    if (xhr.status === 0) return 'Połączenie przerwane (CORS lub serwer offline).';
    return `Błąd: ${xhr.status}`;
  }

  function doUpload(file) {
    const fd = new FormData();
    fd.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BACKEND}/upload`);
    xhr.setRequestHeader('x-admin-password', adminPassword);

    progressWrap.classList.remove('hidden');
    progressBar.style.width = '0%';
    uploadBtn.disabled = true;
    uploadStatus.textContent = 'Wgrywanie…';

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressBar.style.width = pct + '%';
        uploadStatus.textContent = `Wgrywanie… ${pct}%`;
      }
    });

    xhr.addEventListener('load', () => {
      uploadBtn.disabled = false;
      progressWrap.classList.add('hidden');

      if (xhr.status === 200) {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (_) {}
        uploadStatus.textContent = '✓ Wgrano!';
        selectedFile = null;
        fileInput.value = '';
        dropFilename.textContent = '';
        uploadControls.style.display = 'none';
        refreshLibrary();
        if (data.filename) loadVideoForAdmin(data.filename, false);
      } else {
        uploadStatus.textContent = errorMessage(xhr);
      }
    });

    xhr.addEventListener('error', () => {
      uploadBtn.disabled = false;
      progressWrap.classList.add('hidden');
      uploadStatus.textContent = 'Błąd sieci – sprawdź połączenie z serwerem.';
    });

    xhr.addEventListener('abort', () => {
      uploadBtn.disabled = false;
      progressWrap.classList.add('hidden');
      uploadStatus.textContent = 'Przerwano.';
    });

    xhr.send(fd);
  }

  // ── Load from URL / embed ───────────────────────────────────────────────────

  function validUrl(value, statusEl) {
    if (!value) { statusEl.textContent = 'Podaj URL.'; return false; }
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    } catch (_) {
      statusEl.textContent = 'Nieprawidłowy URL (musi zaczynać się od http:// lub https://).';
      return false;
    }
    return true;
  }

  urlLoadBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!validUrl(url, urlStatus)) return;
    socket.emit('admin:load-url', { password: adminPassword, url });
    loadVideoForAdmin(url, true);
    urlStatus.textContent = '✓ Załadowano z URL!';
    rememberLink(url, 'url');
  });

  embedLoadBtn.addEventListener('click', () => {
    const url = embedInput.value.trim();
    if (!validUrl(url, embedStatus)) return;
    socket.emit('admin:load-embed', { password: adminPassword, url });
    showEmbed(url);
    embedStatus.textContent = '✓ Osadzono!';
    rememberLink(url, 'embed');
  });

  // ── Subtitles ─────────────────────────────────────────────────────────────────
  // The admin renders the same track locally, so the offset can be dialled in
  // against the picture instead of guessing.

  const subs = window.Subtitles.createRenderer(subtitleLayer);
  let subtitleFiles = [];        // .vtt files on the server
  let activeSubtitle = null;     // the one currently broadcast
  let currentSubtitleFile = null; // the one parsed into `subs`

  function updateCcButton() {
    btnCc.setAttribute('aria-pressed', subs.isVisible() ? 'true' : 'false');
    btnCc.title = subs.isVisible() ? 'Wyłącz napisy' : 'Włącz napisy';
  }

  btnCc.addEventListener('click', () => {
    subs.setVisible(!subs.isVisible());
    updateCcButton();
  });

  async function loadSubtitle(file) {
    if ((file || null) === currentSubtitleFile) return;
    currentSubtitleFile = file || null;

    if (!currentSubtitleFile) {
      subs.clear();
      btnCc.classList.add('hidden');
      return;
    }
    try {
      const res = await fetch(`${BACKEND}/uploads/${encodeURIComponent(currentSubtitleFile)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cues = window.Subtitles.parse(await res.text());
      if (currentSubtitleFile !== file) return;
      subs.setCues(cues);
      btnCc.classList.toggle('hidden', cues.length === 0);
      updateCcButton();
    } catch (_) {
      subs.clear();
      btnCc.classList.add('hidden');
    }
  }

  // ── Upload ──

  subDropZone.addEventListener('click', () => subFileInput.click());
  subDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    subDropZone.classList.add('dragover');
  });
  subDropZone.addEventListener('dragleave', () => subDropZone.classList.remove('dragover'));
  subDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    subDropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadSubtitle(e.dataTransfer.files[0]);
  });
  subFileInput.addEventListener('change', () => {
    if (subFileInput.files[0]) uploadSubtitle(subFileInput.files[0]);
  });

  async function uploadSubtitle(file) {
    subDropName.textContent = file.name;
    subUploadStatus.textContent = 'Wysyłanie…';

    const fd = new FormData();
    fd.append('subtitle', file);
    try {
      const res = await fetch(`${BACKEND}/subtitles`, {
        method: 'POST',
        headers: { 'x-admin-password': adminPassword },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        subUploadStatus.textContent = data.error || `Błąd: ${res.status}`;
        return;
      }
      subUploadStatus.textContent = '✓ Napisy wgrane i włączone!';
      subFileInput.value = '';
      refreshSubtitles();
    } catch (_) {
      subUploadStatus.textContent = 'Błąd sieci.';
    }
  }

  async function refreshSubtitles() {
    try {
      const res = await fetch(`${BACKEND}/subtitles`, { headers: { 'x-admin-password': adminPassword } });
      if (!res.ok) return;
      const data = await res.json();
      subtitleFiles = Array.isArray(data.files) ? data.files : [];
    } catch (_) { /* keep the old list */ }
    renderSubtitleList();
  }

  function renderSubtitleList() {
    subList.innerHTML = '';
    subtitleFiles.forEach((entry) => {
      const isActive = entry.name === activeSubtitle;
      const row = document.createElement('div');
      row.className = 'library-row';

      const name = document.createElement('span');
      name.className = 'library-row__name';
      name.textContent = `${isActive ? '💬' : '📄'} ${entry.name}`;
      name.title = entry.name;

      const toggle = document.createElement('button');
      toggle.className = isActive ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm';
      toggle.textContent = isActive ? 'Wyłącz' : 'Włącz';
      toggle.addEventListener('click', () => {
        socket.emit('admin:subtitle', { password: adminPassword, file: isActive ? null : entry.name });
      });

      const remove = document.createElement('button');
      remove.className = 'btn btn-danger btn-sm';
      remove.textContent = '🗑';
      remove.title = 'Usuń napisy z serwera';
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Usunąć napisy „${entry.name}"?`)) return;
        remove.disabled = true;
        try {
          const res = await fetch(`${BACKEND}/subtitles/${encodeURIComponent(entry.name)}`, {
            method: 'DELETE',
            headers: { 'x-admin-password': adminPassword },
          });
          if (!res.ok) throw new Error('delete failed');
        } catch (_) {
          remove.disabled = false;
          window.alert('Nie udało się usunąć napisów.');
          return;
        }
        refreshSubtitles();
      });

      row.appendChild(name);
      row.appendChild(toggle);
      row.appendChild(remove);
      subList.appendChild(row);
    });

    subSyncPanel.classList.toggle('hidden', !activeSubtitle);
  }

  // ── Offset ──
  // Typing sends continuously, so debounce the socket traffic while still
  // updating the admin's own rendering immediately.

  let offsetTimer = null;

  function applyOffset(value, { broadcast }) {
    const n = Number(value);
    const offset = Number.isFinite(n) ? Math.max(-600, Math.min(600, n)) : 0;
    subs.setOffset(offset);
    if (document.activeElement !== subOffsetInput) subOffsetInput.value = offset;
    if (!broadcast) return;
    clearTimeout(offsetTimer);
    offsetTimer = setTimeout(() => {
      socket.emit('admin:subtitle-offset', { password: adminPassword, offset });
    }, 150);
  }

  subOffsetInput.addEventListener('input', () => applyOffset(subOffsetInput.value, { broadcast: true }));
  subOffsetMinus.addEventListener('click', () => {
    subOffsetInput.value = (Number(subOffsetInput.value || 0) - 0.5).toFixed(1);
    applyOffset(subOffsetInput.value, { broadcast: true });
  });
  subOffsetPlus.addEventListener('click', () => {
    subOffsetInput.value = (Number(subOffsetInput.value || 0) + 0.5).toFixed(1);
    applyOffset(subOffsetInput.value, { broadcast: true });
  });
  subOffsetReset.addEventListener('click', () => {
    subOffsetInput.value = '0';
    applyOffset(0, { broadcast: true });
  });

  // A timer rather than requestAnimationFrame: rAF is suspended while the tab is
  // hidden, and 100 ms is well below the threshold where a cue change is visible.
  setInterval(() => {
    if (currentSrcKey && !isEmbedMode) {
      subs.update(player.currentTime);
      if (!scrubbing) updateSeekUI();
    }
  }, 100);

  // ── Library ───────────────────────────────────────────────────────────────────

  function formatSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /** Fetch the real contents of uploads/ – the list used to live only in memory. */
  async function refreshLibrary() {
    try {
      const res = await fetch(`${BACKEND}/videos`, { headers: { 'x-admin-password': adminPassword } });
      if (!res.ok) return;
      const data = await res.json();
      serverFiles = Array.isArray(data.files) ? data.files : [];
      if (data.maxUploadBytes) maxUploadBytes = data.maxUploadBytes;
    } catch (_) {
      // keep whatever we had
    }
    renderLibrary();
  }

  libraryRefresh.addEventListener('click', refreshLibrary);

  function renderLibrary() {
    const rows = [
      ...serverFiles.map((f) => ({ label: f.name, name: f.name, size: f.size, kind: 'file' })),
      ...linkEntries.map((e) => ({ label: e.url, name: e.url, kind: e.kind })),
    ];

    libraryCard.classList.toggle('hidden', rows.length === 0);
    libraryList.innerHTML = '';

    const icons = { file: '🎞', url: '🔗', embed: '📺' };

    rows.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'library-row';

      const name = document.createElement('span');
      name.className = 'library-row__name';
      name.textContent = `${icons[entry.kind] || ''} ${entry.label}`;
      name.title = entry.label;

      const play = document.createElement('button');
      play.className = 'btn btn-secondary btn-sm';
      play.textContent = '▶ Odtwórz';
      play.addEventListener('click', () => {
        if (entry.kind === 'embed') {
          socket.emit('admin:load-embed', { password: adminPassword, url: entry.name });
          showEmbed(entry.name);
        } else if (entry.kind === 'url') {
          socket.emit('admin:load-url', { password: adminPassword, url: entry.name });
          loadVideoForAdmin(entry.name, true);
        } else {
          socket.emit('admin:load', { password: adminPassword, filename: entry.name });
          loadVideoForAdmin(entry.name, false);
        }
      });

      const remove = document.createElement('button');
      remove.className = 'btn btn-danger btn-sm';
      remove.textContent = '🗑';
      remove.title = entry.kind === 'file' ? 'Usuń plik z serwera' : 'Usuń z listy';
      remove.addEventListener('click', () => deleteEntry(entry, remove));

      row.appendChild(name);
      if (entry.size) {
        const size = document.createElement('span');
        size.className = 'library-row__size';
        size.textContent = formatSize(entry.size);
        row.appendChild(size);
      }
      row.appendChild(play);
      row.appendChild(remove);
      libraryList.appendChild(row);
    });
  }

  async function deleteEntry(entry, btn) {
    if (entry.kind !== 'file') {
      linkEntries = linkEntries.filter((e) => e.url !== entry.name);
      saveLinks();
      renderLibrary();
      return;
    }
    if (!window.confirm(`Usunąć plik „${entry.name}" z serwera?`)) return;
    btn.disabled = true;
    try {
      const res = await fetch(`${BACKEND}/videos/${encodeURIComponent(entry.name)}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': adminPassword },
      });
      if (!res.ok) throw new Error('delete failed');
    } catch (_) {
      btn.disabled = false;
      window.alert('Nie udało się usunąć pliku.');
      return;
    }
    refreshLibrary();
  }

  // ── Player ────────────────────────────────────────────────────────────────────

  function loadVideoForAdmin(filename, isExternal) {
    // Switch back from embed mode if needed
    if (isEmbedMode) showVideo();
    // Only allow http/https for external URLs
    if (isExternal && !filename.startsWith('http://') && !filename.startsWith('https://')) return;

    const key = (isExternal ? 'ext:' : 'up:') + filename;
    if (key !== currentSrcKey) {
      currentSrcKey = key;
      // Swapping the source fires pause/seeked on the element; don't echo those.
      suppressSeekSync(1000);
      player.src = isExternal
        ? `${BACKEND}/proxy?url=${encodeURIComponent(filename)}`
        : `${BACKEND}/uploads/${encodeURIComponent(filename)}`;
      player.load();
      placeholder.classList.add('hidden');
    }
    playbackControls.classList.remove('hidden');
    showSeekBar(true);
  }

  player.addEventListener('error', () => {
    if (!currentSrcKey) return;
    stateDot.className = 'dot red';
    stateLabel.textContent = 'Nie udało się załadować filmu (sprawdź plik lub URL).';
  });

  // The `play` / `pause` element events below do the broadcasting, so these
  // buttons only drive the player – otherwise every click emitted twice.
  btnPlay.addEventListener('click', () => {
    if (isEmbedMode && ytPlayer && ytPlayer.playVideo) {
      ytPlayer.playVideo();   // YT onStateChange broadcasts
      setStateUI(true);
    } else {
      player.play().catch(() => {});
    }
  });

  btnPause.addEventListener('click', () => {
    if (isEmbedMode && ytPlayer && ytPlayer.pauseVideo) {
      ytPlayer.pauseVideo();
      setStateUI(false);
    } else {
      player.pause();
    }
  });

  btnRestart.addEventListener('click', () => {
    if (isEmbedMode && ytPlayer && ytPlayer.seekTo) {
      ytPlayer.pauseVideo();
      ytPlayer.seekTo(0, true);
    } else {
      player.pause();
      suppressSeekSync();
      player.currentTime = 0;
    }
    socket.emit('admin:seek',  { password: adminPassword, currentTime: 0 });
    socket.emit('admin:pause', { password: adminPassword, currentTime: 0 });
    setStateUI(false);
  });

  btnClear.addEventListener('click', () => {
    socket.emit('admin:clear', { password: adminPassword });
    clearPlayer();
  });

  // ── Seek bar ─────────────────────────────────────────────────────────────────
  // The <video> has no native controls (they would let the admin desync himself
  // from the room), so playback position gets its own scrubber. Dragging it just
  // moves player.currentTime – the existing `seeked` handler broadcasts.

  let scrubbing = false;

  function formatClock(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  /** Duration we can actually seek within (live streams report Infinity). */
  function seekableDuration() {
    const d = player.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  function ratioFromPointer(e) {
    const rect = seekTrack.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function scrubTo(e) {
    const d = seekableDuration();
    if (!d) return;
    player.currentTime = Math.min(d - 0.05, ratioFromPointer(e) * d);
    updateSeekUI();
  }

  seekTrack.addEventListener('pointerdown', (e) => {
    if (isEmbedMode || !seekableDuration()) return;
    scrubbing = true;
    try { seekTrack.setPointerCapture(e.pointerId); } catch (_) {}
    scrubTo(e);
    e.preventDefault();
  });

  seekTrack.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });

  function endScrub(e) {
    if (!scrubbing) return;
    scrubbing = false;
    try { seekTrack.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  seekTrack.addEventListener('pointerup', (e) => { scrubTo(e); endScrub(e); });
  seekTrack.addEventListener('pointercancel', endScrub);

  // Keyboard access for the same control.
  seekTrack.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { nudge(5); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { nudge(-5); e.preventDefault(); }
  });

  /** Jump relative to the current position, on whichever player is active. */
  function nudge(delta) {
    if (isEmbedMode) {
      if (!ytPlayer || !ytPlayer.seekTo) return;
      const t = Math.max(0, ytTime() + delta);
      ytPlayer.seekTo(t, true);
      socket.emit('admin:seek', { password: adminPassword, currentTime: t });
      return;
    }
    const d = seekableDuration();
    if (!d) return;
    player.currentTime = Math.min(d - 0.05, Math.max(0, player.currentTime + delta));
  }

  btnBack10.addEventListener('click', () => nudge(-10));
  btnFwd10.addEventListener('click', () => nudge(10));

  function updateSeekUI() {
    const d = seekableDuration();
    const t = player.currentTime || 0;

    seekCurrent.textContent = formatClock(t);
    seekDuration.textContent = d ? formatClock(d) : '--:--';

    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    seekPlayed.style.width = pct + '%';
    seekThumb.style.left = pct + '%';

    seekTrack.setAttribute('aria-valuemax', Math.round(d));
    seekTrack.setAttribute('aria-valuenow', Math.round(t));
    seekTrack.setAttribute('aria-valuetext', `${formatClock(t)} z ${d ? formatClock(d) : '?'}`);

    // Buffered span covering the playhead – tells the admin whether a seek will stall.
    let bufferedEnd = 0;
    try {
      for (let i = 0; i < player.buffered.length; i++) {
        if (player.buffered.start(i) <= t && player.buffered.end(i) >= t) {
          bufferedEnd = player.buffered.end(i);
          break;
        }
      }
    } catch (_) { /* buffered throws while the element is empty */ }
    seekBuffered.style.width = d ? Math.min(100, (bufferedEnd / d) * 100) + '%' : '0%';
  }

  function showSeekBar(on) {
    seekBar.classList.toggle('hidden', !on);
    if (on) updateSeekUI();
  }

  // ── Seek sync ────────────────────────────────────────────────────────────────
  // Programmatic seeks must not be echoed back to the server. The old boolean
  // flag stayed armed whenever a seek produced no `seeked` event (e.g. the value
  // didn't change), which then swallowed the admin's next real scrub.

  let seekTimer = null;
  let suppressSeekUntil = 0;

  function suppressSeekSync(ms) {
    suppressSeekUntil = Date.now() + (ms || 600);
  }

  player.addEventListener('seeked', () => {
    if (Date.now() < suppressSeekUntil) return;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      socket.emit('admin:seek', { password: adminPassword, currentTime: player.currentTime });
    }, 200);
  });

  // Keep the server in step when the admin uses the native controls.
  player.addEventListener('play', () => {
    if (!socket || Date.now() < suppressSeekUntil) return;
    socket.emit('admin:play', { password: adminPassword, currentTime: player.currentTime });
    setStateUI(true);
  });

  player.addEventListener('pause', () => {
    if (!socket || Date.now() < suppressSeekUntil || player.ended) return;
    socket.emit('admin:pause', { password: adminPassword, currentTime: player.currentTime });
    setStateUI(false);
  });

  // Without this the server keeps advancing its clock past the end of the film
  // and every viewer sits in an endless "korekcja synchronizacji" loop.
  player.addEventListener('ended', () => {
    if (!socket) return;
    const end = Number.isFinite(player.duration) ? player.duration : player.currentTime;
    socket.emit('admin:pause', { password: adminPassword, currentTime: end });
    stateDot.className = 'dot yellow';
    stateLabel.textContent = 'Koniec filmu';
  });

  // ── State UI ──────────────────────────────────────────────────────────────────

  function setStateUI(playing) {
    if (playing) {
      stateDot.className   = 'dot green';
      stateLabel.textContent = 'Odtwarzanie — widzowie zsynchronizowani';
    } else {
      stateDot.className   = 'dot yellow';
      stateLabel.textContent = 'Wstrzymano';
    }
  }

  // The admin drives the state, so the 3s heartbeat should only nudge the local
  // player when it is genuinely out of step (e.g. a second admin tab took over).
  // Applying it unconditionally re-seeked the video every three seconds.
  const ADMIN_DRIFT_TOLERANCE = 2; // seconds

  function updatePlayerState(state) {
    if (!state) return;

    // Track which subtitle the server considers active, so the list buttons and
    // the local rendering follow whatever any admin tab picked.
    if (state.subtitle !== activeSubtitle) {
      activeSubtitle = state.subtitle || null;
      renderSubtitleList();
    }
    if (state.isEmbed || !state.filename) loadSubtitle(null);
    else loadSubtitle(state.subtitle);
    applyOffset(state.subtitleOffset || 0, { broadcast: false });

    if (!state.filename) {
      if (currentSrcKey || isEmbedMode) clearPlayer();
      return;
    }

    if (state.isEmbed) {
      if (!isEmbedMode || currentEmbedUrl !== state.filename) showEmbed(state.filename);
      if (ytPlayer && ytPlayer.seekTo) {
        const target = state.playing
          ? state.currentTime + (Date.now() - state.serverTime) / 1000
          : state.currentTime;
        if (Math.abs(ytTime() - target) > ADMIN_DRIFT_TOLERANCE) ytPlayer.seekTo(target, true);
        const playerState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
        if (state.playing && playerState !== YT.PlayerState.PLAYING && playerState !== YT.PlayerState.BUFFERING) {
          ytPlayer.playVideo();
        } else if (!state.playing && playerState === YT.PlayerState.PLAYING) {
          ytPlayer.pauseVideo();
        }
      }
      setStateUI(state.playing);
      return;
    }

    loadVideoForAdmin(state.filename, !!state.isExternal);

    // While the admin drags the scrubber his own position is the truth; the
    // heartbeat still carries the pre-seek time and would yank it back.
    if (scrubbing) { setStateUI(state.playing); return; }

    const target = state.playing
      ? state.currentTime + (Date.now() - state.serverTime) / 1000
      : state.currentTime;

    if (Math.abs(player.currentTime - target) > ADMIN_DRIFT_TOLERANCE) {
      suppressSeekSync();
      player.currentTime = target;
    }

    if (state.playing && player.paused) {
      suppressSeekSync();
      player.play().catch(() => {});
    } else if (!state.playing && !player.paused) {
      suppressSeekSync();
      player.pause();
    }

    setStateUI(state.playing);
  }

  updateVolumeIcon(1);

}());
