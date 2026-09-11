# A-Chat 💬

A WhatsApp-style realtime chat web app: Node.js + Express + WebSocket backend and a
vanilla HTML/CSS/JS frontend that mirrors the WhatsApp Web experience.

## Features

- **User accounts 🔐** — register with a username and password; login is required; sessions persist in localStorage so you don't have to re-auth on refresh
- **Realtime messaging** between browser tabs / devices over WebSocket
- **WhatsApp Web UI** — chat list, message bubbles with tails, date separators, ✓ / ✓✓ / blue-tick receipts
- **Password-protected rooms 🔒** — create a room with a name and password; join with the password or a 6-character invite code; share invite codes with others
- **Message reactions 😍** — long-press (or right-click) any message to react with emoji; bots also react to your messages; click a reaction chip to toggle yours
- **Message replies, edits & deletes ↩️✏️🗑️** — swipe a message (or use the long-press
  menu) to reply with a quoted snapshot you can tap to jump back to the original; edit
  your own texts and photo captions in place (tagged "edited"); delete your own
  messages for everyone — the bubble becomes a "This message was deleted" tombstone
  with text, media and reactions wiped, persisted across reloads
- **Group chats 👥** — "New group" modal with name, optional group picture and member
  checkboxes; group messages show colored sender names; delivery/read ticks aggregate
  across all members
- **Photo sharing 📸** — attachment button with client-side resize (max 1280px),
  caption/preview modal before sending, photos stored server-side in `data/uploads`
  and served at `/uploads` (click to open the full-size lightbox)
- **Voice messages 🎙️** — MediaRecorder capture with a live recording timer bar and
  cancel/send controls; each note gets a waveform (40 RMS bars) rendered into a custom
  play/pause bubble. Codec parameters from the recorder (`audio/webm;codecs=opus`,
  Safari's `audio/mp4;codecs=mp4a.40.2`) are handled end to end
- **Voice calls 📞** — tap 📞 in a chat header for peer-to-peer WebRTC audio: incoming-call
  screen with answer/decline, ringing tone, call timer, mute & speaker controls,
  busy/offline handling and a "no answer" timeout. Group chats get mesh calls (up to 8
  people): everyone online is rung, and anyone already on the call can pull in more
  people afterwards with the 👤+ button (late joiners get the full peer mesh and their
  own ring timeout — perfect for members who were offline when the call started).
  Every call leaves a log entry in the chat — 📞 Voice call · 0:42, ❌ missed,
  📵 declined — and shows up in the sidebar preview too
- **Group & room info 👥** — tap a group or room name/avatar in the chat header for an info
  panel with the picture, member count, "Created by … on …" line and the full member list
  (creator 👑 first, online status / last seen per member). Rooms also show their invite
  code with a copy button
- **Video calls 🎥** — tap 🎥 for a peer-to-peer WebRTC video call: live camera tiles
  for you (mirrored preview) and every peer, camera on/off toggle, plus the same
  mute/speaker controls, ringing screen, timer and busy/offline handling as voice
  calls. Group video works over the same mesh (up to 8 people). Calls are logged as
  🎥 Video call · 0:42 / ❌ Missed video call entries in the chat and sidebar
- **Profile pictures 👤** — click your own avatar to upload (client-resized to 256px),
  persisted per user in `data/users.json` and broadcast to everyone; the three bots
  ship with SVG avatars
- **Privacy & Ghost Mode 🛡️👻** — a per-account privacy panel (tap 🛡️ in the sidebar)
  with three toggles — **read receipts**, **last seen** and **typing indicator** —
  plus a one-tap **Ghost Mode** that makes you appear offline to everyone (your
  presence, typing, delivery and read receipts are hidden, and callers see you as
  offline — you can still read, reply and place calls). Settings persist per
  account in `data/users.json` and survive restarts; a 👻 badge shows next to your
  name while ghosting
- **GIF picker with real search 🎞️** — the 🎭 button opens the panel on the GIF tab;
  typing is debounced and hits `GET /api/gifs`, which proxies a real GIF provider
  (GIPHY by default, Klipy and the retired Tenor API as fallbacks). Shows "Searching…"
  and "No GIFs found" states, an empty search shows trending GIFs, and if every
  provider is unreachable it falls back to a built-in list so the panel is never dead
- **Polls 📊** — 📊 in the composer opens a create dialog (question, up to 4 options,
  allow-multiple). The card in the chat shows a header, ○/● (or ☐/☑) per option, the
  percentage and a live bar for each, the per-option tally, a total vote count and — for
  the author or a group admin — a Close poll button; tapping your option again removes
  your vote, and voting/closing broadcasts to everyone in the chat. Needs an open chat
  (the button tells you "Open a chat first" otherwise)
- **Chat header menu ⋮** — Search in chat, Pin, Mute, Disappearing messages, Wallpaper
  and Clear chat in one dropdown (labels reflect current state); ↗️ forwards the newest
  message of the open chat (long-press any bubble to forward a specific one); 🔍 opens
  in-chat search, which filters as you type — including inside poll cards — and restores
  the full list when you close it
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
  8 MB cap, MIME parameters such as `codecs=opus` tolerated) and returns a
  `/uploads/...` URL served with the correct `Content-Type` and byte-range support
- **GIF search API** — `GET /api/gifs?q=<query>&limit=<1..50>` walks the provider
  chain in `GIF_PROVIDERS` (default `giphy,klipy,tenor`) and returns the first
  provider's normalised results: `{ ok, source, attribution, results: [{url,
  previewUrl, w, h, alt}] }`. `q` searches, no `q` trends. Keys stay server-side,
  results are cached in memory for 5 minutes (a stale entry is served if every
  provider goes down) and a total failure answers `502 {ok:false,results:[]}` so the
  picker can fall back to its built-in list. Only `https` image URLs are passed
  through — the same rule the message sanitizer applies to `kind:"gif"`, so the
  picker can never offer a GIF that would fail to send.
  **Heads-up on Tenor:** Google closed the public Tenor API on 2026-06-30 (no new
  keys since 2026-01-13), so Tenor is kept only as a legacy fallback for keys issued
  before that; GIPHY (free instant beta key) is the default provider

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
sending a photo with 📎, recording a 🎤 voice note, or placing a 📞 voice / 🎥 video call.
(Allow camera and microphone access; calls are peer-to-peer over WebRTC with STUN, so
they work on the same machine/network and across typical NATs.)

### Tests

Both suites run offline (stub GIF providers, no network) and both exit non-zero on
failure. They need `npm install` first; the UI one uses jsdom from `devDependencies`.

```bash
npm test           # protocol + persistence: two WebSocket clients and raw HTTP calls
                   # against a scratch server — DMs, groups, rooms, receipts, uploads,
                   # calls, reactions, edits/deletes, privacy/ghost mode, the GIF
                   # provider chain, polls and forwarding (160 assertions)
npm run test:ui    # the client itself, driven in jsdom: button handlers, panel
                   # toggles, rendered poll/GIF markup, debounced GIF search and its
                   # fallbacks (73 assertions). UI_TEST_VERBOSE=1 for server logs
npm run test:all   # both
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

- `server.js` — Express static host + `ws` WebSocket router + `/api/upload` + WebRTC
  call signalling relay (`kind: "voice" | "video"` on every call frame). Every message carries a `convoId`: `dm::A::B` (two
  participants), `grp::<id>` (group), or `room::<id>` (password-protected room).
  Presence, typing and per-member delivered/read receipts (`deliveredBy` / `readBy`
  arrays) travel as JSON frames; history, groups, profiles, reactions, accounts and
  rooms are kept in memory and flushed to JSON files in `data/`. Each profile carries
  a `privacy` object (`readReceipts`, `lastSeen`, `typing`, `ghost`) — the server
  enforces them server-side (a ghost user is reported offline, and their typing,
  delivery and read receipts are never emitted to others). Passwords are hashed
  with PBKDF2 (10,000 iterations, SHA-512). Uploaded media is written to `data/uploads`
  and served at `/uploads`. Calls never touch media on the server — only SDP/ICE
  signalling is relayed between participants, and each call is logged as a `kind:"call"`
  message (with `media.callKind`, status, duration and participants) so both sides
  keep a history entry.
- `public/` — zero-build frontend (`index.html`, `style.css`, `app.js`) plus
  `public/avatars/*.svg` for the bot profile pictures.
- The client talks to the server over the same host/port (`ws://`/`wss://`), so it
  works behind any reverse proxy without extra config.
- `scripts/smoke-test.js` — end-to-end test that runs a scratch server and drives it
  with two WebSocket clients plus HTTP calls. `/api/gifs` is covered against stub
  providers (GIPHY + Tenor shapes, rendition selection, caching, failover,
  stale-cache and 502 fallback), so `npm test` needs no network access.
- `scripts/ui-test.js` — loads `public/index.html` + `public/app.js` in jsdom,
  bridges `window.WebSocket` to a real server and clicks through the UI: the 🎭
  GIF picker (including the built-in-list fallback), the 📊 poll card and its
  percentages, and the ↗️ / ⋮ / 🔍 header buttons. Catches the class of bug a
  protocol test can't see — a button with no handler, a panel that closes itself,
  a bubble that renders its text twice.

## Configuration

| Env var              | Default | Description                        |
|----------------------|---------|------------------------------------|
| `PORT`               | `3000`  | HTTP/WS port                       |
| `DATA_DIR`           | `./data`| Where messages/groups/users/uploads live |
| `CALL_RING_TIMEOUT_MS` | `45000` | How long an unanswered call rings before it is logged as missed |
| `GIF_PROVIDERS`      | `giphy,klipy,tenor` | Provider chain for `/api/gifs`, tried in order; first one that answers wins |
| `GIPHY_API_KEY`      | shared public beta key | Your [GIPHY](https://developers.giphy.com/docs/api) key — free and instant, recommended for anything beyond a demo (the shared beta key is capped at ~100 calls/hour) |
| `GIPHY_RATING`       | `pg-13` | GIPHY content rating (`g`, `pg`, `pg-13`, `r`) |
| `KLIPY_API_KEY`      | unset | [Klipy](https://docs.klipy.com/) key. Klipy is skipped entirely while this is unset |
| `TENOR_API_KEY`      | legacy demo key | Tenor key, for the discontinued Tenor API (shut down 2026-06-30); setting one also switches that provider to its v2 endpoint |
| `TENOR_CONTENT_FILTER` | `medium` | Tenor content filter (`low` / `medium` / `high` / `off`) |
| `TENOR_API_BASE` / `GIPHY_API_BASE` / `KLIPY_API_BASE` | provider URLs | Override a provider base URL — how `npm test` points the chain at its stub providers |
| `GIF_TIMEOUT_MS`     | `4000`  | Per-request timeout for each provider call |
| `GIF_CACHE_TTL_MS`   | `300000` | How long `/api/gifs` results are cached (5 min) |
