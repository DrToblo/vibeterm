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
let sessionInfo = { active: false, cwd: null, cli: null, sessionName: null, sessionType: null };
let scrollbackBuffer = Buffer.alloc(0);

const LAST_SESSION_FILE = path.join(__dirname, '.last-session.json');

function saveLastSession(info) {
  try { fs.writeFileSync(LAST_SESSION_FILE, JSON.stringify(info)); } catch (_) {}
}

function clearLastSession() {
  try { fs.unlinkSync(LAST_SESSION_FILE); } catch (_) {}
}

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

function tmuxName(cli, cwd) {
  const folder = path.basename(cwd)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'session';
  return `${folder}-${cli}`;
}

function spawnSession(cli, cwd) {
  const ptyEnv = { ...process.env, TERM: 'xterm-256color' };
  delete ptyEnv.CLAUDECODE;

  const sessionName = tmuxName(cli, cwd);

  // new-session -A: attach if session exists, create if not
  const proc = pty.spawn('tmux', [
    'new-session', '-A',
    '-s', sessionName,
    cli,
  ], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: ptyEnv,
  });

  ptyProcess = proc;
  sessionInfo = { active: true, cwd, cli, sessionName, sessionType: 'managed' };
  scrollbackBuffer = Buffer.alloc(0);

  saveLastSession({ sessionType: 'managed', cli, cwd, sessionName });
  broadcast(JSON.stringify({ type: 'state', active: true, cwd, cli, sessionName, sessionType: 'managed' }));

  proc.onData(data => {
    appendScrollback(data);
    broadcast(data);
  });

  proc.onExit(() => {
    // Only update state if this is still the active process (not superseded by kill)
    if (ptyProcess === proc) {
      sessionInfo = { active: false, cwd: null, cli: null, sessionName: null, sessionType: null };
      ptyProcess = null;
      clearLastSession();
      broadcast(JSON.stringify({ type: 'state', active: false }));
    }
  });
}

function attachSession(sessionName) {
  const ptyEnv = { ...process.env, TERM: 'xterm-256color' };
  delete ptyEnv.CLAUDECODE;

  const proc = pty.spawn('tmux', [
    'attach-session', '-t', sessionName,
  ], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: ptyEnv,
  });

  ptyProcess = proc;
  sessionInfo = { active: true, cwd: null, cli: null, sessionName, sessionType: 'custom' };
  scrollbackBuffer = Buffer.alloc(0);

  saveLastSession({ sessionType: 'custom', sessionName });
  broadcast(JSON.stringify({ type: 'state', active: true, sessionName, sessionType: 'custom' }));

  proc.onData(data => {
    appendScrollback(data);
    broadcast(data);
  });

  proc.onExit(() => {
    if (ptyProcess === proc) {
      sessionInfo = { active: false, cwd: null, cli: null, sessionName: null, sessionType: null };
      ptyProcess = null;
      clearLastSession();
      broadcast(JSON.stringify({ type: 'state', active: false }));
    }
  });
}

// On server startup: reattach to any surviving session
function restoreExistingSession() {
  // 1. Try to restore from persisted last session
  try {
    const saved = JSON.parse(fs.readFileSync(LAST_SESSION_FILE, 'utf8'));
    if (saved.sessionName) {
      const runningSessions = execSync(
        'tmux list-sessions -F "#{session_name}"',
        { encoding: 'utf8' }
      ).trim().split('\n').filter(Boolean);

      if (runningSessions.includes(saved.sessionName)) {
        if (saved.sessionType === 'managed' && saved.cli && saved.cwd) {
          console.log(`Reattaching to managed tmux session: ${saved.sessionName}`);
          spawnSession(saved.cli, saved.cwd);
        } else {
          console.log(`Reattaching to custom tmux session: ${saved.sessionName}`);
          attachSession(saved.sessionName);
        }
        return;
      }
    }
  } catch (_) {
    // no persist file or tmux not running — fall through
  }

  // 2. Fall back to looking for vibeterm-managed sessions
  try {
    const output = execSync(
      'tmux list-panes -a -F "#{session_name}|#{pane_current_path}"',
      { encoding: 'utf8' }
    ).trim();

    for (const line of output.split('\n')) {
      const pipe = line.indexOf('|');
      if (pipe === -1) continue;
      const name = line.slice(0, pipe);
      const cwd  = line.slice(pipe + 1) || os.homedir();
      const match = name.match(/^.+-(claude|gemini)$/);
      if (!match) continue;

      console.log(`Reattaching to existing tmux session: ${name} (${cwd})`);
      spawnSession(match[1], cwd);
      break;
    }
  } catch (_) {
    // tmux not running or no sessions — fine, start fresh
  }
}

// ── REST API ───────────────────────────────────────────────────────────────────

app.get('/api/session', (req, res) => {
  if (sessionInfo.active) {
    res.json({
      active: true,
      cwd: sessionInfo.cwd,
      cli: sessionInfo.cli,
      sessionName: sessionInfo.sessionName,
      sessionType: sessionInfo.sessionType,
    });
  } else {
    res.json({ active: false });
  }
});

app.get('/api/tmux-sessions', (req, res) => {
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}|#{session_windows}"',
      { encoding: 'utf8' }
    ).trim();
    const sessions = output.split('\n').filter(Boolean).map(line => {
      const [name, windows] = line.split('|');
      return { name, windows: parseInt(windows) || 1 };
    });
    res.json({ sessions });
  } catch (_) {
    res.json({ sessions: [] });
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
    const statEntry = e => {
      try { return fs.statSync(path.join(browsePath, e.name)).mtimeMs; } catch (_) { return 0; }
    };
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, type: 'dir', mtime: statEntry(e) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const hiddenDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('.'))
      .map(e => ({ name: e.name, type: 'dir', mtime: statEntry(e) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = entries
      .filter(e => e.isFile())
      .map(e => ({ name: e.name, type: 'file', mtime: statEntry(e) }))
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

  const { cwd, cli, sessionName } = req.body;

  // Attach to a custom (pre-existing) tmux session
  if (sessionName) {
    attachSession(String(sessionName));
    return res.json({ ok: true });
  }

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

// Detach: disconnect PTY but leave the tmux session running
app.post('/api/session/detach', (req, res) => {
  const proc = ptyProcess;

  ptyProcess = null;
  sessionInfo = { active: false, cwd: null, cli: null, sessionName: null, sessionType: null };
  scrollbackBuffer = Buffer.alloc(0);
  clearLastSession();

  broadcast(JSON.stringify({ type: 'state', active: false }));
  res.json({ ok: true });

  if (proc) try { proc.kill(); } catch (_) {}
});

// Kill: terminate the tmux session entirely
app.post('/api/session/kill', (req, res) => {
  const { cli, sessionName, sessionType } = sessionInfo;
  const proc = ptyProcess;

  // Null out first so onExit doesn't double-broadcast
  ptyProcess = null;
  sessionInfo = { active: false, cwd: null, cli: null, sessionName: null, sessionType: null };
  scrollbackBuffer = Buffer.alloc(0);
  clearLastSession();

  broadcast(JSON.stringify({ type: 'state', active: false }));
  res.json({ ok: true });

  // Kill the appropriate tmux session
  if (sessionName) {
    exec(`tmux kill-session -t "${sessionName}"`, () => {});
  }

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
    sessionName: sessionInfo.sessionName,
    sessionType: sessionInfo.sessionType,
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
