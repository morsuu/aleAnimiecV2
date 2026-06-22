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

  const urlInput       = document.getElementById('url-input');
  const urlLoadBtn     = document.getElementById('url-load-btn');
  const urlStatus      = document.getElementById('url-status');

  const embedInput     = document.getElementById('embed-input');
  const embedLoadBtn   = document.getElementById('embed-load-btn');
  const embedStatus    = document.getElementById('embed-status');

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
  const stateDot       = document.getElementById('state-dot');
  const stateLabel     = document.getElementById('state-label');

  // ── State ─────────────────────────────────────────────────────────────────────

  let adminPassword = '';
  let socket        = null;
  let selectedFile  = null;
  let loadedFilenames = []; // { name: string, isEmbed: boolean }[]

  const BACKEND = window.BACKEND_URL || '';

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
    player.volume = vol;
    savedVolume = vol > 0 ? vol : savedVolume;
    updateVolumeIcon();
  });

  btnMute.addEventListener('click', () => {
    if (player.volume > 0) {
      savedVolume = player.volume;
      player.volume = 0;
      volumeSlider.value = 0;
    } else {
      player.volume = savedVolume || 1;
      volumeSlider.value = player.volume;
    }
    updateVolumeIcon();
  });

  function updateVolumeIcon() {
    if (player.volume === 0) {
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

  function toEmbedUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com' || u.hostname === 'youtu.be' || u.hostname === 'm.youtube.com') {
        let vid = null;
        if (u.hostname === 'youtu.be') vid = u.pathname.slice(1);
        else if (u.pathname.startsWith('/watch')) vid = u.searchParams.get('v');
        else if (u.pathname.startsWith('/shorts/')) vid = u.pathname.split('/shorts/')[1].split('/')[0];
        else if (u.pathname.startsWith('/live/')) vid = u.pathname.split('/live/')[1].split('/')[0];
        else if (u.pathname.startsWith('/embed/')) return url;
        if (vid) return `https://www.youtube.com/embed/${vid}?autoplay=1`;
      }
      if (u.hostname === 'www.twitch.tv' || u.hostname === 'twitch.tv' || u.hostname === 'm.twitch.tv') {
        if (u.pathname.startsWith('/videos/')) {
          const videoId = u.pathname.split('/videos/')[1];
          return `https://player.twitch.tv/?video=${videoId}&parent=${location.hostname}&autoplay=true`;
        }
        const channel = u.pathname.replace(/^\//, '').split('/')[0];
        if (channel) return `https://player.twitch.tv/?channel=${channel}&parent=${location.hostname}&autoplay=true`;
      }
      return url;
    } catch (_) { return url; }
  }

  let isEmbedMode = false;

  function showEmbed(url) {
    isEmbedMode = true;
    player.classList.add('hidden');
    player.pause();
    embedPlayer.classList.remove('hidden');
    embedPlayer.src = toEmbedUrl(url);
    placeholder.classList.add('hidden');
    // Hide standard playback controls for embeds
    playbackControls.style.display = 'none';
  }

  function showVideo() {
    isEmbedMode = false;
    embedPlayer.classList.add('hidden');
    embedPlayer.src = '';
    player.classList.remove('hidden');
  }

  // ── Login flow ────────────────────────────────────────────────────────────────

  pwSubmit.addEventListener('click', () => attemptLogin(pwInput.value.trim()));
  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pwSubmit.click(); });

  /**
   * Tries to authenticate by sending a test socket command.
   * We can't verify server-side synchronously, so we connect with the password
   * and the server will silently ignore any admin commands with a wrong password.
   * We do a lightweight HTTP check via the upload endpoint (returns 403 on bad pw).
   */
  async function attemptLogin(pw) {
    if (!pw) { pwError.textContent = 'Podaj hasło.'; return; }

    // Quick auth-check: send a no-op OPTIONS-like fetch
    try {
      const res = await fetch(`${BACKEND}/upload`, {
        method: 'POST',
        headers: { 'x-admin-password': pw },
        body: new FormData(), // empty – server will reject, but we check the HTTP code
      });
      if (res.status === 403) {
        pwError.textContent = 'Złe hasło. Spróbuj ponownie.';
        return;
      }
      // 400 (no file) means the password was accepted
      adminPassword = pw;
      loginOverlay.style.display = 'none';
      mainContent.style.display  = 'block';
      initSocket();
    } catch (err) {
      pwError.textContent = 'Błąd połączenia z serwerem.';
    }
  }

  // ── Socket ────────────────────────────────────────────────────────────────────

  function initSocket() {
    socket = io(BACKEND || undefined);

    socket.on('connect', () => {
      connDot.className   = 'dot green';
      connLabel.textContent = 'Połączono';
    });

    socket.on('disconnect', () => {
      connDot.className   = 'dot red';
      connLabel.textContent = 'Rozłączono';
    });

    socket.on('viewers:count', (n) => { viewersCount.textContent = n; });

    socket.on('sync:state', (state) => {
      updatePlayerState(state);
    });

    socket.on('video:loaded', ({ filename, isEmbed }) => {
      if (!loadedFilenames.some(f => f.name === filename)) {
        loadedFilenames.push({ name: filename, isEmbed: !!isEmbed });
        renderLibrary();
      }
      if (isEmbed) {
        showEmbed(filename);
      }
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
    dropFilename.textContent = file.name;
    uploadControls.style.display = 'flex';
    uploadStatus.textContent = '';
  }

  uploadBtn.addEventListener('click', () => {
    if (!selectedFile) return;
    doUpload(selectedFile);
  });

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
      }
    });

    xhr.addEventListener('load', () => {
      uploadBtn.disabled = false;
      progressWrap.classList.add('hidden');

      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        uploadStatus.textContent = '✓ Wgrano!';
        selectedFile = null;
        if (!loadedFilenames.some(f => f.name === data.filename)) {
          loadedFilenames.push({ name: data.filename, isEmbed: false });
          renderLibrary();
        }
        loadVideoForAdmin(data.filename, false);
      } else {
        uploadStatus.textContent = `Błąd: ${xhr.status}`;
      }
    });

    xhr.addEventListener('error', () => {
      uploadBtn.disabled = false;
      uploadStatus.textContent = 'Błąd sieci.';
    });

    xhr.send(fd);
  }

  // ── Load from URL ─────────────────────────────────────────────────────────────

  urlLoadBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) { urlStatus.textContent = 'Podaj URL.'; return; }
    try { new URL(url); } catch (_) { urlStatus.textContent = 'Nieprawidłowy URL.'; return; }
    socket.emit('admin:load-url', { password: adminPassword, url });
    loadVideoForAdmin(url, true);
    urlStatus.textContent = '✓ Załadowano z URL!';
    if (!loadedFilenames.some(f => f.name === url)) {
      loadedFilenames.push({ name: url, isEmbed: false });
      renderLibrary();
    }
  });

  // ── Load embed (YouTube, Twitch, etc.) ──────────────────────────────────────

  embedLoadBtn.addEventListener('click', () => {
    const url = embedInput.value.trim();
    if (!url) { embedStatus.textContent = 'Podaj URL.'; return; }
    try { new URL(url); } catch (_) { embedStatus.textContent = 'Nieprawidłowy URL.'; return; }
    socket.emit('admin:load-embed', { password: adminPassword, url });
    showEmbed(url);
    embedStatus.textContent = '✓ Osadzono!';
    if (!loadedFilenames.some(f => f.name === url)) {
      loadedFilenames.push({ name: url, isEmbed: true });
      renderLibrary();
    }
  });

  // ── Library ───────────────────────────────────────────────────────────────────

  function renderLibrary() {
    if (loadedFilenames.length === 0) {
      libraryCard.style.display = 'none';
      return;
    }
    libraryCard.style.display = 'block';
    libraryList.innerHTML = '';

    loadedFilenames.forEach((entry) => {
      const filename = entry.name;
      const isEmbed = !!entry.isEmbed;
      const isExternal = filename.startsWith('http://') || filename.startsWith('https://');
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:.75rem;';

      const name = document.createElement('span');
      name.textContent = isEmbed ? '📺 ' + filename : isExternal ? '🔗 ' + filename : filename;
      name.style.cssText = 'flex:1;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.textContent = '▶ Odtwórz';
      btn.style.flexShrink = '0';
      btn.addEventListener('click', () => {
        if (isEmbed) {
          socket.emit('admin:load-embed', { password: adminPassword, url: filename });
          showEmbed(filename);
        } else if (isExternal) {
          socket.emit('admin:load-url', { password: adminPassword, url: filename });
          loadVideoForAdmin(filename, true);
        } else {
          socket.emit('admin:load', { password: adminPassword, filename: filename });
          loadVideoForAdmin(filename, false);
        }
      });

      row.appendChild(name);
      row.appendChild(btn);
      libraryList.appendChild(row);
    });
  }

  // ── Player ────────────────────────────────────────────────────────────────────

  function loadVideoForAdmin(filename, isExternal) {
    // Switch back from embed mode if needed
    if (isEmbedMode) showVideo();
    // Only allow http/https for external URLs
    if (isExternal && !filename.startsWith('http://') && !filename.startsWith('https://')) return;
    const src = isExternal ? `${BACKEND}/proxy?url=${encodeURIComponent(filename)}` : `${BACKEND}/uploads/${encodeURIComponent(filename)}`;
    const currentSrc = player.src; // absolute URL
    const alreadyLoaded = isExternal ? currentSrc.includes(encodeURIComponent(filename)) : currentSrc.endsWith(encodeURIComponent(filename));
    if (!alreadyLoaded) {
      player.src = src;
      player.load();
      placeholder.classList.add('hidden');
    }
    playbackControls.style.removeProperty('display');
    playbackControls.style.display = 'flex';
    setStateUI(false);
  }

  btnPlay.addEventListener('click', () => {
    player.play();
    socket.emit('admin:play', { password: adminPassword, currentTime: player.currentTime });
    setStateUI(true);
  });

  btnPause.addEventListener('click', () => {
    player.pause();
    socket.emit('admin:pause', { password: adminPassword, currentTime: player.currentTime });
    setStateUI(false);
  });

  btnRestart.addEventListener('click', () => {
    player.pause();
    player.currentTime = 0;
    socket.emit('admin:seek',  { password: adminPassword, currentTime: 0 });
    socket.emit('admin:pause', { password: adminPassword, currentTime: 0 });
    setStateUI(false);
  });

  // Sync seek events (scrubbing) – only for manual user seeks, not programmatic ones
  let seekTimer = null;
  let ignoreSeeked = false;
  player.addEventListener('seeked', () => {
    if (ignoreSeeked) { ignoreSeeked = false; return; }
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      socket.emit('admin:seek', { password: adminPassword, currentTime: player.currentTime });
    }, 200);
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

  function updatePlayerState(state) {
    if (!state.filename) return;
    if (state.isEmbed) {
      showEmbed(state.filename);
      return;
    }
    loadVideoForAdmin(state.filename, !!state.isExternal);
    ignoreSeeked = true;
    if (state.playing) {
      const lag = (Date.now() - state.serverTime) / 1000;
      player.currentTime = state.currentTime + lag;
      if (player.paused) player.play().catch(() => {});
    } else {
      player.currentTime = state.currentTime;
      player.pause();
    }
    setStateUI(state.playing);
  }

}());
