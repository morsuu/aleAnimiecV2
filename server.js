'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');

const express = require('express');
const { Server } = require('socket.io');
const multer = require('multer');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const FRONTEND_URL = process.env.FRONTEND_URL || ''; // e.g. https://ale-animiec.vercel.app

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ─── Video state ─────────────────────────────────────────────────────────────

/** @type {{ filename: string|null, isExternal: boolean, playing: boolean, currentTime: number, serverTime: number }} */
let videoState = {
  filename: null,
  isExternal: false,
  playing: false,
  currentTime: 0,
  serverTime: Date.now(),
};

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express();

// ─── CORS (allow frontend on different origin, e.g. Vercel) ──────────────────
app.use((req, res, next) => {
  const origin = FRONTEND_URL || req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.sendStatus(200));

app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded videos
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── Upload ───────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename(req, file, cb) {
    // Sanitize filename: keep extension, strip directory traversal chars
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const base = path.basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_\- ]/g, '_')
      .slice(0, 80);
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const ALLOWED_MIMETYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
]);

const upload = multer({
  storage,
  fileFilter(req, file, cb) {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  },
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4 GB max
});

app.post('/upload', (req, res, next) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}, upload.single('video'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  videoState = {
    filename: file.filename,
    isExternal: false,
    playing: false,
    currentTime: 0,
    serverTime: Date.now(),
  };

  io.emit('video:loaded', { filename: file.filename, isExternal: false });
  res.json({ filename: file.filename });
});

// ─── Proxy for external videos ───────────────────────────────────────────────
// Streams external video URLs through the server so that CORS / header issues
// (e.g. pixeldrain, Google Drive, Dropbox) don't block playback in <video>.

const https = require('https');

app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'Only http/https URLs are allowed' });
  }

  // Validate URL to avoid SSRF on private IPs
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Block requests to private/internal networks
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hostname) ||
    /^f[cd][0-9a-f]{2}:/i.test(hostname) || // IPv6 private
    /^fe80:/i.test(hostname) // IPv6 link-local
  ) {
    return res.status(403).json({ error: 'Requests to private/internal networks are not allowed' });
  }

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;

  // Forward range header for seeking support
  const headers = { 'User-Agent': 'aleAnimiec/1.0' };
  if (req.headers.range) {
    headers['Range'] = req.headers.range;
  }

  const proxyReq = lib.get(targetUrl, { headers, lookup: (hostname, opts, cb) => {
    // Use DNS lookup callback to block resolved private IPs
    const dns = require('dns');
    dns.lookup(hostname, opts, (err, address, family) => {
      if (err) return cb(err);
      if (
        /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(address) ||
        address === '::1' ||
        /^f[cd][0-9a-f]{2}:/i.test(address) ||
        /^fe80:/i.test(address)
      ) {
        return cb(new Error('Resolved to a private IP address'));
      }
      cb(null, address, family);
    });
  } }, (proxyRes) => {
    // Follow redirects (up to 5)
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      // Redirect – re-issue request to the new URL
      res.redirect(307, `/proxy?url=${encodeURIComponent(proxyRes.headers.location)}`);
      proxyRes.resume();
      return;
    }

    // Forward relevant headers
    const fwdHeaders = {};
    if (proxyRes.headers['content-type']) fwdHeaders['Content-Type'] = proxyRes.headers['content-type'];
    if (proxyRes.headers['content-length']) fwdHeaders['Content-Length'] = proxyRes.headers['content-length'];
    if (proxyRes.headers['content-range']) fwdHeaders['Content-Range'] = proxyRes.headers['content-range'];
    if (proxyRes.headers['accept-ranges']) fwdHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

    res.writeHead(proxyRes.statusCode, fwdHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to fetch external video' });
    }
  });

  req.on('close', () => {
    proxyReq.destroy();
  });
});

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(app);

// ─── Socket.io ───────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL || true,
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

/** Broadcast viewer count to all connected clients. */
function broadcastViewerCount() {
  io.emit('viewers:count', io.engine.clientsCount);
}

// ── Periodic heartbeat: broadcast state every 3s for tight sync ────────────
setInterval(() => {
  if (videoState.filename && videoState.playing) {
    io.emit('sync:state', currentState());
  }
}, 3000);

io.on('connection', (socket) => {
  broadcastViewerCount();
  socket.on('disconnect', () => broadcastViewerCount());

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

  socket.on('admin:play', ({ password, currentTime }) => {
    if (password !== ADMIN_PASSWORD) return;
    videoState = {
      ...videoState,
      playing: true,
      currentTime,
      serverTime: Date.now(),
    };
    io.emit('sync:state', currentState());
  });

  socket.on('admin:pause', ({ password, currentTime }) => {
    if (password !== ADMIN_PASSWORD) return;
    videoState = {
      ...videoState,
      playing: false,
      currentTime,
      serverTime: Date.now(),
    };
    io.emit('sync:state', currentState());
  });

  socket.on('admin:seek', ({ password, currentTime }) => {
    if (password !== ADMIN_PASSWORD) return;
    videoState = {
      ...videoState,
      currentTime,
      serverTime: Date.now(),
    };
    io.emit('sync:state', currentState());
  });

  socket.on('admin:load', ({ password, filename }) => {
    if (password !== ADMIN_PASSWORD) return;
    videoState = {
      filename,
      isExternal: false,
      playing: false,
      currentTime: 0,
      serverTime: Date.now(),
    };
    io.emit('video:loaded', { filename, isExternal: false });
    io.emit('sync:state', currentState());
  });

  socket.on('admin:load-url', ({ password, url }) => {
    if (password !== ADMIN_PASSWORD) return;
    if (!url || typeof url !== 'string') return;
    // Only allow http/https URLs
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    videoState = {
      filename: url,
      isExternal: true,
      playing: false,
      currentTime: 0,
      serverTime: Date.now(),
    };
    io.emit('video:loaded', { filename: url, isExternal: true });
    io.emit('sync:state', currentState());
  });
});

// ─── Keep-alive self-ping (prevents Render free tier from sleeping) ──────────

const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '';
if (SELF_URL) {
  const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000; // every 10 minutes
  setInterval(() => {
    const lib = SELF_URL.startsWith('https') ? https : http;
    lib.get(`${SELF_URL}/`, (res) => { res.resume(); }).on('error', () => {});
  }, KEEP_ALIVE_INTERVAL);
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
  console.log(`Admin panel   → http://localhost:${PORT}/admin.html`);
});
