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

  const placeholder    = document.getElementById('placeholder');
  const player         = document.getElementById('player');
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
  let loadedFilenames = [];

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
      const res = await fetch('/upload', {
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
    socket = io();

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

    socket.on('video:loaded', ({ filename }) => {
      if (!loadedFilenames.includes(filename)) {
        loadedFilenames.push(filename);
        renderLibrary();
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
    xhr.open('POST', '/upload');
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
        if (!loadedFilenames.includes(data.filename)) {
          loadedFilenames.push(data.filename);
          renderLibrary();
        }
        loadVideoForAdmin(data.filename);
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

  // ── Library ───────────────────────────────────────────────────────────────────

  function renderLibrary() {
    if (loadedFilenames.length === 0) {
      libraryCard.style.display = 'none';
      return;
    }
    libraryCard.style.display = 'block';
    libraryList.innerHTML = '';

    loadedFilenames.forEach((fn) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:.75rem;';

      const name = document.createElement('span');
      name.textContent = fn;
      name.style.cssText = 'flex:1;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.textContent = '▶ Odtwórz';
      btn.style.flexShrink = '0';
      btn.addEventListener('click', () => {
        socket.emit('admin:load', { password: adminPassword, filename: fn });
        loadVideoForAdmin(fn);
      });

      row.appendChild(name);
      row.appendChild(btn);
      libraryList.appendChild(row);
    });
  }

  // ── Player ────────────────────────────────────────────────────────────────────

  function loadVideoForAdmin(filename) {
    const encodedName = encodeURIComponent(filename);
    if (!player.src.endsWith(encodedName)) {
      player.src = `/uploads/${encodedName}`;
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
    loadVideoForAdmin(state.filename);
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
