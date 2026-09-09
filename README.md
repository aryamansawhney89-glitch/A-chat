# A-Chat 💬

A WhatsApp-style realtime chat web app: Node.js + Express + WebSocket backend and a
vanilla HTML/CSS/JS frontend that mirrors the WhatsApp Web experience.

## Features

- **User accounts 🔐** — register with a username and password; login is required; sessions persist in localStorage so you don't have to re-auth on refresh
- **Realtime messaging** between browser tabs / devices over WebSocket
- **WhatsApp Web UI** — chat list, message bubbles with tails, date separators, ✓ / ✓✓ / blue-tick receipts
- **Password-protected rooms 🔒** — create a room with a name and password; join with the password or a 6-character invite code; share invite codes with others
- **Message reactions 😍** — long-press (or right-click) any message to react with emoji; bots also react to your messages; click a reaction chip to toggle yours
- **Group chats 👥** — "New group" modal with name, optional group picture and member
  checkboxes; group messages show colored sender names; delivery/read ticks aggregate
  across all members
- **Photo sharing 📸** — attachment button with client-side resize (max 1280px),
  caption/preview modal before sending, photos stored server-side in `data/uploads`
  and served at `/uploads` (click to open the full-size lightbox)
- **Voice messages 🎙️** — MediaRecorder capture with a live recording timer bar and
  cancel/send controls; each note gets a waveform (40 RMS bars) rendered into a custom
  play/pause bubble player
- **Profile pictures 👤** — click your own avatar to upload (client-resized to 256px),
  persisted per user in `data/users.json` and broadcast to everyone; the three bots
  ship with SVG avatars
- **Typing indicators** and **online / last-seen presence** (per chat and per member in groups)
- **Unread badges** (sidebar + browser tab title)
- **Emoji picker**, auto-growing composer, Enter-to-send
- **Dark mode** toggle (persisted)
- **Message sounds** (Web Audio — no audio files needed)
- **Demo bots** — Aria (support), Max (your buddy) and DJ Nova (music picks 🎵) reply live
  in DMs, and in groups they react to photos, voice notes and @mentions
- **Conversation-based server routing** — every message belongs to a `convoId`
  (`dm::A::B` for direct messages, `grp::<id>` for groups), so both kinds share one
  code path for history, receipts and typing
- **Chat history, groups, rooms and profiles persisted** to `data/messages.json`,
  `data/groups.json`, `data/rooms.json`, `data/accounts.json` and `data/users.json`
  (survive server restarts; legacy message stores are migrated automatically)
- **Upload API** — `POST /api/upload` accepts base64 data URLs (images + audio,
  8 MB cap) and returns a `/uploads/...` URL

## Run it locally

```bash
git clone https://github.com/aryamansawhney89-glitch/A-Music.git
cd A-Music
npm install
npm start        # serves on http://localhost:3000
```

Open the page, pick a name, and start chatting. Open a **second browser tab with a
different name** to chat live between two users — messages, typing indicators and
read receipts all update in real time. Try creating a group with the 👥 button,
sending a photo with 📎, or holding a conversation via 🎤 voice notes.

### Smoke test

```bash
npm test         # two WebSocket clients exercise DMs, groups, receipts, uploads
```

## Deploy it (free, ~3 minutes)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Faryamansawhney89-glitch%2FA-Music)

1. Click the button above and sign in to **Render** with your GitHub account.
2. Render reads [`render.yaml`](render.yaml) and creates the web service automatically
   — just confirm the blueprint and click **Apply / Deploy**.
3. When the deploy finishes, Render gives you a public URL like
   `https://a-chat-xxxx.onrender.com` — **share that link with anyone**. 🌍

Or do it manually: [dashboard.render.com](https://dashboard.render.com) → **New +** →
**Web Service** → select the `A-chat` repo → Runtime **Node**, Build `npm install`,
Start `npm start`, Plan **Free** → **Deploy**.

> **Free-tier notes:** the app sleeps after ~15 min without visitors (the first visit
> takes up to a minute to wake it), and chat history + uploads reset on
> restarts/redeploys since the free plan has an ephemeral disk.

## How it works

- `server.js` — Express static host + `ws` WebSocket router + `/api/upload`. Every
  message carries a `convoId`: `dm::A::B` (two participants), `grp::<id>` (group), or
  `room::<id>` (password-protected room). Presence, typing and per-member delivered/read
  receipts (`deliveredBy` / `readBy` arrays) travel as JSON frames; history, groups,
  profiles, reactions, accounts and rooms are kept in memory and flushed to JSON files
  in `data/`. Passwords are hashed with PBKDF2 (10,000 iterations, SHA-512). Uploaded
  media is written to `data/uploads` and served at `/uploads`.
- `public/` — zero-build frontend (`index.html`, `style.css`, `app.js`) plus
  `public/avatars/*.svg` for the bot profile pictures.
- The client talks to the server over the same host/port (`ws://`/`wss://`), so it
  works behind any reverse proxy without extra config.
- `scripts/smoke-test.js` — end-to-end test that runs a scratch server and drives it
  with two WebSocket clients.

## Configuration

| Env var    | Default       | Description                        |
|------------|---------------|------------------------------------|
| `PORT`     | `3000`        | HTTP/WS port                       |
| `DATA_DIR` | `./data`      | Where messages/groups/users/uploads live |
