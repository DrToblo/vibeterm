require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const pty = require('node-pty');
const { exec, execSync } = require('child_process');
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

// ── tmux session management ────────────────────────────────────────────────────

function tmuxName(cli) {
  return `vibeterm-${cli}`;
}

function spawnSession(cli, cwd) {
  const ptyEnv = { ...process.env, TERM: 'xterm-256color' };
  delete ptyEnv.CLAUDECODE;

  // new-session -A: attach if session exists, create if not
  const proc = pty.spawn('tmux', [
    'new-session', '-A',
    '-s', tmuxName(cli),
    cli,
  ], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: ptyEnv,
  });

  ptyProcess = proc;
  sessionInfo = { active: true, cwd, cli };
  scrollbackBuffer = Buffer.alloc(0);

  broadcast(JSON.stringify({ type: 'state', active: true, cwd, cli }));

  proc.onData(data => {
    appendScrollback(data);
    broadcast(data);
  });

  proc.onExit(() => {
    // Only update state if this is still the active process (not superseded by kill)
    if (ptyProcess === proc) {
      sessionInfo = { active: false, cwd: null, cli: null };
      ptyProcess = null;
      broadcast(JSON.stringify({ type: 'state', active: false }));
    }
  });
}

// On server startup: reattach to any surviving vibeterm tmux session
function restoreExistingSession() {
  try {
    // list-panes -a gives session_name + pane cwd for every pane across all sessions
    const output = execSync(
      'tmux list-panes -a -F "#{session_name}|#{pane_current_path}"',
      { encoding: 'utf8' }
    ).trim();

    for (const line of output.split('\n')) {
      const pipe = line.indexOf('|');
      if (pipe === -1) continue;
      const name = line.slice(0, pipe);
      const cwd  = line.slice(pipe + 1) || os.homedir();
      const match = name.match(/^vibeterm-(claude|gemini)$/);
      if (!match) continue;

      console.log(`Reattaching to existing tmux session: ${name} (${cwd})`);
      spawnSession(match[1], cwd);
      break; // only restore one session at a time
    }
  } catch (_) {
    // tmux not running or no sessions — fine, start fresh
  }
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

    res.json({ path: browsePath, parent, entries: [...dirs, ...hiddenDirs, ...files] });
  } catch (err) {
    res.json({
      path: browsePath,
      parent: path.dirname(browsePath) !== browsePath ? path.dirname(browsePath) : null,
      entries: [],
      error: err.code === 'EACCES' ? 'Permission denied' : err.message,
    });
  }
});

app.post('/api/mkdir', (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'Missing path' });

  const resolved = path.resolve(dirPath);
  try {
    fs.mkdirSync(resolved);
    res.json({ ok: true });
  } catch (err) {
    const msg = err.code === 'EEXIST' ? 'Already exists' :
                err.code === 'EACCES' ? 'Permission denied' : err.message;
    res.status(400).json({ error: msg });
  }
});

app.post('/api/session/start', (req, res) => {
  if (sessionInfo.active) {
    return res.status(409).json({ error: 'Session already active' });
  }

  const { cwd, cli } = req.body;
  if (!cwd || !cli) return res.status(400).json({ error: 'Missing cwd or cli' });
  if (!['claude', 'gemini'].includes(cli)) return res.status(400).json({ error: 'cli must be "claude" or "gemini"' });

  try {
    if (!fs.statSync(cwd).isDirectory()) return res.status(400).json({ error: 'cwd is not a directory' });
  } catch (err) {
    return res.status(400).json({ error: 'Invalid cwd: ' + err.message });
  }

  spawnSession(cli, cwd);
  res.json({ ok: true });
});

app.post('/api/session/kill', (req, res) => {
  const cli = sessionInfo.cli;
  const proc = ptyProcess;

  // Null out first so onExit doesn't double-broadcast
  ptyProcess = null;
  sessionInfo = { active: false, cwd: null, cli: null };
  scrollbackBuffer = Buffer.alloc(0);

  broadcast(JSON.stringify({ type: 'state', active: false }));
  res.json({ ok: true });

  // Kill the tmux session (terminates the CLI running inside)
  if (cli) exec(`tmux kill-session -t ${tmuxName(cli)}`, () => {});

  // Also kill the pty attachment (belt-and-suspenders)
  if (proc) try { proc.kill(); } catch (_) {}
});

// ── WebSocket server ───────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  // 1. Send current state
  ws.send(JSON.stringify({
    type: 'state',
    active: sessionInfo.active,
    cwd: sessionInfo.cwd,
    cli: sessionInfo.cli,
  }));

  // 2. Replay scrollback so the terminal catches up to current output
  if (sessionInfo.active && scrollbackBuffer.length > 0) {
    ws.send(scrollbackBuffer);
  }

  ws.on('message', message => {
    const raw = message.toString('binary');
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize' && ptyProcess) {
        const cols = Math.max(1, Math.round(msg.cols));
        const rows = Math.max(1, Math.round(msg.rows));
        ptyProcess.resize(cols, rows);
        // tmux responds to SIGWINCH from the pty resize — no extra command needed
      }
      return;
    } catch (_) {}
    if (ptyProcess) ptyProcess.write(raw);
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

restoreExistingSession();

server.listen(PORT, () => {
  console.log(`Claude Terminal → http://localhost:${PORT}`);
});
