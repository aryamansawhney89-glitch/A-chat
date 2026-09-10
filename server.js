'use strict';

/**
 * A-Chat — WhatsApp-style realtime chat server.
 *
 * Express serves the static client and the /uploads folder; a WebSocket
 * endpoint routes everything by conversation id:
 *   - dm::A::B   two participants (names sorted, joined with "::")
 *   - grp::<id>  a group chat
 * Messages, groups and user profiles are persisted as JSON files in data/
 * (messages.json, groups.json, users.json); media uploads land in data/uploads.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const MAX_HISTORY = 500;                  // per conversation
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB decoded cap for /api/upload
const PBKDF2_ITER = 10000;               // password hashing iterations

/* ---------------------------------- bots ---------------------------------- */

const BOTS = [
  {
    name: 'Aria',
    subtitle: 'A-Chat Support',
    rules: [
      { keys: ['hi', 'hello', 'hey', 'yo'], replies: [
        'Hey {u}! 👋 How can I help you today?',
        'Hi {u}! Great to see you on A-Chat 💬',
      ] },
      { keys: ['help', 'feature', 'how'], replies: [
        'Here is what A-Chat can do: realtime messaging, voice 📞 and video 🎥 calls, group chats 👥, photo sharing 📸, voice notes 🎙️, profile pictures 👤, replies ↩️, message edits ✏️ and deletes 🗑️, reactions 😍, read receipts ✓✓, typing indicators, emoji 😄 and a dark mode toggle 🌙. Tip: long-press or right-click any message to react, reply, edit or delete — or swipe a message to reply!',
      ] },
      { keys: ['group', 'invite'], replies: [
        'Groups are here! 👥 Tap the 👥 button in the sidebar, pick a name, a picture (optional) and tick the members you want.',
      ] },
      { keys: ['photo', 'picture', 'image'], replies: [
        'You can send photos! 📸 Tap the 📎 button in any chat — you can add a caption before sending.',
      ] },
      { keys: ['voice', 'record', 'audio'], replies: [
        'Voice notes work too! 🎙️ Tap the 🎤 in a chat, record, then hit the send arrow — the bubble even shows a waveform.',
      ] },
      { keys: ['music', 'song', 'play', 'playlist'], replies: [
        'For tunes, our resident DJ is the one to ask — say "play" to DJ Nova 🎧',
      ] },
      { keys: ['thank'], replies: ['Anytime, {u}! 💚', 'You are very welcome!'] },
      { keys: ['bye', 'later', 'cya'], replies: ['See you soon, {u}! 👋', 'Bye {u}! I am here whenever you need me.'] },
    ],
    fallback: [
      'Interesting — tell me more! 😄',
      'Got it. Anything else I can help with? Type "help" to see what I know.',
      'I am only a demo bot, but I am all ears 👂',
    ],
  },
  {
    name: 'Max',
    subtitle: 'Buddy',
    rules: [
      { keys: ['hi', 'hello', 'hey', 'yo', 'sup'], replies: ['yo {u}!! what\'s up 🙌', 'heyyy {u} 🔥'] },
      { keys: ['lol', 'haha', 'funny', 'lmao'], replies: ['😂😂😂', 'lmaooo stop'] },
      { keys: ['yes', 'yeah', 'yep'], replies: ['let\'s gooo', 'knew it 😎'] },
      { keys: ['no', 'nope', 'nah'], replies: ['aww ok 😅', 'fair enough lol'] },
      { keys: ['bye', 'later', 'cya'], replies: ['cya! ✌️', 'okok later {u} 🤙'] },
    ],
    fallback: [
      'lol true',
      'fr fr',
      'no way 😅',
      'ok but have you tried the dark mode toggle yet 🌙',
      'haha nice',
      'say less',
    ],
  },
  {
    name: 'DJ Nova',
    subtitle: 'Music Bot',
    rules: [
      { keys: ['play', 'song', 'music', 'playlist', 'recommend', 'track'], replies: [
        '🎵 Today\'s pick: "Midnight City" — M83. Instant vibe.',
        '🎧 Queue this: Tame Impala — "The Less I Know The Better".',
        '🔥 Try Dua Lipa — "Levitating" and thank me later.',
        '🎶 Chill mix idea: lo-fi beats + rain sounds. You\'re welcome.',
        '🎸 Feeling loud? "Seven Nation Army" — The White Stripes.',
        '🎹 Something smooth: Norah Jones — "Come Away With Me".',
      ] },
      { keys: ['hi', 'hello', 'hey'], replies: ['Yo {u}! 🎧 Need a track? Just say "play".'] },
      { keys: ['love', 'great', 'nice', 'cool'], replies: ['Told you I had taste 😎🎶'] },
    ],
    fallback: [
      'Say "play" and I\'ll drop a recommendation 🎶',
      'I live for the bass 🎛️ — ask me for a song!',
    ],
  },
];

const BOT_AVATARS = {
  'Aria': '/avatars/aria.svg',
  'Max': '/avatars/max.svg',
  'DJ Nova': '/avatars/dj-nova.svg',
};

// Reactions to media messages, per bot personality.
const MEDIA_REPLIES = {
  'Aria': {
    photo: [
      'Nice picture! 📸 Thanks for sharing.',
      'Photo received — looks great! 🖼️',
      '📸 Lovely! A-Chat picture messages in action.',
    ],
    voice: [
      'Got your voice note! 🎙️ It plays right inside the chat bubble.',
      'I heard you loud and clear! 🔊',
      'Voice message received — loving that waveform 🎚️',
    ],
  },
  'Max': {
    photo: [
      'yo nice pic 😄📸',
      'lmaooo what a shot 😂',
      'ok that\'s a good one 🔥',
    ],
    voice: [
      'bro. your voice note 😂🎙️',
      'ok ok I listened, iconic 🔊',
      'voice notes?? we fancy fancy 🎙️✨',
    ],
  },
  'DJ Nova': {
    photo: [
      '📸 That image deserves a soundtrack — say "play" and I\'ll pick one.',
      'Nice shot! Every moment needs a theme song 🎶',
    ],
    voice: [
      '🎙️ Voice note detected — instant remix potential. Say "play" for a track!',
      'Your voice has rhythm 🎶 — let\'s find it a beat. Say "play"!',
    ],
  },
};

const isBot = (name) => BOTS.some((b) => b.name === name);

function pickBotReply(bot, userName, text) {
  const t = text.toLowerCase();
  for (const rule of bot.rules) {
    if (rule.keys.some((k) => t.includes(k))) {
      return rule.replies[Math.floor(Math.random() * rule.replies.length)].replaceAll('{u}', userName);
    }
  }
  return bot.fallback[Math.floor(Math.random() * bot.fallback.length)].replaceAll('{u}', userName);
}

function pickMediaReply(botName, kind) {
  const set = MEDIA_REPLIES[botName];
  if (!set || !set[kind]) return null;
  return set[kind][Math.floor(Math.random() * set[kind].length)];
}

/* ---------------------------------- state --------------------------------- */

const clients = new Map();       // name -> ws
const lastSeen = new Map();      // name -> ts (also lists offline users)
const conversations = new Map(); // convoId -> message[]
const groups = new Map();        // grp::<id> -> {id, name, pic, members, createdBy, createdAt}
const profiles = new Map();      // name -> {name, pic, about}
const accounts = new Map();      // username (lower) -> {username, salt, hash, createdAt}
const rooms = new Map();         // room::<id> -> {id, name, salt, hash, members, createdBy, inviteCode, createdAt}
const sessions = new Map();      // sessionToken -> username (lower)
let nextId = 1;

const dmConvoId = (a, b) => `dm::${[a, b].sort().join('::')}`;
const newGroupId = () => `grp::${crypto.randomBytes(4).toString('hex')}`;
const newRoomId = () => `room::${crypto.randomBytes(4).toString('hex')}`;
const newInviteCode = () => crypto.randomBytes(3).toString('hex').toUpperCase(); // 6-char code

/* ---------------------------- password helpers ---------------------------- */

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const result = hashPassword(password, salt);
  return result.hash === hash;
}

function newSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function convoParticipants(convoId) {
  if (typeof convoId !== 'string') return [];
  if (convoId.startsWith('dm::')) return convoId.slice(4).split('::').filter(Boolean);
  if (convoId.startsWith('grp::')) {
    const g = groups.get(convoId);
    return g ? [...g.members] : [];
  }
  if (convoId.startsWith('room::')) {
    const r = rooms.get(convoId);
    return r ? [...r.members] : [];
  }
  return [];
}

function canAccess(convoId, name) {
  return !!name && convoParticipants(convoId).includes(name);
}

/* ------------------------------ persistence ------------------------------- */

function normalizeConvoId(key) {
  if (key.startsWith('dm::') || key.startsWith('grp::')) return key;
  // legacy "A::B" keys from before convoId routing
  return `dm::${key.split('::').filter(Boolean).sort().join('::')}`;
}

function migrateMessage(m, convoId) {
  if (!m || !m.from) return null;
  const others = convoParticipants(convoId).filter((p) => p !== m.from);
  const deleted = m.deleted === true;
  return {
    id: m.id,
    convoId,
    from: m.from,
    kind: m.kind || 'text',
    text: deleted ? '' : (m.text || ''),
    media: deleted ? null : (m.media || null),
    ts: m.ts || Date.now(),
    deliveredBy: Array.isArray(m.deliveredBy) ? m.deliveredBy : (m.delivered ? others : []),
    readBy: Array.isArray(m.readBy) ? m.readBy : (m.read ? others : []),
    reactions: deleted ? {} : (m.reactions && typeof m.reactions === 'object' ? m.reactions : {}),
    // message actions: quote snapshot, edit marker, delete-for-everyone tombstone
    replyTo: !deleted && m.replyTo && typeof m.replyTo === 'object' && typeof m.replyTo.id === 'number' ? m.replyTo : null,
    editedAt: Number.isFinite(m.editedAt) ? m.editedAt : null,
    deleted,
  };
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    for (const [key, msgs] of Object.entries(raw)) {
      if (!Array.isArray(msgs) || !msgs.length) continue;
      const convoId = normalizeConvoId(key);
      const migrated = msgs.map((m) => migrateMessage(m, convoId)).filter(Boolean);
      if (migrated.length) conversations.set(convoId, migrated);
    }
  } catch { /* first run — no history yet */ }

  try {
    const raw = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    for (const g of raw) {
      if (g && g.id && g.name && Array.isArray(g.members)) groups.set(g.id, g);
    }
  } catch { /* no groups yet */ }

  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for (const [name, p] of Object.entries(raw)) {
      if (p && typeof p === 'object') {
        profiles.set(name, { name, pic: p.pic || null, about: p.about || '' });
      }
    }
  } catch { /* no profiles yet */ }

  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    for (const [key, a] of Object.entries(raw)) {
      if (a && a.username && a.salt && a.hash) accounts.set(key, a);
    }
  } catch { /* no accounts yet */ }

  try {
    const raw = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    for (const r of raw) {
      if (r && r.id && r.name && r.salt && r.hash) {
        r.members = Array.isArray(r.members) ? r.members : [];
        rooms.set(r.id, r);
        // also make sure the room convo exists
        if (!conversations.has(r.id)) conversations.set(r.id, []);
      }
    }
  } catch { /* no rooms yet */ }

  // make sure the bots always have their avatars + about text
  for (const b of BOTS) {
    const existing = profiles.get(b.name);
    if (!existing) profiles.set(b.name, { name: b.name, pic: BOT_AVATARS[b.name], about: b.subtitle });
    else if (!existing.pic) existing.pic = BOT_AVATARS[b.name];
  }

  const all = [...conversations.values()].flat();
  if (all.length) nextId = Math.max(...all.map((m) => m.id || 0)) + 1;
  if (all.length) console.log(`Loaded ${all.length} messages, ${groups.size} groups, ${profiles.size} profiles from disk.`);
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAll, 400);
}

function saveAll() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(Object.fromEntries(conversations)));
    fs.writeFileSync(GROUPS_FILE, JSON.stringify([...groups.values()]));
    fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(profiles)));
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(Object.fromEntries(accounts)));
    fs.writeFileSync(ROOMS_FILE, JSON.stringify([...rooms.values()]));
  } catch (err) {
    console.error('Save failed:', err.message);
  }
}

/* --------------------------------- helpers -------------------------------- */

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function pushMessage(m) {
  if (!conversations.has(m.convoId)) conversations.set(m.convoId, []);
  const arr = conversations.get(m.convoId);
  arr.push(m);
  if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  scheduleSave();
}

function notifyStatus(m) {
  send(clients.get(m.from), {
    type: 'status', id: m.id, convoId: m.convoId, deliveredBy: m.deliveredBy, readBy: m.readBy,
  });
}

function markDeliveredFor(name) {
  let changed = false;
  for (const msgs of conversations.values()) {
    for (const m of msgs) {
      if (m.from !== name && canAccess(m.convoId, name) && !m.deliveredBy.includes(name)) {
        m.deliveredBy.push(name);
        changed = true;
        notifyStatus(m);
      }
    }
  }
  if (changed) scheduleSave();
}

function userInfo(name) {
  const p = profiles.get(name) || {};
  const online = clients.has(name);
  return {
    name,
    online,
    bot: isBot(name),
    lastSeen: online ? null : lastSeen.get(name) || null,
    pic: p.pic || null,
    about: p.about || '',
  };
}

function userList() {
  const known = new Set([...lastSeen.keys(), ...profiles.keys()]);
  const humans = [...known].filter((n) => !isBot(n)).map(userInfo);
  const bots = BOTS.map((b) => userInfo(b.name));
  return [...bots, ...humans];
}

function broadcastUsers() {
  const payload = JSON.stringify({ type: 'users', users: userList() });
  for (const ws of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function groupsForUser(name) {
  return [...groups.values()].filter((g) => g.members.includes(name));
}

function roomsForUser(name) {
  return [...rooms.values()].filter((r) => r.members.includes(name)).map((r) => ({
    id: r.id, name: r.name, members: r.members, createdBy: r.createdBy,
    inviteCode: r.inviteCode, createdAt: r.createdAt,
  }));
}

function broadcastGroups() {
  for (const [name, ws] of clients) {
    send(ws, { type: 'groups', groups: groupsForUser(name) });
  }
}

function broadcastRooms() {
  for (const [name, ws] of clients) {
    send(ws, { type: 'rooms', rooms: roomsForUser(name) });
  }
}

const PIC_RE = /^\/(uploads|avatars)\/[A-Za-z0-9._-]+$/;
function sanitizePic(pic) {
  return typeof pic === 'string' && PIC_RE.test(pic) ? pic : null;
}

function sanitizeMedia(media, kind) {
  if (kind === 'text') return null;
  if (!media || typeof media !== 'object') return null;
  const url = typeof media.url === 'string' ? media.url : '';
  if (!PIC_RE.test(url) || !url.startsWith('/uploads/')) return null;
  const out = { url };
  if (media.name) out.name = String(media.name).slice(0, 120);
  if (Number.isFinite(media.w)) out.w = Math.max(0, Math.round(media.w));
  if (Number.isFinite(media.h)) out.h = Math.max(0, Math.round(media.h));
  if (Number.isFinite(media.duration)) out.duration = Math.min(600, Math.max(0, Math.round(media.duration * 10) / 10));
  if (Array.isArray(media.wave)) {
    out.wave = media.wave.slice(0, 40).map((v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0))));
  }
  return out;
}

// Snapshot of a replied-to message, attached to the reply so the quote still
// renders sensibly even after the original scrolls out of history or is
// deleted (a reply to a deleted message keeps a tombstone snapshot).
// Clients may reference the original by bare id or by passing the message.
function sanitizeReplyTo(convoId, ref) {
  const id = typeof ref === 'number' ? ref : (ref && typeof ref.id === 'number' ? ref.id : null);
  if (id === null) return null;
  const msgs = conversations.get(convoId) || [];
  const target = msgs.find((x) => x.id === id);
  if (!target) return null;
  if (target.deleted) {
    return { id: target.id, from: target.from, kind: 'text', text: '', deleted: true };
  }
  const snap = {
    id: target.id,
    from: target.from,
    kind: target.kind || 'text',
    text: String(target.text || '').slice(0, 140),
  };
  if (snap.kind === 'call' && target.media) {
    snap.callKind = target.media.callKind === 'video' ? 'video' : 'voice';
    snap.status = String(target.media.status || 'completed');
  }
  return snap;
}

/* ---------------------------------- bots ---------------------------------- */

const BOT_REACTIONS = {
  'Aria': ['💚', '👍', '😊', '🙌'],
  'Max': ['😂', '🔥', '💯', '😎', '🤣'],
  'DJ Nova': ['🎵', '🎶', '🔥', '🎧', '💃'],
};

function botReactToMessage(convoId, fromName) {
  // Bots may react with an emoji to human messages (30% chance in DMs, 15% in groups)
  const isDM = convoId.startsWith('dm::');
  if (Math.random() > (isDM ? 0.30 : 0.15)) return;
  for (const p of convoParticipants(convoId)) {
    if (p === fromName || !isBot(p)) continue;
    const emojis = BOT_REACTIONS[p];
    if (!emojis) continue;
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    // find the last message from fromName in this convo
    const msgs = conversations.get(convoId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].from === fromName) {
        handleReact(convoId, p, msgs[i].id, emoji, true, /*silent*/ true);
        break;
      }
    }
  }
}

function handleReact(convoId, reactor, messageId, emoji, add, silent) {
  const msgs = conversations.get(convoId) || [];
  const m = msgs.find((x) => x.id === messageId);
  if (!m || !emoji || m.deleted) return null;
  if (!m.reactions) m.reactions = {};
  if (add) {
    if (!m.reactions[emoji]) m.reactions[emoji] = [];
    if (!m.reactions[emoji].includes(reactor)) {
      m.reactions[emoji].push(reactor);
    }
  } else {
    if (m.reactions[emoji]) {
      m.reactions[emoji] = m.reactions[emoji].filter((n) => n !== reactor);
      if (!m.reactions[emoji].length) delete m.reactions[emoji];
    }
  }
  scheduleSave();
  if (!silent) {
    // broadcast to all participants
    for (const p of convoParticipants(convoId)) {
      if (!isBot(p)) send(clients.get(p), { type: 'reaction', convoId, id: messageId, reactions: m.reactions });
    }
  }
  return m;
}

function botSay(convoId, botName, text) {
  const m = {
    id: nextId++, convoId, from: botName, kind: 'text', text,
    media: null, ts: Date.now(), deliveredBy: [], readBy: [], reactions: {},
    replyTo: null, editedAt: null, deleted: false,
  };
  for (const p of convoParticipants(convoId)) {
    if (p === botName) continue;
    if (isBot(p)) { m.deliveredBy.push(p); m.readBy.push(p); }
    else if (clients.has(p)) m.deliveredBy.push(p);
  }
  pushMessage(m);
  for (const p of convoParticipants(convoId)) {
    if (p !== botName && !isBot(p)) send(clients.get(p), { type: 'message', message: m });
  }
}

function scheduleBotReply(botName, convoId, fromName, replyText) {
  const thinkMs = 500 + Math.min(2500, replyText.length * 45) + Math.random() * 500;
  setTimeout(() => {
    for (const p of convoParticipants(convoId)) {
      if (p !== botName && !isBot(p)) send(clients.get(p), { type: 'typing', convoId, from: botName, isTyping: true });
    }
    setTimeout(() => {
      for (const p of convoParticipants(convoId)) {
        if (p !== botName && !isBot(p)) send(clients.get(p), { type: 'typing', convoId, from: botName, isTyping: false });
      }
      botSay(convoId, botName, replyText);
    }, thinkMs);
  }, 450);
}

// Bots always answer DMs; in groups they react to photos/voice notes and
// when someone mentions them by name.
function maybeBotReact(convoId, m) {
  const text = (m.text || '').toLowerCase();
  for (const p of convoParticipants(convoId)) {
    if (p === m.from || !isBot(p)) continue;
    const mentioned = text.includes(p.toLowerCase()) || text.includes('@' + p.toLowerCase());
    if (!convoId.startsWith('dm::') && m.kind === 'text' && !mentioned) continue;
    const bot = BOTS.find((b) => b.name === p);
    const reply = (m.kind === 'photo' || m.kind === 'voice')
      ? (pickMediaReply(p, m.kind) || pickBotReply(bot, m.from, m.text || ''))
      : pickBotReply(bot, m.from, m.text || '');
    scheduleBotReply(p, convoId, m.from, reply);
  }
}

/* --------------------------- voice & video calls ---------------------------- */

/* WebRTC calls are peer-to-peer; the server only relays signalling.
 *
 *   client                          server                         client
 *     |--- call_invite {convoId, kind} ->|                                 |
 *     |<-- call_created {callId, kind} --|--- call_invite {callId, kind} -->|  (rings)
 *     |                             |<-- call_accept {callId} --------|
 *     |<-- call_join {offerTo:B} ---|--- call_join {isYou, peers} --->|
 *     |<========= call_signal {sdp|candidate} relayed both ways =====>|
 *     |--- call_leave {callId} ---->|--- call_ended + call log ------>|
 *
 * kind is 'voice' or 'video' (anything else is normalised to 'voice'). It
 * travels on call_created/call_invite/call_join/call_ended and is stored on
 * the logged history entry as media.callKind so old entries (no callKind)
 * still render as voice calls.
 *
 * The participant who joined the call *first* always creates the SDP offer for
 * a newer participant, so two peers never create offers at the same time.
 */

const calls = new Map();                 // callId -> call
const CALL_RING_TIMEOUT_MS = Number(process.env.CALL_RING_TIMEOUT_MS || 45000);
const CALL_MAX_MEMBERS = 8;              // mesh cap for group calls
const newCallId = () => crypto.randomBytes(6).toString('hex');

function callMembers(call) {
  return new Set([...call.joined, ...call.ringing]);
}

function sendCall(name, payload) {
  send(clients.get(name), payload);
}

function userInCall(name) {
  for (const c of calls.values()) {
    if (!c.ended && callMembers(c).has(name)) return true;
  }
  return false;
}

function callDuration(call) {
  return call.startedAt ? Math.max(0, Math.round((Date.now() - call.startedAt) / 1000)) : 0;
}

// A call entry lands in the conversation history, exactly like a message, so
// both sides see "📞 Voice call · 1:23" / "❌ Missed voice call" after a reload.
function logCallMessage(call, status, duration) {
  const m = {
    id: nextId++, convoId: call.convoId, from: call.initiator, kind: 'call', text: '',
    media: {
      status,
      callKind: call.kind === 'video' ? 'video' : 'voice',
      duration: Math.min(86400, Math.max(0, duration)),
      members: [...call.participants].sort(),
    },
    ts: Date.now(), deliveredBy: [], readBy: [], reactions: {},
    replyTo: null, editedAt: null, deleted: false,
  };
  for (const p of convoParticipants(call.convoId)) {
    if (p === call.initiator) continue;
    if (isBot(p)) { m.deliveredBy.push(p); m.readBy.push(p); }
    else if (clients.has(p)) m.deliveredBy.push(p);
  }
  pushMessage(m);
  for (const p of convoParticipants(call.convoId)) {
    if (p !== call.initiator && !isBot(p)) send(clients.get(p), { type: 'message', message: m });
  }
  sendCall(call.initiator, { type: 'message', message: m }); // echo so the caller logs it too
}

function endCall(call, reason) {
  if (call.ended) return;
  call.ended = true;
  clearTimeout(call.timer);
  calls.delete(call.id);
  const duration = callDuration(call);
  const kind = call.kind === 'video' ? 'video' : 'voice';
  for (const n of callMembers(call)) {
    sendCall(n, { type: 'call_ended', callId: call.id, convoId: call.convoId, kind, reason, duration });
  }
  const status = call.startedAt
    ? 'completed'
    : (reason === 'declined' ? 'declined' : reason === 'cancelled' ? 'cancelled' : 'missed');
  logCallMessage(call, status, duration);
}

function onRingTimeout(call) {
  if (call.ended) return;
  const unanswered = [...call.ringing];
  call.ringing.clear();
  for (const n of unanswered) sendCall(n, { type: 'call_cancelled', callId: call.id, reason: 'timeout' });
  if (call.startedAt === null) endCall(call, 'timeout');
  // else: someone already answered, the call carries on with them
}

// One participant hangs up (or disconnects). Ends the call when nobody is left
// talking, or when the caller gives up before anyone has answered.
function leaveCall(call, name) {
  if (call.ended) return;
  call.ringing.delete(name);
  const idx = call.joined.indexOf(name);
  if (idx >= 0) call.joined.splice(idx, 1);
  for (const n of callMembers(call)) {
    sendCall(n, { type: 'call_peer_left', callId: call.id, name });
  }
  if (call.startedAt === null && name === call.initiator) {
    endCall(call, 'cancelled');       // caller hung up while it was still ringing
  } else if (call.startedAt !== null && call.joined.length < 2) {
    endCall(call, 'ended');           // last talker left — call is over
  } else if (call.startedAt === null && call.ringing.size === 0 && call.declined.size) {
    endCall(call, 'declined');        // everyone invited declined
  } else if (call.startedAt === null && call.joined.length === 0) {
    endCall(call, 'cancelled');       // nobody left at all
  }
}

function dropUserFromCalls(name) {
  for (const call of [...calls.values()]) {
    if (callMembers(call).has(name)) leaveCall(call, name);
  }
}

function startCall(ws, msg) {
  const from = ws.userName;
  if (!from) return;
  const convoId = String(msg.convoId || '');
  if (!canAccess(convoId, from)) return;
  if (userInCall(from)) {
    send(ws, { type: 'call_error', convoId, error: 'You are already on a call.' });
    return;
  }
  const wanted = typeof msg.to === 'string' && msg.to ? msg.to : null;
  const targets = convoParticipants(convoId)
    .filter((n) => n !== from && !isBot(n) && (!wanted || n === wanted));
  if (!targets.length) {
    send(ws, { type: 'call_failed', convoId, reason: 'nobody' });
    return;
  }
  const online = targets.filter((n) => clients.has(n));
  if (!online.length) {
    send(ws, { type: 'call_failed', convoId, reason: 'offline' });
    return;
  }
  const free = online.filter((n) => !userInCall(n)).slice(0, CALL_MAX_MEMBERS);
  if (!free.length) {
    send(ws, { type: 'call_failed', convoId, reason: 'busy' });
    return;
  }
  const kind = msg.kind === 'video' ? 'video' : 'voice';
  const call = {
    id: newCallId(),
    convoId,
    kind,
    initiator: from,
    ringing: new Set(free),
    joined: [from],
    participants: new Set([from]), // everyone who ever picked up (for the call log)
    declined: new Set(),
    createdAt: Date.now(),
    startedAt: null,
    ended: false,
    timer: null,
  };
  calls.set(call.id, call);
  call.timer = setTimeout(() => onRingTimeout(call), CALL_RING_TIMEOUT_MS);
  send(ws, { type: 'call_created', callId: call.id, convoId, kind, callees: free });
  for (const n of free) {
    sendCall(n, { type: 'call_invite', callId: call.id, convoId, kind, from, callees: free });
  }
}

function acceptCall(call, name) {
  call.ringing.delete(name);
  const existing = [...call.joined];
  call.joined.push(name);
  call.participants.add(name);
  if (call.startedAt === null) call.startedAt = Date.now();
  // The newcomer only answers offers; everyone already in the call offers to them.
  const kind = call.kind === 'video' ? 'video' : 'voice';
  sendCall(name, {
    type: 'call_join', callId: call.id, convoId: call.convoId, kind, name, initiator: call.initiator,
    isYou: true, peers: existing, members: [...call.joined],
  });
  for (const n of existing) {
    sendCall(n, {
      type: 'call_join', callId: call.id, convoId: call.convoId, kind, name, initiator: call.initiator,
      isYou: false, offerTo: name, members: [...call.joined],
    });
  }
}

function rejectCall(call, name) {
  if (!call.ringing.has(name)) return;
  call.ringing.delete(name);
  call.declined.add(name);
  for (const n of callMembers(call)) {
    if (n !== name) sendCall(n, { type: 'call_declined', callId: call.id, from: name });
  }
  if (call.startedAt === null && call.ringing.size === 0) {
    endCall(call, call.declined.size ? 'declined' : 'missed');
  }
}

// Relay one SDP blob or one ICE candidate between two participants.
function relayCallSignal(call, from, msg) {
  const to = typeof msg.to === 'string' ? msg.to : '';
  const members = callMembers(call);
  if (!members.has(from) || !members.has(to)) return;
  const out = { type: 'call_signal', callId: call.id, from };
  if (msg.sdp && typeof msg.sdp === 'object') {
    out.sdp = { type: String(msg.sdp.type || '').slice(0, 24), sdp: String(msg.sdp.sdp || '').slice(0, 40000) };
  } else if (msg.candidate && typeof msg.candidate === 'object') {
    out.candidate = {
      candidate: String(msg.candidate.candidate || '').slice(0, 2000),
      sdpMid: msg.candidate.sdpMid === null ? null : String(msg.candidate.sdpMid || '').slice(0, 16),
      sdpMLineIndex: Number.isFinite(msg.candidate.sdpMLineIndex) ? msg.candidate.sdpMLineIndex : 0,
    };
  } else {
    return;
  }
  sendCall(to, out);
}

/* ------------------------------ message router ---------------------------- */

function handle(ws, msg) {
  switch (msg.type) {
    case 'join': {
      let name = String(msg.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      if (!name) name = 'Guest-' + Math.floor(Math.random() * 1000);
      if (isBot(name)) name = name + ' (you)';

      // Session token for returning users
      const token = typeof msg.token === 'string' ? msg.token : null;
      if (token) {
        const sessionKey = sessions.get(token);
        if (sessionKey) {
          const acct = accounts.get(sessionKey);
          if (acct) name = acct.username;
        }
      }

      const existing = clients.get(name);
      if (existing && existing !== ws) {
        send(existing, { type: 'kicked', reason: 'You signed in from another tab.' });
        existing.close();
      }
      ws.userName = name;
      clients.set(name, ws);
      lastSeen.set(name, Date.now());
      if (!profiles.has(name)) {
        profiles.set(name, { name, pic: null, about: '' });
        scheduleSave();
      }
      send(ws, { type: 'joined', name, users: userList(), groups: groupsForUser(name), rooms: roomsForUser(name), hasAccount: accounts.has(name.toLowerCase()) });
      broadcastUsers();
      markDeliveredFor(name);
      const key = dmConvoId(name, 'Aria');
      if (!conversations.has(key) || conversations.get(key).length === 0) {
        setTimeout(() => {
          if (clients.has(name)) {
            botSay(key, 'Aria',
              `Welcome to A-Chat, ${name}! 🎉 I'm Aria, the demo assistant. Pick any contact to chat, use 👥 to create a group, 🔒 to create a password-protected room, or long-press a message to react 😍. Type "help" to see everything.`);
          }
        }, 1200);
      }
      break;
    }

    case 'message': {
      const from = ws.userName;
      if (!from) return;
      const convoId = String(msg.convoId || '');
      const kind = ['text', 'photo', 'voice'].includes(msg.kind) ? msg.kind : 'text';
      const text = String(msg.text || '').slice(0, 4000);
      const media = sanitizeMedia(msg.media, kind);
      if (!canAccess(convoId, from)) return;
      if (kind === 'text' && !text.trim()) return;
      if (kind !== 'text' && !media) return;
      const m = {
        id: nextId++, convoId, from, kind, text, media, ts: Date.now(),
        deliveredBy: [], readBy: [], reactions: {},
        replyTo: sanitizeReplyTo(convoId, msg.replyTo), editedAt: null, deleted: false,
      };
      pushMessage(m);
      send(ws, { type: 'message', message: m }); // echo to sender (assigns id/ts)
      const participants = convoParticipants(convoId);
      let changed = false;
      // bots "read" instantly — mark them first so every copy of the message
      // (including those sent to humans) already carries their receipts
      for (const p of participants) {
        if (p !== from && isBot(p)) {
          m.deliveredBy.push(p);
          m.readBy.push(p);
          changed = true;
        }
      }
      for (const p of participants) {
        if (p === from || isBot(p)) continue;
        const target = clients.get(p);
        if (target && target.readyState === WebSocket.OPEN) {
          m.deliveredBy.push(p);
          changed = true;
          send(target, { type: 'message', message: m });
        }
      }
      if (changed) {
        notifyStatus(m);
        scheduleSave();
      }
      maybeBotReact(convoId, m);
      // bots may also react with emoji to human messages
      setTimeout(() => botReactToMessage(convoId, from), 1500 + Math.random() * 2000);
      break;
    }

    case 'typing': {
      const from = ws.userName;
      const convoId = String(msg.convoId || '');
      if (!from || !canAccess(convoId, from)) return;
      for (const p of convoParticipants(convoId)) {
        if (p !== from && !isBot(p)) {
          send(clients.get(p), { type: 'typing', convoId, from, isTyping: !!msg.isTyping });
        }
      }
      break;
    }

    case 'read': {
      const me = ws.userName;
      const convoId = String(msg.convoId || '');
      if (!me || !canAccess(convoId, me)) return;
      const msgs = conversations.get(convoId) || [];
      let changed = false;
      for (const m of msgs) {
        if (m.from !== me && !m.readBy.includes(me)) {
          m.readBy.push(me);
          changed = true;
          notifyStatus(m);
        }
      }
      if (changed) scheduleSave();
      break;
    }

    case 'history': {
      const me = ws.userName;
      const convoId = String(msg.convoId || '');
      if (!me || !canAccess(convoId, me)) {
        send(ws, { type: 'history', convoId, messages: [] });
        return;
      }
      markDeliveredFor(me);
      send(ws, { type: 'history', convoId, messages: conversations.get(convoId) || [] });
      break;
    }

    case 'group_create': {
      const from = ws.userName;
      if (!from) return;
      const name = String(msg.name || '').trim().slice(0, 50);
      if (!name) {
        send(ws, { type: 'error', error: 'Group name is required.' });
        return;
      }
      const requested = Array.isArray(msg.members) ? msg.members : [];
      const members = [...new Set([
        from,
        ...requested.map((n) => String(n).trim().slice(0, 24)),
      ])].filter((n) => n === from || isBot(n) || profiles.has(n));
      const group = {
        id: newGroupId(),
        name,
        pic: sanitizePic(msg.pic),
        members,
        createdBy: from,
        createdAt: Date.now(),
      };
      groups.set(group.id, group);
      scheduleSave();
      send(ws, { type: 'group_created', group });
      broadcastGroups();
      break;
    }

    case 'profile_set': {
      const from = ws.userName;
      if (!from) return;
      if (!('pic' in msg)) return;
      const pic = msg.pic === null ? null : sanitizePic(msg.pic);
      if (msg.pic !== null && msg.pic !== undefined && !pic) {
        send(ws, { type: 'error', error: 'Invalid profile picture.' });
        return;
      }
      const p = profiles.get(from) || { name: from, pic: null, about: '' };
      p.pic = pic;
      profiles.set(from, p);
      scheduleSave();
      send(ws, { type: 'profile_saved', pic });
      broadcastUsers();
      break;
    }

    case 'react': {
      const from = ws.userName;
      if (!from) return;
      const convoId = String(msg.convoId || '');
      const messageId = typeof msg.id === 'number' ? msg.id : null;
      const emoji = typeof msg.emoji === 'string' ? msg.emoji.slice(0, 8) : null;
      const add = msg.add !== false; // default true
      if (!convoId || messageId === null || !emoji) return;
      if (!canAccess(convoId, from)) return;
      // Only allow a curated set of emojis
      const ALLOWED_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏', '🔥', '🎉', '😍', '👎', '💯', '🤣'];
      if (!ALLOWED_REACTIONS.includes(emoji)) return;
      handleReact(convoId, from, messageId, emoji, add);
      break;
    }

    // Edit one of your own messages (or a photo caption). Everyone in the
    // conversation gets message_edited so bubbles update in place.
    case 'edit': {
      const from = ws.userName;
      if (!from) return;
      const convoId = String(msg.convoId || '');
      const id = typeof msg.id === 'number' ? msg.id : null;
      const text = String(msg.text || '').slice(0, 4000);
      if (!convoId || id === null || !canAccess(convoId, from)) return;
      const msgs = conversations.get(convoId) || [];
      const m = msgs.find((x) => x.id === id);
      if (!m || m.deleted || m.from !== from) return;      // your own messages only
      if (m.kind !== 'text' && m.kind !== 'photo') return; // text bodies & photo captions
      if (m.kind === 'text' && !text.trim()) return;
      if ((m.text || '') === text) return;                 // no-op edit
      m.text = text;
      m.editedAt = Date.now();
      scheduleSave();
      for (const p of convoParticipants(convoId)) {
        if (!isBot(p)) send(clients.get(p), { type: 'message_edited', convoId, id, text, editedAt: m.editedAt });
      }
      break;
    }

    // Delete for everyone: the message stays in history as a tombstone
    // ("This message was deleted") with text/media/reactions wiped.
    case 'delete': {
      const from = ws.userName;
      if (!from) return;
      const convoId = String(msg.convoId || '');
      const id = typeof msg.id === 'number' ? msg.id : null;
      if (!convoId || id === null || !canAccess(convoId, from)) return;
      const msgs = conversations.get(convoId) || [];
      const m = msgs.find((x) => x.id === id);
      if (!m || m.deleted || m.from !== from) return;      // your own messages only
      m.deleted = true;
      m.text = '';
      m.media = null;
      m.reactions = {};
      m.replyTo = null;
      scheduleSave();
      for (const p of convoParticipants(convoId)) {
        if (!isBot(p)) send(clients.get(p), { type: 'message_deleted', convoId, id });
      }
      break;
    }

    case 'call_invite': startCall(ws, msg); break;

    case 'call_accept': {
      const me = ws.userName;
      const call = calls.get(String(msg.callId || ''));
      if (!me || !call || call.ended || !call.ringing.has(me)) return;
      acceptCall(call, me);
      break;
    }

    case 'call_reject': {
      const me = ws.userName;
      const call = calls.get(String(msg.callId || ''));
      if (!me || !call || call.ended) return;
      rejectCall(call, me);
      break;
    }

    case 'call_signal': {
      const me = ws.userName;
      const call = calls.get(String(msg.callId || ''));
      if (!me || !call || call.ended) return;
      relayCallSignal(call, me, msg);
      break;
    }

    case 'call_leave': {
      const me = ws.userName;
      const call = calls.get(String(msg.callId || ''));
      if (!me || !call || call.ended || !callMembers(call).has(me)) return;
      leaveCall(call, me);
      break;
    }

    case 'register': {
      const username = String(msg.username || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      const password = String(msg.password || '');
      if (!username || username.length < 2) {
        send(ws, { type: 'auth_error', error: 'Username must be at least 2 characters.' });
        return;
      }
      if (!password || password.length < 3) {
        send(ws, { type: 'auth_error', error: 'Password must be at least 3 characters.' });
        return;
      }
      if (isBot(username)) {
        send(ws, { type: 'auth_error', error: 'That username is reserved.' });
        return;
      }
      const key = username.toLowerCase();
      if (accounts.has(key)) {
        send(ws, { type: 'auth_error', error: 'Username already taken.' });
        return;
      }
      const { salt, hash } = hashPassword(password);
      const account = { username, salt, hash, createdAt: Date.now() };
      accounts.set(key, account);
      // create profile if not exists
      if (!profiles.has(username)) {
        profiles.set(username, { name: username, pic: null, about: '' });
      }
      // create session
      const token = newSessionToken();
      sessions.set(token, key);
      scheduleSave();
      send(ws, { type: 'auth_ok', username, token, isNew: true });
      break;
    }

    case 'login': {
      const username = String(msg.username || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      const password = String(msg.password || '');
      const key = username.toLowerCase();
      const account = accounts.get(key);
      if (!account) {
        send(ws, { type: 'auth_error', error: 'Account not found. Please register first.' });
        return;
      }
      if (!verifyPassword(password, account.salt, account.hash)) {
        send(ws, { type: 'auth_error', error: 'Incorrect password.' });
        return;
      }
      // create session
      const token = newSessionToken();
      sessions.set(token, key);
      // check if session token was provided (reconnect)
      send(ws, { type: 'auth_ok', username: account.username, token, isNew: false });
      break;
    }

    case 'room_create': {
      const from = ws.userName;
      if (!from) return;
      const name = String(msg.name || '').trim().slice(0, 50);
      const password = String(msg.password || '');
      if (!name) {
        send(ws, { type: 'error', error: 'Room name is required.' });
        return;
      }
      if (!password || password.length < 3) {
        send(ws, { type: 'error', error: 'Room password must be at least 3 characters.' });
        return;
      }
      const { salt, hash } = hashPassword(password);
      const room = {
        id: newRoomId(),
        name,
        salt,
        hash,
        members: [from],
        createdBy: from,
        inviteCode: newInviteCode(),
        createdAt: Date.now(),
      };
      rooms.set(room.id, room);
      conversations.set(room.id, []);
      scheduleSave();
      send(ws, { type: 'room_created', room: { id: room.id, name: room.name, members: room.members, createdBy: room.createdBy, inviteCode: room.inviteCode, createdAt: room.createdAt } });
      broadcastRooms();
      break;
    }

    case 'room_join': {
      const from = ws.userName;
      if (!from) return;
      const roomId = String(msg.roomId || '');
      const password = String(msg.password || '');
      const inviteCode = String(msg.inviteCode || '').toUpperCase().trim();
      const room = rooms.get(roomId);
      if (!room) {
        // try finding by invite code
        if (inviteCode) {
          const found = [...rooms.values()].find((r) => r.inviteCode === inviteCode);
          if (found) {
            // invite code bypasses password
            if (!found.members.includes(from)) {
              found.members.push(from);
              scheduleSave();
              broadcastRooms();
              send(ws, { type: 'room_joined', room: { id: found.id, name: found.name, members: found.members, createdBy: found.createdBy, inviteCode: found.inviteCode, createdAt: found.createdAt } });
              // notify existing members
              for (const m of found.members) {
                if (m !== from && clients.has(m)) {
                  send(clients.get(m), { type: 'room_member_joined', roomId: found.id, member: from });
                }
              }
              return;
            }
            send(ws, { type: 'room_joined', room: { id: found.id, name: found.name, members: found.members, createdBy: found.createdBy, inviteCode: found.inviteCode, createdAt: found.createdAt } });
            return;
          }
        }
        send(ws, { type: 'error', error: 'Room not found.' });
        return;
      }
      // already a member?
      if (room.members.includes(from)) {
        send(ws, { type: 'room_joined', room: { id: room.id, name: room.name, members: room.members, createdBy: room.createdBy, inviteCode: room.inviteCode, createdAt: room.createdAt } });
        return;
      }
      // verify password
      if (!password || !verifyPassword(password, room.salt, room.hash)) {
        send(ws, { type: 'error', error: 'Incorrect room password.' });
        return;
      }
      room.members.push(from);
      scheduleSave();
      broadcastRooms();
      send(ws, { type: 'room_joined', room: { id: room.id, name: room.name, members: room.members, createdBy: room.createdBy, inviteCode: room.inviteCode, createdAt: room.createdAt } });
      // notify existing members
      for (const m of room.members) {
        if (m !== from && clients.has(m)) {
          send(clients.get(m), { type: 'room_member_joined', roomId: room.id, member: from });
        }
      }
      break;
    }

    case 'room_list': {
      const from = ws.userName;
      if (!from) return;
      send(ws, { type: 'rooms', rooms: roomsForUser(from) });
      break;
    }
  }
}

/* --------------------------------- server --------------------------------- */

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '1d',
  setHeaders(res, filePath) {
    const ct = SERVED_TYPES[path.extname(filePath).toLowerCase()];
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes'); // lets players seek inside voice notes
  },
}));
app.get('/healthz', (_req, res) => res.json({ ok: true, users: clients.size }));

const UPLOAD_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-m4a': '.m4a',
};

// Extension -> Content-Type for files we serve out of /uploads. `send` would
// otherwise label .webm/.ogg as video/*, which some browsers refuse to decode
// inside an <audio> element (voice notes).
const SERVED_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
};

const uploadJson = express.json({ limit: '14mb' }); // 8MB binary ≈ 10.7MB base64

// A data URL is  data:<type>[;<parameter>=<value>]*;base64,<payload>
// MediaRecorder blobs keep their codec parameters ("audio/webm;codecs=opus",
// "audio/mp4;codecs=mp4a.40.2"), and FileReader copies those verbatim into the
// data URL — so the parameter list has to be tolerated, not rejected.
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]*$/;

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const marker = dataUrl.indexOf(';base64,');
  if (marker < 5) return null;
  const header = dataUrl.slice(5, marker).trim();
  const payload = dataUrl.slice(marker + 8);
  const mime = header.split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) return null;
  if (!BASE64_RE.test(payload)) return null;
  return { mime, payload };
}

app.post('/api/upload', uploadJson, (req, res) => {
  const { dataUrl, name } = req.body || {};
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return res.status(400).json({ ok: false, error: 'dataUrl (base64 data URL) is required.' });
  }
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    return res.status(400).json({ ok: false, error: 'Only base64 data URLs are accepted.' });
  }
  const mime = parsed.mime;
  const ext = UPLOAD_TYPES[mime];
  if (!ext) {
    return res.status(415).json({ ok: false, error: `Unsupported media type: ${mime}` });
  }
  const buf = Buffer.from(parsed.payload, 'base64');
  if (!buf.length) {
    return res.status(400).json({ ok: false, error: 'Empty upload.' });
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ ok: false, error: 'File too large (8MB max).' });
  }
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const filename = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
    res.json({ ok: true, url: `/uploads/${filename}`, size: buf.length, type: mime, name: String(name || '').slice(0, 120) });
  } catch (err) {
    console.error('Upload failed:', err.message);
    res.status(500).json({ ok: false, error: 'Upload failed.' });
  }
});

// JSON body errors (oversized payloads etc.) → clean JSON responses
app.use('/api', (err, _req, res, _next) => {
  if (err && (err.type === 'entity.too.large' || err.statusCode === 413 || err.status === 413)) {
    return res.status(413).json({ ok: false, error: 'Payload too large (8MB max).' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body.' });
  }
  console.error('API error:', err && err.message);
  res.status(500).json({ ok: false, error: 'Request failed.' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    try {
      handle(ws, msg);
    } catch (err) {
      console.error('Handler error:', err);
    }
  });
  ws.on('close', () => {
    if (ws.userName) dropUserFromCalls(ws.userName);
    if (ws.userName && clients.get(ws.userName) === ws) {
      clients.delete(ws.userName);
      lastSeen.set(ws.userName, Date.now());
      broadcastUsers();
    }
  });
});

loadState();
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`A-Chat listening on http://0.0.0.0:${PORT}`);
});
