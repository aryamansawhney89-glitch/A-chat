'use strict';

/* ================================ A-Chat client ================================
   Supports DMs + group chats (convoId routing), photo sharing with captions,
   voice messages with waveform players, and profile pictures.               */

const $ = (id) => document.getElementById(id);

const authScreen = $('authScreen');
const joinScreen = $('joinScreen');
const app = $('app');
const nameInput = $('nameInput');
const joinBtn = $('joinBtn');
const chatListEl = $('chatList');
const connBanner = $('connBanner');
const emptyState = $('emptyState');
const chatView = $('chatView');
const chatAvatar = $('chatAvatar');
const chatTitle = $('chatTitle');
const chatStatus = $('chatStatus');
const messagesEl = $('messages');
const msgInput = $('msgInput');
const sendBtn = $('sendBtn');
const micBtn = $('micBtn');
const emojiBtn = $('emojiBtn');
const attachBtn = $('attachBtn');
const emojiPanel = $('emojiPanel');
const searchInput = $('searchInput');
const themeBtn = $('themeBtn');
const logoutBtn = $('logoutBtn');
const backBtn = $('backBtn');
const newGroupBtn = $('newGroupBtn');
const newRoomBtn = $('newRoomBtn');
const joinRoomBtn = $('joinRoomBtn');
const myAvatarWrap = $('myAvatarWrap');
const toastEl = $('toast');

/* ---------------------------------- state ---------------------------------- */

const state = {
  me: null,
  ws: null,
  connected: false,
  recording: false,
  authenticated: false,
  authToken: null,
  authUsername: null,
  users: [],            // [{name, online, bot, lastSeen, pic, about}]
  groups: new Map(),    // grp::<id> -> group
  rooms: new Map(),     // room::<id> -> room
  chats: new Map(),     // convoId -> {messages: [], unread: 0, lastTs: 0}
  active: null,         // active convoId
  lastDateLabel: null,
};

const AVATAR_COLORS = ['#00a884', '#0088cc', '#8e44ad', '#e67e22', '#e91e63', '#16a085', '#c0392b', '#2c3e50'];
function avatarColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
const initialOf = (name) => (String(name).trim()[0] || '?').toUpperCase();

function applyAvatar(el, name, pic, icon) {
  if (pic) {
    el.style.background = 'var(--panel-header)';
    el.style.backgroundImage = `url("${pic}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.style.background = avatarColor(name);
    el.textContent = icon || initialOf(name);
  }
}

/* ------------------------------- tick (receipt) icons ---------------------- */

const TICK_SINGLE = `<svg viewBox="0 0 16 11" class="tick"><path d="M14.5 1 6 9.5 1.5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const TICK_DOUBLE = `<svg viewBox="0 0 20 11" class="tick"><path d="M11.5 1 4.5 9.5 1.2 6.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.5 1 11.5 9.5 10.2 8.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Ticks aggregate across members: double-blue only when everyone has read.
function tickState(m) {
  if (m.from !== state.me) return null;
  const meta = metaFor(m.convoId);
  const others = meta ? meta.members.filter((n) => n !== state.me) : [];
  if (!others.length) return 'sent';
  if (others.every((n) => (m.readBy || []).includes(n))) return 'read';
  if (others.every((n) => (m.deliveredBy || []).includes(n))) return 'delivered';
  return 'sent';
}

function tickSVG(m) {
  const s = tickState(m);
  if (!s) return '';
  if (s === 'read') return TICK_DOUBLE.replace('class="tick"', 'class="tick read"');
  if (s === 'delivered') return TICK_DOUBLE;
  return TICK_SINGLE;
}

/* ------------------------------ tiny helpers ------------------------------- */

function timeHM(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 864e5);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function listTime(ts) {
  const label = dateLabel(ts);
  return label === 'Today' ? timeHM(ts) : label === 'Yesterday' ? 'Yesterday' : new Date(ts).toLocaleDateString();
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

/* message sounds */
let actx = null;
function pop(freq) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.07, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.14);
    o.connect(g).connect(actx.destination);
    o.start();
    o.stop(actx.currentTime + 0.15);
  } catch { /* audio not available */ }
}

/* ------------------------------ convo helpers ------------------------------ */

const dmConvoId = (a, b) => `dm::${[a, b].sort().join('::')}`;

function metaFor(convoId) {
  if (typeof convoId !== 'string') return null;
  if (convoId.startsWith('dm::')) {
    const [a, b] = convoId.slice(4).split('::').filter(Boolean);
    if (!a || !b) return null;
    const other = a === state.me ? b : a;
    const u = findUser(other);
    return { kind: 'dm', members: [a, b].sort(), title: other, pic: u ? u.pic : null, user: u };
  }
  if (convoId.startsWith('grp::')) {
    const g = state.groups.get(convoId);
    if (!g) return null;
    return { kind: 'group', members: [...g.members], title: g.name, pic: g.pic, group: g };
  }
  if (convoId.startsWith('room::')) {
    const r = state.rooms.get(convoId);
    if (!r) return null;
    return { kind: 'room', members: [...r.members], title: r.name, pic: null, room: r };
  }
  return null;
}

function getChat(convoId) {
  if (!state.chats.has(convoId)) state.chats.set(convoId, { messages: [], unread: 0, lastTs: 0 });
  return state.chats.get(convoId);
}

function findUser(name) {
  return state.users.find((u) => u.name === name);
}

function myPic() {
  const u = state.me && findUser(state.me);
  return u ? u.pic : null;
}

/* ------------------------------ websocket ---------------------------------- */

function wsSend(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}`);
  state.ws.onopen = () => {
    state.connected = true;
    setConnUI();
    // If we already have auth, re-join
    if (state.authenticated && state.authUsername && state.authToken) {
      wsSend({ type: 'join', name: state.authUsername, token: state.authToken });
    }
  };
  state.ws.onmessage = (e) => {
    try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  state.ws.onclose = () => {
    state.connected = false;
    setConnUI();
    setTimeout(connect, 1600); // auto-reconnect
  };
  state.ws.onerror = () => state.ws.close();
}

function setConnUI() {
  const joined = !!state.me;
  connBanner.classList.toggle('hidden', state.connected || !joined);
}

/* ------------------------------ auth flow ---------------------------------- */

const authUsernameInput = $('authUsername');
const authPasswordInput = $('authPassword');
const authSubmitBtn = $('authSubmitBtn');
const authErrorEl = $('authError');
let authMode = 'login'; // 'login' or 'register'

// Tab switching
document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    authMode = tab.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === authMode));
    authSubmitBtn.textContent = authMode === 'login' ? 'Log in' : 'Create account';
    authPasswordInput.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    authErrorEl.classList.add('hidden');
  });
});

authSubmitBtn.addEventListener('click', submitAuth);
authPasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
authUsernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') authPasswordInput.focus(); });

function submitAuth() {
  const username = authUsernameInput.value.trim();
  const password = authPasswordInput.value;
  if (!username || username.length < 2) {
    authErrorEl.textContent = 'Username must be at least 2 characters.';
    authErrorEl.classList.remove('hidden');
    return;
  }
  if (!password || password.length < 3) {
    authErrorEl.textContent = 'Password must be at least 3 characters.';
    authErrorEl.classList.remove('hidden');
    return;
  }
  authErrorEl.classList.add('hidden');
  authSubmitBtn.disabled = true;
  if (authMode === 'register') {
    wsSend({ type: 'register', username, password });
  } else {
    wsSend({ type: 'login', username, password });
  }
  setTimeout(() => { authSubmitBtn.disabled = false; }, 3000);
}

// Check for stored session token on load
const storedToken = localStorage.getItem('achat-token');
const storedName = localStorage.getItem('achat-name');

/* ------------------------------ join flow (legacy/fallback) ---------------------------------- */

joinBtn.addEventListener('click', startJoin);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startJoin(); });

nameInput.value = storedName || '';
nameInput.focus();

function startJoin() {
  const name = nameInput.value.trim();
  if (!name) { toast('Please enter a name'); return; }
  state.me = name;
  localStorage.setItem('achat-name', name);
  if (state.connected) wsSend({ type: 'join', name });
  // otherwise onopen will send it
}

/* --------------------------- server event handler -------------------------- */

function handle(msg) {
  switch (msg.type) {
    case 'auth_ok': {
      state.authenticated = true;
      state.authToken = msg.token;
      state.authUsername = msg.username;
      localStorage.setItem('achat-token', msg.token);
      localStorage.setItem('achat-name', msg.username);
      authScreen.classList.add('hidden');
      // Auto-join with authenticated name
      state.me = msg.username;
      if (state.connected) wsSend({ type: 'join', name: msg.username, token: msg.token });
      break;
    }

    case 'auth_error': {
      const errEl = $('authError');
      errEl.textContent = msg.error || 'Authentication failed';
      errEl.classList.remove('hidden');
      break;
    }

    case 'rooms': {
      state.rooms = new Map((msg.rooms || []).map((r) => [r.id, r]));
      renderChatList();
      updateActiveHeader();
      break;
    }

    case 'room_created': {
      state.rooms.set(msg.room.id, msg.room);
      closeRoomModal();
      showInviteCard(msg.room);
      renderChatList();
      break;
    }

    case 'room_joined': {
      state.rooms.set(msg.room.id, msg.room);
      closeJoinRoomModal();
      toast(`Joined room "${msg.room.name}" 🔒`);
      renderChatList();
      openChat(msg.room.id);
      break;
    }

    case 'room_member_joined': {
      const room = state.rooms.get(msg.roomId);
      if (room && !room.members.includes(msg.member)) {
        room.members.push(msg.member);
      }
      if (state.active === msg.roomId) {
        // Show notice in chat
        const notice = document.createElement('div');
        notice.className = 'room-notice';
        notice.innerHTML = `<span>🔒 ${msg.member} joined the room</span>`;
        messagesEl.appendChild(notice);
        scrollBottom();
        updateActiveHeader();
      }
      break;
    }

    case 'joined': {
      state.me = msg.name;
      state.users = msg.users || [];
      state.groups = new Map((msg.groups || []).map((g) => [g.id, g]));
      state.rooms = new Map((msg.rooms || []).map((r) => [r.id, r]));
      joinScreen.classList.add('hidden');
      app.classList.remove('hidden');
      renderMe();
      renderChatList();
      break;
    }

    case 'users': {
      state.users = msg.users || [];
      renderMe();
      renderChatList();
      updateActiveHeader();
      break;
    }

    case 'groups': {
      state.groups = new Map((msg.groups || []).map((g) => [g.id, g]));
      renderChatList();
      updateActiveHeader();
      break;
    }

    case 'group_created': {
      state.groups.set(msg.group.id, msg.group);
      closeGroupModal();
      toast(`Group "${msg.group.name}" created 🎉`);
      openChat(msg.group.id);
      break;
    }

    case 'profile_saved': {
      renderMe();
      renderChatList();
      toast('Profile picture updated 👤');
      break;
    }

    case 'message': {
      const m = msg.message;
      const chat = getChat(m.convoId);
      const prev = chat.messages[chat.messages.length - 1];
      chat.messages.push(m);
      chat.lastTs = m.ts;
      clearTyping(m.convoId);

      if (m.convoId === state.active && !chatView.classList.contains('hidden')) {
        appendMessage(m, prev);
        maybeScroll(m);
        if (m.from !== state.me && document.hasFocus()) {
          wsSend({ type: 'read', convoId: m.convoId });
        } else if (m.from !== state.me) {
          chat.unread++;
        }
      } else if (m.from !== state.me) {
        chat.unread++;
      }

      if (m.from === state.me) pop(520);
      else if (m.convoId !== state.active || !document.hasFocus()) pop(880);

      renderChatList();
      updateTitleBadge();
      break;
    }

    case 'history': {
      const chat = getChat(msg.convoId);
      chat.messages = msg.messages || [];
      chat.lastTs = chat.messages.length ? chat.messages[chat.messages.length - 1].ts : 0;
      if (state.active === msg.convoId) {
        renderMessages(chat);
        wsSend({ type: 'read', convoId: msg.convoId });
        chat.unread = 0;
        renderChatList();
        updateTitleBadge();
      }
      break;
    }

    case 'status': {
      const chat = getChat(msg.convoId);
      const m = chat.messages.find((x) => x.id === msg.id);
      if (m) {
        if (Array.isArray(msg.deliveredBy)) m.deliveredBy = msg.deliveredBy;
        if (Array.isArray(msg.readBy)) m.readBy = msg.readBy;
        if (state.active === m.convoId) {
          const el = messagesEl.querySelector(`[data-id="${m.id}"] .ticks`);
          if (el) el.innerHTML = tickSVG(m);
        }
        renderChatList();
      }
      break;
    }

    case 'typing': {
      if (msg.convoId === state.active) showTyping(msg.convoId, msg.from, msg.isTyping);
      break;
    }

    case 'error': {
      toast(msg.error || 'Something went wrong');
      groupCreateBtn.disabled = false;
      photoSendBtn.disabled = false;
      break;
    }

    case 'kicked': {
      state.me = null;
      state.active = null;
      toast(msg.reason || 'Signed in elsewhere');
      app.classList.add('hidden');
      joinScreen.classList.remove('hidden');
      break;
    }

    case 'reaction': {
      const chat = getChat(msg.convoId);
      const m = chat.messages.find((x) => x.id === msg.id);
      if (m) {
        m.reactions = msg.reactions || {};
        if (state.active === msg.convoId) {
          renderReactionsOnBubble(m);
        }
        renderChatList();
      }
      break;
    }
  }
}

/* ------------------------------ rendering ---------------------------------- */

function renderMe() {
  $('myName').textContent = state.me;
  applyAvatar($('myAvatar'), state.me, myPic());
}

function listEntries() {
  const entries = [];
  for (const u of state.users) {
    if (u.name === state.me) continue;
    const id = dmConvoId(state.me, u.name);
    entries.push({ id, title: u.name, pic: u.pic, user: u, chat: getChat(id), kind: 'dm' });
  }
  for (const g of state.groups.values()) {
    entries.push({ id: g.id, title: g.name, pic: g.pic, group: g, chat: getChat(g.id), kind: 'group' });
  }
  for (const r of state.rooms.values()) {
    entries.push({ id: r.id, title: r.name, pic: null, room: r, chat: getChat(r.id), kind: 'room' });
  }
  return entries.sort((a, b) => (b.chat.lastTs - a.chat.lastTs) || a.title.localeCompare(b.title));
}

function previewText(m) {
  if (m.kind === 'photo') return '📸 Photo' + (m.text ? `: ${m.text}` : '');
  if (m.kind === 'voice') return '🎙️ Voice message';
  return m.text;
}

function renderChatList() {
  const filter = searchInput.value.trim().toLowerCase();
  chatListEl.innerHTML = '';
  let any = false;

  for (const c of listEntries()) {
    if (filter && !c.title.toLowerCase().includes(filter)) continue;
    any = true;
    const isGroup = !!c.group;
    const isRoom = !!c.room;
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === state.active ? ' active' : '');
    item.addEventListener('click', () => openChat(c.id));

    const av = document.createElement('div');
    av.className = 'avatar';
    applyAvatar(av, c.title, c.pic, isGroup ? '👥' : isRoom ? '🔒' : undefined);

    const body = document.createElement('div');
    body.className = 'ci-body';

    const top = document.createElement('div');
    top.className = 'ci-top';
    const nameEl = document.createElement('span');
    nameEl.className = 'ci-name';
    nameEl.textContent = c.title;
    if (c.user && c.user.bot) {
      const tag = document.createElement('span');
      tag.className = 'bot-tag';
      tag.textContent = 'BOT';
      nameEl.appendChild(tag);
    }
    if (isRoom) {
      const tag = document.createElement('span');
      tag.className = 'bot-tag';
      tag.style.borderColor = '#e67e22';
      tag.style.color = '#e67e22';
      tag.textContent = '🔒';
      nameEl.appendChild(tag);
    }
    const timeEl = document.createElement('span');
    timeEl.className = 'ci-time' + (c.chat.unread ? ' unread' : '');
    if (c.chat.lastTs) timeEl.textContent = listTime(c.chat.lastTs);
    top.append(nameEl, timeEl);

    const bottom = document.createElement('div');
    bottom.className = 'ci-bottom';
    const prev = document.createElement('span');
    prev.className = 'ci-preview';
    const last = c.chat.messages[c.chat.messages.length - 1];
    if (last) {
      if (last.from === state.me) {
        const t = document.createElement('span');
        t.innerHTML = tickSVG(last);
        prev.appendChild(t);
      }
      if (isGroup && last.from !== state.me) {
        const who = document.createElement('span');
        who.className = 'ci-sender';
        who.textContent = `${last.from}: `;
        prev.appendChild(who);
      }
      const txt = document.createElement('span');
      txt.textContent = previewText(last);
      prev.appendChild(txt);
    } else if (isGroup) {
      prev.textContent = `${c.group.members.length} members`;
    } else if (isRoom) {
      prev.textContent = `${c.room.members.length} members • invite: ${c.room.inviteCode}`;
    } else {
      prev.textContent = c.user && c.user.online ? (c.user.bot ? 'bot • online' : 'online') : 'tap to start chatting';
    }
    bottom.appendChild(prev);
    if (c.chat.unread) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = c.chat.unread;
      bottom.appendChild(badge);
    }

    body.append(top, bottom);
    item.append(av, body);
    chatListEl.appendChild(item);
  }

  if (!any) {
    const note = document.createElement('div');
    note.className = 'list-note';
    note.textContent = filter
      ? 'No contacts match your search.'
      : 'No contacts yet — open this page in another tab with a different name to add people.';
    chatListEl.appendChild(note);
  }
}

function openChat(convoId) {
  const meta = metaFor(convoId);
  if (!meta) return;
  state.active = convoId;
  emptyState.classList.add('hidden');
  chatView.classList.remove('hidden');
  document.body.classList.add('chat-open');

  chatTitle.textContent = meta.title;
  applyAvatar(chatAvatar, meta.group ? meta.group.id : meta.title, meta.pic, meta.kind === 'group' ? '👥' : meta.kind === 'room' ? '🔒' : undefined);
  updateActiveHeader();

  const chat = getChat(convoId);
  chat.unread = 0;
  if (chat.messages.length) {
    renderMessages(chat);
    wsSend({ type: 'read', convoId });
  } else {
    messagesEl.innerHTML = '';
    state.lastDateLabel = null;
    typingRowEl = null;
  }
  wsSend({ type: 'history', convoId }); // refresh from server + mark delivered

  renderChatList();
  updateTitleBadge();
  msgInput.focus();
}

function updateActiveHeader() {
  if (!state.active) return;
  const meta = metaFor(state.active);
  if (!meta) return;
  if (meta.kind === 'group') {
    if (chatStatus.dataset.typing === '1') return;
    const others = meta.members.filter((n) => n !== state.me);
    chatStatus.className = 'chat-status';
    chatStatus.textContent = others.length ? others.join(', ') : 'just you';
  } else if (meta.kind === 'room') {
    if (chatStatus.dataset.typing === '1') return;
    const others = meta.members.filter((n) => n !== state.me);
    const onlineCount = others.filter((n) => { const u = findUser(n); return u && u.online; }).length;
    chatStatus.className = 'chat-status';
    chatStatus.textContent = `${meta.members.length} members` + (onlineCount ? ` • ${onlineCount} online` : '') + ` • 🔒 invite: ${meta.room.inviteCode}`;
  } else {
    const u = meta.user;
    if (!u) { chatStatus.textContent = ''; return; }
    if (chatStatus.dataset.typing === '1') return; // don't stomp typing indicator
    chatStatus.className = 'chat-status';
    if (u.online) {
      chatStatus.textContent = 'online';
      chatStatus.classList.add('online');
    } else if (u.lastSeen) {
      chatStatus.textContent = `last seen ${listTime(u.lastSeen)}`;
    } else {
      chatStatus.textContent = 'offline';
    }
  }
}

/* ---- messages pane ---- */

function daySep(label) {
  const sep = document.createElement('div');
  sep.className = 'day-sep';
  const s = document.createElement('span');
  s.textContent = label;
  sep.appendChild(s);
  return sep;
}

const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>';

let currentAudio = null;
let currentVoiceUI = null;
function stopCurrentVoice() {
  if (currentAudio) currentAudio.pause();
  if (currentVoiceUI) currentVoiceUI.reset();
  currentAudio = null;
  currentVoiceUI = null;
}

function buildVoicePlayer(m) {
  const media = m.media || {};
  const wave = Array.isArray(media.wave) && media.wave.length
    ? media.wave
    : Array.from({ length: 40 }, () => 30);
  const totalDur = media.duration || 0;

  const wrap = document.createElement('div');
  wrap.className = 'voice-player';

  const btn = document.createElement('button');
  btn.className = 'voice-btn';
  btn.title = 'Play / pause';
  btn.innerHTML = PLAY_SVG;

  const barsEl = document.createElement('div');
  barsEl.className = 'voice-bars';
  const spans = wave.map((v) => {
    const s = document.createElement('span');
    s.style.height = Math.max(12, Math.min(100, v)) + '%';
    barsEl.appendChild(s);
    return s;
  });

  const timeEl = document.createElement('span');
  timeEl.className = 'voice-time';
  timeEl.textContent = fmtDur(totalDur);

  wrap.append(btn, barsEl, timeEl);

  let audio = null;
  let raf = null;

  const api = {
    reset() {
      btn.innerHTML = PLAY_SVG;
      spans.forEach((s) => s.classList.remove('on'));
      timeEl.textContent = fmtDur(totalDur);
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    },
  };

  function paintProgress() {
    if (!audio) return;
    const dur = audio.duration && isFinite(audio.duration) ? audio.duration : totalDur;
    const p = dur ? Math.min(1, audio.currentTime / dur) : 0;
    const n = Math.round(p * spans.length);
    spans.forEach((s, i) => s.classList.toggle('on', i < n));
    timeEl.textContent = fmtDur(Math.max(0, dur - audio.currentTime));
    if (audio.paused) { raf = null; return; }
    raf = requestAnimationFrame(paintProgress);
  }

  btn.addEventListener('click', () => {
    if (!audio) {
      audio = new Audio(media.url);
      audio.preload = 'metadata';
      audio.addEventListener('ended', () => api.reset());
    }
    if (currentVoiceUI && currentVoiceUI !== api) stopCurrentVoice();
    if (audio.paused) {
      audio.play().then(() => {
        currentAudio = audio;
        currentVoiceUI = api;
        btn.innerHTML = PAUSE_SVG;
        if (!raf) raf = requestAnimationFrame(paintProgress);
      }).catch(() => toast('Could not play this voice message'));
    } else {
      audio.pause();
      btn.innerHTML = PLAY_SVG;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    }
  });

  return wrap;
}

function buildBubble(m, prev) {
  const out = m.from === state.me;
  const meta = metaFor(m.convoId);
  const isGroup = meta && meta.kind === 'group';
  const row = document.createElement('div');
  row.className = 'msg-row ' + (out ? 'out' : 'in');

  const bubble = document.createElement('div');
  const newGroup = !prev || prev.from !== m.from || dateLabel(prev.ts) !== dateLabel(m.ts);
  bubble.className = 'bubble' + (newGroup ? ' tail' : '');

  if (!out && isGroup && newGroup) {
    const sender = document.createElement('span');
    sender.className = 'sender-name';
    sender.textContent = m.from;
    sender.style.color = avatarColor(m.from);
    bubble.appendChild(sender);
  }

  if (m.kind === 'photo' && m.media) {
    bubble.classList.add('photo-bubble');
    const img = document.createElement('img');
    img.className = 'photo-img';
    img.src = m.media.url;
    img.alt = m.media.name || 'Photo';
    img.addEventListener('click', () => openLightbox(m.media.url));
    bubble.appendChild(img);
  }

  if (m.kind === 'voice' && m.media) {
    bubble.classList.add('voice-bubble');
    bubble.appendChild(buildVoicePlayer(m));
  }

  const metaEl = document.createElement('span');
  metaEl.className = 'meta';
  metaEl.dataset.id = m.id;
  const t = document.createElement('span');
  t.textContent = timeHM(m.ts);
  metaEl.appendChild(t);
  if (out) {
    const ticks = document.createElement('span');
    ticks.className = 'ticks';
    ticks.innerHTML = tickSVG(m);
    metaEl.appendChild(ticks);
  }

  if (m.text) {
    if (m.kind === 'photo') {
      // caption under the photo, time floats right of the caption line
      const capWrap = document.createElement('span');
      capWrap.className = 'caption-wrap';
      capWrap.appendChild(metaEl);
      const cap = document.createElement('span');
      cap.className = 'caption';
      cap.textContent = m.text;
      capWrap.appendChild(cap);
      bubble.appendChild(capWrap);
    } else {
      const text = document.createElement('span');
      text.textContent = m.text;
      bubble.appendChild(text);
      bubble.appendChild(metaEl);
    }
  } else {
    bubble.appendChild(metaEl);
    if (m.kind === 'photo') {
      bubble.classList.add('no-caption');
      metaEl.classList.add('overlay');
    }
  }

  // Wrapper to stack bubble + reactions vertically
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap';
  wrap.appendChild(bubble);

  const reactionsEl = document.createElement('div');
  reactionsEl.className = 'reactions-row';
  wrap.appendChild(reactionsEl);
  renderReactionsInEl(m, reactionsEl);

  row.appendChild(wrap);
  row.dataset.msgId = m.id;

  // Long-press / right-click to open reaction picker
  let pressTimer = null;
  const openPicker = (e) => {
    if (e) e.preventDefault();
    openReactionPicker(m, reactionsEl);
  };
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openPicker(e); });
  row.addEventListener('pointerdown', () => {
    pressTimer = setTimeout(openPicker, 500);
  });
  row.addEventListener('pointerup', () => clearTimeout(pressTimer));
  row.addEventListener('pointerleave', () => clearTimeout(pressTimer));

  return row;
}

/* ---- reactions ---- */

const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

function renderReactionsInEl(m, container) {
  const reactions = m.reactions || {};
  const keys = Object.keys(reactions).filter((k) => reactions[k] && reactions[k].length);
  container.innerHTML = '';
  for (const emoji of keys) {
    const users = reactions[emoji];
    const chip = document.createElement('button');
    chip.className = 'reaction-chip';
    if (users.includes(state.me)) chip.classList.add('mine');
    chip.innerHTML = `<span class="reaction-emoji">${emoji}</span><span class="reaction-count">${users.length}</span>`;
    chip.title = users.join(', ');
    chip.addEventListener('click', () => {
      const add = !users.includes(state.me);
      wsSend({ type: 'react', convoId: m.convoId, id: m.id, emoji, add });
    });
    container.appendChild(chip);
  }
  // add "+" button to add more reactions
  const addBtn = document.createElement('button');
  addBtn.className = 'reaction-add';
  addBtn.innerHTML = '+';
  addBtn.title = 'Add reaction';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openReactionPicker(m, container);
  });
  container.appendChild(addBtn);
}

function renderReactionsOnBubble(m) {
  const row = messagesEl.querySelector(`[data-msg-id="${m.id}"]`);
  if (!row) return;
  const container = row.querySelector('.reactions-row');
  if (container) renderReactionsInEl(m, container);
}

let reactionPickerEl = null;
function openReactionPicker(m, anchorEl) {
  closeReactionPicker();
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  picker.id = 'reactionPicker';
  for (const emoji of QUICK_REACTIONS) {
    const btn = document.createElement('button');
    btn.className = 'reaction-pick';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      wsSend({ type: 'react', convoId: m.convoId, id: m.id, emoji, add: true });
      closeReactionPicker();
    });
    picker.appendChild(btn);
  }
  // Add a "more" button that opens a larger grid
  const moreBtn = document.createElement('button');
  moreBtn.className = 'reaction-pick reaction-more-pick';
  moreBtn.textContent = '⋯';
  moreBtn.title = 'More reactions';
  moreBtn.addEventListener('click', () => {
    picker.innerHTML = '';
    const ALL_REACTIONS = ['❤️','👍','😂','😮','😢','🙏','🔥','🎉','😍','👎','💯','🤣','😡','🥺','✨','👏','🤝','💪','🫶','💔'];
    for (const emoji of ALL_REACTIONS) {
      const btn = document.createElement('button');
      btn.className = 'reaction-pick';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        wsSend({ type: 'react', convoId: m.convoId, id: m.id, emoji, add: true });
        closeReactionPicker();
      });
      picker.appendChild(btn);
    }
    const backBtn = document.createElement('button');
    backBtn.className = 'reaction-pick reaction-back';
    backBtn.textContent = '←';
    backBtn.addEventListener('click', () => {
      picker.innerHTML = '';
      for (const e of QUICK_REACTIONS) {
        const b = document.createElement('button');
        b.className = 'reaction-pick';
        b.textContent = e;
        b.addEventListener('click', () => {
          wsSend({ type: 'react', convoId: m.convoId, id: m.id, emoji: e, add: true });
          closeReactionPicker();
        });
        picker.appendChild(b);
      }
      const mb = document.createElement('button');
      mb.className = 'reaction-pick reaction-more-pick';
      mb.textContent = '⋯';
      mb.addEventListener('click', moreBtn.click.bind(moreBtn));
      picker.appendChild(mb);
    });
    picker.appendChild(backBtn);
  });
  picker.appendChild(moreBtn);

  document.body.appendChild(picker);
  reactionPickerEl = picker;

  // Position near the message row
  const rect = anchorEl.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  picker.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';

  // Close on outside click
  setTimeout(() => {
    const closer = (e) => {
      if (!picker.contains(e.target)) {
        closeReactionPicker();
        document.removeEventListener('pointerdown', closer);
      }
    };
    document.addEventListener('pointerdown', closer);
  }, 50);
}

function closeReactionPicker() {
  if (reactionPickerEl && reactionPickerEl.parentNode) {
    reactionPickerEl.parentNode.removeChild(reactionPickerEl);
  }
  reactionPickerEl = null;
}

function renderMessages(chat) {
  messagesEl.innerHTML = '';
  typingRowEl = null;
  state.lastDateLabel = null;
  let prev = null;
  for (const m of chat.messages) {
    const label = dateLabel(m.ts);
    if (label !== state.lastDateLabel) {
      messagesEl.appendChild(daySep(label));
      state.lastDateLabel = label;
    }
    messagesEl.appendChild(buildBubble(m, prev));
    prev = m;
  }
  scrollBottom(true);
}

function appendMessage(m, prev) {
  const label = dateLabel(m.ts);
  if (label !== state.lastDateLabel) {
    messagesEl.appendChild(daySep(label));
    state.lastDateLabel = label;
    prev = null; // tail after separator
  }
  removeTypingRow();
  messagesEl.appendChild(buildBubble(m, prev));
}

function scrollBottom(force) {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function maybeScroll(m) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;
  if (m.from === state.me || nearBottom) scrollBottom();
}

/* ---- typing indicator ---- */

let typingRowEl = null;
let typingTimer = null;

function showTyping(convoId, from, isTyping) {
  if (isTyping) {
    const meta = metaFor(convoId);
    const isGroup = meta && meta.kind === 'group';
    chatStatus.textContent = isGroup ? `${from} is typing…` : 'typing…';
    chatStatus.className = 'chat-status typing';
    chatStatus.dataset.typing = '1';
    if (!typingRowEl) {
      typingRowEl = document.createElement('div');
      typingRowEl.className = 'msg-row in';
      typingRowEl.innerHTML = '<div class="bubble typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    }
    removeTypingRow();
    messagesEl.appendChild(typingRowEl);
    scrollBottom();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => clearTyping(convoId), 5000); // safety
  } else {
    clearTyping(convoId);
  }
}

function removeTypingRow() {
  if (typingRowEl && typingRowEl.parentNode) typingRowEl.parentNode.removeChild(typingRowEl);
}

function clearTyping(convoId) {
  clearTimeout(typingTimer);
  removeTypingRow();
  if (convoId === state.active) {
    delete chatStatus.dataset.typing;
    updateActiveHeader();
  }
}

/* ------------------------------ composer ----------------------------------- */

function autoResize() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
  const hasText = msgInput.value.trim().length > 0;
  sendBtn.classList.toggle('hidden', !hasText);
  micBtn.classList.toggle('hidden', hasText);
}

function sendMessage() {
  const text = msgInput.value.replace(/\s+$/, '');
  if (!text.trim() || !state.active) return;
  wsSend({ type: 'message', convoId: state.active, kind: 'text', text });
  msgInput.value = '';
  autoResize();
  sendTyping(false);
  msgInput.focus();
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('input', () => { autoResize(); sendTyping(true); });
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

/* typing notifications (throttled) */
let lastTypingSent = 0;
let typingStopTimer = null;
function sendTyping(isTyping) {
  if (!state.active) return;
  const now = Date.now();
  if (isTyping) {
    if (now - lastTypingSent > 1800) {
      wsSend({ type: 'typing', convoId: state.active, isTyping: true });
      lastTypingSent = now;
    }
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(() => wsSend({ type: 'typing', convoId: state.active, isTyping: false }), 1800);
  } else {
    clearTimeout(typingStopTimer);
    wsSend({ type: 'typing', convoId: state.active, isTyping: false });
  }
}

/* ------------------------------ uploads (shared) --------------------------- */

async function uploadDataUrl(dataUrl, name) {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, name }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || 'Upload failed');
  return j.url;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(blob);
  });
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}

// Client-side resize via canvas (max dimension), JPEG output.
async function resizeImage(file, maxDim, quality = 0.85) {
  const objUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageEl(objUrl);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

/* ------------------------------ photo sharing ------------------------------ */

const photoInput = $('photoInput');
const photoModal = $('photoModal');
const photoPreview = $('photoPreview');
const photoCaption = $('photoCaption');
const photoCancelBtn = $('photoCancelBtn');
const photoSendBtn = $('photoSendBtn');
const photoCloseBtn = $('photoCloseBtn');
const lightbox = $('lightbox');
const lightboxImg = $('lightboxImg');

let pendingPhoto = null; // {dataUrl, name, w, h}

attachBtn.addEventListener('click', () => {
  if (!state.active) return;
  photoInput.click();
});

photoInput.addEventListener('change', async () => {
  const file = photoInput.files && photoInput.files[0];
  photoInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please choose an image'); return; }
  try {
    const dataUrl = await resizeImage(file, 1280, 0.85);
    const img = await loadImageEl(dataUrl);
    pendingPhoto = { dataUrl, name: file.name || 'photo.jpg', w: img.naturalWidth, h: img.naturalHeight };
    photoPreview.src = dataUrl;
    photoCaption.value = '';
    photoModal.classList.remove('hidden');
    photoCaption.focus();
  } catch (err) {
    toast(err.message || 'Could not read that image');
  }
});

function closePhotoModal() {
  photoModal.classList.add('hidden');
  pendingPhoto = null;
  photoSendBtn.disabled = false;
}

photoCancelBtn.addEventListener('click', closePhotoModal);
photoCloseBtn.addEventListener('click', closePhotoModal);

photoSendBtn.addEventListener('click', async () => {
  if (!pendingPhoto || !state.active) return;
  const caption = photoCaption.value.trim();
  photoSendBtn.disabled = true;
  try {
    const url = await uploadDataUrl(pendingPhoto.dataUrl, pendingPhoto.name);
    wsSend({
      type: 'message',
      convoId: state.active,
      kind: 'photo',
      text: caption,
      media: { url, w: pendingPhoto.w, h: pendingPhoto.h, name: pendingPhoto.name },
    });
    closePhotoModal();
  } catch (err) {
    toast(err.message || 'Upload failed');
    photoSendBtn.disabled = false;
  }
});

function openLightbox(url) {
  lightboxImg.src = url;
  lightbox.classList.remove('hidden');
}
lightbox.addEventListener('click', () => {
  lightbox.classList.add('hidden');
  lightboxImg.src = '';
});

/* ------------------------------ voice messages ----------------------------- */

const recordingBar = $('recordingBar');
const composerBar = $('composerBar');
const recTimeEl = $('recTime');
const recCancelBtn = $('recCancelBtn');
const recSendBtn = $('recSendBtn');

const rec = { recorder: null, stream: null, chunks: [], cancelled: false, started: 0, timer: null, mime: '' };

function pickRecMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const mt of candidates) {
    try { if (MediaRecorder.isTypeSupported(mt)) return mt; } catch { /* keep trying */ }
  }
  return '';
}

function mimeExt(mime) {
  if (!mime) return '.webm';
  if (mime.includes('mp4') || mime.includes('aac') || mime.includes('m4a')) return '.m4a';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('wav')) return '.wav';
  return '.webm';
}

async function startRecording() {
  if (state.recording || !state.active) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('Voice messages are not supported in this browser');
    return;
  }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Microphone permission denied');
    return;
  }
  rec.mime = pickRecMime();
  try {
    rec.recorder = rec.mime ? new MediaRecorder(rec.stream, { mimeType: rec.mime }) : new MediaRecorder(rec.stream);
  } catch {
    rec.recorder = new MediaRecorder(rec.stream);
    rec.mime = rec.recorder.mimeType || '';
  }
  rec.chunks = [];
  rec.cancelled = false;
  rec.started = Date.now();
  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = onRecStop;
  rec.recorder.start(250);
  state.recording = true;
  composerBar.classList.add('hidden');
  recordingBar.classList.remove('hidden');
  recTimeEl.textContent = '0:00';
  clearInterval(rec.timer);
  rec.timer = setInterval(() => {
    recTimeEl.textContent = fmtDur((Date.now() - rec.started) / 1000);
  }, 200);
}

function stopRecording(sendIt) {
  if (!state.recording) return;
  rec.cancelled = !sendIt;
  clearInterval(rec.timer);
  try {
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  } catch { /* already stopped */ }
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  state.recording = false;
  recordingBar.classList.add('hidden');
  composerBar.classList.remove('hidden');
}

// 40 RMS bars from the decoded audio, normalised 0-100.
async function computeWave(blob) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    const N = 40;
    const block = Math.max(1, Math.floor(data.length / N));
    const raw = [];
    let max = 0;
    for (let i = 0; i < N; i++) {
      let sum = 0;
      const start = i * block;
      for (let j = 0; j < block; j++) {
        const v = data[start + j] || 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / block);
      raw.push(rms);
      max = Math.max(max, rms);
    }
    const wave = raw.map((v) => Math.max(6, Math.round((v / (max || 1)) * 100)));
    return { wave, duration: buf.duration || (Date.now() - rec.started) / 1000 };
  } finally {
    if (ac.close) ac.close().catch(() => {});
  }
}

async function onRecStop() {
  const blob = new Blob(rec.chunks, { type: rec.mime || (rec.recorder && rec.recorder.mimeType) || 'audio/webm' });
  rec.chunks = [];
  if (rec.cancelled) return;
  if (blob.size < 800) { toast('Recording too short'); return; }
  let wave, duration;
  try {
    ({ wave, duration } = await computeWave(blob));
  } catch {
    wave = Array.from({ length: 40 }, () => 30);
    duration = (Date.now() - rec.started) / 1000;
  }
  try {
    const url = await uploadDataUrl(await blobToDataUrl(blob), `voice-note${mimeExt(blob.type)}`);
    if (!state.active) return;
    wsSend({
      type: 'message',
      convoId: state.active,
      kind: 'voice',
      text: '',
      media: { url, duration: Math.round(duration * 10) / 10, wave },
    });
  } catch (err) {
    toast(err.message || 'Upload failed');
  }
}

micBtn.addEventListener('click', startRecording);
recCancelBtn.addEventListener('click', () => stopRecording(false));
recSendBtn.addEventListener('click', () => stopRecording(true));

/* ------------------------------ profile picture ---------------------------- */

const avatarInput = $('avatarInput');

myAvatarWrap.addEventListener('click', () => avatarInput.click());
avatarInput.addEventListener('change', async () => {
  const file = avatarInput.files && avatarInput.files[0];
  avatarInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please choose an image'); return; }
  try {
    const dataUrl = await resizeImage(file, 256, 0.85);
    const url = await uploadDataUrl(dataUrl, 'profile-pic.jpg');
    wsSend({ type: 'profile_set', pic: url });
  } catch (err) {
    toast(err.message || 'Upload failed');
  }
});

/* ------------------------------ new group modal ---------------------------- */

const groupModal = $('groupModal');
const groupCloseBtn = $('groupCloseBtn');
const groupCancelBtn = $('groupCancelBtn');
const groupCreateBtn = $('groupCreateBtn');
const groupNameInput = $('groupNameInput');
const groupMembersEl = $('groupMembers');
const groupPicWrap = $('groupPicWrap');
const groupPicIcon = $('groupPicIcon');
const groupPicInput = $('groupPicInput');

let groupPicDraft = null; // resized dataURL, uploaded on create

newGroupBtn.addEventListener('click', openGroupModal);
groupCloseBtn.addEventListener('click', closeGroupModal);
groupCancelBtn.addEventListener('click', closeGroupModal);

function openGroupModal() {
  groupNameInput.value = '';
  groupPicDraft = null;
  groupPicWrap.style.backgroundImage = '';
  groupPicWrap.style.background = 'var(--accent-dark)';
  groupPicIcon.classList.remove('hidden');
  groupCreateBtn.disabled = false;

  groupMembersEl.innerHTML = '';
  for (const u of state.users) {
    if (u.name === state.me) continue;
    const row = document.createElement('label');
    row.className = 'gm-member';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = u.name;

    const av = document.createElement('div');
    av.className = 'avatar';
    applyAvatar(av, u.name, u.pic);

    const nameEl = document.createElement('span');
    nameEl.textContent = u.name;
    if (u.bot) {
      const tag = document.createElement('span');
      tag.className = 'bot-tag';
      tag.textContent = 'BOT';
      nameEl.appendChild(tag);
    }

    const status = document.createElement('span');
    status.className = 'gm-status';
    status.textContent = u.online ? 'online' : 'offline';

    row.append(cb, av, nameEl, status);
    groupMembersEl.appendChild(row);
  }
  groupModal.classList.remove('hidden');
  groupNameInput.focus();
}

function closeGroupModal() {
  groupModal.classList.add('hidden');
  groupPicDraft = null;
  groupCreateBtn.disabled = false;
}

groupPicWrap.addEventListener('click', () => groupPicInput.click());
groupPicInput.addEventListener('change', async () => {
  const file = groupPicInput.files && groupPicInput.files[0];
  groupPicInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please choose an image'); return; }
  try {
    groupPicDraft = await resizeImage(file, 256, 0.85);
    groupPicWrap.style.backgroundImage = `url("${groupPicDraft}")`;
    groupPicIcon.classList.add('hidden');
  } catch (err) {
    toast(err.message || 'Could not read that image');
  }
});

groupCreateBtn.addEventListener('click', async () => {
  const name = groupNameInput.value.trim();
  if (!name) { toast('Please enter a group name'); groupNameInput.focus(); return; }
  const members = [...groupMembersEl.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
  if (!members.length) { toast('Add at least one member'); return; }
  groupCreateBtn.disabled = true;
  try {
    let pic = null;
    if (groupPicDraft) pic = await uploadDataUrl(groupPicDraft, 'group-pic.jpg');
    wsSend({ type: 'group_create', name, members, pic });
    // modal closes when the server echoes group_created
    setTimeout(() => { groupCreateBtn.disabled = false; }, 3000);
  } catch (err) {
    toast(err.message || 'Upload failed');
    groupCreateBtn.disabled = false;
  }
});

/* ------------------------------ emoji panel -------------------------------- */

const EMOJIS = ['😀','😂','🤣','😊','😍','😘','😎','🤔','😅','😭','😡','🥺','😴','🤯','😇','🙃','😉','🤗','🤫','🤭','👍','👎','👌','✌️','🙏','👏','🙌','🤝','💪','🫶','❤️','💔','💯','🔥','✨','🎉','🎂','🎁','🎧','🎵','🎶','⚽','🏆','🌙','☀️','🌈','⭐','🍕'];

for (const emo of EMOJIS) {
  const b = document.createElement('button');
  b.textContent = emo;
  b.addEventListener('click', () => {
    const start = msgInput.selectionStart || msgInput.value.length;
    msgInput.value = msgInput.value.slice(0, start) + emo + msgInput.value.slice(msgInput.selectionEnd || start);
    autoResize();
    msgInput.focus();
    msgInput.selectionStart = msgInput.selectionEnd = start + emo.length;
  });
  emojiPanel.appendChild(b);
}

emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPanel.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!emojiPanel.contains(e.target)) emojiPanel.classList.add('hidden');
});

/* ------------------------------ sidebar ------------------------------------ */

searchInput.addEventListener('input', renderChatList);

themeBtn.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('achat-theme', dark ? 'dark' : 'light');
  themeBtn.textContent = dark ? '☀️' : '🌙';
});
document.documentElement.dataset.theme = localStorage.getItem('achat-theme') || 'light';
themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙';

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('achat-name');
  location.reload();
});

backBtn.addEventListener('click', () => document.body.classList.remove('chat-open'));

/* ------------------------------ misc --------------------------------------- */

function updateTitleBadge() {
  let total = 0;
  for (const chat of state.chats.values()) total += chat.unread;
  document.title = total ? `(${total}) A-Chat` : 'A-Chat';
}

window.addEventListener('focus', () => {
  if (state.active) {
    const chat = getChat(state.active);
    if (chat.unread) {
      chat.unread = 0;
      renderChatList();
      updateTitleBadge();
    }
    wsSend({ type: 'read', convoId: state.active });
  }
});

/* ------------------------------ room modals ------------------------------ */

const roomModal = $('roomModal');
const roomCloseBtn = $('roomCloseBtn');
const roomCancelBtn = $('roomCancelBtn');
const roomCreateBtn = $('roomCreateBtn');
const roomNameInput = $('roomNameInput');
const roomPasswordInput = $('roomPasswordInput');

const joinRoomModal = $('joinRoomModal');
const joinRoomCloseBtn = $('joinRoomCloseBtn');
const joinRoomCancelBtn = $('joinRoomCancelBtn');
const joinRoomSubmitBtn = $('joinRoomSubmitBtn');
const joinRoomCodeInput = $('joinRoomCodeInput');
const joinRoomPasswordInput = $('joinRoomPasswordInput');
const joinRoomErrorEl = $('joinRoomError');

const roomInviteModal = $('roomInviteModal');
const inviteCloseBtn = $('inviteCloseBtn');
const inviteDoneBtn = $('inviteDoneBtn');
const inviteCodeDisplay = $('inviteCodeDisplay');
const inviteRoomName = $('inviteRoomName');
const copyInviteBtn = $('copyInviteBtn');

newRoomBtn.addEventListener('click', openRoomModal);
roomCloseBtn.addEventListener('click', closeRoomModal);
roomCancelBtn.addEventListener('click', closeRoomModal);

function openRoomModal() {
  roomNameInput.value = '';
  roomPasswordInput.value = '';
  roomCreateBtn.disabled = false;
  roomModal.classList.remove('hidden');
  roomNameInput.focus();
}

function closeRoomModal() {
  roomModal.classList.add('hidden');
  roomCreateBtn.disabled = false;
}

roomCreateBtn.addEventListener('click', () => {
  const name = roomNameInput.value.trim();
  const password = roomPasswordInput.value;
  if (!name) { toast('Please enter a room name'); roomNameInput.focus(); return; }
  if (!password || password.length < 3) { toast('Password must be at least 3 characters'); roomPasswordInput.focus(); return; }
  roomCreateBtn.disabled = true;
  wsSend({ type: 'room_create', name, password });
  setTimeout(() => { roomCreateBtn.disabled = false; }, 3000);
});

// Join room
joinRoomBtn.addEventListener('click', openJoinRoomModal);
joinRoomCloseBtn.addEventListener('click', closeJoinRoomModal);
joinRoomCancelBtn.addEventListener('click', closeJoinRoomModal);

function openJoinRoomModal() {
  joinRoomCodeInput.value = '';
  joinRoomPasswordInput.value = '';
  joinRoomErrorEl.classList.add('hidden');
  joinRoomSubmitBtn.disabled = false;
  joinRoomModal.classList.remove('hidden');
  joinRoomCodeInput.focus();
}

function closeJoinRoomModal() {
  joinRoomModal.classList.add('hidden');
  joinRoomSubmitBtn.disabled = false;
}

joinRoomSubmitBtn.addEventListener('click', () => {
  const code = joinRoomCodeInput.value.trim().toUpperCase();
  const password = joinRoomPasswordInput.value;
  if (!code && !password) {
    joinRoomErrorEl.textContent = 'Enter an invite code or room password.';
    joinRoomErrorEl.classList.remove('hidden');
    return;
  }
  joinRoomErrorEl.classList.add('hidden');
  joinRoomSubmitBtn.disabled = true;
  // If we have a code, try joining by code first
  if (code) {
    wsSend({ type: 'room_join', roomId: '', inviteCode: code, password: '' });
  } else {
    // Need to find room by password — send all rooms we know about
    // Actually the server needs a roomId. Let's send password and let server match.
    // For simplicity, we'll try joining each known room with this password.
    // Better: send a special "join by password" request.
    // For now, iterate through known rooms
    let found = false;
    for (const r of state.rooms.values()) {
      if (r.members.includes(state.me)) continue;
      wsSend({ type: 'room_join', roomId: r.id, password, inviteCode: '' });
      found = true;
      break;
    }
    if (!found) {
      joinRoomErrorEl.textContent = 'No rooms available. Ask for an invite code.';
      joinRoomErrorEl.classList.remove('hidden');
      joinRoomSubmitBtn.disabled = false;
    }
  }
  setTimeout(() => { joinRoomSubmitBtn.disabled = false; }, 3000);
});

// Invite card
function showInviteCard(room) {
  inviteRoomName.textContent = room.name;
  inviteCodeDisplay.textContent = room.inviteCode;
  roomInviteModal.classList.remove('hidden');
}

function closeInviteModal() {
  roomInviteModal.classList.add('hidden');
}
inviteCloseBtn.addEventListener('click', closeInviteModal);
inviteDoneBtn.addEventListener('click', closeInviteModal);

copyInviteBtn.addEventListener('click', async () => {
  const code = inviteCodeDisplay.textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('Invite code copied! 📋');
  } catch {
    // Fallback: select the text
    const range = document.createRange();
    range.selectNode(inviteCodeDisplay);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    toast('Select and copy the code above');
  }
});

/* ------------------------------ escape key updates ------------------------------ */

// Update existing escape handler
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!lightbox.classList.contains('hidden')) {
      lightbox.classList.add('hidden');
      lightboxImg.src = '';
    }
    closePhotoModal();
    closeGroupModal();
    closeRoomModal();
    closeJoinRoomModal();
    closeInviteModal();
    closeReactionPicker();
  }
});

/* ------------------------------ initial screen ------------------------------ */

// Show auth screen by default (unless we have a stored token)
if (storedToken && storedName) {
  authScreen.classList.add('hidden');
  // Will auto-auth via connect() onopen
} else {
  authScreen.classList.remove('hidden');
  authUsernameInput.value = storedName || '';
  authUsernameInput.focus();
}

connect();
