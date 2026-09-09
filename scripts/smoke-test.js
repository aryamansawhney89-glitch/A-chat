'use strict';

/**
 * A-Chat smoke test — spins up a fresh server on a scratch data dir and
 * exercises it with two WebSocket clients:
 *   join → DM + delivered/read receipts → group create + group message +
 *   aggregated receipts → photo upload + message (bot reacts) → voice upload
 *   + message (bot reacts) → profile picture broadcast → oversized upload
 *   rejected → JSON persistence (with legacy messages.json migration).
 *
 * Run: npm test   (or: node scripts/smoke-test.js)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocket } = require('ws');

const PORT = Number(process.env.TEST_PORT || 3777);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  ✅', name);
  } else {
    failed++;
    console.error('  ❌', name, extra);
  }
}

class Client {
  constructor(name) {
    this.name = name;
    this.events = [];
    this.ws = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws.on('message', (d) => this.events.push(JSON.parse(d)));
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  async waitFor(type, pred = () => true, timeout = 6000, label = '') {
    const start = Date.now();
    let hit = this.events.find((e) => e.type === type && pred(e));
    while (!hit) {
      if (Date.now() - start > timeout) {
        throw new Error(`timeout waiting for "${type}" ${label} on ${this.name}`);
      }
      await sleep(60);
      hit = this.events.find((e) => e.type === type && pred(e));
    }
    return hit;
  }
  close() {
    if (this.ws) this.ws.close();
  }
}

function httpPostJson(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') });
          } catch {
            resolve({ status: res.statusCode, json: {} });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// smallest valid 1x1 PNG
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeWavDataUrl() {
  const sr = 8000;
  const n = 1600; // 0.2s sine wave
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 6) * 12000), 44 + i * 2);
  return 'data:audio/wav;base64,' + buf.toString('base64');
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a-chat-test-'));

  // Pre-seed a LEGACY messages.json (pre-convoId format) to verify migration.
  fs.writeFileSync(
    path.join(dataDir, 'messages.json'),
    JSON.stringify({
      'Alice::Bob': [
        { id: 9001, from: 'Bob', to: 'Alice', text: 'legacy hello', ts: Date.now() - 60000, delivered: true, read: false },
      ],
    })
  );

  console.log(`Starting server on :${PORT} (data: ${dataDir})`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stderr.write('[server!] ' + d));

  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      await httpGet(PORT, '/healthz');
      up = true;
    } catch {
      await sleep(100);
    }
  }
  if (!up) throw new Error('server did not start');

  try {
    console.log('\n— join & presence —');
    const alice = new Client('Alice');
    const bob = new Client('Bob');
    await alice.connect();
    await bob.connect();
    alice.send({ type: 'join', name: 'Alice' });
    bob.send({ type: 'join', name: 'Bob' });
    const ja = await alice.waitFor('joined');
    const jb = await bob.waitFor('joined');
    ok('both clients joined', ja.name === 'Alice' && jb.name === 'Bob');
    ok(
      'bot avatars (SVG) present in users list',
      ['Aria', 'Max', 'DJ Nova'].every((n) => {
        const u = ja.users.find((x) => x.name === n);
        return u && typeof u.pic === 'string' && u.pic.endsWith('.svg');
      })
    );

    console.log('\n— legacy history migration —');
    const dmAB = 'dm::Alice::Bob';
    alice.send({ type: 'history', convoId: dmAB });
    const h = await alice.waitFor('history', (e) => e.convoId === dmAB);
    const legacy = h.messages.find((m) => m.text === 'legacy hello');
    ok(
      'old "A::B" message migrated to dm:: convoId + readBy arrays',
      !!legacy && legacy.convoId === dmAB && Array.isArray(legacy.deliveredBy) && Array.isArray(legacy.readBy)
    );

    console.log('\n— DM + read receipts —');
    alice.send({ type: 'message', convoId: dmAB, kind: 'text', text: 'hi Bob' });
    const bmsg = await bob.waitFor('message', (e) => e.message.text === 'hi Bob');
    ok('DM reaches Bob', !!bmsg);
    ok('deliveredBy tracks Bob (online recipient)', bmsg.message.deliveredBy.includes('Bob'));
    bob.send({ type: 'read', convoId: dmAB });
    const stat = await alice.waitFor('status', (e) => e.id === bmsg.message.id && (e.readBy || []).includes('Bob'));
    ok('read receipt (blue tick state) reaches Alice', !!stat);

    console.log('\n— group chat —');
    alice.send({ type: 'group_create', name: 'Test Pack', members: ['Bob', 'Aria'] });
    const gc = await alice.waitFor('group_created');
    const gid = gc.group.id;
    ok('group id uses grp:: prefix', gid.startsWith('grp::'));
    ok(
      'members include creator + invitees (Bob, bot Aria)',
      gc.group.members.includes('Alice') && gc.group.members.includes('Bob') && gc.group.members.includes('Aria')
    );
    await bob.waitFor('groups', (e) => e.groups.some((g) => g.id === gid));
    ok('group broadcast reached Bob (member)', true);

    alice.send({ type: 'message', convoId: gid, kind: 'text', text: 'welcome to the pack' });
    const gmsgB = await bob.waitFor('message', (e) => e.message.convoId === gid && e.message.text === 'welcome to the pack');
    ok('group message reaches Bob', !!gmsgB);
    ok('bot member Aria auto-delivered+read', gmsgB.message.deliveredBy.includes('Aria') && gmsgB.message.readBy.includes('Aria'));
    bob.send({ type: 'read', convoId: gid });
    const gstat = await alice.waitFor(
      'status',
      (e) => e.convoId === gid && (e.readBy || []).includes('Bob') && (e.readBy || []).includes('Aria')
    );
    ok('group ticks aggregate across members (Bob + Aria read)', !!gstat);

    // non-member cannot read the group history
    alice.send({ type: 'history', convoId: 'grp::doesnotexist' });
    const emptyH = await alice.waitFor('history', (e) => e.convoId === 'grp::doesnotexist');
    ok('history for unknown convo returns empty', Array.isArray(emptyH.messages) && emptyH.messages.length === 0);

    console.log('\n— upload API + photo message —');
    const up1 = await httpPostJson(PORT, '/api/upload', { dataUrl: PNG_DATA_URL, name: 'dot.png' });
    ok('POST /api/upload accepts base64 data URL', up1.status === 200 && up1.json.ok && /^\/uploads\/.+\.png$/.test(up1.json.url));
    const img = await httpGet(PORT, up1.json.url);
    ok('uploaded file served at /uploads with image/png', img.status === 200 && (img.headers['content-type'] || '').includes('image/png'));

    alice.send({ type: 'message', convoId: gid, kind: 'photo', text: 'my pic', media: { url: up1.json.url, w: 1, h: 1, name: 'dot.png' } });
    const photoB = await bob.waitFor('message', (e) => e.message.convoId === gid && e.message.kind === 'photo');
    ok('photo message reaches Bob with media url', photoB.message.media.url === up1.json.url && photoB.message.text === 'my pic');
    const botPhoto = await alice.waitFor('message', (e) => e.message.convoId === gid && e.message.from === 'Aria', 12000);
    ok('Aria reacts to a photo in the group', !!botPhoto);

    const badType = await httpPostJson(PORT, '/api/upload', { dataUrl: 'data:application/pdf;base64,JVBERi0=' });
    ok('non image/audio upload rejected (415)', badType.status === 415 || badType.json.ok === false);

    console.log('\n— voice notes —');
    const up2 = await httpPostJson(PORT, '/api/upload', { dataUrl: makeWavDataUrl(), name: 'clip.wav' });
    ok('audio upload accepted (.wav)', up2.status === 200 && up2.json.ok && up2.json.url.endsWith('.wav'));
    const wave = Array.from({ length: 40 }, (_, i) => ((i % 5) + 1) * 18);
    alice.send({ type: 'message', convoId: dmAB, kind: 'voice', text: '', media: { url: up2.json.url, duration: 1.2, wave } });
    const voiceB = await bob.waitFor('message', (e) => e.message.kind === 'voice' && e.message.convoId === dmAB);
    ok(
      'voice message reaches Bob with 40-bar waveform',
      Array.isArray(voiceB.message.media.wave) && voiceB.message.media.wave.length === 40
    );
    alice.send({ type: 'message', convoId: 'dm::Alice::Aria', kind: 'voice', text: '', media: { url: up2.json.url, duration: 1.0, wave } });
    const ariaVoice = await alice.waitFor('message', (e) => e.message.convoId === 'dm::Alice::Aria' && e.message.from === 'Aria', 12000);
    ok('Aria reacts to a voice note in DM', !!ariaVoice);

    console.log('\n— oversized upload —');
    const bigBody = 'data:image/png;base64,' + Buffer.alloc(9 * 1024 * 1024).toString('base64');
    const bigRes = await httpPostJson(PORT, '/api/upload', { dataUrl: bigBody });
    ok('upload over 8MB rejected (413)', bigRes.status === 413 || bigRes.json.ok === false);

    console.log('\n— profile pictures —');
    alice.send({ type: 'profile_set', pic: up1.json.url });
    await alice.waitFor('profile_saved', (e) => e.pic === up1.json.url);
    await bob.waitFor('users', (e) => e.users.some((u) => u.name === 'Alice' && u.pic === up1.json.url));
    ok('profile pic broadcast to everyone', true);

    console.log('\n— message reactions —');
    // Send a DM from Alice so Bob can react to it
    alice.send({ type: 'message', convoId: dmAB, kind: 'text', text: 'react to this!' });
    const reactTarget = await bob.waitFor('message', (e) => e.message.text === 'react to this!');
    ok('message available for reaction', !!reactTarget);
    // Bob reacts with ❤️
    bob.send({ type: 'react', convoId: dmAB, id: reactTarget.message.id, emoji: '❤️', add: true });
    const reactUpdate = await alice.waitFor('reaction', (e) => e.id === reactTarget.message.id);
    ok('reaction broadcast to Alice', !!reactUpdate && reactUpdate.reactions['❤️'] && reactUpdate.reactions['❤️'].includes('Bob'));
    // Bob removes the reaction
    bob.send({ type: 'react', convoId: dmAB, id: reactTarget.message.id, emoji: '❤️', add: false });
    const reactRemove = await alice.waitFor('reaction', (e) => e.id === reactTarget.message.id && (!e.reactions['❤️'] || !e.reactions['❤️'].includes('Bob')));
    ok('reaction removal broadcast', !!reactRemove);
    // Invalid emoji is rejected (no reaction event)
    const eventsBefore = alice.events.length;
    bob.send({ type: 'react', convoId: dmAB, id: reactTarget.message.id, emoji: '🚀', add: true });
    await sleep(300);
    const newReactEvents = alice.events.slice(eventsBefore).filter((e) => e.type === 'reaction' && e.id === reactTarget.message.id);
    ok('invalid emoji rejected (no reaction broadcast)', newReactEvents.length === 0);

    console.log('\n— user accounts —');
    // Use a third client for auth tests
    const carol = new Client('Carol');
    await carol.connect();
    // Register
    carol.send({ type: 'register', username: 'Carol', password: 'secret123' });
    const authOk = await carol.waitFor('auth_ok');
    ok('register returns auth_ok with token', authOk.username === 'Carol' && typeof authOk.token === 'string' && authOk.isNew === true);
    // Duplicate registration
    const dave = new Client('Dave');
    await dave.connect();
    dave.send({ type: 'register', username: 'Carol', password: 'other' });
    const dupErr = await dave.waitFor('auth_error');
    ok('duplicate registration rejected', dupErr.error.includes('already taken'));
    // Login with correct password
    dave.send({ type: 'login', username: 'Carol', password: 'secret123' });
    const loginOk = await dave.waitFor('auth_ok');
    ok('login with correct password succeeds', loginOk.username === 'Carol' && loginOk.isNew === false);
    // Login with wrong password
    const eve = new Client('Eve');
    await eve.connect();
    eve.send({ type: 'login', username: 'Carol', password: 'wrong' });
    const badLogin = await eve.waitFor('auth_error');
    ok('login with wrong password rejected', badLogin.error.includes('Incorrect'));
    // Short password rejected
    const frank = new Client('Frank');
    await frank.connect();
    frank.send({ type: 'register', username: 'Frank', password: 'ab' });
    const shortPw = await frank.waitFor('auth_error');
    ok('short password rejected', shortPw.error.includes('at least 3'));
    frank.close();
    // Join after registration
    carol.send({ type: 'join', name: 'Carol', token: authOk.token });
    const carolJoined = await carol.waitFor('joined');
    ok('join after auth returns rooms array', Array.isArray(carolJoined.rooms));
    dave.close();
    eve.close();

    console.log('\n— rooms —');
    // Alice creates a room
    alice.send({ type: 'room_create', name: 'Secret Club', password: 'pass123' });
    const roomCreated = await alice.waitFor('room_created');
    ok('room created with invite code', roomCreated.room.name === 'Secret Club' && typeof roomCreated.room.inviteCode === 'string' && roomCreated.room.inviteCode.length === 6);
    const roomId = roomCreated.room.id;
    ok('room id uses room:: prefix', roomId.startsWith('room::'));

    // Bob joins with correct password
    bob.send({ type: 'room_join', roomId, password: 'pass123', inviteCode: '' });
    const bobJoined = await bob.waitFor('room_joined', (e) => e.room.id === roomId);
    ok('room join with correct password', bobJoined.room.members.includes('Bob'));
    // Bob is now notified to Alice
    await alice.waitFor('room_member_joined', (e) => e.roomId === roomId && e.member === 'Bob');
    ok('room member joined notification', true);

    // Bob tries wrong password (need new room)
    alice.send({ type: 'room_create', name: 'VIP Room', password: 'vip999' });
    const room2 = await alice.waitFor('room_created');
    const room2Id = room2.room.id;
    // Use Carol (who is already connected from auth tests but not a member of room2)
    carol.send({ type: 'room_join', roomId: room2Id, password: 'wrong', inviteCode: '' });
    const roomErr = await carol.waitFor('error', (e) => (e.error || '').includes('Incorrect'));
    ok('room join with wrong password rejected', !!roomErr);

    // Join by invite code (bypasses password)
    carol.send({ type: 'room_join', roomId: '', inviteCode: roomCreated.room.inviteCode, password: '' });
    const carolRoomJoined = await carol.waitFor('room_joined', (e) => e.room.id === roomId);
    ok('room join by invite code', carolRoomJoined.room.members.includes('Carol'));

    // Send message in room
    alice.send({ type: 'message', convoId: roomId, kind: 'text', text: 'welcome to the secret club' });
    const roomMsg = await bob.waitFor('message', (e) => e.message.convoId === roomId && e.message.text === 'welcome to the secret club');
    ok('room message reaches members', !!roomMsg);
    // Non-member cannot read room history
    // Use a fresh client that is not a member of room2
    const guest = new Client('Guest');
    await guest.connect();
    guest.send({ type: 'join', name: 'Guest' });
    await guest.waitFor('joined');
    guest.send({ type: 'history', convoId: room2Id });
    const noAccess = await guest.waitFor('history', (e) => e.convoId === room2Id);
    ok('non-member gets empty history for room', Array.isArray(noAccess.messages) && noAccess.messages.length === 0);
    guest.close();

    carol.close();

    console.log('\n— persistence —');
    await sleep(800); // allow debounced save
    ok('messages.json persisted', fs.existsSync(path.join(dataDir, 'messages.json')));
    const groupsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'groups.json'), 'utf8'));
    ok('groups.json persisted with the new group', groupsRaw.some((g) => g.id === gid && g.name === 'Test Pack'));
    const usersRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    ok(
      'users.json persisted (Alice pic + bot avatars)',
      usersRaw.Alice && usersRaw.Alice.pic === up1.json.url && usersRaw.Aria.pic.endsWith('.svg') && usersRaw['DJ Nova'].pic.endsWith('.svg')
    );
    ok('accounts.json persisted', fs.existsSync(path.join(dataDir, 'accounts.json')));
    const accountsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    ok('account stored with salt and hash', accountsRaw.carol && accountsRaw.carol.salt && accountsRaw.carol.hash);
    const roomsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'rooms.json'), 'utf8'));
    ok('rooms.json persisted with new rooms', roomsRaw.length >= 2 && roomsRaw.some((r) => r.name === 'Secret Club'));

    alice.close();
    bob.close();
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
