'use strict';

/**
 * A-Chat — WhatsApp-style realtime chat server.
 *
 * Express serves the static client and the /uploads folder; a WebSocket
 * endpoint routes everything by conversation id:
 *   - dm::A::B   two participants (names sorted, joined with "::")
 *   - grp::<id>  a group chat
 *   - room::<id> password-protected room
 * Messages, groups and user profiles are persisted as JSON files in data/
 * (messages.json, groups.json, users.json); media uploads land in data/uploads.
 * Extended in v1.4 with: disappearing messages, delete-for-me, pinned chats,
 * starred messages, mentions, stickers/GIFs, status stories, polls,
 * forwarding, search, admin controls, push, retention/export, 2FA.
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
const DISAPPEARING_FILE = path.join(DATA_DIR, 'disappearing.json');
const STATUS_FILE = path.join(DATA_DIR, 'statuses.json');
const PUSH_FILE = path.join(DATA_DIR, 'push.json');
const MAX_HISTORY = 500;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const PBKDF2_ITER = 10000;

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

const clients = new Map();
const lastSeen = new Map();
const conversations = new Map();
const groups = new Map();
const profiles = new Map();
const accounts = new Map();
const rooms = new Map();
const sessions = new Map();
let nextId = 1;

const disappearingTimers = new Map(); // convoId -> seconds
const statuses = new Map(); // id -> status
let nextStatusId = 1;
const pushSubs = new Map(); // username lower -> subscription object
const messageTimers = new Map(); // messageId -> timeout

const dmConvoId = (a, b) => `dm::${[a, b].sort().join('::')}`;
const newGroupId = () => `grp::${crypto.randomBytes(4).toString('hex')}`;
const newRoomId = () => `room::${crypto.randomBytes(4).toString('hex')}`;
const newInviteCode = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const newStatusId = () => `sts::${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

/* --------------------------- privacy & ghost mode -------------------------- */

const DEFAULT_PRIVACY = { readReceipts: true, lastSeen: true, typing: true, ghost: false };

function normalizePrivacy(p) {
  const out = { ...DEFAULT_PRIVACY };
  if (p && typeof p === 'object') {
    for (const k of Object.keys(out)) {
      if (typeof p[k] === 'boolean') out[k] = p[k];
    }
  }
  return out;
}

function profileFor(name) {
  let p = profiles.get(name);
  if (!p) {
    p = { name, pic: null, about: '', privacy: { ...DEFAULT_PRIVACY }, pinnedChats: [], wallpaper: null, twoFA: null };
    profiles.set(name, p);
  } else {
    p.privacy = normalizePrivacy(p.privacy);
    if (!Array.isArray(p.pinnedChats)) p.pinnedChats = [];
    if (!p.wallpaper) p.wallpaper = null;
    if (!p.twoFA) p.twoFA = null;
  }
  return p;
}

function privacyOf(name) {
  const p = profiles.get(name);
  return p && p.privacy ? normalizePrivacy(p.privacy) : { ...DEFAULT_PRIVACY };
}

const isGhost = (name) => privacyOf(name).ghost === true;

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

function generate2FASecret() {
  return crypto.randomBytes(10).toString('hex').toUpperCase();
}
function generate2FACode(secret) {
  // simple TOTP-like: hash secret + time slice (30s)
  const slice = Math.floor(Date.now() / 30000);
  const h = crypto.createHash('sha256').update(secret + ':' + slice).digest('hex');
  const num = parseInt(h.slice(0, 6), 16) % 1000000;
  return String(num).padStart(6, '0');
}
function verify2FACode(secret, code) {
  const slice = Math.floor(Date.now() / 30000);
  for (let d = -1; d <= 1; d++) {
    const h = crypto.createHash('sha256').update(secret + ':' + (slice + d)).digest('hex');
    const num = parseInt(h.slice(0, 6), 16) % 1000000;
    if (String(num).padStart(6, '0') === code) return true;
  }
  return false;
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

function isGroupAdmin(convoId, name) {
  if (convoId.startsWith('grp::')) {
    const g = groups.get(convoId);
    if (!g) return false;
    if (g.createdBy === name) return true;
    if (Array.isArray(g.admins) && g.admins.includes(name)) return true;
    return false;
  }
  if (convoId.startsWith('room::')) {
    const r = rooms.get(convoId);
    if (!r) return false;
    return r.createdBy === name;
  }
  return false;
}

/* ------------------------------ persistence ------------------------------- */

function normalizeConvoId(key) {
  if (key.startsWith('dm::') || key.startsWith('grp::') || key.startsWith('room::')) return key;
  return `dm::${key.split('::').filter(Boolean).sort().join('::')}`;
}

function migrateMessage(m, convoId) {
  if (!m || !m.from) return null;
  const others = convoParticipants(convoId).filter((p) => p !== m.from);
  const deleted = m.deleted === true;
  const base = {
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
    replyTo: !deleted && m.replyTo && typeof m.replyTo === 'object' && typeof m.replyTo.id === 'number' ? m.replyTo : null,
    editedAt: Number.isFinite(m.editedAt) ? m.editedAt : null,
    deleted,
    // new fields
    deletedFor: Array.isArray(m.deletedFor) ? m.deletedFor : [],
    forwarded: !!m.forwarded,
    forwardedFrom: m.forwardedFrom || null,
    expiresAt: Number.isFinite(m.expiresAt) ? m.expiresAt : null,
    starredBy: Array.isArray(m.starredBy) ? m.starredBy : [],
    editHistory: Array.isArray(m.editHistory) ? m.editHistory : [],
  };
  // sanitize kind
  const allowedKinds = ['text','photo','voice','call','sticker','gif','poll'];
  if (!allowedKinds.includes(base.kind)) base.kind = 'text';
  // poll media validation
  if (base.kind === 'poll' && base.media) {
    if (!base.media.question || !Array.isArray(base.media.options)) {
      base.kind = 'text';
      base.media = null;
    }
  }
  return base;
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
  } catch { }

  try {
    const raw = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    for (const g of raw) {
      if (g && g.id && g.name && Array.isArray(g.members)) {
        if (!Array.isArray(g.admins)) g.admins = [g.createdBy].filter(Boolean);
        if (!g.createdAt) g.createdAt = Date.now();
        groups.set(g.id, g);
      }
    }
  } catch { }

  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for (const [name, p] of Object.entries(raw)) {
      if (p && typeof p === 'object') {
        profiles.set(name, {
          name,
          pic: p.pic || null,
          about: p.about || '',
          privacy: normalizePrivacy(p.privacy),
          pinnedChats: Array.isArray(p.pinnedChats) ? p.pinnedChats : [],
          wallpaper: p.wallpaper || null,
          twoFA: p.twoFA || null,
        });
      }
    }
  } catch { }

  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    for (const [key, a] of Object.entries(raw)) {
      if (a && a.username && a.salt && a.hash) accounts.set(key, a);
    }
  } catch { }

  try {
    const raw = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    for (const r of raw) {
      if (r && r.id && r.name && r.salt && r.hash) {
        r.members = Array.isArray(r.members) ? r.members : [];
        if (!r.retention) r.retention = null;
        rooms.set(r.id, r);
        if (!conversations.has(r.id)) conversations.set(r.id, []);
      }
    }
  } catch { }

  try {
    const raw = JSON.parse(fs.readFileSync(DISAPPEARING_FILE, 'utf8'));
    for (const [k,v] of Object.entries(raw)) {
      if (typeof v === 'number' && v > 0) disappearingTimers.set(k, v);
    }
  } catch {}

  try {
    const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    for (const s of raw) {
      if (s && s.id && s.from) {
        statuses.set(s.id, s);
        const num = parseInt(s.id.split('-')[0].replace('sts::',''),36);
        if (!isNaN(num)) nextStatusId = Math.max(nextStatusId, num+1);
      }
    }
    // cleanup expired
    const now = Date.now();
    for (const [id,s] of statuses) {
      if (s.expiresAt && s.expiresAt < now) statuses.delete(id);
    }
  } catch {}

  try {
    const raw = JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8'));
    for (const [k,v] of Object.entries(raw)) pushSubs.set(k, v);
  } catch {}

  for (const b of BOTS) {
    const existing = profiles.get(b.name);
    if (!existing) profiles.set(b.name, { name: b.name, pic: BOT_AVATARS[b.name], about: b.subtitle, privacy: { ...DEFAULT_PRIVACY }, pinnedChats: [], wallpaper: null, twoFA: null });
    else if (!existing.pic) existing.pic = BOT_AVATARS[b.name];
  }

  const all = [...conversations.values()].flat();
  if (all.length) nextId = Math.max(...all.map((m) => m.id || 0)) + 1;
  if (all.length) console.log(`Loaded ${all.length} messages, ${groups.size} groups, ${profiles.size} profiles from disk.`);

  // schedule expiry for loaded messages
  for (const msgs of conversations.values()) {
    for (const m of msgs) if (m.expiresAt) scheduleExpiry(m);
  }
  // schedule status expiry
  for (const s of statuses.values()) {
    const delay = s.expiresAt - Date.now();
    if (delay > 0) setTimeout(() => { statuses.delete(s.id); broadcastStatuses(); scheduleSave(); }, delay);
  }
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
    fs.writeFileSync(DISAPPEARING_FILE, JSON.stringify(Object.fromEntries(disappearingTimers)));
    fs.writeFileSync(STATUS_FILE, JSON.stringify([...statuses.values()]));
    fs.writeFileSync(PUSH_FILE, JSON.stringify(Object.fromEntries(pushSubs)));
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
  // schedule disappearing
  if (m.expiresAt) scheduleExpiry(m);
}

function scheduleExpiry(m) {
  if (!m.expiresAt) return;
  const delay = m.expiresAt - Date.now();
  if (delay <= 0) {
    expireMessage(m);
    return;
  }
  if (messageTimers.has(m.id)) clearTimeout(messageTimers.get(m.id));
  const t = setTimeout(() => expireMessage(m), Math.min(delay, 2147483647));
  messageTimers.set(m.id, t);
}

function expireMessage(m) {
  const msgs = conversations.get(m.convoId);
  if (!msgs) return;
  const idx = msgs.findIndex(x => x.id === m.id);
  if (idx === -1) return;
  // already deleted?
  if (msgs[idx].deleted) return;
  const msg = msgs[idx];
  msg.deleted = true;
  msg.text = '';
  msg.media = null;
  msg.reactions = {};
  msg.replyTo = null;
  msg.expiresAt = null;
  messageTimers.delete(m.id);
  scheduleSave();
  for (const p of convoParticipants(m.convoId)) {
    if (!isBot(p)) send(clients.get(p), { type: 'message_deleted', convoId: m.convoId, id: m.id, expired: true });
  }
}

function notifyStatus(m) {
  send(clients.get(m.from), {
    type: 'status', id: m.id, convoId: m.convoId, deliveredBy: m.deliveredBy, readBy: m.readBy,
  });
}

function markDeliveredFor(name) {
  if (isGhost(name)) return;
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
  const priv = privacyOf(name);
  const online = clients.has(name) && !priv.ghost;
  const showLastSeen = !priv.ghost && priv.lastSeen;
  return {
    name,
    online,
    bot: isBot(name),
    lastSeen: online || !showLastSeen ? null : lastSeen.get(name) || null,
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
  return [...groups.values()].filter((g) => g.members.includes(name)).map(g => ({
    id: g.id, name: g.name, pic: g.pic, members: g.members, createdBy: g.createdBy, createdAt: g.createdAt, admins: g.admins || [g.createdBy]
  }));
}

function roomsForUser(name) {
  return [...rooms.values()].filter((r) => r.members.includes(name)).map((r) => ({
    id: r.id, name: r.name, members: r.members, createdBy: r.createdBy,
    inviteCode: r.inviteCode, createdAt: r.createdAt, retention: r.retention || null,
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

function broadcastStatuses() {
  const list = [...statuses.values()].filter(s => s.expiresAt > Date.now());
  const payload = JSON.stringify({ type: 'statuses', statuses: list });
  for (const ws of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function getStatusesForUser(name) {
  const now = Date.now();
  return [...statuses.values()].filter(s => s.expiresAt > now);
}

const PIC_RE = /^\/(uploads|avatars)\/[A-Za-z0-9._-]+$/;
function sanitizePic(pic) {
  return typeof pic === 'string' && PIC_RE.test(pic) ? pic : null;
}

function sanitizeMedia(media, kind) {
  if (kind === 'text') return null;
  if (kind === 'poll') {
    if (!media || typeof media !== 'object') return null;
    const question = String(media.question || '').trim().slice(0, 200);
    if (!question) return null;
    const opts = Array.isArray(media.options) ? media.options : [];
    const cleanOpts = opts.map(o => String(o.text || o).trim().slice(0, 80)).filter(Boolean).slice(0, 8);
    if (cleanOpts.length < 2) return null;
    return {
      question,
      options: cleanOpts.map(t => ({ text: t, votes: [] })),
      multiple: !!media.multiple,
      closed: false,
    };
  }
  if (kind === 'sticker' || kind === 'gif') {
    if (!media || typeof media !== 'object') return null;
    const url = typeof media.url === 'string' ? media.url : '';
    // allow external GIF URLs for demo, but sanitize to http/https
    if (url.startsWith('/uploads/')) {
      if (!PIC_RE.test(url)) return null;
      return { url, w: media.w, h: media.h };
    }
    if (/^https:\/\/.+\.(gif|webp|png|jpg|jpeg)(\?.*)?$/.test(url)) {
      return { url: url.slice(0, 500) };
    }
    return null;
  }
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
  const isDM = convoId.startsWith('dm::');
  if (Math.random() > (isDM ? 0.30 : 0.15)) return;
  for (const p of convoParticipants(convoId)) {
    if (p === fromName || !isBot(p)) continue;
    const emojis = BOT_REACTIONS[p];
    if (!emojis) continue;
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    const msgs = conversations.get(convoId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].from === fromName) {
        handleReact(convoId, p, msgs[i].id, emoji, true, true);
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
    for (const p of convoParticipants(convoId)) {
      if (!isBot(p)) send(clients.get(p), { type: 'reaction', convoId, id: messageId, reactions: m.reactions, reactor, emoji, add });
    }
  }
  return m;
}

function botSay(convoId, botName, text) {
  const m = {
    id: nextId++, convoId, from: botName, kind: 'text', text,
    media: null, ts: Date.now(), deliveredBy: [], readBy: [], reactions: {},
    replyTo: null, editedAt: null, deleted: false, deletedFor: [], forwarded: false, forwardedFrom: null, expiresAt: null, starredBy: [], editHistory: [],
  };
  for (const p of convoParticipants(convoId)) {
    if (p === botName) continue;
    if (isBot(p)) { m.deliveredBy.push(p); m.readBy.push(p); }
    else if (clients.has(p) && !isGhost(p)) m.deliveredBy.push(p);
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

const calls = new Map();
const CALL_RING_TIMEOUT_MS = Number(process.env.CALL_RING_TIMEOUT_MS || 45000);
const CALL_MAX_MEMBERS = 8;
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
    replyTo: null, editedAt: null, deleted: false, deletedFor: [], forwarded: false, forwardedFrom: null, expiresAt: null, starredBy: [], editHistory: [],
  };
  for (const p of convoParticipants(call.convoId)) {
    if (p === call.initiator) continue;
    if (isBot(p)) { m.deliveredBy.push(p); m.readBy.push(p); }
    else if (clients.has(p) && !isGhost(p)) m.deliveredBy.push(p);
  }
  pushMessage(m);
  for (const p of convoParticipants(call.convoId)) {
    if (p !== call.initiator && !isBot(p)) send(clients.get(p), { type: 'message', message: m });
  }
  sendCall(call.initiator, { type: 'message', message: m });
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
}

function leaveCall(call, name) {
  if (call.ended) return;
  call.ringing.delete(name);
  const idx = call.joined.indexOf(name);
  if (idx >= 0) call.joined.splice(idx, 1);
  for (const n of callMembers(call)) {
    sendCall(n, { type: 'call_peer_left', callId: call.id, name });
  }
  if (call.startedAt === null && name === call.initiator) {
    endCall(call, 'cancelled');
  } else if (call.startedAt !== null && call.joined.length < 2) {
    endCall(call, 'ended');
  } else if (call.startedAt === null && call.ringing.size === 0 && call.declined.size) {
    endCall(call, 'declined');
  } else if (call.startedAt === null && call.joined.length === 0) {
    endCall(call, 'cancelled');
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
  const online = targets.filter((n) => clients.has(n) && !isGhost(n));
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
    participants: new Set([from]),
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
      let name = String(msg.name || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
      if (!name) name = 'Guest-' + Math.floor(Math.random() * 1000);
      if (isBot(name)) name = name + ' (you)';
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
      const isNewProfile = !profiles.has(name);
      profileFor(name);
      if (isNewProfile) scheduleSave();
      const pro = profileFor(name);
      send(ws, {
        type: 'joined',
        name,
        users: userList(),
        groups: groupsForUser(name),
        rooms: roomsForUser(name),
        hasAccount: accounts.has(name.toLowerCase()),
        privacy: pro.privacy,
        pinnedChats: pro.pinnedChats || [],
        wallpaper: pro.wallpaper || null,
        statuses: getStatusesForUser(name),
        disappearing: Object.fromEntries(disappearingTimers),
      });
      broadcastUsers();
      markDeliveredFor(name);
      // send statuses
      send(ws, { type: 'statuses', statuses: getStatusesForUser(name) });
      // send disappearing timers
      send(ws, { type: 'disappearing_all', timers: Object.fromEntries(disappearingTimers) });
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
      const kind = ['text', 'photo', 'voice','sticker','gif','poll'].includes(msg.kind) ? msg.kind : 'text';
      const text = String(msg.text || '').slice(0, 4000);
      const media = sanitizeMedia(msg.media, kind);
      if (!canAccess(convoId, from)) return;
      if (kind === 'text' && !text.trim() && !media) return;
      if (kind !== 'text' && kind !== 'poll' && !media && !text.trim()) return;
      if (kind === 'poll' && !media) return;
      // mentions detection
      const mentions = [];
      const mentionRe = /@([A-Za-z0-9_ ]{2,24})/g;
      let mm;
      while ((mm = mentionRe.exec(text)) !== null) {
        const mName = mm[1].trim();
        if (convoParticipants(convoId).includes(mName) && !mentions.includes(mName)) mentions.push(mName);
      }
      // disappearing timer
      let expiresAt = null;
      const timerSec = disappearingTimers.get(convoId);
      if (Number.isFinite(msg.expiresIn) && msg.expiresIn > 0) {
        expiresAt = Date.now() + Math.min(86400, Math.max(1, msg.expiresIn)) * 1000;
      } else if (timerSec) {
        expiresAt = Date.now() + timerSec * 1000;
      }
      const m = {
        id: nextId++, convoId, from, kind, text, media, ts: Date.now(),
        deliveredBy: [], readBy: [], reactions: {},
        replyTo: sanitizeReplyTo(convoId, msg.replyTo), editedAt: null, deleted: false,
        deletedFor: [], forwarded: !!msg.forwarded, forwardedFrom: msg.forwardedFrom || null, expiresAt, starredBy: [], editHistory: [], mentions,
      };
      pushMessage(m);
      send(ws, { type: 'message', message: m });
      const participants = convoParticipants(convoId);
      let changed = false;
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
          if (!isGhost(p)) {
            m.deliveredBy.push(p);
            changed = true;
          }
          // filter deletedFor?
          send(target, { type: 'message', message: m });
          // mention notification
          if (mentions.includes(p)) {
            send(target, { type: 'mention', convoId, id: m.id, from });
          }
          // push notification if offline
          if (!clients.has(p) && pushSubs.has(p.toLowerCase())) {
            // placeholder: log push
            console.log(`Push notify ${p} for message ${m.id}`);
          }
        }
      }
      if (changed) {
        notifyStatus(m);
        scheduleSave();
      }
      maybeBotReact(convoId, m);
      setTimeout(() => botReactToMessage(convoId, from), 1500 + Math.random() * 2000);
      break;
    }

    case 'typing': {
      const from = ws.userName;
      const convoId = String(msg.convoId || '');
      if (!from || !canAccess(convoId, from)) return;
      if (isGhost(from) || !privacyOf(from).typing) return;
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
      if (isGhost(me) || !privacyOf(me).readReceipts) return;
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
      // per-chat read state: notify others of read up to
      for (const p of convoParticipants(convoId)) {
        if (p !== me && !isBot(p)) send(clients.get(p), { type: 'read_state', convoId, reader: me, ts: Date.now() });
      }
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
      const all = conversations.get(convoId) || [];
      // filter deletedFor
      const filtered = all.filter(m => !(m.deletedFor || []).includes(me));
      send(ws, { type: 'history', convoId, messages: filtered });
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
        admins: [from],
      };
      groups.set(group.id, group);
      scheduleSave();
      send(ws, { type: 'group_created', group: { id: group.id, name: group.name, pic: group.pic, members: group.members, createdBy: group.createdBy, createdAt: group.createdAt, admins: group.admins } });
      broadcastGroups();
      break;
    }

    case 'group_add_member': {
      const from = ws.userName;
      const gid = String(msg.groupId || '');
      const toAdd = String(msg.member || '').trim();
      const g = groups.get(gid);
      if (!from || !g) return;
      if (!isGroupAdmin(gid, from)) { send(ws, { type: 'error', error: 'Only admins can add members.' }); return; }
      if (!profiles.has(toAdd) || g.members.includes(toAdd)) return;
      g.members.push(toAdd);
      scheduleSave();
      broadcastGroups();
      send(ws, { type: 'group_updated', group: g });
      break;
    }

    case 'group_remove_member': {
      const from = ws.userName;
      const gid = String(msg.groupId || '');
      const toRem = String(msg.member || '').trim();
      const g = groups.get(gid);
      if (!from || !g) return;
      const isAdmin = isGroupAdmin(gid, from);
      const selfLeave = toRem === from;
      if (!isAdmin && !selfLeave) { send(ws, { type: 'error', error: 'Only admins can remove members.' }); return; }
      if (toRem === g.createdBy) { send(ws, { type: 'error', error: 'Cannot remove group creator.' }); return; }
      g.members = g.members.filter(m => m !== toRem);
      g.admins = (g.admins || []).filter(a => a !== toRem);
      scheduleSave();
      broadcastGroups();
      for (const p of g.members) send(clients.get(p), { type: 'group_member_removed', groupId: gid, member: toRem });
      send(clients.get(toRem), { type: 'group_member_removed', groupId: gid, member: toRem, you: true });
      break;
    }

    case 'group_make_admin': {
      const from = ws.userName;
      const gid = String(msg.groupId || '');
      const who = String(msg.member || '').trim();
      const g = groups.get(gid);
      if (!from || !g) return;
      if (g.createdBy !== from) { send(ws, { type: 'error', error: 'Only creator can promote admins.' }); return; }
      if (!g.members.includes(who)) return;
      if (!g.admins.includes(who)) g.admins.push(who);
      scheduleSave();
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
      const p = profileFor(from);
      p.pic = pic;
      profiles.set(from, p);
      scheduleSave();
      send(ws, { type: 'profile_saved', pic });
      broadcastUsers();
      break;
    }

    case 'wallpaper_set': {
      const from = ws.userName;
      if (!from) return;
      const wp = String(msg.wallpaper || '').slice(0, 500);
      const p = profileFor(from);
      p.wallpaper = wp || null;
      scheduleSave();
      send(ws, { type: 'wallpaper_saved', wallpaper: p.wallpaper });
      break;
    }

    case 'privacy_set': {
      const from = ws.userName;
      if (!from) return;
      if (!msg.privacy || typeof msg.privacy !== 'object') return;
      const p = profileFor(from);
      const current = normalizePrivacy(p.privacy);
      for (const k of Object.keys(current)) {
        if (typeof msg.privacy[k] === 'boolean') current[k] = msg.privacy[k];
      }
      p.privacy = current;
      scheduleSave();
      send(ws, { type: 'privacy_saved', privacy: current });
      broadcastUsers();
      break;
    }

    case 'react': {
      const from = ws.userName;
      if (!from) return;
      const convoId = String(msg.convoId || '');
      const messageId = typeof msg.id === 'number' ? msg.id : null;
      const emoji = typeof msg.emoji === 'string' ? msg.emoji.slice(0, 8) : null;
      const add = msg.add !== false;
      if (!convoId || messageId === null || !emoji) return;
      if (!canAccess(convoId, from)) return;
      const ALLOWED_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏', '🔥', '🎉', '😍', '👎', '💯', '🤣','😡','🥺','✨','👏','🤝','💪','🫶','💔'];
      if (!ALLOWED_REACTIONS.includes(emoji)) return;
      handleReact(convoId, from, messageId, emoji, add);
      break;
    }

    case 'edit': {
      const from = ws.userName;
      if (!from) return;
      const convoId = String(msg.convoId || '');
      const id = typeof msg.id === 'number' ? msg.id : null;
      const text = String(msg.text || '').slice(0, 4000);
      if (!convoId || id === null || !canAccess(convoId, from)) return;
      const msgs = conversations.get(convoId) || [];
      const m = msgs.find((x) => x.id === id);
      if (!m || m.deleted || m.from !== from) return;
      if (m.kind !== 'text' && m.kind !== 'photo' && m.kind !== 'poll') return;
      if (m.kind === 'text' && !text.trim()) return;
      if ((m.text || '') === text) return;
      // push history
      if (!m.editHistory) m.editHistory = [];
      m.editHistory.push({ text: m.text, at: m.editedAt || m.ts });
      if (m.editHistory.length > 10) m.editHistory.shift();
      m.text = text;
      m.editedAt = Date.now();
      scheduleSave();
      for (const p of convoParticipants(convoId)) {
        if (!isBot(p)) send(clients.get(p), { type: 'message_edited', convoId, id, text, editedAt: m.editedAt, editHistory: m.editHistory });
      }
      break;
    }

    case 'delete': {
      const from = ws.userName;
      if (!from) return;
      const convoId = String(msg.convoId || '');
      const id = typeof msg.id === 'number' ? msg.id : null;
      if (!convoId || id === null || !canAccess(convoId, from)) return;
      const msgs = conversations.get(convoId) || [];
      const m = msgs.find((x) => x.id === id);
      if (!m || m.deleted) return;
      const isAdminDelete = isGroupAdmin(convoId, from) && m.from !== from;
      if (m.from !== from && !isAdminDelete) return;
      m.deleted = true;
      m.text = '';
      m.media = null;
      m.reactions = {};
      m.replyTo = null;
      if (m.expiresAt && messageTimers.has(m.id)) { clearTimeout(messageTimers.get(m.id)); messageTimers.delete(m.id); }
      scheduleSave();
      for (const p of convoParticipants(convoId)) {
        if (!isBot(p)) send(clients.get(p), { type: 'message_deleted', convoId, id });
      }
      break;
    }

    case 'delete_for_me': {
      const from = ws.userName;
      if (!from) return;
      const convoId = String(msg.convoId || '');
      const id = typeof msg.id === 'number' ? msg.id : null;
      if (!convoId || id === null || !canAccess(convoId, from)) return;
      const msgs = conversations.get(convoId) || [];
      const m = msgs.find(x => x.id === id);
      if (!m) return;
      if (!m.deletedFor) m.deletedFor = [];
      if (!m.deletedFor.includes(from)) m.deletedFor.push(from);
      scheduleSave();
      send(ws, { type: 'message_deleted_for_me', convoId, id });
      break;
    }

    case 'clear_chat': {
      const from = ws.userName;
      const convoId = String(msg.convoId || '');
      if (!from || !canAccess(convoId, from)) return;
      const msgs = conversations.get(convoId) || [];
      for (const m of msgs) {
        if (!m.deletedFor) m.deletedFor = [];
        if (!m.deletedFor.includes(from)) m.deletedFor.push(from);
      }
      scheduleSave();
      send(ws, { type: 'chat_cleared', convoId });
      break;
    }

    case 'pin_chat': {
      const from = ws.userName;
      const convoId = String(msg.convoId || '');
      const pin = !!msg.pinned;
      if (!from || !convoId) return;
      const p = profileFor(from);
      if (pin) {
        if (!p.pinnedChats.includes(convoId)) p.pinnedChats.push(convoId);
      } else {
        p.pinnedChats = p.pinnedChats.filter(c => c !== convoId);
      }
      scheduleSave();
      send(ws, { type: 'pinned_update', pinnedChats: p.pinnedChats });
      break;
    }

    case 'star_message': {
      const from = ws.userName;
      const convoId = String(msg.convoId || '');
      const id = typeof msg.id === 'number' ? msg.id : null;
      const star = !!msg.starred;
      if (!from || !convoId || id === null) return;
      const msgs = conversations.get(convoId) || [];
      const m = msgs.find(x => x.id === id);
      if (!m) return;
      if (!m.starredBy) m.starredBy = [];
      if (star) {
        if (!m.starredBy.includes(from)) m.starredBy.push(from);
      } else {
        m.starredBy = m.starredBy.filter(n => n !== from);
      }
      scheduleSave();
      for (const p of convoParticipants(convoId)) {
        if (!isBot(p)) send(clients.get(p), { type: 'message_starred', convoId, id, starredBy: m.starredBy });
      }
      break;
    }

    case 'forward': {
      const from = ws.userName;
      const srcId = typeof msg.messageId === 'number' ? msg.messageId : null;
      const srcConvo = String(msg.fromConvoId || '');
      const targets = Array.isArray(msg.toConvoIds) ? msg.toConvoIds : [];
      if (!from || srcId === null || !srcConvo || !targets.length) return;
      const srcMsgs = conversations.get(srcConvo) || [];
      const src = srcMsgs.find(x => x.id === srcId);
      if (!src || src.deleted) return;
      for (const convoId of targets.slice(0, 5)) {
        const toId = String(convoId);
        if (!canAccess(toId, from)) continue;
        const fwd = {
          id: nextId++, convoId: toId, from, kind: src.kind, text: src.text, media: src.media, ts: Date.now(),
          deliveredBy: [], readBy: [], reactions: {}, replyTo: null, editedAt: null, deleted: false,
          deletedFor: [], forwarded: true, forwardedFrom: src.from, expiresAt: null, starredBy: [], editHistory: [], mentions: [],
        };
        // apply disappearing timer if set
        const t = disappearingTimers.get(toId);
        if (t) fwd.expiresAt = Date.now() + t*1000;
        pushMessage(fwd);
        // deliver
        for (const p of convoParticipants(toId)) {
          if (p === from) { send(ws, { type: 'message', message: fwd }); continue; }
          if (isBot(p)) { fwd.deliveredBy.push(p); fwd.readBy.push(p); continue; }
          const target = clients.get(p);
          if (target) {
            if (!isGhost(p)) fwd.deliveredBy.push(p);
            send(target, { type: 'message', message: fwd });
          }
        }
        if (fwd.deliveredBy.length) notifyStatus(fwd);
      }
      break;
    }

    case 'poll_vote': {
      const from = ws.userName;
      const convoId = String(msg.convoId || '');
      const id = typeof msg.id === 'number' ? msg.id : null;
      const idx = Number(msg.optionIndex);
      if (!from || !convoId || id === null || !Number.isInteger(idx)) return;
      const msgs = conversations.get(convoId) || [];
      const m = msgs.find(x => x.id === id);
      if (!m || m.kind !== 'poll' || m.deleted || !m.media || m.media.closed) return;
      if (!canAccess(convoId, from)) return;
      const opts = m.media.options;
      if (idx < 0 || idx >= opts.length) return;
      // toggle vote
      for (const opt of opts) {
        const has = opt.votes.includes(from);
        if (opt === opts[idx]) {
          if (has) opt.votes = opt.votes.filter(v => v !== from);
          else {
            if (!m.media.multiple) {
              for (const o of opts) o.votes = o.votes.filter(v => v !== from);
            }
            opt.votes.push(from);
          }
        } else if (!m.media.multiple) {
          opt.votes = opt.votes.filter(v => v !== from);
        }
      }
      scheduleSave();
      for (const p of convoParticipants(convoId)) {
        if (!isBot(p)) send(clients.get(p), { type: 'poll_update', convoId, id, media: m.media });
      }
      break;
    }

    case 'poll_close': {
      const from = ws.userName;
      const convoId = String(msg.convoId || '');
      const id = typeof msg.id === 'number' ? msg.id : null;
      const msgs = conversations.get(convoId) || [];
      const m = msgs.find(x => x.id === id);
      if (!m || m.kind !== 'poll' || m.deleted) return;
      if (m.from !== from && !isGroupAdmin(convoId, from)) return;
      m.media.closed = true;
      scheduleSave();
      for (const p of convoParticipants(convoId)) {
        if (!isBot(p)) send(clients.get(p), { type: 'poll_update', convoId, id, media: m.media });
      }
      break;
    }

    case 'disappearing_set': {
      const from = ws.userName;
      const convoId = String(msg.convoId || '');
      const seconds = Number(msg.seconds);
      if (!from || !canAccess(convoId, from)) return;
      if (!seconds || seconds <= 0) {
        disappearingTimers.delete(convoId);
      } else {
        const allowed = [5,30,60,300,3600,86400];
        const use = allowed.includes(seconds) ? seconds : Math.min(86400, Math.max(5, seconds));
        disappearingTimers.set(convoId, use);
      }
      scheduleSave();
      for (const p of convoParticipants(convoId)) {
        if (!isBot(p)) send(clients.get(p), { type: 'disappearing_update', convoId, seconds: disappearingTimers.get(convoId) || 0 });
      }
      // system message
      if (disappearingTimers.has(convoId)) {
        const t = disappearingTimers.get(convoId);
        const label = t < 60 ? `${t}s` : t < 3600 ? `${Math.floor(t/60)}m` : `${Math.floor(t/3600)}h`;
        const sys = {
          id: nextId++, convoId, from: 'System', kind: 'text', text: `⏳ ${from} turned on disappearing messages: ${label}`,
          media: null, ts: Date.now(), deliveredBy: [], readBy: [], reactions: {}, replyTo: null, editedAt: null, deleted: false,
          deletedFor: [], forwarded: false, forwardedFrom: null, expiresAt: null, starredBy: [], editHistory: [], mentions: [],
        };
        pushMessage(sys);
        for (const p of convoParticipants(convoId)) if (!isBot(p)) send(clients.get(p), { type: 'message', message: sys });
      }
      break;
    }

    case 'retention_set': {
      const from = ws.userName;
      const convoId = String(msg.convoId || '');
      const days = Number(msg.days);
      if (!from) return;
      if (convoId.startsWith('room::')) {
        const r = rooms.get(convoId);
        if (!r || r.createdBy !== from) return;
        r.retention = days > 0 ? Math.min(30, days) : null;
        // apply retroactive expiry? schedule cleanup
        if (r.retention) {
          const cutoff = Date.now() - r.retention*86400000;
          const msgs = conversations.get(convoId) || [];
          const remain = msgs.filter(m => m.ts >= cutoff);
          if (remain.length !== msgs.length) {
            conversations.set(convoId, remain);
            for (const p of r.members) if (!isBot(p)) send(clients.get(p), { type: 'retention_pruned', convoId, removed: msgs.length - remain.length });
          }
        }
        scheduleSave();
        broadcastRooms();
      }
      break;
    }

    case 'status_create': {
      const from = ws.userName;
      if (!from) return;
      const text = String(msg.text || '').slice(0, 500);
      const media = msg.media ? sanitizeMedia(msg.media, msg.kind === 'photo' ? 'photo':'text') : null;
      if (!text && !media) return;
      const st = {
        id: newStatusId(),
        from,
        text,
        media,
        ts: Date.now(),
        expiresAt: Date.now() + 24*3600*1000,
        views: [],
      };
      statuses.set(st.id, st);
      scheduleSave();
      broadcastStatuses();
      setTimeout(() => { if (statuses.has(st.id)) { statuses.delete(st.id); broadcastStatuses(); scheduleSave(); } }, 24*3600*1000);
      send(ws, { type: 'status_created', status: st });
      break;
    }

    case 'status_view': {
      const from = ws.userName;
      const sid = String(msg.statusId || '');
      const s = statuses.get(sid);
      if (!from || !s) return;
      if (!s.views.includes(from)) s.views.push(from);
      scheduleSave();
      send(clients.get(s.from), { type: 'status_viewed', statusId: sid, viewer: from, views: s.views });
      break;
    }

    case 'search_messages': {
      const from = ws.userName;
      const q = String(msg.query || '').trim().toLowerCase().slice(0, 100);
      if (!from || !q) { send(ws, { type: 'search_results', query: q, results: [] }); return; }
      const results = [];
      for (const [convoId, msgs] of conversations) {
        if (!canAccess(convoId, from)) continue;
        for (const m of msgs) {
          if ((m.deletedFor || []).includes(from)) continue;
          if (m.deleted) continue;
          const hay = (m.text || '').toLowerCase();
          const mediaHay = m.media && m.media.question ? m.media.question.toLowerCase() : '';
          if (hay.includes(q) || mediaHay.includes(q)) {
            results.push({ convoId, message: m });
            if (results.length >= 30) break;
          }
        }
        if (results.length >= 30) break;
      }
      send(ws, { type: 'search_results', query: q, results });
      break;
    }

    case 'push_subscribe': {
      const from = ws.userName;
      if (!from) return;
      const sub = msg.subscription;
      if (!sub || typeof sub !== 'object') return;
      pushSubs.set(from.toLowerCase(), sub);
      scheduleSave();
      send(ws, { type: 'push_subscribed' });
      break;
    }

    case 'push_unsubscribe': {
      const from = ws.userName;
      if (!from) return;
      pushSubs.delete(from.toLowerCase());
      scheduleSave();
      send(ws, { type: 'push_unsubscribed' });
      break;
    }

    case '2fa_enable': {
      const from = ws.userName;
      if (!from) return;
      const p = profileFor(from);
      const secret = generate2FASecret();
      p.twoFA = { secret, enabled: false };
      scheduleSave();
      send(ws, { type: '2fa_secret', secret, otpauth: `otpauth://totp/A-Chat:${from}?secret=${secret}&issuer=A-Chat` });
      break;
    }

    case '2fa_verify': {
      const from = ws.userName;
      const code = String(msg.code || '').trim();
      if (!from || !code) return;
      const p = profileFor(from);
      if (!p.twoFA || !p.twoFA.secret) { send(ws, { type: '2fa_error', error: 'No 2FA setup' }); return; }
      if (verify2FACode(p.twoFA.secret, code)) {
        p.twoFA.enabled = true;
        // also store in account
        const acc = accounts.get(from.toLowerCase());
        if (acc) { acc.twoFA = { secret: p.twoFA.secret, enabled: true }; }
        scheduleSave();
        send(ws, { type: '2fa_enabled' });
      } else {
        send(ws, { type: '2fa_error', error: 'Invalid code' });
      }
      break;
    }

    case '2fa_disable': {
      const from = ws.userName;
      if (!from) return;
      const p = profileFor(from);
      p.twoFA = null;
      const acc = accounts.get(from.toLowerCase());
      if (acc) acc.twoFA = null;
      scheduleSave();
      send(ws, { type: '2fa_disabled' });
      break;
    }

    case 'password_reset_request': {
      const username = String(msg.username || '').trim();
      const key = username.toLowerCase();
      const acc = accounts.get(key);
      if (!acc) { send(ws, { type: 'reset_error', error: 'Account not found' }); return; }
      const token = crypto.randomBytes(20).toString('hex');
      acc.resetToken = token;
      acc.resetExpires = Date.now() + 15*60*1000;
      scheduleSave();
      // in real app you'd email; here we return token for demo
      send(ws, { type: 'reset_token', token, username: acc.username });
      break;
    }

    case 'password_reset': {
      const token = String(msg.token || '').trim();
      const newPass = String(msg.password || '');
      if (!token || newPass.length < 3) { send(ws, { type: 'reset_error', error: 'Invalid token or password' }); return; }
      let found = null;
      for (const acc of accounts.values()) if (acc.resetToken === token) found = acc;
      if (!found || !found.resetExpires || found.resetExpires < Date.now()) { send(ws, { type: 'reset_error', error: 'Token expired or invalid' }); return; }
      const { salt, hash } = hashPassword(newPass);
      found.salt = salt; found.hash = hash;
      found.resetToken = null; found.resetExpires = null;
      scheduleSave();
      send(ws, { type: 'reset_ok' });
      break;
    }

    case 'account_delete': {
      const from = ws.userName;
      if (!from) return;
      const accKey = from.toLowerCase();
      // require password confirmation if account exists
      const acc = accounts.get(accKey);
      if (acc) {
        const pw = String(msg.password || '');
        if (!verifyPassword(pw, acc.salt, acc.hash)) { send(ws, { type: 'error', error: 'Incorrect password' }); return; }
      }
      // remove from groups/rooms
      for (const g of groups.values()) {
        g.members = g.members.filter(m => m !== from);
        if (g.admins) g.admins = g.admins.filter(a => a !== from);
      }
      for (const r of rooms.values()) {
        r.members = r.members.filter(m => m !== from);
      }
      accounts.delete(accKey);
      profiles.delete(from);
      // hide messages? keep but mark deletedFor?
      // sessions
      for (const [t,k] of sessions) if (k === accKey) sessions.delete(t);
      if (clients.has(from)) clients.get(from).close();
      lastSeen.delete(from);
      scheduleSave();
      broadcastUsers(); broadcastGroups(); broadcastRooms();
      send(ws, { type: 'account_deleted' });
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

    case 'call_add': {
      const me = ws.userName;
      const call = calls.get(String(msg.callId || ''));
      if (!me || !call || call.ended || !call.joined.includes(me)) return;
      const wanted = (Array.isArray(msg.to) ? msg.to : [msg.to]).map((n) => String(n || '')).slice(0, CALL_MAX_MEMBERS);
      const added = [];
      for (const name of wanted) {
        if (!name || isBot(name)) continue;
        if (!convoParticipants(call.convoId).includes(name)) continue;
        if (call.joined.includes(name) || call.ringing.has(name) || call.declined.has(name)) continue;
        if (!clients.has(name) || isGhost(name) || userInCall(name)) continue;
        if (callMembers(call).size >= CALL_MAX_MEMBERS) break;
        call.ringing.add(name);
        added.push(name);
      }
      if (!added.length) return;
      const kind = call.kind === 'video' ? 'video' : 'voice';
      for (const n of added) {
        sendCall(n, { type: 'call_invite', callId: call.id, convoId: call.convoId, kind, from: me, callees: added });
      }
      for (const n of call.joined) {
        sendCall(n, { type: 'call_peer_ringing', callId: call.id, names: added });
      }
      const batch = [...added];
      setTimeout(() => {
        if (call.ended) return;
        for (const n of batch) {
          if (call.ringing.delete(n)) {
            sendCall(n, { type: 'call_cancelled', callId: call.id, reason: 'timeout' });
          }
        }
      }, CALL_RING_TIMEOUT_MS + 500);
      break;
    }

    case 'register': {
      const username = String(msg.username || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
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
      const account = { username, salt, hash, createdAt: Date.now(), twoFA: null, resetToken: null, resetExpires: null };
      accounts.set(key, account);
      if (!profiles.has(username)) profileFor(username);
      const token = newSessionToken();
      sessions.set(token, key);
      scheduleSave();
      send(ws, { type: 'auth_ok', username, token, isNew: true });
      break;
    }

    case 'login': {
      const username = String(msg.username || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
      const password = String(msg.password || '');
      const otp = String(msg.otp || '').trim();
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
      // 2FA check
      const prof = profiles.get(account.username);
      const twoFA = (prof && prof.twoFA && prof.twoFA.enabled) ? prof.twoFA : account.twoFA;
      if (twoFA && twoFA.enabled) {
        if (!otp) {
          send(ws, { type: 'auth_2fa_required' });
          return;
        }
        if (!verify2FACode(twoFA.secret, otp)) {
          send(ws, { type: 'auth_error', error: 'Invalid 2FA code.' });
          return;
        }
      }
      const token = newSessionToken();
      sessions.set(token, key);
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
        retention: null,
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
        if (inviteCode) {
          const found = [...rooms.values()].find((r) => r.inviteCode === inviteCode);
          if (found) {
            if (!found.members.includes(from)) {
              found.members.push(from);
              scheduleSave();
              broadcastRooms();
              send(ws, { type: 'room_joined', room: { id: found.id, name: found.name, members: found.members, createdBy: found.createdBy, inviteCode: found.inviteCode, createdAt: found.createdAt } });
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
      if (room.members.includes(from)) {
        send(ws, { type: 'room_joined', room: { id: room.id, name: room.name, members: room.members, createdBy: room.createdBy, inviteCode: room.inviteCode, createdAt: room.createdAt } });
        return;
      }
      if (!password || !verifyPassword(password, room.salt, room.hash)) {
        send(ws, { type: 'error', error: 'Incorrect room password.' });
        return;
      }
      room.members.push(from);
      scheduleSave();
      broadcastRooms();
      send(ws, { type: 'room_joined', room: { id: room.id, name: room.name, members: room.members, createdBy: room.createdBy, inviteCode: room.inviteCode, createdAt: room.createdAt } });
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
    res.setHeader('Accept-Ranges', 'bytes');
  },
}));
app.get('/healthz', (_req, res) => res.json({ ok: true, users: clients.size }));
app.get('/sw.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'sw.js')));

// export data
app.get('/api/export/:user', (req, res) => {
  const user = String(req.params.user || '').trim();
  if (!user) return res.status(400).json({ ok: false, error: 'user required' });
  const data = { user, exportedAt: new Date().toISOString(), messages: [], groups: groupsForUser(user), rooms: roomsForUser(user), profile: profiles.get(user) || null };
  for (const [convoId, msgs] of conversations) {
    if (!canAccess(convoId, user) && !msgs.some(m => m.from === user)) continue;
    for (const m of msgs) {
      if (m.from === user || (canAccess(convoId, user) && !(m.deletedFor || []).includes(user))) {
        data.messages.push(m);
      }
    }
  }
  res.json({ ok: true, data });
});
app.get('/api/statuses', (req, res) => {
  res.json({ ok: true, statuses: [...statuses.values()].filter(s => s.expiresAt > Date.now()) });
});
app.get('/api/vapidPublicKey', (_req, res) => {
  res.json({ ok: true, publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' });
});

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

const uploadJson = express.json({ limit: '14mb' });

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

app.post('/api/push/subscribe', uploadJson, (req, res) => {
  const { user, subscription } = req.body || {};
  if (!user || !subscription) return res.status(400).json({ ok: false, error: 'user + subscription required' });
  pushSubs.set(String(user).toLowerCase(), subscription);
  scheduleSave();
  res.json({ ok: true });
});

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
