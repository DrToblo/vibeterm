# Claude Terminal

A mobile-first web terminal that streams a persistent PTY session (Claude Code CLI or Gemini CLI) to the browser over WebSockets.

## Prerequisites

`node-pty` requires native build tools:

```bash
sudo apt install build-essential python3
```

Node.js 18+ required.

## Installation

```bash
npm install
```

## Configuration

Copy the example env file:

```bash
cp .env.example .env
```

Edit `.env`:

```
PORT=4000
```

## Running

```bash
node server.js
```

Then open [http://localhost:4000](http://localhost:4000) in your browser.

## Cloudflare Tunnel

To expose the terminal externally:

```bash
cloudflared tunnel run --url http://localhost:4000
```

WSS passthrough is automatic — Cloudflare upgrades `ws://` to `wss://` and the frontend auto-detects based on `window.location.protocol`.

Authentication is handled by Cloudflare Access — configure an Access policy on your tunnel to restrict who can reach the terminal.

## Mobile Usage

- The mobile toolbar appears automatically on touch devices (< 768px)
- Tap the terminal area to bring up the on-screen keyboard
- Use the toolbar buttons for Esc, Tab, arrow keys, and common Ctrl combos
- Set `maximum-scale=1` in viewport is already configured to prevent accidental pinch-zoom

## Architecture

```
Browser (xterm.js)  ←→  WebSocket  ←→  Node.js (express + ws)  ←→  node-pty  ←→  claude / gemini
```

- Single persistent PTY session — survives WebSocket disconnections
- 50 KB in-memory scrollback buffer replayed on reconnect
- WebSocket keepalive ping every 30s (prevents Cloudflare 100s idle timeout)
