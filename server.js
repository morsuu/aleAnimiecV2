'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const dns = require('dns');
const crypto = require('crypto');

const express = require('express');
const { Server } = require('socket.io');
const multer = require('multer');

const { normalizeToVtt, looksLikeSubtitles } = require('./lib/subtitle-format');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const MAX_UPLOAD_BYTES = Math.round(parseFloat(process.env.MAX_UPLOAD_GB || '4') * 1024 * 1024 * 1024);

if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  console.warn('[WARN] ADMIN_PASSWORD nie jest ustawione – używam domyślnego "admin". Ustaw je w zmiennych środowiskowych!');
}

/**
 * FRONTEND_URL may list several origins, comma separated. Trailing slashes are
 * stripped – an `Access-Control-Allow-Origin` that carries one never matches the
 * browser's origin, which silently breaks every cross-origin request (uploads
 * included).
 */
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// Escape hatch for Vercel preview deployments, whose origin changes per deploy.
const ALLOW_ANY_ORIGIN = process.env.ALLOW_ANY_ORIGIN === '1' || ALLOWED_ORIGINS.length === 0;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOW_ANY_ORIGIN) return true;
  return ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ''));
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const STATE_FILE = path.join(UPLOADS_DIR, '.state.json');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.mkv', '.avi', '.m4v']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

// ─── Auth ────────────────────────────────────────────────────────────────────

/** Constant-time password check, tolerant of missing / non-string input. */
function isAdmin(password) {
  if (typeof password !== 'string') return false;
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.headers['x-admin-password'])) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ─── Video state ─────────────────────────────────────────────────────────────

const EMPTY_STATE = {
  filename: null,
  isExternal: false,
  isEmbed: false,
  playing: false,
  currentTime: 0,
  // Active subtitle file (in uploads/) and its offset in seconds. A positive
  // offset shows each line later, a negative one earlier.
  subtitle: null,
  subtitleOffset: 0,
  serverTime: Date.now(),
};

const MAX_SUBTITLE_OFFSET = 600; // seconds

/** @type {typeof EMPTY_STATE} */
let videoState = { ...EMPTY_STATE };

// Restore the last state so a redeploy / cold start doesn't drop the session.
try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved && typeof saved === 'object' && saved.filename) {
      videoState = { ...EMPTY_STATE, ...saved, playing: false, serverTime: Date.now() };
    }
  }
} catch (_) { /* corrupt state file – start fresh */ }

let saveTimer = null;
function persistState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(videoState), () => {});
  }, 500);
}

/** Reject NaN / Infinity / negative times – one bad value desyncs every viewer. */
function sanitizeTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function setState(patch) {
  // `serverTime` is the epoch the viewers extrapolate from, so it always moves
  // to now. Re-base `currentTime` along with it, otherwise a patch that has
  // nothing to do with playback (changing subtitles, say) rewinds the film for
  // everyone by however long it had been playing.
  const rebased = videoState.playing
    ? { currentTime: videoState.currentTime + (Date.now() - videoState.serverTime) / 1000 }
    : {};
  videoState = { ...videoState, ...rebased, ...patch, serverTime: Date.now() };
  persistState();
}

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express();

// ─── CORS (frontend lives on a different origin, e.g. Vercel) ────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.sendStatus(200));

app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded videos (dotfiles – including .state.json – stay hidden)
app.use('/uploads', express.static(UPLOADS_DIR, { dotfiles: 'ignore' }));

// ─── Upload ───────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename(req, file, cb) {
    // Sanitize filename: keep extension, strip directory traversal chars
    const rawExt = path.extname(file.originalname).toLowerCase();
    const ext = VIDEO_EXTENSIONS.has(rawExt) ? rawExt : '.mp4';
    const base = path.basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_\- ]/g, '_')
      .slice(0, 80) || 'video';
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter(req, file, cb) {
    // Browsers are inconsistent about video mimetypes (.mkv and .avi often come
    // through as application/octet-stream or an empty string), so accept on
    // either a video/* mimetype or a known video extension.
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk = typeof file.mimetype === 'string' && file.mimetype.startsWith('video/');
    if (mimeOk || VIDEO_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      const err = new Error('Dozwolone są tylko pliki video');
      err.code = 'INVALID_FILE_TYPE';
      cb(err);
    }
  },
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

/** Human readable upload limit, for error messages. */
const MAX_UPLOAD_LABEL = MAX_UPLOAD_BYTES >= 1024 * 1024 * 1024
  ? `${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(1)} GB`
  : `${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`;

app.post('/upload', requireAdmin, (req, res, next) => {
  // Reject on Content-Length before a single byte hits the disk – letting multer
  // discover the overflow mid-stream tears down the connection and the panel
  // never gets to read the error.
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared && declared > MAX_UPLOAD_BYTES + 65536) {
    res.set('Connection', 'close');
    return res.status(413).json({ error: `Plik jest za duży (limit ${MAX_UPLOAD_LABEL})` });
  }
  next();
}, upload.single('video'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  setState({ ...EMPTY_STATE, filename: file.filename });

  io.emit('video:loaded', { filename: file.filename, isExternal: false, isEmbed: false });
  io.emit('sync:state', currentState());
  res.json({ filename: file.filename, size: file.size });
});

// ─── Video library ───────────────────────────────────────────────────────────
// Without this the admin panel lost every uploaded file on page reload.

/** Resolve a user-supplied name to a path inside UPLOADS_DIR, or null. */
function safeUploadPath(name) {
  if (typeof name !== 'string' || !name || name.startsWith('.')) return null;
  const base = path.basename(name);
  if (base !== name) return null;
  const full = path.join(UPLOADS_DIR, base);
  if (path.dirname(full) !== UPLOADS_DIR) return null;
  return full;
}

app.get('/videos', requireAdmin, (req, res) => {
  fs.readdir(UPLOADS_DIR, { withFileTypes: true }, (err, entries) => {
    if (err) return res.status(500).json({ error: 'Nie udało się odczytać katalogu' });
    const files = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
      .map((e) => {
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(path.join(UPLOADS_DIR, e.name));
          size = st.size;
          mtime = st.mtimeMs;
        } catch (_) { /* file vanished between readdir and stat */ }
        return { name: e.name, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    // The panel needs the size limit to reject an oversized file before it
    // starts streaming, and this is the first call it makes after logging in.
    res.json({ files, maxUploadBytes: MAX_UPLOAD_BYTES });
  });
});

app.delete('/videos/:name', requireAdmin, (req, res) => {
  const full = safeUploadPath(req.params.name);
  if (!full) return res.status(400).json({ error: 'Nieprawidłowa nazwa pliku' });

  fs.unlink(full, (err) => {
    if (err) {
      return res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Nie udało się usunąć pliku' });
    }
    // If the deleted file was on air, clear the state so viewers stop 404-ing.
    if (videoState.filename === req.params.name && !videoState.isExternal) {
      setState({ ...EMPTY_STATE });
      io.emit('video:cleared');
      io.emit('sync:state', currentState());
    }
    res.json({ ok: true });
  });
});

// ─── Subtitles ───────────────────────────────────────────────────────────────
// Everything is normalised to WebVTT on the way in, so the players only ever
// deal with one format. Conversion lives in lib/ so it can be unit tested.

const subtitleUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter(req, file, cb) {
    if (SUBTITLE_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      const err = new Error('Dozwolone są tylko pliki .srt i .vtt');
      err.code = 'INVALID_FILE_TYPE';
      cb(err);
    }
  },
  limits: { fileSize: MAX_SUBTITLE_BYTES },
});

app.post('/subtitles', requireAdmin, subtitleUpload.single('subtitle'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nie wysłano pliku' });

  let vtt;
  try {
    vtt = normalizeToVtt(req.file.buffer, req.file.originalname);
  } catch (_) {
    return res.status(422).json({ error: 'Nie udało się odczytać pliku napisów' });
  }
  if (!looksLikeSubtitles(vtt)) {
    return res.status(422).json({ error: 'Plik nie wygląda na napisy (brak znaczników czasu)' });
  }

  const base = path.basename(req.file.originalname, path.extname(req.file.originalname))
    .replace(/[^a-zA-Z0-9_\- ]/g, '_')
    .slice(0, 80) || 'napisy';
  const name = `${Date.now()}_${base}.vtt`;

  fs.writeFile(path.join(UPLOADS_DIR, name), vtt, 'utf8', (err) => {
    if (err) return res.status(500).json({ error: 'Nie udało się zapisać napisów' });
    // A fresh upload becomes the active track right away.
    setState({ subtitle: name, subtitleOffset: 0 });
    io.emit('sync:state', currentState());
    io.emit('subtitles:changed');
    res.json({ name });
  });
});

app.get('/subtitles', requireAdmin, (req, res) => {
  fs.readdir(UPLOADS_DIR, { withFileTypes: true }, (err, entries) => {
    if (err) return res.status(500).json({ error: 'Nie udało się odczytać katalogu' });
    const files = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && path.extname(e.name).toLowerCase() === '.vtt')
      .map((e) => {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(UPLOADS_DIR, e.name)).mtimeMs; } catch (_) {}
        return { name: e.name, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ files });
  });
});

app.delete('/subtitles/:name', requireAdmin, (req, res) => {
  const full = safeUploadPath(req.params.name);
  if (!full || path.extname(req.params.name).toLowerCase() !== '.vtt') {
    return res.status(400).json({ error: 'Nieprawidłowa nazwa pliku' });
  }
  fs.unlink(full, (err) => {
    if (err) {
      return res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Nie udało się usunąć napisów' });
    }
    if (videoState.subtitle === req.params.name) {
      setState({ subtitle: null, subtitleOffset: 0 });
      io.emit('sync:state', currentState());
    }
    io.emit('subtitles:changed');
    res.json({ ok: true });
  });
});

// ─── Proxy for external videos ───────────────────────────────────────────────
// Streams external video URLs through the server so that CORS / header issues
// (e.g. pixeldrain, Google Drive, Dropbox) don't block playback in <video>.

const MAX_PROXY_HOPS = 5;
const PROXY_TIMEOUT_MS = 20000;

/** Block hostnames that point at the local machine or a private network. */
function isPrivateHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hostname) ||
    /^f[cd][0-9a-f]{2}:/i.test(hostname) ||
    /^fe80:/i.test(hostname)
  );
}

function isPrivateAddress(address) {
  return (
    /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(address) ||
    address === '::1' ||
    /^f[cd][0-9a-f]{2}:/i.test(address) ||
    /^fe80:/i.test(address)
  );
}

app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  const hops = parseInt(req.query.hops || '0', 10) || 0;

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  if (hops > MAX_PROXY_HOPS) {
    return res.status(508).json({ error: 'Zbyt wiele przekierowań' });
  }
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'Only http/https URLs are allowed' });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (isPrivateHost(parsed.hostname)) {
    return res.status(403).json({ error: 'Requests to private/internal networks are not allowed' });
  }

  const lib = parsed.protocol === 'https:' ? https : http;

  // Forward range header for seeking support
  const headers = { 'User-Agent': 'aleAnimiec/1.0' };
  if (req.headers.range) headers['Range'] = req.headers.range;

  const options = {
    headers,
    lookup: (hostname, opts, cb) => {
      // Re-check the resolved address so a DNS record pointing at a private IP
      // can't slip past the hostname check above.
      dns.lookup(hostname, opts, (err, address, family) => {
        if (err) return cb(err);
        if (Array.isArray(address)) {
          if (address.some((a) => isPrivateAddress(a.address))) {
            return cb(new Error('Resolved to a private IP address'));
          }
          return cb(null, address);
        }
        if (isPrivateAddress(address)) return cb(new Error('Resolved to a private IP address'));
        cb(null, address, family);
      });
    },
  };

  const proxyReq = lib.get(targetUrl, options, (proxyRes) => {
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      proxyRes.resume();
      // `location` is often relative – resolve it against the URL we just
      // requested, otherwise the next hop fails the http/https check.
      let next;
      try {
        next = new URL(proxyRes.headers.location, targetUrl).href;
      } catch (_) {
        return res.status(502).json({ error: 'Nieprawidłowe przekierowanie' });
      }
      return res.redirect(307, `/proxy?hops=${hops + 1}&url=${encodeURIComponent(next)}`);
    }

    const fwdHeaders = {};
    if (proxyRes.headers['content-type']) fwdHeaders['Content-Type'] = proxyRes.headers['content-type'];
    if (proxyRes.headers['content-length']) fwdHeaders['Content-Length'] = proxyRes.headers['content-length'];
    if (proxyRes.headers['content-range']) fwdHeaders['Content-Range'] = proxyRes.headers['content-range'];
    if (proxyRes.headers['accept-ranges']) fwdHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

    res.writeHead(proxyRes.statusCode, fwdHeaders);
    proxyRes.pipe(res);
    proxyRes.on('error', () => res.destroy());
  });

  proxyReq.setTimeout(PROXY_TIMEOUT_MS, () => proxyReq.destroy(new Error('Upstream timeout')));

  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'Failed to fetch external video' });
    else res.destroy();
  });

  res.on('close', () => proxyReq.destroy());
});

// ─── Error handler ───────────────────────────────────────────────────────────
// Multer rejections (file too large, wrong type) used to fall through to
// Express' default handler, which answers with an HTML 500 the panel can't read.

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // The client may still be streaming its body; close rather than wait it out.
  if (req.method === 'POST') res.set('Connection', 'close');
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Plik jest za duży (limit ${MAX_UPLOAD_LABEL})` });
  }
  if (err && err.code === 'INVALID_FILE_TYPE') {
    return res.status(415).json({ error: err.message });
  }
  console.error('[error]', err && err.message);
  res.status(500).json({ error: 'Błąd serwera' });
});

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(app);

// Long uploads must not be cut off by the default request timeout.
server.requestTimeout = 0;
server.headersTimeout = 120000;

// ─── Socket.io ───────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin(origin, cb) { cb(null, !origin || isAllowedOrigin(origin)); },
    methods: ['GET', 'POST'],
  },
});

/** Compute the state a viewer should receive right now. */
function currentState() {
  if (videoState.playing) {
    // advance currentTime by elapsed wall-clock time so late joiners sync instantly
    const elapsed = (Date.now() - videoState.serverTime) / 1000;
    return { ...videoState, currentTime: videoState.currentTime + elapsed, serverTime: Date.now() };
  }
  return { ...videoState };
}

/**
 * Broadcast viewer count. Deferred by a tick because on 'disconnect' the socket
 * is still counted, which made the badge read one too high.
 */
function broadcastViewerCount() {
  setTimeout(() => io.emit('viewers:count', io.engine.clientsCount), 0);
}

// ── Periodic heartbeat: broadcast state every 3s for tight sync ────────────
setInterval(() => {
  if (videoState.filename && videoState.playing) {
    io.emit('sync:state', currentState());
  }
}, 3000);

io.on('connection', (socket) => {
  broadcastViewerCount();
  socket.on('disconnect', broadcastViewerCount);

  // Immediately send the current state so the viewer can sync
  socket.emit('sync:state', currentState());

  // ── Clock offset (NTP-style) ─────────────────────────────────────────────
  // Client sends `ping:time` with its local timestamp, server responds with
  // server timestamp so client can compute clock offset.
  socket.on('ping:time', (clientTime, ack) => {
    if (typeof ack === 'function') {
      ack({ serverTime: Date.now(), clientTime });
    }
  });

  // ── Manual resync request from viewer ────────────────────────────────────
  socket.on('viewer:resync', () => {
    socket.emit('sync:state', currentState());
  });

  // ── Admin events (password-checked) ──────────────────────────────────────

  socket.on('admin:play', (msg) => {
    if (!msg || !isAdmin(msg.password)) return;
    setState({ playing: true, currentTime: sanitizeTime(msg.currentTime) });
    io.emit('sync:state', currentState());
  });

  socket.on('admin:pause', (msg) => {
    if (!msg || !isAdmin(msg.password)) return;
    setState({ playing: false, currentTime: sanitizeTime(msg.currentTime) });
    io.emit('sync:state', currentState());
  });

  socket.on('admin:seek', (msg) => {
    if (!msg || !isAdmin(msg.password)) return;
    setState({ currentTime: sanitizeTime(msg.currentTime) });
    io.emit('sync:state', currentState());
  });

  socket.on('admin:load', (msg) => {
    if (!msg || !isAdmin(msg.password)) return;
    // Only serve files that actually exist in uploads/
    const full = safeUploadPath(msg.filename);
    if (!full || !fs.existsSync(full)) {
      socket.emit('admin:error', { message: 'Nie znaleziono pliku na serwerze' });
      return;
    }
    setState({ ...EMPTY_STATE, filename: msg.filename });
    io.emit('video:loaded', { filename: msg.filename, isExternal: false, isEmbed: false });
    io.emit('sync:state', currentState());
  });

  /** Shared handler for the URL-based load events. */
  function loadUrl(msg, isEmbed) {
    if (!msg || !isAdmin(msg.password)) return;
    const url = msg.url;
    if (!url || typeof url !== 'string') return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    setState({ ...EMPTY_STATE, filename: url, isExternal: true, isEmbed });
    io.emit('video:loaded', { filename: url, isExternal: true, isEmbed });
    io.emit('sync:state', currentState());
  }

  socket.on('admin:load-url',   (msg) => loadUrl(msg, false));
  socket.on('admin:load-embed', (msg) => loadUrl(msg, true));

  // ── Subtitles ────────────────────────────────────────────────────────────

  socket.on('admin:subtitle', (msg) => {
    if (!msg || !isAdmin(msg.password)) return;
    if (msg.file === null) {
      setState({ subtitle: null, subtitleOffset: 0 });
    } else {
      const full = safeUploadPath(msg.file);
      if (!full || path.extname(String(msg.file)).toLowerCase() !== '.vtt' || !fs.existsSync(full)) {
        socket.emit('admin:error', { message: 'Nie znaleziono pliku napisów' });
        return;
      }
      setState({ subtitle: msg.file, subtitleOffset: 0 });
    }
    io.emit('sync:state', currentState());
  });

  socket.on('admin:subtitle-offset', (msg) => {
    if (!msg || !isAdmin(msg.password)) return;
    const raw = Number(msg.offset);
    if (!Number.isFinite(raw)) return;
    const offset = Math.max(-MAX_SUBTITLE_OFFSET, Math.min(MAX_SUBTITLE_OFFSET, raw));
    setState({ subtitleOffset: offset });
    // Nudging the offset happens continuously while dragging, so send just the
    // one number instead of a full state broadcast that would re-seek everyone.
    io.emit('subtitles:offset', { offset });
  });

  socket.on('admin:clear', (msg) => {
    if (!msg || !isAdmin(msg.password)) return;
    setState({ ...EMPTY_STATE });
    io.emit('video:cleared');
    io.emit('sync:state', currentState());
  });
});

// ─── Keep-alive self-ping (prevents Render free tier from sleeping) ──────────

const SELF_URL = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').replace(/\/+$/, '');
if (SELF_URL) {
  const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000; // every 10 minutes
  setInterval(() => {
    const lib = SELF_URL.startsWith('https') ? https : http;
    lib.get(`${SELF_URL}/health`, (res) => { res.resume(); }).on('error', () => {});
  }, KEEP_ALIVE_INTERVAL);
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
  console.log(`Admin panel   → http://localhost:${PORT}/admin.html`);
  console.log(`CORS          → ${ALLOW_ANY_ORIGIN ? 'dowolne origin' : ALLOWED_ORIGINS.join(', ')}`);
});
