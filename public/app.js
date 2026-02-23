'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  browsePath: '',
  browseRoot: null,
  selectedCli: 'claude',
  selectedSession: null,
  sessionActive: false,
  wsConnected: false,
  ws: null,
  hasConnectedOnce: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  reconnectOverlayTimer: null,
  killConfirmTimer: null,
  killConfirmPending: false,
  ctrlMode: false,
  activeTab: 'remote',  // 'remote' | 'tmux'
  isMobile: ('ontouchstart' in window) || window.innerWidth < 768,
};

// ── ANSI color stripper (for mono/e-ink mode) ──────────────────────────────────
// Removes SGR color codes (basic, 256-color, truecolor) while keeping bold/underline/etc.
const _td = new TextDecoder('utf-8', { fatal: false });
function stripAnsiColors(data) {
  const str = typeof data === 'string' ? data : _td.decode(data);
  return str.replace(/\x1b\[([0-9;]*)m/g, (_, params) => {
    if (!params) return '\x1b[m';
    const out = [];
    const segs = params.split(';');
    let i = 0;
    while (i < segs.length) {
      const n = parseInt(segs[i], 10) || 0;
      if (n === 38 || n === 48) {
        // extended fg/bg: skip 38;5;N (2 extra) or 38;2;R;G;B (3 extra)
        const mode = parseInt(segs[i + 1], 10);
        i += (mode === 5 ? 3 : mode === 2 ? 5 : 1);
      } else if ((n >= 30 && n <= 37) || n === 39 ||
                 (n >= 40 && n <= 47) || n === 49 ||
                 (n >= 90 && n <= 97) || (n >= 100 && n <= 107)) {
        i++; // drop color codes
      } else {
        out.push(segs[i++]);
      }
    }
    return out.length ? `\x1b[${out.join(';')}m` : '';
  });
}

// ── Settings ───────────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'vibeterm-settings';
const SETTINGS_DEFAULT = { darkMode: false, monoMode: false, yoloClaude: false, yoloGemini: false, extraArgs: '' };

let settings = (() => {
  try { return { ...SETTINGS_DEFAULT, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...SETTINGS_DEFAULT }; }
})();

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ── Theme registry ─────────────────────────────────────────────────────────────
// Single source of truth: add a new theme here and nowhere else.
// vars: CSS custom property overrides applied to :root (empty = use stylesheet defaults).
// terminal: xterm.js theme object (null = inherit from 'default').
const THEMES = {
  default: {
    vars: {},
    terminal: {
      background: '#111111', foreground: '#EEEEEE',
      cursor: '#D97757', cursorAccent: '#111111',
      selectionBackground: 'rgba(217,119,87,0.30)',
      black: '#1A1A1A', red: '#E5484D', green: '#30A46C', yellow: '#F76B15',
      blue: '#4D9EFF', magenta: '#A06BDB', cyan: '#00B4D8', white: '#CCCCCC',
      brightBlack: '#555555', brightRed: '#FF6369', brightGreen: '#4ADE80',
      brightYellow: '#FFB224', brightBlue: '#74B3FF', brightMagenta: '#C084FC',
      brightCyan: '#22D3EE', brightWhite: '#FFFFFF',
    },
  },

  dark: {
    // Only overrides the launch-screen variables; terminal stays identical to default.
    vars: {
      '--launch-bg':        '#111111',
      '--launch-bg2':       '#1A1A1A',
      '--launch-bg-fade':   'rgba(17,17,17,0.9)',
      '--launch-border':    '#2A2A2A',
      '--launch-text':      '#EEEEEE',
      '--launch-text2':     '#888888',
      '--launch-accent':    '#D97757',
      '--launch-accent-h':  '#C96442',
      '--launch-accent-lt': 'rgba(217,119,87,0.15)',
    },
    terminal: null,  // same as default
  },

  mono: {
    vars: {
      '--bg-primary':       '#FFFFFF',
      '--bg-secondary':     '#FFFFFF',
      '--bg-card':          '#FFFFFF',
      '--border-color':     '#000000',
      '--text-primary':     '#000000',
      '--text-secondary':   '#000000',
      '--accent':           '#000000',
      '--accent-hover':     '#000000',
      '--toolbar-bg':       '#FFFFFF',
      '--toolbar-text':     '#000000',
      '--launch-bg':        '#FFFFFF',
      '--launch-bg2':       '#FFFFFF',
      '--launch-bg-fade':   'rgba(255,255,255,0.9)',
      '--launch-border':    '#000000',
      '--launch-text':      '#000000',
      '--launch-text2':     '#000000',
      '--launch-accent':    '#000000',
      '--launch-accent-h':  '#000000',
      '--launch-accent-lt': '#EEEEEE',
      '--logo-primary':     '#000000',
      '--logo-secondary':   '#000000',
      '--tab-active-bg':    '#000000',
      '--tab-active-text':  '#FFFFFF',
    },
    terminal: {
      background: '#FFFFFF', foreground: '#000000',
      cursor: '#000000', cursorAccent: '#FFFFFF',
      selectionBackground: 'rgba(0,0,0,0.3)',
      black: '#000000', red: '#000000', green: '#000000', yellow: '#000000',
      blue: '#000000', magenta: '#000000', cyan: '#000000', white: '#000000',
      brightBlack: '#000000', brightRed: '#000000', brightGreen: '#000000',
      brightYellow: '#000000', brightBlue: '#000000', brightMagenta: '#000000',
      brightCyan: '#000000', brightWhite: '#000000',
    },
  },
};

// All CSS vars that any theme can override — used to reset before switching themes.
const ALL_THEME_VARS = [...new Set(
  Object.values(THEMES).flatMap(t => Object.keys(t.vars))
)];

function applyTheme(name) {
  const theme = THEMES[name] || THEMES.default;
  // Reset all previously applied inline var overrides back to stylesheet defaults
  ALL_THEME_VARS.forEach(k => document.documentElement.style.removeProperty(k));
  // Apply this theme's overrides
  Object.entries(theme.vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  // Apply xterm terminal theme (fall back to default's terminal)
  term.options.theme = theme.terminal ?? THEMES.default.terminal;
}

function applySettings() {
  const name = settings.monoMode ? 'mono' : settings.darkMode ? 'dark' : 'default';
  applyTheme(name);
  syncSettingsUI();
}

function syncSettingsUI() {
  document.getElementById('lm-dark-toggle').classList.toggle('on', settings.darkMode);
  document.getElementById('lm-mono-toggle').classList.toggle('on', settings.monoMode);
  document.getElementById('lm-yolo-claude-toggle').classList.toggle('on', settings.yoloClaude);
  document.getElementById('lm-yolo-gemini-toggle').classList.toggle('on', settings.yoloGemini);
  const extraArgsEl = document.getElementById('lm-extra-args');
  if (document.activeElement !== extraArgsEl) extraArgsEl.value = settings.extraArgs;
}

// ── Font size ──────────────────────────────────────────────────────────────────
const FONT_SIZE_MIN = 10, FONT_SIZE_MAX = 20;
const FONT_SIZE_KEY = 'vibeterm-fontSize';

function loadFontSize() {
  const saved = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
  return (saved >= FONT_SIZE_MIN && saved <= FONT_SIZE_MAX) ? saved : (state.isMobile ? 12 : 13);
}

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const launchScreen     = $('launch-screen');
const terminalView     = $('terminal-view');
const terminalWrap     = $('terminal-wrap');
const pathDisplay      = $('path-display');
const pathRow          = $('path-row');
const browserList      = $('browser-list');
const startBtn         = $('start-btn');
const killBtn          = $('kill-btn');
const detachBtn        = $('detach-btn');
const headerWordmark   = $('header-wordmark');
const reconnectOverlay = $('reconnect-overlay');
const mobileToolbar    = $('mobile-toolbar');
const mobileInput      = $('mobile-input');
const ctrlBtn          = $('tb-ctrl');
const mkdirBtn         = $('mkdir-btn');
const cloneBtn         = $('clone-btn');
const fontDecBtn       = $('font-dec');
const fontIncBtn       = $('font-inc');
const runnerToggleEl   = document.querySelector('.runner-toggle');

// ── xterm.js ───────────────────────────────────────────────────────────────────
const fitAddon = new FitAddon.FitAddon();
const webLinks = new WebLinksAddon.WebLinksAddon();

const initialTheme = settings.monoMode ? THEMES.mono.terminal : THEMES.default.terminal;

const term = new Terminal({
  fontFamily:        '"JetBrains Mono", "Fira Code", monospace',
  fontSize:          loadFontSize(),
  lineHeight:        1.0,
  customGlyphs:      true,
  scrollback:        5000,
  scrollSensitivity: 5,
  allowProposedApi:  true,
  theme:             initialTheme,
});

term.loadAddon(fitAddon);
term.loadAddon(webLinks);
term.open($('terminal-container'));
term.loadAddon(new WebglAddon.WebglAddon());

function applyFontSize(size) {
  const s = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
  term.options.fontSize = s;
  localStorage.setItem(FONT_SIZE_KEY, String(s));
  requestAnimationFrame(() => doFit());
  fontDecBtn.disabled = s <= FONT_SIZE_MIN;
  fontIncBtn.disabled = s >= FONT_SIZE_MAX;
}

applyFontSize(loadFontSize());
applySettings();

term.onData(data => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(data);
});

// ── Layout / fit ───────────────────────────────────────────────────────────────
const PILL_H   = 52;
const PILL_GAP = 10;

let resizeTimer;

function doFit() {
  try {
    fitAddon.fit();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  } catch (_) {}
}

function updateLayout() {
  const vv = window.visualViewport;
  if (!vv) { doFit(); return; }

  const keyboardH = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));

  if (state.isMobile && state.sessionActive) {
    const pillBottom = keyboardH + PILL_GAP;
    mobileToolbar.style.bottom = pillBottom + 'px';

    const pillarH = PILL_H + pillBottom;
    terminalWrap.style.paddingBottom = pillarH + 'px';
  }

  doFit();
}

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateLayout, 80);
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateLayout, 80);
  });
  window.visualViewport.addEventListener('scroll', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateLayout, 80);
  });
}

// ── View switching ─────────────────────────────────────────────────────────────
function showLaunch() {
  launchScreen.classList.remove('hidden');
  terminalView.classList.add('hidden');
  mobileToolbar.style.display = 'none';
  document.body.classList.remove('mobile-show');
  terminalWrap.style.paddingBottom = '';
  // Restore mkdir/clone buttons only if in remote tab
  if (state.activeTab === 'remote') {
    mkdirBtn.style.display = '';
    cloneBtn.style.display = '';
  }
}

function showTerminal() {
  launchScreen.classList.add('hidden');
  terminalView.classList.remove('hidden');
  mkdirBtn.style.display = 'none';
  cloneBtn.style.display = 'none';
  if (state.isMobile) {
    document.body.classList.add('mobile-show');
    mobileToolbar.style.display = '';
  }
  requestAnimationFrame(() => { updateLayout(); term.scrollToBottom(); });
}

// ── Reconnect overlay ──────────────────────────────────────────────────────────
function showReconnectOverlay() { reconnectOverlay.classList.add('visible'); }
function hideReconnectOverlay() {
  reconnectOverlay.classList.remove('visible');
  clearTimeout(state.reconnectOverlayTimer);
  state.reconnectOverlayTimer = null;
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

function forceReconnect() {
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.reconnectOverlayTimer);
  state.reconnectOverlayTimer = null;
  state.reconnectAttempt = 0;

  if (state.ws) {
    const old = state.ws;
    state.ws = null;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(); } catch (_) {}
  }

  showReconnectOverlay();
  state.reconnectTimer = setTimeout(connect, 150);
}

async function connect() {
  if (state.hasConnectedOnce) {
    try {
      await fetch(`/api/session?_=${Date.now()}`, { cache: 'no-store' });
      return location.reload();
    } catch (_) {
      scheduleReconnect();
      return;
    }
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/?_=${Date.now()}`);
  state.ws = ws;
  ws.binaryType = 'arraybuffer';

  const connectTimeout = setTimeout(() => {
    if (state.ws !== ws) return;
    try { ws.close(); } catch (_) {}
  }, 3000);

  ws.addEventListener('open', () => {
    clearTimeout(connectTimeout);
    if (state.ws !== ws) return;
    state.wsConnected = true;
    state.hasConnectedOnce = true;
    state.reconnectAttempt = 0;
    hideReconnectOverlay();
    term.reset();
  });

  ws.addEventListener('message', evt => {
    if (state.ws !== ws) return;
    if (evt.data instanceof ArrayBuffer) {
      const data = new Uint8Array(evt.data);
      term.write(settings.monoMode ? stripAnsiColors(data) : data);
      return;
    }
    const raw = evt.data;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { term.write(settings.monoMode ? stripAnsiColors(raw) : raw); return; }

    if (msg.type === 'state') {
      state.sessionActive = msg.active;
      if (msg.active) {
        updateHeaderForSession(msg.sessionType, msg.sessionName, msg.cli);
        showTerminal();
      } else {
        resetHeader();
        showLaunch();
        term.clear();
        resetKillBtn();
        if (state.activeTab === 'tmux') {
          state.selectedSession = null;
          startBtn.disabled = true;
          startBtn.textContent = 'RESUME SESSION';
          loadSessions();
        } else {
          startBtn.disabled = false;
          startBtn.textContent = 'START SESSION';
        }
      }
    }
  });

  ws.addEventListener('close', () => {
    clearTimeout(connectTimeout);
    if (state.ws !== ws) return;
    state.wsConnected = false;
    scheduleReconnect();
    if (!state.reconnectOverlayTimer) {
      state.reconnectOverlayTimer = setTimeout(showReconnectOverlay, 1000);
    }
  });

  ws.addEventListener('error', () => {
    clearTimeout(connectTimeout);
    if (state.ws !== ws) return;
    ws.close();
  });
}

function scheduleReconnect() {
  const delays = [500, 1000, 2000, 4000, 10000];
  const delay = delays[Math.min(state.reconnectAttempt, delays.length - 1)];
  state.reconnectAttempt++;
  clearTimeout(state.reconnectTimer);
  if (document.visibilityState === 'hidden') return;
  state.reconnectTimer = setTimeout(connect, delay);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  forceReconnect();
});

window.addEventListener('pageshow', e => {
  if (e.persisted) forceReconnect();
});

window.addEventListener('focus', () => {
  if (!state.wsConnected) forceReconnect();
});

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (state.wsConnected && state.ws && state.ws.readyState === WebSocket.OPEN) return;
  if (state.reconnectTimer) return;
  forceReconnect();
}, 3000);

// ── Header logos ───────────────────────────────────────────────────────────────
const CLAUDE_LOGO_SVG = `<svg width="22" height="22"><use href="/icons.svg#icon-claude"/></svg>`;
const GEMINI_LOGO_SVG = `<svg width="22" height="22"><use href="/icons.svg#icon-gemini"/></svg>`;

function setHeaderLogo(cli) {
  if (cli === 'gemini') headerWordmark.innerHTML = GEMINI_LOGO_SVG;
  else headerWordmark.innerHTML = CLAUDE_LOGO_SVG;
}

// ── Header state ───────────────────────────────────────────────────────────────
function setGeminiMode(on) {
  terminalView.classList.toggle('gemini-mode', on);
}

function updateHeaderForSession(sessionType, sessionName, cli) {
  if (sessionType === 'custom') {
    if (/claude/i.test(sessionName)) { setHeaderLogo('claude'); setGeminiMode(false); }
    else if (/gemini/i.test(sessionName)) { setHeaderLogo('gemini'); setGeminiMode(true); }
    else { headerWordmark.textContent = sessionName || 'tmux'; setGeminiMode(false); }
  } else {
    setHeaderLogo(cli);
    setGeminiMode(cli === 'gemini');
  }
  detachBtn.style.display = '';
}

function resetHeader() {
  if (state.selectedCli === 'tmux') {
    headerWordmark.textContent = 'tmux';
  } else {
    setHeaderLogo(state.selectedCli || 'claude');
  }
  setGeminiMode(false);
  detachBtn.style.display = 'none';
}

// ── Tab Switcher ───────────────────────────────────────────────────────────────
const settingsPanel = $('settings-panel');
const bottomBar     = $('bottom-bar');

function showSettingsPanel() {
  browserList.style.display = 'none';
  settingsPanel.style.display = 'block';
  pathRow.style.display = 'none';
  runnerToggleEl.style.display = 'none';
  mkdirBtn.style.display = 'none';
  cloneBtn.style.display = 'none';
  bottomBar.style.display = 'none';
  syncSettingsUI();
}

function hideSettingsPanel() {
  settingsPanel.style.display = 'none';
  browserList.style.display = '';
  bottomBar.style.display = '';
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeTab = btn.dataset.tab;

    if (state.activeTab === 'settings') {
      showSettingsPanel();
    } else if (state.activeTab === 'tmux') {
      hideSettingsPanel();
      state.selectedCli = 'tmux';
      pathRow.style.display = 'none';
      runnerToggleEl.style.display = 'none';
      mkdirBtn.style.display = 'none';
      cloneBtn.style.display = 'none';
      startBtn.disabled = true;
      startBtn.textContent = 'RESUME SESSION';
      loadSessions();
    } else {
      hideSettingsPanel();
      // Restore runner selection
      const activeRunner = document.querySelector('.runner-btn.active');
      state.selectedCli = activeRunner ? activeRunner.dataset.cli : 'claude';
      pathRow.style.display = '';
      runnerToggleEl.style.display = '';
      mkdirBtn.style.display = '';
      cloneBtn.style.display = '';
      startBtn.disabled = false;
      startBtn.textContent = 'START SESSION';
      browse(state.browsePath || '');
    }
  });
});

// ── CLI Runner Toggle (Claude / Gemini) ────────────────────────────────────────
document.querySelectorAll('.runner-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.runner-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedCli = btn.dataset.cli;
  });
});

// ── Session List (tmux mode) ────────────────────────────────────────────────────
async function loadSessions() {
  state.selectedSession = null;
  startBtn.disabled = true;
  startBtn.textContent = 'RESUME SESSION';

  browserList.innerHTML = '<div class="browser-loading"><span class="browser-spinner"></span> Loading…</div>';
  let data;
  try {
    const resp = await fetch('/api/tmux-sessions');
    data = await resp.json();
  } catch (err) {
    browserList.innerHTML = `<div class="browser-error">Network error: ${err.message}</div>`;
    return;
  }

  if (!data.sessions || data.sessions.length === 0) {
    browserList.innerHTML = '<div class="sessions-empty">No tmux sessions running</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const session of data.sessions) {
    const card = document.createElement('button');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="session-card-left">
        <div class="session-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
        </div>
        <div class="session-info">
          <span class="session-card-name">${session.name}</span>
          <span class="session-card-meta">${session.windows} window${session.windows !== 1 ? 's' : ''}</span>
        </div>
      </div>
    `;
    card.addEventListener('click', () => {
      document.querySelectorAll('.session-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      state.selectedSession = session.name;
      startBtn.disabled = false;
    });
    frag.appendChild(card);
  }
  browserList.innerHTML = '';
  browserList.appendChild(frag);
}

// ── Directory Browser ──────────────────────────────────────────────────────────
async function browse(dirPath) {
  mkdirBtn.style.display = '';
  browserList.innerHTML = '<div class="browser-loading"><span class="browser-spinner"></span> Loading…</div>';
  let data;
  try {
    const resp = await fetch(`/api/browse?path=${encodeURIComponent(dirPath)}`);
    data = await resp.json();
  } catch (err) {
    browserList.innerHTML = `<div class="browser-error">Network error: ${err.message}</div>`;
    return;
  }
  if (data.error) {
    browserList.innerHTML = `<div class="browser-error">${data.error}</div>`;
    if (data.path) { state.browsePath = data.path; state.browseRoot = data.browseRoot || null; renderBreadcrumb(data.path, state.browseRoot); }
    return;
  }
  state.browsePath = data.path;
  state.browseRoot = data.browseRoot || null;
  renderBreadcrumb(data.path, state.browseRoot);

  const frag = document.createDocumentFragment();
  if (data.parent) frag.appendChild(makeEntryRow('parent', '..', data.parent, null));
  for (const e of data.entries) {
    const full = data.path.replace(/\/$/, '') + '/' + e.name;
    frag.appendChild(makeEntryRow(e.type, e.name, e.type === 'dir' ? full : null, e.mtime));
  }
  if (!data.entries.length && !data.parent) {
    const msg = document.createElement('div');
    msg.className = 'browser-loading';
    msg.textContent = 'Empty directory';
    frag.appendChild(msg);
  }
  browserList.innerHTML = '';
  browserList.appendChild(frag);
}

function fmtMtime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const diffDays = (now - d) / 86400000;
  if (diffDays < 1 && now.getDate() === d.getDate()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays < 365) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

const ICON_PARENT = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/></svg>`;
const ICON_FOLDER = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
const ICON_FILE   = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

function makeEntryRow(type, name, targetPath, mtime) {
  const row = document.createElement('button');
  row.className = `browser-entry ${type}`;

  const left = document.createElement('div');
  left.className = 'entry-left';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'entry-icon';
  iconWrap.innerHTML = type === 'parent' ? ICON_PARENT : type === 'dir' ? ICON_FOLDER : ICON_FILE;

  const textCol = document.createElement('div');
  textCol.className = 'entry-text';

  const nm = document.createElement('span');
  nm.className = 'entry-name';
  nm.textContent = name;
  textCol.appendChild(nm);

  if (mtime) {
    const meta = document.createElement('span');
    meta.className = 'entry-meta';
    meta.textContent = fmtMtime(mtime);
    textCol.appendChild(meta);
  }

  left.appendChild(iconWrap);
  left.appendChild(textCol);
  row.appendChild(left);

  if (targetPath) {
    row.addEventListener('click', () => browse(targetPath));
  } else {
    row.disabled = true;
  }
  return row;
}

function renderBreadcrumb(fullPath, browseRoot) {
  const lock = browseRoot ? '🔒 ' : '';
  pathDisplay.textContent = lock + '/' + fullPath.split('/').filter(Boolean).join('/');
}

// ── Start Session ──────────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  if (state.activeTab === 'tmux') {
    if (!state.selectedSession) return;
    startBtn.disabled = true;
    startBtn.textContent = 'ATTACHING…';
    try {
      const resp = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: state.selectedSession }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || 'Failed to attach to session');
        startBtn.disabled = false;
        startBtn.textContent = 'RESUME SESSION';
      }
    } catch (err) {
      alert('Network error: ' + err.message);
      startBtn.disabled = false;
      startBtn.textContent = 'RESUME SESSION';
    }
  } else {
    if (!state.browsePath) return;
    startBtn.disabled = true;
    startBtn.textContent = 'STARTING…';
    try {
      const yolo = state.selectedCli === 'claude' ? settings.yoloClaude : settings.yoloGemini;
      const resp = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: state.browsePath,
          cli: state.selectedCli,
          yolo,
          extraArgs: settings.extraArgs,
          monochrome: settings.monoMode,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || 'Failed to start session');
        startBtn.disabled = false;
        startBtn.textContent = 'START SESSION';
      }
    } catch (err) {
      alert('Network error: ' + err.message);
      startBtn.disabled = false;
      startBtn.textContent = 'START SESSION';
    }
  }
});

// ── Header Menu ────────────────────────────────────────────────────────────────
const menuBtn         = $('menu-btn');
const headerMenu      = $('header-menu');
const headerMenuScrim = $('header-menu-scrim');

function openHeaderMenu() {
  headerMenu.classList.add('open');
  headerMenuScrim.classList.add('open');
}

function closeHeaderMenu() {
  headerMenu.classList.remove('open');
  headerMenuScrim.classList.remove('open');
  if (state.killConfirmPending) resetKillBtn();
}

menuBtn.addEventListener('click', () => {
  if (headerMenu.classList.contains('open')) closeHeaderMenu();
  else openHeaderMenu();
});

headerMenuScrim.addEventListener('click', closeHeaderMenu);

fontDecBtn.addEventListener('click', () => applyFontSize(term.options.fontSize - 1));
fontIncBtn.addEventListener('click', () => applyFontSize(term.options.fontSize + 1));

// ── Detach Session ─────────────────────────────────────────────────────────────
detachBtn.addEventListener('click', async () => {
  closeHeaderMenu();
  try { await fetch('/api/session/detach', { method: 'POST' }); } catch (_) {}
});

// ── Kill Session ───────────────────────────────────────────────────────────────
const killBtnLabel = $('kill-btn-label');

function resetKillBtn() {
  state.killConfirmPending = false;
  clearTimeout(state.killConfirmTimer);
  killBtnLabel.textContent = 'End Session';
  killBtn.classList.remove('confirm');
}
killBtn.addEventListener('click', async () => {
  if (!state.killConfirmPending) {
    state.killConfirmPending = true;
    killBtnLabel.textContent = 'Confirm?';
    killBtn.classList.add('confirm');
    state.killConfirmTimer = setTimeout(resetKillBtn, 3000);
  } else {
    resetKillBtn();
    closeHeaderMenu();
    try { await fetch('/api/session/kill', { method: 'POST' }); } catch (_) {}
  }
});

// ── Mobile Toolbar ─────────────────────────────────────────────────────────────
function sendKey(key) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(key);
  if (navigator.vibrate) navigator.vibrate(8);
}

document.querySelectorAll('.tb-btn[data-key]').forEach(btn => {
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    sendKey(btn.dataset.key);
  });
});

ctrlBtn.addEventListener('pointerdown', e => {
  e.preventDefault();
  state.ctrlMode = !state.ctrlMode;
  ctrlBtn.classList.toggle('ctrl-active', state.ctrlMode);
  if (navigator.vibrate) navigator.vibrate(8);
  if (state.isMobile) { mobileInput.setAttribute('inputmode', 'text'); mobileInput.focus(); }
});

function clearCtrl() {
  state.ctrlMode = false;
  ctrlBtn.classList.remove('ctrl-active');
}

// ── Compose Overlay ───────────────────────────────────────────────────────────
const composeOverlay  = $('compose-overlay');
const composeScrim    = $('compose-scrim');
const composeTextarea = $('compose-textarea');
const composeSend     = $('compose-send');
const composeCancel   = $('compose-cancel');
const tbCompose       = $('tb-compose');

function autoResizeTextarea() {
  const vv = window.visualViewport;
  const availH = (vv ? vv.height : window.innerHeight) - 60;
  composeTextarea.style.height = 'auto';
  const natural = composeTextarea.scrollHeight;
  if (natural >= availH) {
    composeTextarea.style.height = availH + 'px';
    composeTextarea.style.overflowY = 'auto';
  } else {
    composeTextarea.style.height = natural + 'px';
    composeTextarea.style.overflowY = 'hidden';
  }
}

function updateComposeSize() {
  const vv = window.visualViewport;
  if (!vv) return;
  const keyboardH = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
  composeOverlay.style.bottom = keyboardH + 'px';
  autoResizeTextarea();
}

function openCompose() {
  updateComposeSize();
  composeOverlay.classList.add('open');
  composeScrim.classList.add('visible');
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateComposeSize);
    window.visualViewport.addEventListener('scroll', updateComposeSize);
  }
  setTimeout(() => { composeTextarea.focus(); autoResizeTextarea(); }, 50);
}

function closeCompose() {
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', updateComposeSize);
    window.visualViewport.removeEventListener('scroll', updateComposeSize);
  }
  composeTextarea.blur();
  composeOverlay.classList.remove('open');
  composeScrim.classList.remove('visible');
  setTimeout(() => {
    composeOverlay.style.bottom = '';
    composeTextarea.style.height = '';
    composeTextarea.style.overflowY = '';
  }, 260);
}

function submitCompose() {
  const text = composeTextarea.value.trimEnd();
  if (text && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(text);
    setTimeout(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send('\r');
    }, 30);
  }
  composeTextarea.value = '';
  closeCompose();
}

tbCompose.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (navigator.vibrate) navigator.vibrate(8);
  openCompose();
});

composeCancel.addEventListener('click', closeCompose);
composeScrim.addEventListener('click', closeCompose);

composeSend.addEventListener('pointerdown', e => {
  e.preventDefault();
  submitCompose();
});

composeTextarea.addEventListener('input', autoResizeTextarea);

composeTextarea.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submitCompose();
  }
});

// ── Mobile keyboard capture ────────────────────────────────────────────────────

if (state.isMobile) {
  $('terminal-container').addEventListener('click', () => {
    mobileInput.setAttribute('inputmode', 'text');
    mobileInput.focus();
  });

  mobileInput.addEventListener('input', () => {
    // Strip any typographic quotes iOS may have inserted around digits.
    const val = mobileInput.value.replace(/[\u2018\u2019\u201C\u201D]/g, '');
    mobileInput.value = '';
    if (!val) return;
    if (state.ctrlMode) {
      const code = val[0].toLowerCase().charCodeAt(0) - 96;
      if (code >= 1 && code <= 26) sendKey(String.fromCharCode(code));
      else sendKey(val);
      clearCtrl();
    } else {
      sendKey(val);
    }
  });

  mobileInput.addEventListener('keydown', e => {
    let key = null;

    // iOS wraps digit e.key values in typographic quotes e.g. "\u201C5\u201D"
    const eKey = e.key.replace(/^[\u2018\u2019\u201C\u201D]+|[\u2018\u2019\u201C\u201D]+$/g, '');

    if (eKey === 'Backspace')        key = '\x7f';
    else if (eKey === 'Enter')       key = '\r';
    else if (eKey === 'Escape')      key = '\x1b';
    else if (eKey === 'Tab')         { key = '\t'; e.preventDefault(); }
    else if (eKey === 'ArrowUp')     key = '\x1b[A';
    else if (eKey === 'ArrowDown')   key = '\x1b[B';
    else if (eKey === 'ArrowLeft')   key = '\x1b[D';
    else if (eKey === 'ArrowRight')  key = '\x1b[C';
    else if (eKey.length === 1 && !e.metaKey) {
      if (e.ctrlKey) {
        const code = eKey.toLowerCase().charCodeAt(0) - 96;
        if (code >= 1 && code <= 26) key = String.fromCharCode(code);
      } else if (!e.altKey) {
        if (state.ctrlMode) {
          const code = eKey.toLowerCase().charCodeAt(0) - 96;
          key = (code >= 1 && code <= 26) ? String.fromCharCode(code) : eKey;
          clearCtrl();
        } else {
          key = eKey;
        }
      }
    }

    if (key) { sendKey(key); e.preventDefault(); }
  });

  mobileInput.addEventListener('blur', () => {
    mobileInput.setAttribute('inputmode', 'none');
  });
}

// ── Mkdir Modal ────────────────────────────────────────────────────────────────
const mkdirScrim     = $('mkdir-scrim');
const mkdirModal     = $('mkdir-modal');
const mkdirInput     = $('mkdir-input');
const mkdirError     = $('mkdir-error');
const mkdirCreateBtn = $('mkdir-create-btn');
const mkdirCancelBtn = $('mkdir-cancel-btn');

function openMkdir() {
  mkdirInput.value = '';
  mkdirError.textContent = '';
  mkdirCreateBtn.disabled = false;
  mkdirScrim.classList.add('visible');
  mkdirModal.classList.add('open');
  setTimeout(() => mkdirInput.focus(), 50);
}

function closeMkdir() {
  mkdirScrim.classList.remove('visible');
  mkdirModal.classList.remove('open');
  mkdirInput.blur();
}

async function submitMkdir() {
  const name = mkdirInput.value.trim();
  if (!name) return;
  if (name.includes('/')) { mkdirError.textContent = 'Name cannot contain /'; return; }

  const fullPath = state.browsePath.replace(/\/$/, '') + '/' + name;
  mkdirCreateBtn.disabled = true;
  mkdirError.textContent = '';

  try {
    const resp = await fetch('/api/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      mkdirError.textContent = data.error || 'Failed to create folder';
      mkdirCreateBtn.disabled = false;
      return;
    }
    closeMkdir();
    browse(state.browsePath);
  } catch (err) {
    mkdirError.textContent = 'Network error';
    mkdirCreateBtn.disabled = false;
  }
}

mkdirBtn.addEventListener('click', openMkdir);
mkdirCancelBtn.addEventListener('click', closeMkdir);
mkdirScrim.addEventListener('click', closeMkdir);
mkdirCreateBtn.addEventListener('click', submitMkdir);
mkdirInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitMkdir(); }
  if (e.key === 'Escape') { e.preventDefault(); closeMkdir(); }
});

// ── Clone Modal ────────────────────────────────────────────────────────────────
const cloneScrim     = $('clone-scrim');
const cloneModal     = $('clone-modal');
const cloneUrlInput  = $('clone-url-input');
const cloneDestInput = $('clone-dest-input');
const cloneStatus    = $('clone-status');
const cloneSubmitBtn = $('clone-submit-btn');
const cloneCancelBtn = $('clone-cancel-btn');

function openClone() {
  cloneUrlInput.value = '';
  cloneDestInput.value = '';
  cloneStatus.textContent = '';
  cloneStatus.className = 'clone-status';
  cloneSubmitBtn.disabled = false;
  cloneScrim.classList.add('visible');
  cloneModal.classList.add('open');
  setTimeout(() => cloneUrlInput.focus(), 50);
}

function closeClone() {
  cloneScrim.classList.remove('visible');
  cloneModal.classList.remove('open');
  cloneUrlInput.blur();
  cloneDestInput.blur();
}

async function submitClone() {
  const url = cloneUrlInput.value.trim();
  if (!url) return;
  const dest = cloneDestInput.value.trim();

  cloneStatus.textContent = 'Cloning…';
  cloneStatus.className = 'clone-status cloning';
  cloneSubmitBtn.disabled = true;

  try {
    const resp = await fetch('/api/git-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, dest: dest || undefined, cwd: state.browsePath }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      cloneStatus.textContent = data.error || 'Clone failed';
      cloneStatus.className = 'clone-status error';
      cloneSubmitBtn.disabled = false;
      return;
    }
    closeClone();
    browse(state.browsePath);
  } catch (err) {
    cloneStatus.textContent = 'Network error';
    cloneStatus.className = 'clone-status error';
    cloneSubmitBtn.disabled = false;
  }
}

cloneBtn.addEventListener('click', openClone);
cloneCancelBtn.addEventListener('click', closeClone);
cloneScrim.addEventListener('click', closeClone);
cloneSubmitBtn.addEventListener('click', submitClone);
[cloneUrlInput, cloneDestInput].forEach(inp => {
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitClone(); }
    if (e.key === 'Escape') { e.preventDefault(); closeClone(); }
  });
});

// ── Settings Panel handlers ────────────────────────────────────────────────────
$('sr-dark-btn').addEventListener('click', () => {
  settings.darkMode = !settings.darkMode;
  saveSettings();
  applySettings();
});

$('sr-mono-btn').addEventListener('click', () => {
  settings.monoMode = !settings.monoMode;
  saveSettings();
  applySettings();
});

$('sr-yolo-claude-btn').addEventListener('click', () => {
  settings.yoloClaude = !settings.yoloClaude;
  saveSettings();
  syncSettingsUI();
});

$('sr-yolo-gemini-btn').addEventListener('click', () => {
  settings.yoloGemini = !settings.yoloGemini;
  saveSettings();
  syncSettingsUI();
});

$('lm-extra-args').addEventListener('change', e => {
  settings.extraArgs = e.target.value.trim();
  saveSettings();
});

// ── Bootstrap ──────────────────────────────────────────────────────────────────
(async () => {
  const resp = await fetch('/api/session').catch(() => null);
  const session = resp ? await resp.json().catch(() => null) : null;
  browse((session && session.cwd) ? session.cwd : '');
  mkdirBtn.style.display = '';
  cloneBtn.style.display = '';
})();

connect();
