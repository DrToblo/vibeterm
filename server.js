require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const SCROLLBACK_MAX = 50000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Session state ──────────────────────────────────────────────────────────────

let ptyProcess = null;
let sessionInfo = { active: false, cwd: null, cli: null };
let scrollbackBuffer = Buffer.alloc(0);

function appendScrollback(data) {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');
  const combined = Buffer.concat([scrollbackBuffer, chunk]);
  scrollbackBuffer = combined.length > SCROLLBACK_MAX
    ? combined.slice(combined.length - SCROLLBACK_MAX)
    : combined;
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

// ── REST API ───────────────────────────────────────────────────────────────────

app.get('/api/session', (req, res) => {
  if (sessionInfo.active) {
    res.json({ active: true, cwd: sessionInfo.cwd, cli: sessionInfo.cli });
  } else {
    res.json({ active: false });
  }
});

app.get('/api/browse', (req, res) => {
  let browsePath = req.query.path || os.homedir();

  // Resolve ~
  if (browsePath.startsWith('~')) {
    browsePath = path.join(os.homedir(), browsePath.slice(1));
  }
  browsePath = path.resolve(browsePath);

  try {
    const entries = fs.readdirSync(browsePath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, type: 'dir' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const hiddenDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('.'))
      .map(e => ({ name: e.name, type: 'dir' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = entries
      .filter(e => e.isFile())
      .map(e => ({ name: e.name, type: 'file' }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(browsePath) !== browsePath
      ? path.dirname(browsePath)
      : null;

    res.json({
      path: browsePath,
      parent,
      entries: [...dirs, ...hiddenDirs, ...files],
    });
  } catch (err) {
    res.json({
      path: browsePath,
      parent: path.dirname(browsePath) !== browsePath ? path.dirname(browsePath) : null,
      entries: [],
      error: err.code === 'EACCES' ? 'Permission denied' : err.message,
    });
  }
});

app.post('/api/session/start', (req, res) => {
  if (sessionInfo.active) {
    return res.status(409).json({ error: 'Session already active' });
  }

  const { cwd, cli } = req.body;

  if (!cwd || !cli) {
    return res.status(400).json({ error: 'Missing cwd or cli' });
  }
  if (!['claude', 'gemini'].includes(cli)) {
    return res.status(400).json({ error: 'cli must be "claude" or "gemini"' });
  }

  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'cwd is not a directory' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Invalid cwd: ' + err.message });
  }

  const ptyEnv = { ...process.env, TERM: 'xterm-256color' };
  delete ptyEnv.CLAUDECODE; // prevent "nested session" error

  ptyProcess = pty.spawn(cli, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: ptyEnv,
  });

  sessionInfo = { active: true, cwd, cli };
  scrollbackBuffer = Buffer.alloc(0);

  // Notify all connected clients that a session is now live
  broadcast(JSON.stringify({ type: 'state', active: true, cwd, cli }));

  ptyProcess.onData(data => {
    appendScrollback(data);
    broadcast(data);
  });

  ptyProcess.onExit(() => {
    sessionInfo = { active: false, cwd: null, cli: null };
    ptyProcess = null;
    broadcast(JSON.stringify({ type: 'state', active: false }));
  });

  res.json({ ok: true });
});

app.post('/api/session/kill', (req, res) => {
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch (_) {}
    ptyProcess = null;
  }
  sessionInfo = { active: false, cwd: null, cli: null };
  scrollbackBuffer = Buffer.alloc(0);
  broadcast(JSON.stringify({ type: 'state', active: false }));
  res.json({ ok: true });
});

// ── WebSocket server ───────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  // 1. Send current state immediately
  ws.send(JSON.stringify({
    type: 'state',
    active: sessionInfo.active,
    cwd: sessionInfo.cwd,
    cli: sessionInfo.cli,
  }));

  // 2. Replay scrollback if a session is live
  if (sessionInfo.active && scrollbackBuffer.length > 0) {
    ws.send(scrollbackBuffer);
  }

  ws.on('message', message => {
    const raw = message.toString('binary');
    // Try JSON control message first
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize' && ptyProcess) {
        const cols = Math.max(1, Math.round(msg.cols));
        const rows = Math.max(1, Math.round(msg.rows));
        ptyProcess.resize(cols, rows);
      }
      return;
    } catch (_) {
      // Not JSON — raw keyboard input
    }
    if (ptyProcess) {
      ptyProcess.write(raw);
    }
  });

  ws.on('error', () => {});
});

// ── Keepalive ──────────────────────────────────────────────────────────────────

setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.ping();
  });
}, 30000);

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Claude Terminal → http://localhost:${PORT}`);
});
