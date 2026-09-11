'use strict';

/* ================================ A-Chat client ================================
   Supports DMs + group chats (convoId routing), photo sharing with captions,
   voice messages with waveform players, profile pictures, and voice/video
   calls over WebRTC (signalling relayed by the server).                     */

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
  incoming: null,
  authenticated: false,
  authToken: null,
  authUsername: null,
  users: [],
  groups: new Map(),
  rooms: new Map(),
  chats: new Map(),
  active: null,
  replyTo: null,
  editing: null,
  lastDateLabel: null,
  privacy: { readReceipts: true, lastSeen: true, typing: true, ghost: false },
  // new features
  pinnedChats: [],
  wallpaper: null,
  disappearing: new Map(), // convoId -> seconds
  statuses: [], // [{id,from,text,media,ts,expiresAt,views}]
  filter: 'all', // all | unread | mentions | pinned | starred
  forwardMsg: null, // message to forward
  starredCache: new Map(), // convoId -> Set(ids)
  notifEnabled: false,
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
    if (actx.state === 'suspended') actx.resume().catch(() => {});
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

// Read receipts: skipped entirely when Ghost Mode or the read-receipt toggle is
// off. The server enforces the same rule; this just avoids pointless traffic.
function sendRead(convoId) {
  if (state.privacy.ghost || !state.privacy.readReceipts) return;
  wsSend({ type: 'read', convoId });
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
    // a dead socket kills any in-flight call signalling
    if (activeCall.id || state.incoming) teardownCall();
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
      if (window._pendingRetention && window._pendingRetention>0) {
        wsSend({ type:'retention_set', convoId: msg.room.id, days: window._pendingRetention });
        window._pendingRetention=null;
      }
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
      if (msg.privacy && typeof msg.privacy === 'object') {
        state.privacy = { ...state.privacy, ...msg.privacy };
      }
      if (Array.isArray(msg.pinnedChats)) state.pinnedChats = msg.pinnedChats;
      if (msg.wallpaper) { state.wallpaper = msg.wallpaper; applyWallpaper(msg.wallpaper); }
      if (msg.statuses) { state.statuses = msg.statuses; renderStatuses(); }
      if (msg.disappearing) { state.disappearing = new Map(Object.entries(msg.disappearing)); }
      joinScreen.classList.add('hidden');
      app.classList.remove('hidden');
      renderMe();
      syncPrivacyUI();
      renderChatList();
      renderStatuses();
      updateDisappearingUI();
      // request notification permission status
      if ('Notification' in window && Notification.permission==='granted') state.notifEnabled=true;
      break;
    }

    case 'privacy_saved': {
      if (msg.privacy && typeof msg.privacy === 'object') {
        state.privacy = { ...state.privacy, ...msg.privacy };
      }
      syncPrivacyUI();
      break;
    }
    case 'pinned_update': {
      state.pinnedChats = msg.pinnedChats || [];
      renderChatList();
      break;
    }
    case 'disappearing_all': {
      state.disappearing = new Map(Object.entries(msg.timers || {}));
      updateDisappearingUI();
      break;
    }
    case 'disappearing_update': {
      if (msg.seconds) state.disappearing.set(msg.convoId, msg.seconds);
      else state.disappearing.delete(msg.convoId);
      updateDisappearingUI();
      break;
    }
    case 'message_deleted_for_me': {
      const chat = getChat(msg.convoId);
      const m = chat.messages.find(x=>x.id===msg.id);
      if (m) { if(!m.deletedFor) m.deletedFor=[]; if(!m.deletedFor.includes(state.me)) m.deletedFor.push(state.me); }
      if (state.active===msg.convoId) renderMessages(chat);
      renderChatList();
      break;
    }
    case 'chat_cleared': {
      const chat = getChat(msg.convoId);
      chat.messages = [];
      chat.unread = 0;
      if (state.active===msg.convoId) renderMessages(chat);
      renderChatList();
      break;
    }
    case 'message_starred': {
      const chat = getChat(msg.convoId);
      const m = chat.messages.find(x=>x.id===msg.id);
      if (m) m.starredBy = msg.starredBy || [];
      if (state.active===msg.convoId) {
        const row = messagesEl.querySelector(`[data-msg-id="${msg.id}"]`);
        if (row) { const cb = row.querySelector('.star-indicator'); if(cb) cb.textContent = (m.starredBy||[]).includes(state.me) ? '⭐' : ''; }
      }
      break;
    }
    case 'statuses': {
      state.statuses = msg.statuses || [];
      renderStatuses();
      break;
    }
    case 'status_created': {
      state.statuses.push(msg.status);
      renderStatuses();
      break;
    }
    case 'status_viewed': {
      const s = state.statuses.find(x=>x.id===msg.statusId);
      if (s) s.views = msg.views;
      break;
    }
    case 'poll_update': {
      const chat = getChat(msg.convoId);
      const m = chat.messages.find(x=>x.id===msg.id);
      if (m) { m.media = msg.media; patchMessageInDom(chat,m); }
      break;
    }
    case 'mention': {
      // highlight mention
      const chat = getChat(msg.convoId);
      chat.unread = (chat.unread||0)+1;
      renderChatList();
      toast(`💬 ${msg.from} mentioned you`);
      // per-chat mention indicator via preview
      if (Notification && Notification.permission==='granted' && document.hidden) {
        try { new Notification(`@${msg.from} mentioned you`, { body: 'in '+msg.convoId, icon: '/avatars/aria.svg' }); } catch {}
      }
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
        if (msg.reactor && msg.reactor!==state.me) toast(`${msg.reactor} reacted with ${msg.emoji}`);
      }
      break;
    }
    case 'read_state': {
      // per-chat read state updated
      break;
    }
    case 'wallpaper_saved': {
      state.wallpaper = msg.wallpaper;
      applyWallpaper(state.wallpaper);
      break;
    }
    case '2fa_secret': {
      $('twoFASecret').textContent = msg.secret;
      $('twoFAStatus').textContent = 'Scan or copy secret, then verify';
      $('twoFASecretWrap').classList.remove('hidden');
      break;
    }
    case '2fa_enabled': {
      $('twoFAStatus').textContent = '✅ 2FA enabled';
      $('twoFASecretWrap').classList.add('hidden');
      $('enable2FABtn').classList.add('hidden');
      $('disable2FABtn').classList.remove('hidden');
      toast('2FA enabled 🔐');
      break;
    }
    case '2fa_disabled': {
      $('twoFAStatus').textContent = '2FA disabled';
      $('enable2FABtn').classList.remove('hidden');
      $('disable2FABtn').classList.add('hidden');
      break;
    }
    case '2fa_error': {
      toast(msg.error || '2FA error');
      break;
    }
    case 'push_subscribed': {
      state.notifEnabled = true;
      toast('🔔 Notifications enabled');
      break;
    }
    case 'push_unsubscribed': {
      state.notifEnabled = false;
      toast('Notifications disabled');
      break;
    }
    case 'reset_token': {
      $('resetTokenDisplay').textContent = 'Token: '+msg.token+' (demo: copy it)';
      $('resetTokenDisplay').classList.remove('hidden');
      $('resetTokenInput').classList.remove('hidden');
      $('resetNewPw').classList.remove('hidden');
      $('doResetBtn').classList.remove('hidden');
      $('resetTokenInput').value = msg.token;
      break;
    }
    case 'reset_ok': {
      toast('Password reset! Now log in');
      $('resetTokenDisplay').classList.add('hidden');
      break;
    }
    case 'reset_error': {
      toast(msg.error || 'Reset failed');
      break;
    }
    case 'auth_2fa_required': {
      $('authOtp').classList.remove('hidden');
      $('authError').textContent = '2FA code required';
      $('authError').classList.remove('hidden');
      break;
    }
    case 'search_results': {
      renderSearchResults(msg.query, msg.results || []);
      break;
    }
    case 'account_deleted': {
      toast('Account deleted');
      localStorage.clear();
      location.reload();
      break;
    }

    case 'users': {
      state.users = msg.users || [];
      renderMe();
      renderChatList();
      updateActiveHeader();
      updateCallBtn(); // bot DMs have no 📞
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
          sendRead(m.convoId);
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
        sendRead(msg.convoId);
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

    /* ---- voice/video call signalling ---- */

    case 'call_created': {
      // server accepted our invite and is ringing the other side
      if (!activeCall.convoId) break;
      activeCall.id = msg.callId;
      if (msg.kind === 'video' || msg.kind === 'voice') activeCall.kind = msg.kind;
      activeCall.ringing = new Set(msg.callees || []);
      activeCall.declined = new Set();
      activeCall.status = 'calling';
      setCallStatus('Ringing…');
      break;
    }

    case 'call_invite': {
      if (activeCall.id || activeCall.status !== 'idle' || state.incoming) {
        wsSend({ type: 'call_reject', callId: msg.callId }); // busy
        break;
      }
      if (msg.from === state.me) break;
      state.incoming = {
        callId: msg.callId, convoId: msg.convoId, from: msg.from, callees: msg.callees || [],
        kind: msg.kind === 'video' ? 'video' : 'voice',
      };
      showIncoming(state.incoming);
      startRing();
      break;
    }

    case 'call_join': {
      if (!activeCall.id || activeCall.id !== msg.callId) break;
      if (msg.name) { activeCall.ringing.delete(msg.name); activeCall.declined.delete(msg.name); }
      if (msg.isYou) {
        // we just got in; everyone already there sends us an offer
        activeCall.status = 'connected';
        if (!activeCall.startedAt) { activeCall.startedAt = Date.now(); startCallTimer(); }
        setCallStatus('Connected');
        for (const n of (msg.peers || [])) if (n !== state.me) ensurePeer(n);
      } else {
        // a new participant joined — we joined first, so we send the offer
        if (activeCall.status !== 'connected') {
          activeCall.status = 'connected';
          if (!activeCall.startedAt) { activeCall.startedAt = Date.now(); startCallTimer(); }
          setCallStatus('Connected');
        }
        if (msg.offerTo && msg.offerTo !== state.me) offerToPeer(msg.offerTo);
      }
      renderCallPeers();
      break;
    }

    case 'call_signal': {
      onCallSignal(msg);
      break;
    }

    case 'call_peer_left': {
      if (!activeCall.id || activeCall.id !== msg.callId) break;
      activeCall.ringing.delete(msg.name);
      onCallPeerLeft(msg.name);
      break;
    }

    case 'call_declined': {
      activeCall.ringing.delete(msg.from);
      activeCall.declined.add(msg.from);
      if (activeCall.convoId || state.incoming) toast(`${msg.from} declined the call`);
      break;
    }

    case 'call_peer_ringing': {
      // someone on the call pulled more people in — show who is being rung
      if (!activeCall.id || activeCall.id !== msg.callId) break;
      const names = (msg.names || []).filter(Boolean);
      for (const n of names) activeCall.ringing.add(n);
      if (names.length) {
        toast(`Ringing ${names.join(', ')}…`);
        setCallStatus(`Ringing ${names.join(', ')}…`);
      }
      break;
    }

    case 'call_cancelled': {
      if (state.incoming && state.incoming.callId === msg.callId) {
        state.incoming = null;
        hideIncoming();
        stopRing();
      }
      break;
    }

    case 'call_failed': {
      const meta = activeCall.convoId ? metaFor(activeCall.convoId) : null;
      const who = meta ? meta.title : 'They';
      const why = msg.reason === 'offline' ? `${who} is offline`
        : msg.reason === 'busy' ? `${who} is on another call`
        : msg.reason === 'nobody' ? 'Nobody in this chat can take a call'
        : 'Call failed';
      teardownCall();
      toast(why);
      break;
    }

    case 'call_error': {
      teardownCall();
      toast(msg.error || 'Call failed');
      break;
    }

    case 'call_ended': {
      const mine = activeCall.id === msg.callId;
      const ringing = state.incoming && state.incoming.callId === msg.callId;
      if (!mine && !ringing) break;
      const duration = Number(msg.duration) || 0;
      const wasVideo = activeCall.kind === 'video'
        || (state.incoming && state.incoming.kind === 'video')
        || msg.kind === 'video';
      teardownCall();
      const word = wasVideo ? 'Video call' : 'Call';
      const label = msg.reason === 'timeout' ? 'No answer'
        : msg.reason === 'declined' ? `${word} declined`
        : msg.reason === 'cancelled' ? `${word} cancelled`
        : `${word} ended`;
      toast(duration > 0 ? `${label} · ${fmtDur(duration)}` : label);
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

        case 'message_edited': {
      const chat = getChat(msg.convoId);
      const m = chat.messages.find((x) => x.id === msg.id);
      if (m) {
        m.text = String(msg.text || '');
        m.editedAt = Number.isFinite(msg.editedAt) ? msg.editedAt : Date.now();
        patchMessageInDom(chat, m);
        renderChatList();
      }
      break;
    }

    case 'message_deleted': {
      const chat = getChat(msg.convoId);
      const m = chat.messages.find((x) => x.id === msg.id);
      if (m) {
        m.deleted = true;
        m.text = '';
        m.media = null;
        m.reactions = {};
        m.replyTo = null;
        patchMessageInDom(chat, m);
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
  // pinned sorting + keep unread pinned first
  const pinnedSet = new Set(state.pinnedChats || []);
  return entries.sort((a, b) => {
    const aPinned = pinnedSet.has(a.id) ? 0 : 1;
    const bPinned = pinnedSet.has(b.id) ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;
    return (b.chat.lastTs - a.chat.lastTs) || a.title.localeCompare(b.title);
  });
}
function hasMention(convoId) {
  const chat = getChat(convoId);
  return chat.messages.some(m => (m.mentions||[]).includes(state.me) && !(m.readBy||[]).includes(state.me));
}
function hasStarred(convoId) {
  const chat = getChat(convoId);
  return chat.messages.some(m => (m.starredBy||[]).includes(state.me));
}


function previewText(m) {
  if (m.deleted) return '🚫 This message was deleted';
  if (m.forwarded) return '↗️ Forwarded: ' + (m.text || previewText({...m, forwarded:false}) );
  if (m.kind === 'photo') return '📸 Photo' + (m.text ? `: ${m.text}` : '');
  if (m.kind === 'voice') return '🎙️ Voice message';
  if (m.kind === 'sticker') return '🎭 Sticker';
  if (m.kind === 'gif') return '🎞️ GIF';
  if (m.kind === 'poll') return '📊 Poll: ' + (m.media && m.media.question || '');
  if (m.kind === 'call') return callPreview(m);
  // per-chat read state indicator hint
  let p = m.text;
  if ((m.starredBy||[]).includes(state.me)) p = '⭐ '+p;
  if (m.expiresAt) p = '⏳ '+p;
  return p;
}

// "📞 Voice call · 1:23" / "🎥 Video call · 0:42" / "❌ Missed video call" —
// also used by the sidebar preview. Entries logged before video calls
// existed carry no callKind and render as voice calls.
function callParts(m) {
  const media = m.media || {};
  const status = media.status || 'completed';
  const callKind = media.callKind === 'video' ? 'video' : 'voice';
  const Kind = callKind === 'video' ? 'Video call' : 'Voice call';
  const missed = status !== 'completed';
  const dur = Number(media.duration) || 0;
  const icon = status === 'declined' ? '📵' : missed ? '❌' : (callKind === 'video' ? '🎥' : '📞');
  const label = status === 'declined' ? `Declined ${callKind} call`
    : status === 'cancelled' ? `Cancelled ${callKind} call`
    : missed ? `Missed ${callKind} call` : Kind;
  return { icon, label, dur, missed };
}

function callPreview(m) {
  const p = callParts(m);
  return `${p.icon} ${p.label}` + (p.dur > 0 ? ` · ${fmtDur(p.dur)}` : '');
}

function renderChatList() {
  const filter = searchInput.value.trim().toLowerCase();
  const chipFilter = state.filter || 'all';
  chatListEl.innerHTML = '';
  let any = false;

  for (const c of listEntries()) {
    if (filter && !c.title.toLowerCase().includes(filter) && !previewText(c.chat.messages[c.chat.messages.length-1]||{text:''}).toLowerCase().includes(filter)) continue;
    if (chipFilter==='unread' && !c.chat.unread) continue;
    if (chipFilter==='mentions' && !hasMention(c.id)) continue;
    if (chipFilter==='pinned' && !(state.pinnedChats||[]).includes(c.id)) continue;
    if (chipFilter==='starred' && !hasStarred(c.id)) continue;
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
    if ((state.pinnedChats||[]).includes(c.id)) {
      const pin = document.createElement('span');
      pin.textContent = ' 📌';
      pin.style.fontSize='11px';
      nameEl.appendChild(pin);
    }
    if (hasMention(c.id)) {
      const mt = document.createElement('span');
      mt.className = 'bot-tag';
      mt.style.borderColor = '#e91e63';
      mt.style.color = '#e91e63';
      mt.textContent = '@';
      nameEl.appendChild(mt);
    }
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
  cancelMessageAction(false); // a reply/edit draft belongs to its own chat
  state.active = convoId;
  emptyState.classList.add('hidden');
  chatView.classList.remove('hidden');
  document.body.classList.add('chat-open');

  chatTitle.textContent = meta.title;
  applyAvatar(chatAvatar, meta.group ? meta.group.id : meta.title, meta.pic, meta.kind === 'group' ? '👥' : meta.kind === 'room' ? '🔒' : undefined);
  updateActiveHeader();
  updateCallBtn();

  const chat = getChat(convoId);
  chat.unread = 0;
  if (chat.messages.length) {
    renderMessages(chat);
    sendRead(convoId);
  } else {
    messagesEl.innerHTML = '';
    state.lastDateLabel = null;
    typingRowEl = null;
  }
  wsSend({ type: 'history', convoId }); // refresh from server + mark delivered

  renderChatList();
  updateTitleBadge();
  updateDisappearingUI();
  msgInput.focus();
}

function updateActiveHeader() {
  if (!state.active) return;
  const meta = metaFor(state.active);
  if (!meta) return;
  chatHeaderEl.classList.toggle('infoable', meta.kind !== 'dm'); // title/avatar opens group/room info
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

/* ---- message actions: replies, edits, deletes ---- */

// One-line summary used by quote blocks and the composer reply bar. Accepts
// both live messages (call info in .media) and the server's replyTo snapshot
// (kind/callKind/status at the top level).
function quoteSnippet(q) {
  if (!q || q.deleted) return '🚫 This message was deleted';
  const kind = q.kind || 'text';
  const callKind = q.callKind || (q.media && q.media.callKind) || 'voice';
  const status = q.status || (q.media && q.media.status) || 'completed';
  if (kind === 'photo') return '📸 Photo' + (q.text ? `: ${q.text}` : '');
  if (kind === 'voice') return '🎙️ Voice message';
  if (kind === 'call') {
    if (status !== 'completed') return `❌ ${status[0].toUpperCase()}${status.slice(1)} ${callKind} call`;
    return `${callKind === 'video' ? '🎥' : '📞'} ${callKind === 'video' ? 'Video call' : 'Voice call'}`;
  }
  return q.text || '';
}

// Quoted-original block at the top of a reply bubble; clicking it jumps to
// the original message (if it is still rendered) and flashes it.
function buildQuoteEl(m) {
  const q = m.replyTo;
  const el = document.createElement('div');
  el.className = 'reply-quote' + (q.deleted ? ' deleted' : '');
  const nameEl = document.createElement('span');
  nameEl.className = 'rq-name';
  nameEl.textContent = q.from === state.me ? 'You' : q.from;
  nameEl.style.color = avatarColor(q.from);
  const textEl = document.createElement('span');
  textEl.className = 'rq-text';
  textEl.textContent = quoteSnippet(q);
  el.append(nameEl, textEl);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = messagesEl.querySelector(`[data-msg-id="${q.id}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth; // restart the animation
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1300);
  });
  return el;
}

// Timestamp (+ "edited" tag, + read-receipt ticks for our own messages).
function buildMetaEl(m, out) {
  const metaEl = document.createElement('span');
  metaEl.className = 'meta';
  metaEl.dataset.id = m.id;
  if (m.editedAt && !m.deleted) {
    const ed = document.createElement('span');
    ed.className = 'edited-tag';
    ed.textContent = 'edited';
    metaEl.appendChild(ed);
  }
  const t = document.createElement('span');
  t.textContent = timeHM(m.ts);
  metaEl.appendChild(t);
  if (out) {
    const ticks = document.createElement('span');
    ticks.className = 'ticks';
    ticks.innerHTML = tickSVG(m);
    metaEl.appendChild(ticks);
  }
  return metaEl;
}

// Rebuild a single bubble in place after an edit or delete. Passing the
// previous message keeps the tail/sender-name grouping consistent.
function patchMessageInDom(chat, m) {
  if (state.active !== m.convoId || chatView.classList.contains('hidden')) return;
  const row = messagesEl.querySelector(`[data-msg-id="${m.id}"]`);
  if (!row) return;
  const idx = chat.messages.findIndex((x) => x.id === m.id);
  const prev = idx > 0 ? chat.messages[idx - 1] : null;
  row.replaceWith(buildBubble(m, prev));
}

// WhatsApp-style horizontal swipe on a bubble starts a reply to it.
function attachSwipeReply(row, m) {
  let startX = 0, startY = 0, tracking = false, fired = false;
  row.addEventListener('pointerdown', (e) => {
    startX = e.clientX; startY = e.clientY; tracking = true; fired = false;
  });
  row.addEventListener('pointermove', (e) => {
    if (!tracking || fired) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dx > 60 && Math.abs(dy) < 40) {
      fired = true; tracking = false;
      row.classList.add('swiped');
      setTimeout(() => row.classList.remove('swiped'), 350);
      startReply(m);
    }
  });
  const stop = () => { tracking = false; };
  row.addEventListener('pointerup', stop);
  row.addEventListener('pointercancel', stop);
  row.addEventListener('pointerleave', stop);
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

  // Deleted messages render as a tombstone — no media, quote, reactions or actions
  if (m.deleted) {
    bubble.classList.add('deleted');
    const del = document.createElement('span');
    del.className = 'deleted-text';
    del.textContent = '🚫 This message was deleted';
    bubble.appendChild(del);
    bubble.appendChild(buildMetaEl(m, out));
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap';
    wrap.appendChild(bubble);
    row.appendChild(wrap);
    row.dataset.msgId = m.id;
    return row;
  }

  if (m.replyTo) bubble.appendChild(buildQuoteEl(m));

  if (m.forwarded) {
    const fwdLabel = document.createElement('div');
    fwdLabel.className = 'forward-label';
    fwdLabel.textContent = '↗️ Forwarded' + (m.forwardedFrom ? ' from '+m.forwardedFrom : '');
    bubble.appendChild(fwdLabel);
  }
  if ((m.kind === 'photo' || m.kind === 'sticker' || m.kind === 'gif') && m.media) {
    bubble.classList.add('photo-bubble');
    const img = document.createElement('img');
    img.className = m.kind==='sticker' ? 'sticker-img' : 'photo-img';
    img.src = m.media.url;
    img.alt = m.media.name || m.kind;
    img.addEventListener('click', () => openLightbox(m.media.url));
    bubble.appendChild(img);
  }
  if (m.kind === 'sticker' && !m.media && m.text) {
    const st = document.createElement('div');
    st.className = 'sticker-text';
    st.textContent = m.text;
    st.style.fontSize = '48px';
    st.style.lineHeight = '1';
    bubble.appendChild(st);
  }

  if (m.kind === 'voice' && m.media) {
    bubble.classList.add('voice-bubble');
    bubble.appendChild(buildVoicePlayer(m));
  }
  if (m.kind === 'poll' && m.media) {
    bubble.appendChild(buildPollEl(m));
  }

  if (m.kind === 'call') {
    const parts = callParts(m);
    bubble.classList.add('call-bubble');
    const line = document.createElement('span');
    line.className = 'call-line ' + (parts.missed ? 'missed' : 'ok');
    const ico = document.createElement('span');
    ico.className = 'call-ico';
    ico.textContent = parts.icon;
    const label = document.createElement('span');
    label.className = 'call-label';
    label.textContent = parts.label;
    line.append(ico, label);
    if (parts.dur > 0) {
      const dur = document.createElement('span');
      dur.className = 'call-dur';
      dur.textContent = fmtDur(parts.dur);
      line.appendChild(dur);
    }
    bubble.appendChild(line);
  }

  const metaEl = buildMetaEl(m, out);

  // highlight @mentions
  if (m.text && m.text.includes('@')) {
    // will be handled in text rendering below via innerHTML with highlight
  }
  if (m.text) {
    if (m.kind === 'sticker' && !m.media) {
      // already rendered sticker text big, just add meta
      bubble.appendChild(metaEl);
    } else if (m.kind === 'photo' || m.kind === 'sticker' || m.kind === 'gif') {
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
      // highlight mentions
      if (m.text.includes('@'+state.me)) {
        text.innerHTML = m.text.replace(new RegExp('@'+state.me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<b style="color:var(--accent)">@'+state.me+'</b>');
      } else {
        text.textContent = m.text;
      }
      // starred indicator
      if ((m.starredBy||[]).includes(state.me)) {
        const star = document.createElement('span');
        star.className = 'star-indicator';
        star.textContent = ' ⭐';
        star.style.fontSize='12px';
        text.appendChild(star);
      }
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

  // Long-press / right-click opens the action picker — reactions plus
  // reply / edit / delete (call log entries get swipe-to-reply only)
  if (m.kind !== 'call') {
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
  }

  // swipe right to reply (works on touch, pen and mouse)
  attachSwipeReply(row, m);

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
  picker.className = 'reaction-picker has-actions';
  picker.id = 'reactionPicker';

  // Row 1: quick reactions (with a "more" grid, unchanged behaviour)
  const emojiRow = document.createElement('div');
  emojiRow.className = 'picker-emoji-row';

  const addEmoji = (emoji) => {
    const btn = document.createElement('button');
    btn.className = 'reaction-pick';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      wsSend({ type: 'react', convoId: m.convoId, id: m.id, emoji, add: true });
      closeReactionPicker();
    });
    emojiRow.appendChild(btn);
  };

  const showQuick = () => {
    emojiRow.innerHTML = '';
    for (const emoji of QUICK_REACTIONS) addEmoji(emoji);
    const moreBtn = document.createElement('button');
    moreBtn.className = 'reaction-pick reaction-more-pick';
    moreBtn.textContent = '⋯';
    moreBtn.title = 'More reactions';
    moreBtn.addEventListener('click', showAll);
    emojiRow.appendChild(moreBtn);
  };

  const showAll = () => {
    emojiRow.innerHTML = '';
    const ALL_REACTIONS = ['❤️','👍','😂','😮','😢','🙏','🔥','🎉','😍','👎','💯','🤣','😡','🥺','✨','👏','🤝','💪','🫶','💔'];
    for (const emoji of ALL_REACTIONS) addEmoji(emoji);
    const backBtn = document.createElement('button');
    backBtn.className = 'reaction-pick reaction-back';
    backBtn.textContent = '←';
    backBtn.addEventListener('click', showQuick);
    emojiRow.appendChild(backBtn);
  };

  showQuick();
  picker.appendChild(emojiRow);

  // Row 2: message actions — reply for everyone, edit/delete for your own
  const actions = document.createElement('div');
  actions.className = 'picker-actions';
  const addAction = (icon, label, fn) => {
    const btn = document.createElement('button');
    btn.className = 'picker-action';
    btn.title = label;
    const ico = document.createElement('span');
    ico.className = 'pa-icon';
    ico.textContent = icon;
    const txt = document.createElement('span');
    txt.textContent = label;
    btn.append(ico, txt);
    btn.addEventListener('click', () => { closeReactionPicker(); fn(); });
    actions.appendChild(btn);
  };
  addAction('↩️', 'Reply', () => startReply(m));
  addAction('↗️', 'Forward', () => openForwardPicker(m));
  addAction((m.starredBy||[]).includes(state.me) ? '⭐' : '☆', (m.starredBy||[]).includes(state.me) ? 'Unstar' : 'Star', () => toggleStar(m));
  if (m.from === state.me && (m.kind === 'text' || m.kind === 'photo' || m.kind === 'poll')) addAction('✏️', 'Edit', () => startEdit(m));
  if (m.from === state.me) addAction('🗑️', 'Delete', () => deleteMessage(m));
  if (m.from === state.me) addAction('🗑️', 'Delete for me', () => deleteForMe(m));
  else addAction('🗑️', 'Delete for me', () => deleteForMe(m));
  if (m.editHistory && m.editHistory.length) addAction('🕓', 'History', () => showEditHistory(m));
  // reacted with text handled via toast in reaction handler
  picker.appendChild(actions);

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

/* ---- reply / edit composer bar ---- */

const replyBar = $('replyBar');
const replyBarTitle = $('replyBarTitle');
const replyBarText = $('replyBarText');
const replyBarClose = $('replyBarClose');

function cancelMessageAction(clearInput) {
  const wasEditing = !!state.editing;
  state.replyTo = null;
  state.editing = null;
  replyBar.classList.add('hidden');
  if (clearInput || wasEditing) { msgInput.value = ''; autoResize(); }
}

function startReply(m) {
  state.editing = null;
  state.replyTo = m;
  replyBarTitle.textContent = `Reply to ${m.from === state.me ? 'yourself' : m.from}`;
  replyBarTitle.style.color = avatarColor(m.from);
  replyBarText.textContent = quoteSnippet(m.deleted ? { deleted: true } : m);
  replyBar.classList.remove('hidden');
  msgInput.focus();
}

function startEdit(m) {
  state.replyTo = null;
  state.editing = { convoId: m.convoId, id: m.id };
  replyBarTitle.textContent = 'Edit message';
  replyBarTitle.style.color = '';
  replyBarText.textContent = m.text;
  replyBar.classList.remove('hidden');
  msgInput.value = m.text;
  autoResize();
  msgInput.focus();
  msgInput.selectionStart = msgInput.selectionEnd = msgInput.value.length; // caret to end
}

function deleteMessage(m) {
  if (!window.confirm('Delete this message for everyone?')) return;
  wsSend({ type: 'delete', convoId: m.convoId, id: m.id });
}

replyBarClose.addEventListener('click', () => { cancelMessageAction(false); msgInput.focus(); });

function sendMessage() {
  const text = msgInput.value.replace(/\s+$/, '');
  if (!text.trim() || !state.active) return;
  if (state.editing) {
    // save an edit instead of sending a new message
    if (state.editing.convoId === state.active) {
      wsSend({ type: 'edit', convoId: state.editing.convoId, id: state.editing.id, text });
    }
  } else {
    const payload = { type: 'message', convoId: state.active, kind: 'text', text };
    if (state.replyTo && state.replyTo.convoId === state.active && !state.replyTo.deleted) {
      payload.replyTo = state.replyTo.id;
    }
    wsSend(payload);
  }
  cancelMessageAction(false);
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
  if (state.privacy.ghost || !state.privacy.typing) return; // privacy: no typing leaks
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

// MediaRecorder mime types can carry codec parameters ("audio/webm;codecs=opus",
// "audio/mp4;codecs=mp4a.40.2"). FileReader copies them verbatim into the data
// URL, so strip them — the server keys its whitelist off the bare type.
const baseMime = (t) => String(t || '').split(';')[0].trim().toLowerCase();

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
  const recMime = baseMime(rec.mime || (rec.recorder && rec.recorder.mimeType)) || 'audio/webm';
  const blob = new Blob(rec.chunks, { type: recMime });
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
    toast(err.message || 'Voice message upload failed');
  }
}

micBtn.addEventListener('click', startRecording);
recCancelBtn.addEventListener('click', () => stopRecording(false));
recSendBtn.addEventListener('click', () => stopRecording(true));

/* --------------------------- voice & video calls -----------------------------
   Peer-to-peer WebRTC audio (+ camera video on video calls). The server
   (server.js) only relays SDP/ICE signalling between participants of the same
   conversation, so no media ever touches it. Group calls use a small mesh (one
   RTCPeerConnection per peer); whoever joined the call first creates the offer
   for whoever joined later. */

const callBtn = $('callBtn');
const videoCallBtn = $('videoCallBtn');
const incomingCallModal = $('incomingCallModal');
const incomingKindEl = $('incomingKind');
const incomingAvatarEl = $('incomingAvatar');
const incomingNameEl = $('incomingName');
const incomingStateEl = $('incomingState');
const acceptCallBtn = $('acceptCallBtn');
const declineCallBtn = $('declineCallBtn');
const callOverlay = $('callOverlay');
const callCardEl = $('callCard');
const callKindEl = $('callKind');
const callAvatarEl = $('callAvatar');
const callNameEl = $('callName');
const callStateEl = $('callState');
const callVideoGrid = $('callVideoGrid');
const callTimerEl = $('callTimer');
const callPeersEl = $('callPeers');
const muteBtn = $('muteBtn');
const cameraBtn = $('cameraBtn');
const endCallBtn = $('endCallBtn');
const speakerBtn = $('speakerBtn');
const addToCallBtn = $('addToCallBtn');
const addToCallModal = $('addToCallModal');
const addToCallMembers = $('addToCallMembers');
const addToCallCloseBtn = $('addToCallCloseBtn');
const addToCallCancelBtn = $('addToCallCancelBtn');
const addToCallSubmitBtn = $('addToCallSubmitBtn');

// STUN only — media flows straight between browsers. Peers behind symmetric
// NATs (no TURN server here) may fail to connect; the UI says so.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

const activeCall = {
  id: null,
  convoId: null,
  kind: 'voice',       // 'voice' | 'video'
  direction: null,     // 'in' | 'out'
  status: 'idle',      // 'idle' | 'dialling' | 'calling' | 'connecting' | 'connected'
  startedAt: 0,
  timer: null,
  peers: new Map(),    // name -> {pc, audio, tile, pending[]}
  ringing: new Set(),  // names we know are being rung right now (caller side)
  declined: new Set(), // names that declined this call
  localStream: null,
  localTile: null,
  muted: false,
  cameraOff: false,
  speaker: false,
  sinkId: null,
};

// Video wants a modest 640x480 — enough for a chat tile, light on the mesh.
async function getCallStream(wantVideo) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(`${wantVideo ? 'Video' : 'Voice'} calls need a browser with camera and microphone support`);
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: wantVideo ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false,
  });
}

function callIdentity(convoId) {
  const meta = metaFor(convoId);
  if (!meta) return { title: 'Voice call', pic: null, key: 'call', group: false };
  return { title: meta.title, pic: meta.pic, key: meta.group ? meta.group.id : meta.title, group: meta.kind !== 'dm' };
}

/* ---- peer connections ---- */

function ensurePeer(name) {
  if (activeCall.peers.has(name)) return activeCall.peers.get(name);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = { pc, audio: null, tile: null, pending: [] };
  activeCall.peers.set(name, peer);

  if (activeCall.localStream) {
    // every local track — audio always, plus camera on video calls
    for (const t of activeCall.localStream.getTracks()) pc.addTrack(t, activeCall.localStream);
  }
  pc.onicecandidate = (e) => {
    if (!e.candidate || !activeCall.id) return;
    wsSend({
      type: 'call_signal',
      callId: activeCall.id,
      to: name,
      candidate: {
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      },
    });
  };
  pc.ontrack = (e) => attachRemoteStream(name, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => {
    if (!activeCall.id) return;
    if (pc.connectionState === 'failed') setCallStatus('Connection lost — reconnecting…', true);
    else if (pc.connectionState === 'connected' && activeCall.status === 'connected') setCallStatus('Connected');
  };
  renderCallPeers();
  return peer;
}

function attachRemoteStream(name, stream) {
  const peer = activeCall.peers.get(name);
  if (!peer) return;
  if (activeCall.kind === 'video') {
    // The tile's <video> plays the peer's audio too, so it doubles as the
    // sound sink (volume / speaker routing below just works).
    const tile = ensureVideoTile(name, false);
    peer.tile = tile;
    const video = tile.querySelector('video');
    video.srcObject = stream;
    peer.audio = video;
    updateTileAvatar(tile, stream.getVideoTracks().length > 0);
  } else if (!peer.audio) {
    const el = document.createElement('audio');
    el.className = 'remote-audio';
    el.autoplay = true;
    el.playsInline = true;
    document.body.appendChild(el);
    peer.audio = el;
    peer.audio.srcObject = stream;
  } else {
    peer.audio.srcObject = stream;
  }
  peer.audio.volume = activeCall.speaker ? 1 : 0.9;
  applySpeakerSink();
  const p = peer.audio.play();
  if (p && p.catch) p.catch(() => { /* autoplay blocked — user can tap the bubble */ });
}

async function offerToPeer(name) {
  const peer = ensurePeer(name);
  try {
    const offer = await peer.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: activeCall.kind === 'video',
    });
    await peer.pc.setLocalDescription(offer);
    wsSend({ type: 'call_signal', callId: activeCall.id, to: name, sdp: peer.pc.localDescription });
  } catch (err) {
    console.error('createOffer failed', err);
  }
}

async function onCallSignal(msg) {
  if (!activeCall.id || activeCall.id !== msg.callId) return;
  const peer = ensurePeer(msg.from);
  try {
    if (msg.sdp) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      for (const c of peer.pending.splice(0)) {
        try { await peer.pc.addIceCandidate(c); } catch { /* stale candidate */ }
      }
      if (msg.sdp.type === 'offer') {
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        wsSend({ type: 'call_signal', callId: activeCall.id, to: msg.from, sdp: peer.pc.localDescription });
      }
    } else if (msg.candidate) {
      const c = new RTCIceCandidate(msg.candidate);
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(c).catch(() => {});
      else peer.pending.push(c); // SDP has not arrived yet — queue it
    }
  } catch (err) {
    console.error('call signal failed', err);
  }
}

function dropPeer(name) {
  const peer = activeCall.peers.get(name);
  if (!peer) return;
  try { peer.pc.close(); } catch { /* already closed */ }
  if (peer.tile) {
    // a video tile owns its <video> element — remove the whole tile
    const video = peer.tile.querySelector('video');
    if (video) video.srcObject = null;
    peer.tile.remove();
    peer.tile = null;
    peer.audio = null;
  } else if (peer.audio) {
    peer.audio.srcObject = null;
    peer.audio.remove();
    peer.audio = null;
  }
  activeCall.peers.delete(name);
  renderCallPeers();
}

/* ---- video tiles ---- */

function makeVideoTile(name, isLocal) {
  const tile = document.createElement('div');
  tile.className = 'call-video-tile' + (isLocal ? ' local' : '');
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) {
    video.muted = true; // never feed our own camera audio back to us
    video.setAttribute('aria-label', 'Your camera preview');
  }
  const avatar = document.createElement('div');
  avatar.className = 'call-video-avatar hidden';
  avatar.textContent = initialOf(isLocal ? (state.me || '?') : name);
  avatar.style.background = avatarColor(isLocal ? (state.me || '?') : name);
  const label = document.createElement('span');
  label.className = 'call-video-label';
  label.textContent = isLocal ? 'You' : name;
  tile.append(video, avatar, label);
  return tile;
}

// Reuse a peer's existing tile when ontrack fires again (renegotiation etc.).
function ensureVideoTile(name, isLocal) {
  if (isLocal && activeCall.localTile && activeCall.localTile.isConnected) return activeCall.localTile;
  if (!isLocal) {
    const peer = activeCall.peers.get(name);
    if (peer && peer.tile && peer.tile.isConnected) return peer.tile;
  }
  const tile = makeVideoTile(name, isLocal);
  callVideoGrid.appendChild(tile);
  if (isLocal) activeCall.localTile = tile;
  else {
    const peer = activeCall.peers.get(name);
    if (peer) peer.tile = tile;
  }
  return tile;
}

function updateTileAvatar(tile, hasVideo) {
  const avatar = tile.querySelector('.call-video-avatar');
  const video = tile.querySelector('video');
  tile.classList.toggle('camera-off', !hasVideo);
  if (avatar) avatar.classList.toggle('hidden', hasVideo);
  if (video) video.classList.toggle('hidden', !hasVideo);
}

// Our own preview follows the camera toggle.
function updateLocalTile() {
  if (!activeCall.localTile) return;
  const tracks = activeCall.localStream ? activeCall.localStream.getVideoTracks() : [];
  updateTileAvatar(activeCall.localTile, tracks.length > 0 && !activeCall.cameraOff);
}

function clearVideoGrid() {
  callVideoGrid.innerHTML = '';
  activeCall.localTile = null;
}

/* ---- overlay + timer ---- */

function showCallOverlay() {
  const id = callIdentity(activeCall.convoId);
  const isVideo = activeCall.kind === 'video';
  const kindWord = isVideo ? 'Video call' : 'Voice call';
  callKindEl.textContent = activeCall.direction === 'out' ? `Outgoing ${callKindWord()}` : kindWord;
  applyAvatar(callAvatarEl, id.key, id.pic, id.group ? '👥' : undefined);
  callNameEl.textContent = id.title;
  callTimerEl.textContent = '0:00';
  callTimerEl.classList.add('hidden');
  callCardEl.classList.toggle('video', isVideo);
  callVideoGrid.classList.toggle('hidden', !isVideo);
  cameraBtn.classList.toggle('hidden', !isVideo);
  if (isVideo && activeCall.localStream) {
    const tile = ensureVideoTile(state.me, true);
    const preview = tile.querySelector('video');
    preview.srcObject = activeCall.localStream;
    updateLocalTile();
    const p = preview.play();
    if (p && p.catch) p.catch(() => { /* preview will start on user gesture */ });
  }
  callOverlay.classList.remove('hidden');
  updateMuteBtn();
  updateCameraBtn();
  updateSpeakerBtn();
  updateAddToCallBtn();
  renderCallPeers();
}

// The 👤+ button only makes sense for group/room calls (in a DM everyone is
// already in the call) — and only while a call is actually live.
function updateAddToCallBtn() {
  const meta = activeCall.convoId ? metaFor(activeCall.convoId) : null;
  const show = !!activeCall.convoId && !!meta && meta.kind !== 'dm';
  addToCallBtn.classList.toggle('hidden', !show);
}

// Who could still be pulled in: human convo members, not me, not already
// joined/ringing, and (greyed out) those offline or who already declined.
function addableCallMembers() {
  const meta = activeCall.convoId ? metaFor(activeCall.convoId) : null;
  if (!meta) return [];
  return meta.members
    .filter((n) => n !== state.me && !findUserBy(n, (u) => u.bot))
    .map((n) => {
      const u = findUser(n);
      return {
        name: n,
        pic: u ? u.pic : null,
        online: !!(u && u.online),
        joined: activeCall.peers.has(n),
        declined: !!(activeCall.declined && activeCall.declined.has(n)),
        ringing: !!(activeCall.ringing && activeCall.ringing.has(n)),
      };
    });
}

function openAddToCallModal() {
  if (!activeCall.id) return;
  addToCallMembers.innerHTML = '';
  const candidates = addableCallMembers().filter((c) => !c.joined && !c.declined && !c.ringing);
  let any = false;
  for (const c of candidates) {
    const row = document.createElement('label');
    row.className = 'gm-member' + (c.online ? '' : ' disabled');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.name;
    cb.disabled = !c.online;

    const av = document.createElement('div');
    av.className = 'avatar';
    applyAvatar(av, c.name, c.pic);

    const nameEl = document.createElement('span');
    nameEl.textContent = c.name;

    const status = document.createElement('span');
    status.className = 'gm-status';
    status.textContent = c.online ? 'online' : 'offline';

    row.append(cb, av, nameEl, status);
    addToCallMembers.appendChild(row);
    any = true;
  }
  if (!any) {
    const note = document.createElement('div');
    note.className = 'list-note';
    note.textContent = 'Nobody else is available to join right now.';
    addToCallMembers.appendChild(note);
  }
  addToCallSubmitBtn.disabled = false;
  addToCallModal.classList.remove('hidden');
}

function closeAddToCallModal() {
  addToCallModal.classList.add('hidden');
  addToCallSubmitBtn.disabled = false;
}

addToCallBtn.addEventListener('click', openAddToCallModal);
addToCallCloseBtn.addEventListener('click', closeAddToCallModal);
addToCallCancelBtn.addEventListener('click', closeAddToCallModal);
addToCallSubmitBtn.addEventListener('click', () => {
  if (!activeCall.id) { closeAddToCallModal(); return; }
  const names = [...addToCallMembers.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
  if (!names.length) { toast('Pick at least one person'); return; }
  wsSend({ type: 'call_add', callId: activeCall.id, to: names });
  closeAddToCallModal();
});

function callKindWord() {
  return activeCall.kind === 'video' ? 'video call' : 'voice call';
}

function setCallStatus(text, isError) {
  callStateEl.textContent = text;
  callStateEl.classList.toggle('connected', text === 'Connected');
  callStateEl.classList.toggle('error', !!isError);
}

function startCallTimer() {
  clearInterval(activeCall.timer);
  callTimerEl.classList.remove('hidden');
  const tick = () => { callTimerEl.textContent = fmtDur((Date.now() - activeCall.startedAt) / 1000); };
  tick();
  activeCall.timer = setInterval(tick, 500);
}

function renderCallPeers() {
  callPeersEl.innerHTML = '';
  if (activeCall.kind === 'video') return; // video tiles already carry name labels
  if (activeCall.peers.size < 2) return; // a 1:1 call needs no participant chips
  const add = (name, isYou) => {
    const chip = document.createElement('span');
    chip.className = 'call-peer-chip' + (isYou ? ' you' : '');
    chip.textContent = isYou ? `${name} (you)` : name;
    callPeersEl.appendChild(chip);
  };
  add(state.me, true);
  for (const n of activeCall.peers.keys()) add(n, false);
}

function updateMuteBtn() {
  muteBtn.classList.toggle('off', activeCall.muted);
  muteBtn.title = activeCall.muted ? 'Unmute' : 'Mute';
}

function updateCameraBtn() {
  cameraBtn.classList.toggle('off', activeCall.cameraOff);
  cameraBtn.title = activeCall.cameraOff ? 'Turn camera on' : 'Turn camera off';
}

function updateSpeakerBtn() {
  speakerBtn.classList.toggle('off', activeCall.speaker);
  speakerBtn.title = activeCall.speaker ? 'Speaker on' : 'Speaker off';
}

function applySpeakerSink() {
  if (!activeCall.speaker || !activeCall.sinkId) return;
  if (typeof HTMLMediaElement.prototype.setSinkId !== 'function') return;
  for (const peer of activeCall.peers.values()) {
    if (peer.audio) peer.audio.setSinkId(activeCall.sinkId).catch(() => {});
  }
}

/* ---- ringing tone (Web Audio, no files) ---- */

let ringTimer = null;
function startRing() {
  stopRing();
  const beat = () => { pop(660); setTimeout(() => pop(880), 190); };
  beat();
  ringTimer = setInterval(beat, 1900);
}
function stopRing() {
  clearInterval(ringTimer);
  ringTimer = null;
}

/* ---- incoming call ---- */

function showIncoming(inv) {
  const u = findUser(inv.from);
  incomingKindEl.textContent = inv.kind === 'video' ? 'Incoming video call 🎥' : 'Incoming voice call';
  applyAvatar(incomingAvatarEl, inv.from, u ? u.pic : null);
  incomingNameEl.textContent = inv.from;
  const others = (inv.callees || []).filter((n) => n !== state.me);
  incomingStateEl.textContent = others.length ? `Ringing… (+${others.length} more)` : 'Ringing…';
  incomingCallModal.classList.remove('hidden');
}

function hideIncoming() {
  incomingCallModal.classList.add('hidden');
}

async function acceptIncoming() {
  const inv = state.incoming;
  if (!inv) return;
  state.incoming = null;
  const wantVideo = inv.kind === 'video';
  let stream;
  try {
    stream = await getCallStream(wantVideo);
  } catch (err) {
    wsSend({ type: 'call_reject', callId: inv.callId });
    hideIncoming();
    stopRing();
    toast(wantVideo ? 'Camera or microphone unavailable' : (err.message || 'Microphone permission denied'));
    return;
  }
  hideIncoming();
  stopRing();
  activeCall.id = inv.callId;
  activeCall.convoId = inv.convoId;
  activeCall.kind = wantVideo ? 'video' : 'voice';
  activeCall.direction = 'in';
  activeCall.status = 'connecting';
  activeCall.localStream = stream;
  showCallOverlay();
  setCallStatus('Connecting…');
  wsSend({ type: 'call_accept', callId: inv.callId });
}

function declineIncoming() {
  const inv = state.incoming;
  state.incoming = null;
  if (inv) wsSend({ type: 'call_reject', callId: inv.callId });
  hideIncoming();
  stopRing();
}

/* ---- placing / ending ---- */

async function startCall(kind) {
  if (!state.active) return;
  if (activeCall.id || activeCall.status !== 'idle') { toast('You are already on a call'); return; }
  if (state.recording) stopRecording(false);
  const wantVideo = kind === 'video';
  const convoId = state.active;
  let stream;
  try {
    stream = await getCallStream(wantVideo);
  } catch (err) {
    toast(wantVideo ? 'Camera or microphone unavailable' : (err.message || 'Microphone permission denied'));
    return;
  }
  activeCall.localStream = stream;
  activeCall.convoId = convoId;
  activeCall.kind = wantVideo ? 'video' : 'voice';
  activeCall.direction = 'out';
  activeCall.status = 'dialling';
  showCallOverlay();
  setCallStatus('Calling…');
  wsSend({ type: 'call_invite', convoId, kind: activeCall.kind });
}

// Local hang-up: tell the server, then tear everything down.
function hangUp() {
  if (activeCall.id) wsSend({ type: 'call_leave', callId: activeCall.id });
  teardownCall();
}

function teardownCall() {
  for (const name of [...activeCall.peers.keys()]) dropPeer(name);
  activeCall.peers.clear();
  if (activeCall.localStream) {
    activeCall.localStream.getTracks().forEach((t) => t.stop()); // mic + camera
    activeCall.localStream = null;
  }
  clearVideoGrid();
  clearInterval(activeCall.timer);
  activeCall.timer = null;
  activeCall.id = null;
  activeCall.convoId = null;
  activeCall.kind = 'voice';
  activeCall.direction = null;
  activeCall.status = 'idle';
  activeCall.startedAt = 0;
  activeCall.muted = false;
  activeCall.cameraOff = false;
  activeCall.speaker = false;
  activeCall.sinkId = null;
  activeCall.ringing = new Set();
  activeCall.declined = new Set();
  callCardEl.classList.remove('video');
  callVideoGrid.classList.add('hidden');
  cameraBtn.classList.add('hidden');
  callOverlay.classList.add('hidden');
  callPeersEl.innerHTML = '';
  closeAddToCallModal();
  hideIncoming();
  stopRing();
  state.incoming = null;
}

function onCallPeerLeft(name) {
  dropPeer(name);
  toast(`${name} left the call`);
}

async function toggleMute() {
  if (!activeCall.localStream) return;
  activeCall.muted = !activeCall.muted;
  for (const t of activeCall.localStream.getAudioTracks()) t.enabled = !activeCall.muted;
  updateMuteBtn();
  setCallStatus(activeCall.muted ? 'Muted' : 'Connected');
}

async function toggleCamera() {
  if (!activeCall.localStream) return;
  const tracks = activeCall.localStream.getVideoTracks();
  if (!tracks.length) { toast('No camera in this call'); return; }
  activeCall.cameraOff = !activeCall.cameraOff;
  for (const t of tracks) t.enabled = !activeCall.cameraOff;
  updateCameraBtn();
  updateLocalTile();
}

async function toggleSpeaker() {
  activeCall.speaker = !activeCall.speaker;
  if (activeCall.speaker && !activeCall.sinkId && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId);
      if (outs.length > 1) activeCall.sinkId = outs[outs.length - 1].deviceId;
    } catch { /* device list unavailable */ }
  }
  for (const peer of activeCall.peers.values()) {
    if (peer.audio) peer.audio.volume = activeCall.speaker ? 1 : 0.9;
  }
  applySpeakerSink();
  updateSpeakerBtn();
}

// Hide the 📞/🎥 buttons where a call makes no sense (DMs with the demo bots).
function updateCallBtn() {
  const meta = state.active ? metaFor(state.active) : null;
  let show = false;
  let voiceTitle = 'Voice call';
  let videoTitle = 'Video call';
  if (meta && meta.kind === 'dm') {
    const other = meta.title;
    show = !findUserBy(other, (u) => u.bot);
  } else if (meta) {
    const humans = meta.members.filter((n) => n !== state.me && !findUserBy(n, (u) => u.bot));
    show = humans.length > 0;
    voiceTitle = 'Start group voice call';
    videoTitle = 'Start group video call';
  }
  callBtn.classList.toggle('hidden', !show);
  callBtn.title = voiceTitle;
  videoCallBtn.classList.toggle('hidden', !show);
  videoCallBtn.title = videoTitle;
}

function findUserBy(name, pred) {
  const u = findUser(name);
  return u ? pred(u) : false;
}

callBtn.addEventListener('click', () => startCall('voice'));
videoCallBtn.addEventListener('click', () => startCall('video'));
acceptCallBtn.addEventListener('click', acceptIncoming);
declineCallBtn.addEventListener('click', declineIncoming);
endCallBtn.addEventListener('click', hangUp);
muteBtn.addEventListener('click', toggleMute);
cameraBtn.addEventListener('click', toggleCamera);
speakerBtn.addEventListener('click', toggleSpeaker);

// A closing tab must not leave the other side ringing forever.
window.addEventListener('beforeunload', () => {
  if (activeCall.id) wsSend({ type: 'call_leave', callId: activeCall.id });
});

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

/* --------------------- group / room info panel (tap chat title) ------------ */

const chatInfoModal = $('chatInfoModal');
const chatInfoKind = $('chatInfoKind');
const chatInfoAvatar = $('chatInfoAvatar');
const chatInfoTitle = $('chatInfoTitle');
const chatInfoSub = $('chatInfoSub');
const chatInfoCreated = $('chatInfoCreated');
const chatInfoInviteWrap = $('chatInfoInviteWrap');
const chatInfoInvite = $('chatInfoInvite');
const chatInfoCopyBtn = $('chatInfoCopyBtn');
const chatInfoMembersLabel = $('chatInfoMembersLabel');
const chatInfoMembers = $('chatInfoMembers');
const chatInfoCloseBtn = $('chatInfoCloseBtn');
const chatHeaderEl = document.querySelector('.chat-header');
const chatMetaEl = document.querySelector('.chat-meta');

function infoMemberRow(name, creator) {
  const u = findUser(name);
  const row = document.createElement('div');
  row.className = 'ci-member';

  const av = document.createElement('div');
  av.className = 'avatar';
  applyAvatar(av, name, u ? u.pic : null);

  const body = document.createElement('div');
  body.className = 'ci-member-body';
  const nameEl = document.createElement('span');
  nameEl.className = 'ci-member-name';
  nameEl.textContent = name === state.me ? `${name} (you)` : name;
  if (u && u.bot) {
    const tag = document.createElement('span');
    tag.className = 'bot-tag';
    tag.textContent = 'BOT';
    nameEl.appendChild(tag);
  }
  if (name === creator) {
    const crown = document.createElement('span');
    crown.className = 'ci-crown';
    crown.title = 'Group creator';
    crown.textContent = '👑';
    nameEl.appendChild(crown);
  }
  const statusEl = document.createElement('span');
  statusEl.className = 'ci-member-status' + (u && u.online ? ' online' : '');
  statusEl.textContent = u && u.online ? 'online'
    : u && u.lastSeen ? `last seen ${listTime(u.lastSeen)}`
    : 'offline';
  body.append(nameEl, statusEl);

  row.append(av, body);
  return row;
}

function openChatInfo() {
  if (!state.active) return;
  const meta = metaFor(state.active);
  if (!meta || meta.kind === 'dm') return; // groups and rooms only

  const isRoom = meta.kind === 'room';
  chatInfoKind.textContent = isRoom ? 'Room info' : 'Group info';
  applyAvatar(chatInfoAvatar, isRoom ? meta.room.id : (meta.group ? meta.group.id : meta.title), meta.pic, isRoom ? '🔒' : '👥');
  chatInfoTitle.textContent = meta.title;
  chatInfoSub.textContent = `${isRoom ? 'Room' : 'Group'} · ${meta.members.length} member${meta.members.length === 1 ? '' : 's'}`;

  const creator = isRoom ? meta.room.createdBy : (meta.group && meta.group.createdBy);
  const createdAt = isRoom ? meta.room.createdAt : (meta.group && meta.group.createdAt);
  let line = '';
  if (creator) line += `Created by ${creator === state.me ? 'you' : creator}`;
  if (createdAt) line += `${line ? ' · ' : ''}${new Date(createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  chatInfoCreated.textContent = line;
  chatInfoCreated.classList.toggle('hidden', !line);

  if (isRoom && meta.room.inviteCode) {
    chatInfoInviteWrap.classList.remove('hidden');
    chatInfoInvite.textContent = meta.room.inviteCode;
  } else {
    chatInfoInviteWrap.classList.add('hidden');
  }

  chatInfoMembersLabel.textContent = `${meta.members.length} member${meta.members.length === 1 ? '' : 's'}`;
  chatInfoMembers.innerHTML = '';
  const sorted = [...meta.members].sort((a, b) => {
    if (a === creator) return -1;
    if (b === creator) return 1;
    const ua = findUser(a); const ub = findUser(b);
    const onA = ua && ua.online ? 0 : 1;
    const onB = ub && ub.online ? 0 : 1;
    return (onA - onB) || a.localeCompare(b);
  });
  for (const n of sorted) {
    const row = infoMemberRow(n, creator);
    // admin remove button
    if (isGroupAdmin(state.active, state.me) && n !== state.me && n !== creator) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'btn';
      rmBtn.style.padding = '2px 8px';
      rmBtn.style.fontSize = '11px';
      rmBtn.textContent = 'Remove';
      rmBtn.addEventListener('click', (e)=>{ e.stopPropagation(); if(confirm('Remove '+n+'?')) wsSend({ type:'group_remove_member', groupId: state.active, member:n }); });
      row.appendChild(rmBtn);
      const makeBtn = document.createElement('button');
      makeBtn.className = 'btn';
      makeBtn.style.padding = '2px 8px';
      makeBtn.style.fontSize = '11px';
      makeBtn.textContent = 'Make admin';
      makeBtn.addEventListener('click', (e)=>{ e.stopPropagation(); wsSend({ type:'group_make_admin', groupId: state.active, member:n }); });
      if (!(meta.group && meta.group.admins && meta.group.admins.includes(n))) row.appendChild(makeBtn);
    }
    chatInfoMembers.appendChild(row);
  }
  // show admin actions if admin
  const adminWrap = document.getElementById('adminActions');
  if (adminWrap) adminWrap.classList.toggle('hidden', !isGroupAdmin(state.active, state.me));

  chatInfoModal.classList.remove('hidden');
}

function closeChatInfo() {
  chatInfoModal.classList.add('hidden');
}

chatInfoCloseBtn.addEventListener('click', closeChatInfo);
chatMetaEl.addEventListener('click', openChatInfo);        // tap the chat title/status
chatAvatar.addEventListener('click', openChatInfo);        // or the header avatar
chatInfoCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(chatInfoInvite.textContent);
    toast('Invite code copied! 📋');
  } catch {
    toast('Select and copy the code');
  }
});

/* ------------------------------ emoji panel -------------------------------- */

const STICKERS = ['😺','🐶','🦊','🐼','🦁','🐯','🐨','🐸','🦄','🐙','🦋','🍕','🍔','🍟','🌮','🍩','⚽','🎮','🚀','💎'];
const GIFS = [
  { url: 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif', tags: ['happy','dance'] },
  { url: 'https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif', tags: ['lol','funny'] },
  { url: 'https://media.giphy.com/media/26BRuo6sLetdllPAQ/giphy.gif', tags: ['love','heart'] },
  { url: 'https://media.giphy.com/media/3o6Zt481isNVuQI1l6/giphy.gif', tags: ['wow','omg'] },
  { url: 'https://media.giphy.com/media/xT5LMHxhOfscxPfIfm/giphy.gif', tags: ['sad','cry'] },
  { url: 'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif', tags: ['cool','sunglasses'] },
  { url: 'https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif', tags: ['clap','bravo'] },
  { url: 'https://media.giphy.com/media/26gssIytJBS1EL6Ls/giphy.gif', tags: ['party','celebrate'] },
];
const WALLPAPERS = [
  { id: 'default', label: 'Default', css: '' },
  { id: 'mint', label: 'Mint', css: '#e0f2e9' },
  { id: 'peach', label: 'Peach', css: '#fff3e0' },
  { id: 'lavender', label: 'Lavender', css: '#f3e5f5' },
  { id: 'sky', label: 'Sky', css: '#e3f2fd' },
  { id: 'dark', label: 'Dark', css: '#1a1a1a' },
  { id: 'doodle', label: 'Doodle', css: 'var(--chat-bg)' },
];

const EMOJIS = ['😀','😂','🤣','😊','😍','😘','😎','🤔','😅','😭','😡','🥺','😴','🤯','😇','🙃','😉','🤗','🤫','🤭','👍','👎','👌','✌️','🙏','👏','🙌','🤝','💪','🫶','❤️','💔','💯','🔥','✨','🎉','🎂','🎁','🎧','🎵','🎶','⚽','🏆','🌙','☀️','🌈','⭐','🍕'];

const emojiTabContentEl = document.getElementById('emojiTabContent');
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
  (emojiTabContentEl || emojiPanel).appendChild(b);
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
  localStorage.removeItem('achat-token');
  localStorage.removeItem('achat-name');
  location.reload();
});

backBtn.addEventListener('click', () => document.body.classList.remove('chat-open'));

/* ------------------------------ privacy & ghost mode ----------------------- */

const privacyBtn = $('privacyBtn');
const privacyModal = $('privacyModal');
const privacyCloseBtn = $('privacyCloseBtn');
const privacyDoneBtn = $('privacyDoneBtn');
const ghostToggle = $('ghostToggle');
const readReceiptsToggle = $('readReceiptsToggle');
const lastSeenToggle = $('lastSeenToggle');
const typingToggle = $('typingToggle');
const ghostPill = $('ghostPill');

function syncPrivacyUI() {
  ghostToggle.checked = !!state.privacy.ghost;
  readReceiptsToggle.checked = !!state.privacy.readReceipts;
  lastSeenToggle.checked = !!state.privacy.lastSeen;
  typingToggle.checked = !!state.privacy.typing;
  // Ghost Mode overrides the three fine-grained toggles — grey them out but
  // keep their values so they snap back when Ghost Mode is turned off.
  const overridden = !!state.privacy.ghost;
  readReceiptsToggle.disabled = overridden;
  lastSeenToggle.disabled = overridden;
  typingToggle.disabled = overridden;
  ghostPill.classList.toggle('hidden', !state.privacy.ghost);
}

function readPrivacyUI() {
  return {
    ghost: ghostToggle.checked,
    readReceipts: readReceiptsToggle.checked,
    lastSeen: lastSeenToggle.checked,
    typing: typingToggle.checked,
  };
}

function pushPrivacy() {
  const wasGhost = !!state.privacy.ghost;
  state.privacy = readPrivacyUI();
  syncPrivacyUI();
  if (state.privacy.ghost !== wasGhost) {
    toast(state.privacy.ghost ? '👻 Ghost Mode on — you now appear offline' : 'Ghost Mode off — you are visible again');
  } else {
    toast('Privacy updated 🛡️');
  }
  wsSend({ type: 'privacy_set', privacy: state.privacy });
}

function openPrivacyModal() {
  syncPrivacyUI();
  privacyModal.classList.remove('hidden');
}

function closePrivacyModal() {
  privacyModal.classList.add('hidden');
}

privacyBtn.addEventListener('click', openPrivacyModal);
privacyCloseBtn.addEventListener('click', closePrivacyModal);
privacyDoneBtn.addEventListener('click', closePrivacyModal);
[ghostToggle, readReceiptsToggle, lastSeenToggle, typingToggle].forEach((t) => {
  t.addEventListener('change', pushPrivacy);
});

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
    sendRead(state.active);
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
  const retention = parseInt($('roomRetentionInput')?.value || '0', 10) || 0;
  if (!name) { toast('Please enter a room name'); roomNameInput.focus(); return; }
  if (!password || password.length < 3) { toast('Password must be at least 3 characters'); roomPasswordInput.focus(); return; }
  roomCreateBtn.disabled = true;
  wsSend({ type: 'room_create', name, password });
  // retention set after creation via separate message? For now store and send after room_created handles retention
  window._pendingRetention = retention;
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
    closeChatInfo();
    closeAddToCallModal();
    closePrivacyModal();
    cancelMessageAction(false);
    $('disappearingModal')?.classList.add('hidden');
    $('forwardModal')?.classList.add('hidden');
    $('pollModal')?.classList.add('hidden');
    $('statusCreateModal')?.classList.add('hidden');
    $('statusViewer')?.classList.add('hidden');
    $('wallpaperModal')?.classList.add('hidden');
    $('starredModal')?.classList.add('hidden');
    $('accountModal')?.classList.add('hidden');
    $('addMemberModal')?.classList.add('hidden');
    $('chatSearchBar')?.classList.add('hidden');
    $('searchResults')?.classList.add('hidden');
  }
});

/* ------------------------------ initial screen ------------------------------ */

// Show auth screen by default (unless we have a stored session)
if (storedToken && storedName) {
  // Restore the saved session BEFORE connect(): onopen only auto-joins when
  // state.authenticated is set, otherwise no join is ever sent and the app
  // stays on a black screen (auth hidden, chat never rendered).
  state.authenticated = true;
  state.authToken = storedToken;
  state.authUsername = storedName;
  state.me = storedName;
  authScreen.classList.add('hidden');
  // connect() onopen will send the join below
} else {
  authScreen.classList.remove('hidden');
  authUsernameInput.value = storedName || '';
  authUsernameInput.focus();
}


/* ==================== new feature helpers ==================== */

function buildPollEl(m) {
  const wrap = document.createElement('div');
  wrap.className = 'poll-wrap';
  const q = document.createElement('div');
  q.className = 'poll-question';
  q.textContent = m.media.question;
  wrap.appendChild(q);
  const total = m.media.options.reduce((s,o)=>s+o.votes.length,0) || 1;
  m.media.options.forEach((opt, idx) => {
    const row = document.createElement('div');
    row.className = 'poll-option';
    const btn = document.createElement('button');
    btn.className = 'poll-vote-btn';
    btn.textContent = opt.text;
    if (opt.votes.includes(state.me)) btn.classList.add('voted');
    if (m.media.closed) btn.disabled = true;
    btn.addEventListener('click', () => wsSend({ type: 'poll_vote', convoId: m.convoId, id: m.id, optionIndex: idx }));
    const bar = document.createElement('div');
    bar.className = 'poll-bar';
    const fill = document.createElement('div');
    fill.className = 'poll-fill';
    fill.style.width = Math.round((opt.votes.length/total)*100)+'%';
    bar.appendChild(fill);
    const count = document.createElement('span');
    count.className = 'poll-count';
    count.textContent = opt.votes.length + ' vote' + (opt.votes.length!==1?'s':'');
    if (opt.votes.includes(state.me)) count.textContent += ' • you';
    row.append(btn, bar, count);
    wrap.appendChild(row);
  });
  if (!m.media.closed && (m.from===state.me || isGroupAdmin(m.convoId, state.me))) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Close poll';
    closeBtn.style.marginTop='8px';
    closeBtn.addEventListener('click', ()=>wsSend({type:'poll_close', convoId:m.convoId, id:m.id}));
    wrap.appendChild(closeBtn);
  }
  if (m.media.closed) {
    const closed = document.createElement('div');
    closed.className = 'poll-closed';
    closed.textContent = 'Poll closed';
    wrap.appendChild(closed);
  }
  return wrap;
}
function isGroupAdmin(convoId, name) {
  if (convoId.startsWith('grp::')) {
    const g = state.groups.get(convoId);
    if (!g) return false;
    return g.createdBy===name || (g.admins||[]).includes(name);
  }
  if (convoId.startsWith('room::')) {
    const r = state.rooms.get(convoId);
    return r && r.createdBy===name;
  }
  return false;
}
function toggleStar(m) {
  const starred = !(m.starredBy||[]).includes(state.me);
  wsSend({ type: 'star_message', convoId: m.convoId, id: m.id, starred });
}
function deleteForMe(m) {
  if (!confirm('Delete this message for you only?')) return;
  wsSend({ type: 'delete_for_me', convoId: m.convoId, id: m.id });
}
function showEditHistory(m) {
  const hist = m.editHistory || [];
  if (!hist.length) { toast('No edit history'); return; }
  alert('Edit history:\n' + hist.map(h=> new Date(h.at||h.ts).toLocaleString() + ': ' + h.text).join('\n') + '\n\nCurrent: ' + m.text);
}
let forwardPending = null;
function openForwardPicker(m) {
  forwardPending = m;
  const list = $('forwardList');
  list.innerHTML = '';
  for (const c of listEntries()) {
    const row = document.createElement('label');
    row.className = 'gm-member';
    const cb = document.createElement('input');
    cb.type='checkbox'; cb.value=c.id;
    const av = document.createElement('div');
    av.className='avatar'; applyAvatar(av, c.title, c.pic, c.kind==='group'?'👥': c.kind==='room'?'🔒':undefined);
    const nameEl = document.createElement('span'); nameEl.textContent=c.title;
    row.append(cb, av, nameEl);
    list.appendChild(row);
  }
  $('forwardModal').classList.remove('hidden');
}
function closeForwardPicker() { $('forwardModal').classList.add('hidden'); forwardPending=null; }
function doForward() {
  if (!forwardPending) return;
  const ids = [...$('forwardList').querySelectorAll('input:checked')].map(cb=>cb.value);
  if (!ids.length) { toast('Pick at least one chat'); return; }
  wsSend({ type: 'forward', messageId: forwardPending.id, fromConvoId: forwardPending.convoId, toConvoIds: ids });
  toast('Forwarded ↗️');
  closeForwardPicker();
}
function updateDisappearingUI() {
  const sec = state.active ? (state.disappearing.get(state.active)||0) : 0;
  const btn = $('disappearingBtn');
  if (btn) {
    btn.textContent = sec ? '⏳'+ (sec<60? sec+'s' : sec<3600? Math.floor(sec/60)+'m' : Math.floor(sec/3600)+'h') : '⏳';
    btn.classList.toggle('active', !!sec);
  }
}
function openDisappearingModal() {
  if (!state.active) return;
  const sec = state.disappearing.get(state.active)||0;
  document.querySelectorAll('input[name="disappearing"]').forEach(r=> r.checked = Number(r.value)===sec);
  $('disappearingModal').classList.remove('hidden');
}
function saveDisappearing() {
  const sel = document.querySelector('input[name="disappearing"]:checked');
  const sec = sel ? Number(sel.value) : 0;
  wsSend({ type: 'disappearing_set', convoId: state.active, seconds: sec });
  $('disappearingModal').classList.add('hidden');
  toast(sec ? `⏳ Disappearing: ${sec}s` : 'Disappearing off');
}
function applyWallpaper(wp) {
  state.wallpaper = wp;
  const msgs = document.getElementById('messages');
  if (!msgs) return;
  if (!wp || wp==='default' || !wp) {
    msgs.style.background = '';
    msgs.style.backgroundColor = '';
    localStorage.setItem('achat-wallpaper','default');
    return;
  }
  const found = WALLPAPERS.find(w=>w.id===wp || w.css===wp);
  const css = found ? found.css : wp;
  if (css.startsWith('#') || css.startsWith('rgb')) msgs.style.backgroundColor = css;
  else msgs.style.background = css;
  msgs.style.backgroundImage = 'var(--doodle)';
  localStorage.setItem('achat-wallpaper', wp);
}
function renderWallpapers() {
  const grid = $('wallpaperGrid');
  if (!grid) return;
  grid.innerHTML='';
  for (const w of WALLPAPERS) {
    const btn = document.createElement('button');
    btn.className='wallpaper-swatch';
    btn.title=w.label;
    if (w.css && w.css.startsWith('#')) btn.style.background = w.css;
    else if (w.id==='default') btn.style.background='var(--chat-bg)';
    else if (w.id==='doodle') btn.style.background='var(--panel-header)';
    const lbl = document.createElement('span'); lbl.textContent=w.label;
    btn.append(lbl);
    btn.addEventListener('click', ()=>{
      const val = w.id==='default' ? '' : w.css || w.id;
      wsSend({ type: 'wallpaper_set', wallpaper: val });
      applyWallpaper(val || 'default');
      toast('Wallpaper: '+w.label);
    });
    grid.appendChild(btn);
  }
}
function renderStatuses() {
  const list = $('statusList');
  if (!list) return;
  list.innerHTML='';
  // group by user
  const byUser = new Map();
  for (const s of state.statuses) {
    if (!byUser.has(s.from)) byUser.set(s.from, []);
    byUser.get(s.from).push(s);
  }
  for (const [user, arr] of byUser) {
    const u = findUser(user);
    const item = document.createElement('div');
    item.className='status-item';
    const av = document.createElement('div');
    av.className='status-avatar';
    applyAvatar(av, user, u?u.pic:null);
    if (arr.some(s=>!(s.views||[]).includes(state.me)) && user!==state.me) av.classList.add('unseen');
    const name = document.createElement('span');
    name.className='status-name';
    name.textContent=user;
    item.append(av, name);
    item.addEventListener('click', ()=>openStatusViewer(user));
    list.appendChild(item);
  }
}
function openStatusViewer(user) {
  const arr = state.statuses.filter(s=>s.from===user).sort((a,b)=>b.ts-a.ts);
  if (!arr.length) return;
  const s = arr[0];
  $('statusViewerAvatar').textContent = initialOf(user);
  applyAvatar($('statusViewerAvatar'), user, findUser(user)?.pic);
  $('statusViewerName').textContent=user;
  $('statusViewerTime').textContent=new Date(s.ts).toLocaleString();
  const body = $('statusViewerBody');
  body.innerHTML='';
  if (s.media && s.media.url) {
    const img=document.createElement('img'); img.src=s.media.url; img.style.maxWidth='100%'; body.appendChild(img);
  }
  if (s.text) {
    const p=document.createElement('p'); p.textContent=s.text; p.style.marginTop='12px'; body.appendChild(p);
  }
  $('statusViewerViews').textContent = (s.views||[]).length + ' views';
  $('statusViewer').classList.remove('hidden');
  if (user!==state.me) wsSend({ type: 'status_view', statusId: s.id });
}
function closeStatusViewer(){ $('statusViewer').classList.add('hidden'); }
function openStatusCreate(){ $('statusCreateModal').classList.remove('hidden'); }
function closeStatusCreate(){ $('statusCreateModal').classList.add('hidden'); $('statusText').value=''; $('statusPhotoName').textContent=''; }
function sendStatus(){
  const text=$('statusText').value.trim();
  let media=null;
  if (window._statusDataUrl) media={ url: window._statusUrl || '', name: 'status.jpg' };
  // if we have uploaded url, send as photo inside status
  if (!text && !media) { toast('Add text or photo'); return; }
  // if we have pending dataUrl but not yet uploaded, upload first
  if (window._statusDataUrl && !window._statusUrl) {
    uploadDataUrl(window._statusDataUrl, 'status.jpg').then(url=>{
      window._statusUrl=url;
      wsSend({ type:'status_create', text, media:{url}, kind:'photo' });
      closeStatusCreate();
    }).catch(e=>toast(e.message));
    return;
  }
  wsSend({ type:'status_create', text, media, kind: media?'photo':'text' });
  closeStatusCreate();
}
function renderSearchResults(q, results){
  const el=$('searchResults');
  if (!el) return;
  if (!q) { el.classList.add('hidden'); return; }
  el.innerHTML='';
  el.classList.remove('hidden');
  const head=document.createElement('div'); head.className='gm-label'; head.textContent=`${results.length} results for "${q}"`; el.appendChild(head);
  for (const r of results.slice(0,20)) {
    const row=document.createElement('div');
    row.className='search-result';
    row.innerHTML=`<b>${r.convoId}</b>: ${r.message.text.slice(0,80)}`;
    row.addEventListener('click', ()=>{ openChat(r.convoId); el.classList.add('hidden'); });
    el.appendChild(row);
  }
  if (!results.length) el.innerHTML='<div class="list-note">No matches</div>';
}
function doGlobalSearch(){
  const q=$('searchInput').value.trim();
  if (q.length<2) { $('searchResults').classList.add('hidden'); renderChatList(); return; }
  // local filter already applied via renderChatList, also server search
  wsSend({ type:'search_messages', query: q });
}
function doChatSearch(){
  const q=$('chatSearchInput').value.trim().toLowerCase();
  const chat=getChat(state.active);
  if (!chat) return;
  messagesEl.innerHTML='';
  state.lastDateLabel=null;
  let prev=null;
  for (const m of chat.messages) {
    if (q && !(m.text||'').toLowerCase().includes(q)) continue;
    const label=dateLabel(m.ts);
    if (label!==state.lastDateLabel){ messagesEl.appendChild(daySep(label)); state.lastDateLabel=label; prev=null; }
    messagesEl.appendChild(buildBubble(m, prev));
    prev=m;
  }
}
function togglePinChat(){
  if (!state.active) return;
  const isPinned=(state.pinnedChats||[]).includes(state.active);
  wsSend({ type:'pin_chat', convoId: state.active, pinned: !isPinned });
  toast(isPinned? 'Unpinned 📌':'Pinned 📌');
}
function clearChat(){
  if (!state.active) return;
  if (!confirm('Clear chat for you only? This hides all messages.')) return;
  wsSend({ type:'clear_chat', convoId: state.active });
}
function openPollModal(){ if(!state.active) return; $('pollModal').classList.remove('hidden'); }
function closePollModal(){ $('pollModal').classList.add('hidden'); }
function createPoll(){
  const q=$('pollQuestion').value.trim();
  const opts=[...document.querySelectorAll('.poll-opt')].map(i=>i.value.trim()).filter(Boolean);
  if (!q || opts.length<2) { toast('Add question + at least 2 options'); return; }
  const multiple=$('pollMultiple').checked;
  wsSend({ type:'message', convoId: state.active, kind:'poll', text: q, media: { question:q, options: opts, multiple } });
  closePollModal();
  $('pollQuestion').value=''; document.querySelectorAll('.poll-opt').forEach(i=>i.value='');
}
function setupGifStickers(){
  // GIF search
  const gifSearch=$('gifSearch');
  const gifGrid=$('gifGrid');
  function renderGifs(filter=''){
    gifGrid.innerHTML='';
    const f=filter.toLowerCase();
    for (const g of GIFS) {
      if (f && !g.tags.some(t=>t.includes(f)) && !g.url.includes(f)) continue;
      const img=document.createElement('img');
      img.src=g.url; img.className='gif-thumb';
      img.addEventListener('click', ()=>{
        wsSend({ type:'message', convoId: state.active, kind:'gif', text:'', media:{ url:g.url } });
        $('emojiPanel').classList.add('hidden');
      });
      gifGrid.appendChild(img);
    }
  }
  if(gifSearch) gifSearch.addEventListener('input', ()=>renderGifs(gifSearch.value));
  renderGifs();
  // Stickers
  const stickerGrid=$('stickerGrid');
  if (stickerGrid) {
    stickerGrid.innerHTML='';
    for (const s of STICKERS) {
      const btn=document.createElement('button');
      btn.className='sticker-btn';
      btn.textContent=s;
      btn.style.fontSize='32px';
      btn.addEventListener('click', ()=>{
        wsSend({ type:'message', convoId: state.active, kind:'sticker', text:s, media:null });
        $('emojiPanel').classList.add('hidden');
      });
      stickerGrid.appendChild(btn);
    }
  }
}
function enableNotifications(){
  if (!('Notification' in window)) { toast('Notifications not supported'); return; }
  Notification.requestPermission().then(perm=>{
    if (perm==='granted') {
      state.notifEnabled=true;
      toast('🔔 Notifications enabled');
      // register push
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(reg=>{
          return reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: urlBase64ToUint8Array('BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U') });
        }).then(sub=>{
          wsSend({ type:'push_subscribe', subscription: sub });
        }).catch(()=>{});
      }
    } else { toast('Permission denied'); }
  });
}
function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const rawData=window.atob(base64);
  const outputArray=new Uint8Array(rawData.length);
  for(let i=0;i<rawData.length;++i) outputArray[i]=rawData.charCodeAt(i);
  return outputArray;
}
function exportData(){
  fetch('/api/export/'+encodeURIComponent(state.me)).then(r=>r.json()).then(j=>{
    if (!j.ok) return toast('Export failed');
    const blob=new Blob([JSON.stringify(j.data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=`a-chat-${state.me}-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
    toast('Export downloaded 📥');
  });
}
function openAccountModal(){
  $('accountModal').classList.remove('hidden');
  // fetch 2FA status from profile
  const p = profiles.get(state.me) || {};
  const twoFA = p.twoFA || state.privacy.twoFA;
  $('twoFAStatus').textContent = (p.twoFA && p.twoFA.enabled) ? '✅ 2FA enabled' : '2FA not enabled';
  if (p.twoFA && p.twoFA.enabled) { $('enable2FABtn').classList.add('hidden'); $('disable2FABtn').classList.remove('hidden'); }
  else { $('enable2FABtn').classList.remove('hidden'); $('disable2FABtn').classList.add('hidden'); }
}

connect();
// wallpaper init
renderWallpapers();
setupGifStickers();
applyWallpaper(localStorage.getItem('achat-wallpaper') || 'default');

// new button listeners
$('statusBtn')?.addEventListener('click', openStatusCreate);
$('addStatusBtn')?.addEventListener('click', openStatusCreate);
$('statusCreateCloseBtn')?.addEventListener('click', closeStatusCreate);
$('statusCreateCancelBtn')?.addEventListener('click', closeStatusCreate);
$('statusCreateSendBtn')?.addEventListener('click', sendStatus);
$('statusViewerClose')?.addEventListener('click', closeStatusViewer);
$('wallpaperBtn')?.addEventListener('click', ()=>$('wallpaperModal').classList.remove('hidden'));
$('wallpaperCloseBtn')?.addEventListener('click', ()=>$('wallpaperModal').classList.add('hidden'));
$('wallpaperDoneBtn')?.addEventListener('click', ()=>$('wallpaperModal').classList.add('hidden'));
$('accountBtn')?.addEventListener('click', openAccountModal);
$('accountCloseBtn')?.addEventListener('click', ()=>$('accountModal').classList.add('hidden'));
$('accountDoneBtn')?.addEventListener('click', ()=>$('accountModal').classList.add('hidden'));
$('enable2FABtn')?.addEventListener('click', ()=>wsSend({type:'2fa_enable'}));
$('verify2FABtn')?.addEventListener('click', ()=>wsSend({type:'2fa_verify', code:$('twoFACode').value.trim()}));
$('disable2FABtn')?.addEventListener('click', ()=>{ if(confirm('Disable 2FA?')) wsSend({type:'2fa_disable'}); });
$('exportDataBtn')?.addEventListener('click', exportData);
$('deleteAccountBtn')?.addEventListener('click', ()=>{
  const pw=$('deleteConfirmPw').value;
  if(!pw) return toast('Enter password');
  if(!confirm('Delete account permanently?')) return;
  wsSend({type:'account_delete', password: pw});
});
$('requestResetBtn')?.addEventListener('click', ()=>wsSend({type:'password_reset_request', username: state.me}));
$('doResetBtn')?.addEventListener('click', ()=>wsSend({type:'password_reset', token:$('resetTokenInput').value.trim(), password:$('resetNewPw').value}));
$('pinChatBtn')?.addEventListener('click', togglePinChat);
$('clearChatBtn')?.addEventListener('click', clearChat);
$('disappearingBtn')?.addEventListener('click', openDisappearingModal);
$('disappearingCloseBtn')?.addEventListener('click', ()=>$('disappearingModal').classList.add('hidden'));
$('disappearingCancelBtn')?.addEventListener('click', ()=>$('disappearingModal').classList.add('hidden'));
$('disappearingSaveBtn')?.addEventListener('click', saveDisappearing);
$('pollBtn')?.addEventListener('click', openPollModal);
$('pollCloseBtn')?.addEventListener('click', closePollModal);
$('pollCancelBtn')?.addEventListener('click', closePollModal);
$('pollCreateBtn')?.addEventListener('click', createPoll);
$('forwardCloseBtn')?.addEventListener('click', closeForwardPicker);
$('forwardCancelBtn')?.addEventListener('click', closeForwardPicker);
$('forwardSendBtn')?.addEventListener('click', doForward);
$('notifBtn')?.addEventListener('click', enableNotifications);
$('stickerBtn')?.addEventListener('click', ()=>{ $('emojiPanel').classList.toggle('hidden'); document.querySelector('.emoji-tab[data-tab="sticker"]')?.click(); });
$('globalSearchBtn')?.addEventListener('click', doGlobalSearch);
$('headerSearchBtn')?.addEventListener('click', ()=>$('chatSearchBar').classList.toggle('hidden'));
$('chatSearchClose')?.addEventListener('click', ()=>$('chatSearchBar').classList.add('hidden'));
$('chatSearchInput')?.addEventListener('input', doChatSearch);
$('starredCloseBtn')?.addEventListener('click', ()=>$('starredModal').classList.add('hidden'));
$('starredDoneBtn')?.addEventListener('click', ()=>$('starredModal').classList.add('hidden'));
// status photo
$('statusPhotoBtn')?.addEventListener('click', ()=>$('statusPhotoInput').click());
$('statusPhotoInput')?.addEventListener('change', async ()=>{
  const f=$('statusPhotoInput').files[0]; if(!f) return;
  const dataUrl=await resizeImage(f, 800, 0.85);
  window._statusDataUrl=dataUrl;
  $('statusPhotoName').textContent=f.name;
  // upload for url
  try { const url=await uploadDataUrl(dataUrl, f.name); window._statusUrl=url; } catch(e){ toast(e.message); }
});
// filter chips
document.querySelectorAll('.filter-chip').forEach(ch=>{
  ch.addEventListener('click', ()=>{
    document.querySelectorAll('.filter-chip').forEach(x=>x.classList.remove('active'));
    ch.classList.add('active');
    state.filter=ch.dataset.filter;
    if(state.filter==='starred') {
      // show starred modal instead?
      // render starred list
      const list=$('starredList');
      list.innerHTML='';
      for(const [cid, chat] of state.chats) {
        for(const m of chat.messages) if((m.starredBy||[]).includes(state.me)) {
          const row=document.createElement('div'); row.className='starred-item';
          row.textContent=`${cid}: ${m.text.slice(0,60)}`;
          row.addEventListener('click', ()=>{ $('starredModal').classList.add('hidden'); openChat(cid); });
          list.appendChild(row);
        }
      }
      if(!list.children.length) list.innerHTML='<div class="list-note">No starred messages</div>';
      $('starredModal').classList.remove('hidden');
      state.filter='all';
      document.querySelector('.filter-chip[data-filter="all"]').classList.add('active');
      ch.classList.remove('active');
    }
    renderChatList();
  });
});
// emoji tabs
document.querySelectorAll('.emoji-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.emoji-tab').forEach(x=>x.classList.remove('active'));
    tab.classList.add('active');
    const t=tab.dataset.tab;
    $('emojiTabContent').classList.toggle('hidden', t!=='emoji');
    $('gifTabContent').classList.toggle('hidden', t!=='gif');
    $('stickerTabContent').classList.toggle('hidden', t!=='sticker');
  });
});
$('searchInput')?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') doGlobalSearch(); });
// admin add member
$('addMemberBtn')?.addEventListener('click', ()=>{
  if(!state.active) return;
  const modal=$('addMemberModal');
  const list=$('addMemberList');
  list.innerHTML='';
  const g=state.groups.get(state.active);
  const candidates=state.users.filter(u=>u.name!==state.me && !g.members.includes(u.name));
  for(const u of candidates){
    const row=document.createElement('label'); row.className='gm-member';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.value=u.name;
    const av=document.createElement('div'); av.className='avatar'; applyAvatar(av,u.name,u.pic);
    const nameEl=document.createElement('span'); nameEl.textContent=u.name;
    row.append(cb,av,nameEl); list.appendChild(row);
  }
  modal.classList.remove('hidden');
});
$('addMemberCloseBtn')?.addEventListener('click', ()=>$('addMemberModal').classList.add('hidden'));
$('addMemberCancelBtn')?.addEventListener('click', ()=>$('addMemberModal').classList.add('hidden'));
$('addMemberAddBtn')?.addEventListener('click', ()=>{
  const names=[...$('addMemberList').querySelectorAll('input:checked')].map(cb=>cb.value);
  if(!names.length) return toast('Pick members');
  for(const n of names) wsSend({ type:'group_add_member', groupId: state.active, member:n });
  $('addMemberModal').classList.add('hidden');
  toast('Members added');
});
// fix STARRED filter etc
// 2FA show link
$('show2FALink')?.addEventListener('click', (e)=>{ e.preventDefault(); $('authOtp').classList.remove('hidden'); });
$('forgotLink')?.addEventListener('click', (e)=>{
  e.preventDefault();
  const u=$('authUsername').value.trim();
  if(!u) return toast('Enter username first');
  wsSend({ type:'password_reset_request', username:u });
  toast('Reset token requested (check toast/modal)');
});

