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

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ─── Video state ─────────────────────────────────────────────────────────────

/** @type {{ filename: string|null, playing: boolean, currentTime: number, serverTime: number }} */
let videoState = {
  filename: null,
  playing: false,
  currentTime: 0,
  serverTime: Date.now(),
};

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express();

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
    playing: false,
    currentTime: 0,
    serverTime: Date.now(),
  };

  io.emit('video:loaded', { filename: file.filename });
  res.json({ filename: file.filename });
});

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(app);

// ─── Socket.io ───────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: { origin: false },
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

io.on('connection', (socket) => {
  broadcastViewerCount();
  socket.on('disconnect', () => broadcastViewerCount());

  // Immediately send the current state so the viewer can sync
  socket.emit('sync:state', currentState());

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
      playing: false,
      currentTime: 0,
      serverTime: Date.now(),
    };
    io.emit('video:loaded', { filename });
    io.emit('sync:state', currentState());
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
  console.log(`Admin panel   → http://localhost:${PORT}/admin.html`);
});
