# Claude Web Terminal — Project Specification

## Overview

A mobile-first, single-user web terminal interface that runs locally on a Linux machine and streams a persistent PTY session (Claude Code CLI / Gemini CLI) to the browser over WebSockets. Cloudflare Tunnel handles external access and authentication. The visual design mirrors the Claude.ai light theme — clean, white, warm, refined.

-----

## Architecture

```
Browser (xterm.js + custom UI)
        ↕  WebSocket (ws://)  +  REST API (HTTP)
Node.js Backend (Express + ws)
        ↕  PTY (node-pty)
Claude Code CLI / Gemini CLI process
        ↕  Cloudflare Tunnel (external HTTPS/WSS access)
```

### Backend — `server.js`

- **Runtime**: Node.js
- **Dependencies**: `express`, `ws`, `node-pty`
- **Single persistent PTY session**: spawned on demand when the user confirms the launch screen. Kept alive regardless of WebSocket connections once started.
- **Scrollback buffer**: in-memory circular buffer of the last 50,000 bytes of raw PTY output. On new WebSocket connection, replay the buffer to xterm.js before resuming live output
- **Resize handling**: listen for a `{ type: "resize", cols, rows }` JSON message from the client and call `pty.resize(cols, rows)`
- **Reconnection logic**: when the WebSocket drops, the PTY process keeps running. When a new WebSocket connects and a session already exists, skip the launch screen, attach to the existing PTY, and replay the scrollback buffer
- **Keepalive**: send a WebSocket ping every 30 seconds to prevent Cloudflare’s 100s idle timeout from closing the connection
- **Port**: configurable via `PORT` env var, default `3000`
- **Static files**: serve the frontend from a `/public` directory

### REST API Endpoints

These are used by the launch screen — simple JSON endpoints, no auth needed (Cloudflare handles that).

**`GET /api/session`**
Returns whether a session is currently running.

```json
{ "active": true, "cwd": "/home/user/projects/myapp", "cli": "claude" }
// or
{ "active": false }
```

**`GET /api/browse?path=/home/user`**
Returns directory listing for the given path for the directory browser.

```json
{
  "path": "/home/user",
  "parent": "/home",
  "entries": [
    { "name": "projects", "type": "dir" },
    { "name": "notes", "type": "dir" },
    { "name": "readme.txt", "type": "file" }
  ]
}
```

- Only return directories (filter out files) — users are picking a working directory, not a file
- Actually include files in the listing too, visually dimmed, so the user can orient themselves in the filesystem
- Resolve `~` to the actual home directory
- Handle permission errors gracefully — return an error field instead of crashing
- Default path if none provided: the server process’s home directory (`os.homedir()`)

**`POST /api/session/start`**
Spawns the PTY session. Body:

```json
{ "cwd": "/home/user/projects/myapp", "cli": "claude" }
```

- `cli` must be either `"claude"` or `"gemini"`
- Validate that `cwd` exists and is a directory before spawning
- If a session is already active, return `409 Conflict`
- On success: `{ "ok": true }`

**`POST /api/session/kill`**
Kills the current PTY session and clears the scrollback buffer, returning the UI to the launch screen.

- Returns: `{ "ok": true }`

### Frontend

- **Single HTML file** at `public/index.html` with embedded CSS and JS (no build step required)
- **xterm.js** loaded via CDN (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)
- **WebSocket client**: connects to `ws://` or `wss://` (auto-detect based on `window.location.protocol`). Implements automatic reconnection with exponential backoff (500ms, 1s, 2s, 4s, max 10s). Show a visual reconnecting overlay during disconnection.

-----

## Launch Screen

Shown instead of the terminal when no session is active. When a session is already running (e.g. reconnecting after a network drop), this screen is skipped entirely and the terminal is shown immediately.

### Layout

Centered card on the `--bg-secondary` warm off-white background. Card is white, `border-radius: 12px`, `box-shadow: 0 2px 12px rgba(0,0,0,0.08)`, max-width `480px`, full-width on mobile with `16px` margin.

```
┌─────────────────────────────┐
│  claude                     │  ← wordmark, top of card
│                             │
│  Working Directory          │  ← label
│  ┌───────────────────────┐  │
│  │ /home/user/projects   │  │  ← current path pill (read-only display)
│  └───────────────────────┘  │
│                             │
│  ▼ projects/               │  ← directory browser list
│    myapp/                   │
│    website/                 │
│    notes/    (dimmed file)  │
│  ▲ ../ (parent)             │
│                             │
│  Run with                   │  ← label
│  [ Claude ]  [ Gemini ]     │  ← toggle buttons
│                             │
│  [ Start Session → ]        │  ← primary CTA button
└─────────────────────────────┘
```

### Directory Browser

- Displays the current browse path at the top of the browser as a **clickable breadcrumb** — e.g. `/ home / user / projects` — each segment is tappable to jump to that level
- Below the breadcrumb, a scrollable list of entries fetched from `GET /api/browse?path=...`
- Each directory entry is a full-width tappable row: folder icon + name. Tapping navigates into that directory (updates the browse path and fetches new listing)
- A `../` row at the top (unless already at filesystem root) to navigate up
- Files are shown dimmed and non-tappable — visual context only
- The currently selected directory (i.e. where the session will start) is the directory currently being browsed. There is no separate “confirm directory” step — wherever you’ve navigated to is the selected `cwd`
- Show a subtle loading spinner during each `fetch` call
- Handle errors (permission denied, path not found) with an inline error message in the browser list rather than a toast

### CLI Toggle

Two pill-shaped toggle buttons side by side: **Claude** and **Gemini**. Only one is active at a time. Default: Claude.

- Active state: `background: var(--accent)`, white text
- Inactive state: `background: var(--bg-secondary)`, border, `--text-secondary`

### Start Button

Full-width, accent background (`--accent`), white text, `border-radius: 8px`, height `48px`. Label: `Start Session →`. Disabled and dimmed if no valid `cwd` is selected (shouldn’t happen given the browser always has a path, but handle defensively).

On click:

1. POST to `/api/session/start` with `{ cwd, cli }`
1. Show a brief loading state on the button (“Starting…”)
1. On success, transition to the terminal view with a smooth fade

### Kill Session

When a session is active, add a small `✕ End Session` text button in the header (right side, next to the status pill). On click, show a simple confirmation (“End the current session?”) then POST to `/api/session/kill`. On success, transition back to the launch screen and clear the terminal.

-----

## Visual Design — Claude Light Theme

### Design Direction

Refined, minimal, warm. Mirrors the Claude.ai web interface: white backgrounds, soft warm grays, the Claude orange-amber accent (`#D97757` / `#C96442`), generous spacing, and clean typography. The terminal itself is set against a warm off-white card with a soft shadow, not a harsh black box. Feels like a native Claude product, not a generic dev tool.

### Color Palette (CSS variables)

```css
--bg-primary: #FFFFFF;
--bg-secondary: #F9F7F4;       /* warm off-white page background */
--bg-card: #FFFFFF;
--border-color: #E8E3DC;       /* warm gray borders */
--text-primary: #1A1A1A;
--text-secondary: #6B6460;     /* warm muted gray */
--accent: #D97757;             /* Claude orange */
--accent-hover: #C96442;
--status-green: #30A46C;
--status-red: #E5484D;
--status-amber: #F76B15;

/* Terminal xterm.js theme */
--term-bg: #FDFCFB;            /* near-white, very slightly warm */
--term-fg: #1A1A1A;
--term-cursor: #D97757;
--term-selection: rgba(217, 119, 87, 0.2);
```

### xterm.js Theme Object

```js
{
  background: '#FDFCFB',
  foreground: '#1A1A1A',
  cursor: '#D97757',
  cursorAccent: '#FFFFFF',
  selectionBackground: 'rgba(217, 119, 87, 0.25)',
  black: '#1A1A1A',
  red: '#E5484D',
  green: '#30A46C',
  yellow: '#F76B15',
  blue: '#0091FF',
  magenta: '#8E4EC6',
  cyan: '#00A2C7',
  white: '#F9F7F4',
  brightBlack: '#6B6460',
  brightRed: '#E5484D',
  brightGreen: '#30A46C',
  brightYellow: '#FFB224',
  brightBlue: '#0091FF',
  brightMagenta: '#8E4EC6',
  brightCyan: '#00A2C7',
  brightWhite: '#FFFFFF',
}
```

### Typography

- **UI font**: `'Söhne'` with fallback to `'DM Sans', sans-serif` — warm, humanist, matches Claude’s UI feel
- **Terminal font**: `'Geist Mono'` with fallback to `'JetBrains Mono', 'Fira Code', monospace` — load from Google Fonts / Fontsource CDN
- Terminal font size: `13.5px` desktop, `12px` mobile
- Line height: `1.6`

### Layout

Two views — the launch screen (described above) and the terminal view:

```
┌─────────────────────────────────────────────┐
│  HEADER: Claude logo  ●  Connected  ✕ End  │  ← ~52px, white, border-bottom
├─────────────────────────────────────────────┤
│                                             │
│   TERMINAL (xterm.js, fills remaining       │
│   viewport height, FitAddon handles         │
│   cols/rows)                                │
│                                             │
├─────────────────────────────────────────────┤
│  MOBILE TOOLBAR (only on touch devices)    │  ← ~52px, white, border-top
└─────────────────────────────────────────────┘
```

- The terminal fills 100% of available height between header and toolbar (use CSS `calc(100vh - header - toolbar)` or flex column layout)
- No scrollbars on the outer page — only xterm.js internal scrollback
- Subtle `box-shadow` on the terminal container: `0 1px 3px rgba(0,0,0,0.06)`
- Rounded corners on the terminal container (desktop only): `border-radius: 8px` with small margin

### Header

- Left: Claude logo (SVG wordmark or just styled text “claude” in the Söhne font at ~16px, weight 500)
- Right: connection status pill — green dot + “Connected” / amber spinning dot + “Reconnecting…” / red dot + “Disconnected”
- Height: 52px, `padding: 0 20px`
- Bottom border: `1px solid var(--border-color)`

### Reconnection Overlay

When disconnected, show a centered overlay on top of the terminal (not replacing it):

- Semi-transparent white backdrop: `rgba(255,255,255,0.85)`, `backdrop-filter: blur(4px)`
- A spinner (CSS animated, accent color)
- Text: “Reconnecting…” in `--text-secondary`
- Fades in after 1 second of disconnection (don’t show it for brief blips)

-----

## Mobile Toolbar

Displayed only when `'ontouchstart' in window` or screen width < 768px.

### Layout

Single horizontally scrollable row of buttons, `overflow-x: auto`, `scroll-snap-type: x`, no visible scrollbar. Grouped with subtle separators.

### Buttons (in order)

|Label        |Key Sent                   |
|-------------|---------------------------|
|`Esc`        |`\x1b`                     |
|`Tab`        |`\t`                       |
|`↑`          |`\x1b[A`                   |
|`↓`          |`\x1b[B`                   |
|`←`          |`\x1b[D`                   |
|`→`          |`\x1b[C`                   |
|— separator —|                           |
|`Ctrl+C`     |`\x03`                     |
|`Ctrl+Z`     |`\x1a`                     |
|`Ctrl+D`     |`\x04`                     |
|— separator —|                           |
|`Ctrl+A`     |`\x01` (jump to line start)|
|`Ctrl+E`     |`\x05` (jump to line end)  |
|`Ctrl+L`     |`\x0c` (clear screen)      |
|`Ctrl+R`     |`\x12` (reverse search)    |

### Button Style

- Height: 40px, min-width: 48px, `padding: 0 14px`
- Background: `var(--bg-secondary)`, border: `1px solid var(--border-color)`, `border-radius: 6px`
- Font: monospace, 12px, `var(--text-primary)`
- Active/pressed: background `var(--accent)`, color white, scale transform `0.95` — snappy 80ms transition
- `touch-action: manipulation` to eliminate 300ms tap delay
- Haptic feedback: call `navigator.vibrate(8)` on press where supported

### Keyboard Behavior on Mobile

- Tapping the terminal canvas should trigger the native keyboard. Add a hidden `<textarea>` that receives focus when the terminal area is tapped, capturing keyboard input and forwarding each keystroke to the WebSocket as raw input.
- Suppress default browser behaviors on the textarea (no autocorrect, autocapitalize, spellcheck)
- On iOS, set `inputmode="none"` initially then toggle to `inputmode="text"` on tap to control keyboard appearance

-----

## Project File Structure

```
claude-terminal/
├── server.js               # Node.js backend (PTY, WebSocket, REST API)
├── package.json
├── .env.example            # PORT only — no SHELL_CMD needed, selected at runtime
├── public/
│   └── index.html          # Complete frontend (HTML + CSS + JS, single file)
└── README.md
```

-----

## package.json Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "ws": "^8.16.0",
    "node-pty": "^1.0.0",
    "dotenv": "^16.0.0"
  }
}
```

-----

## README Contents

The README should cover:

1. Prerequisites (`node-pty` requires native build tools — `sudo apt install build-essential python3`)
1. Installation (`npm install`)
1. Configuration (`.env` file: `SHELL_CMD=claude`, `PORT=3000`)
1. Running (`node server.js`)
1. Cloudflare Tunnel setup (brief: `cloudflared tunnel run` pointing to `localhost:3000`, note WSS passthrough is automatic)
1. Mobile usage tips

-----

## Key Implementation Notes for Claude Code

- Use `node-pty`’s `IPty.write()` for all input, including binary escape sequences from the toolbar
- The FitAddon must be called on terminal init AND on every window resize event — debounce resize events to 100ms
- After replaying scrollback on reconnect, call `terminal.scrollToBottom()`
- WebSocket messages from client to server are either raw strings (keyboard input) or JSON strings for control messages (`resize`, etc.) — differentiate by attempting `JSON.parse` and catching errors
- Ensure the xterm.js `allowProposedApi` option is set correctly if using newer addon APIs
- Test PTY resize behavior specifically — incorrect cols/rows causes Claude Code’s TUI to wrap badly
- The `scrollback` option in xterm.js should be set to `5000` lines
- Mobile: prevent the page from zooming on double-tap by setting `touch-action: manipulation` on the terminal container and `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">`
- On WebSocket connect, the server sends an initial JSON message `{ type: "state", active: bool, cwd, cli }` so the frontend knows immediately whether to show the launch screen or the terminal — do this before any scrollback replay
- `GET /api/browse` should use `fs.readdir` with `{ withFileTypes: true }` to distinguish files from directories without extra `stat` calls. Sort directories first, then files, both alphabetically
- The launch screen and terminal view are both present in the DOM at all times — toggle visibility with CSS (`display: none` / `display: flex`) rather than dynamically creating/destroying elements. This avoids needing to re-initialise xterm.js when switching views
- xterm.js should be initialised once on page load (even before a session starts) and only `.open()`ed once. The terminal can safely sit hidden behind the launch screen
- The `End Session` confirmation can be a simple inline state change on the button (first click: button turns red and label becomes “Confirm?”, second click within 3 seconds: confirms; otherwise reverts) — no modal needed

-----

## Out of Scope

- Multi-session / tab support
- User authentication (handled by Cloudflare)
- Persistent scrollback across server restarts
- File upload/download
