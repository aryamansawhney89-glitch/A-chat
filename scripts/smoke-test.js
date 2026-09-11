'use strict';

/**
 * A-Chat smoke test — spins up a fresh server on a scratch data dir and
 * exercises it with two WebSocket clients:
 *   join → DM + delivered/read receipts → group create + group message +
 *   aggregated receipts → photo upload + message (bot reacts) → voice upload
 *   + message (bot reacts) → profile picture broadcast → voice call signalling
 *   (invite/accept/SDP relay/hang-up/missed) → video call signalling (kind
 *   end-to-end, history callKind, voice default) → message replies (quote
 *   snapshots, group replies, tombstones) → message edits (ownership, blank
 *   rejection, history persistence) → message deletes (ownership, tombstone,
 *   reactions wiped, edit/react-after-delete rejected) → group calls (multi-ring,
 *   partial decline, member added mid-call via call_add, leave lifecycle, call
 *   log) → privacy & Ghost Mode (per-setting toggles, hidden presence,
 *   suppressed read receipts / typing / delivery, call gating, persistence) →
 *   GIF search API (provider chain against stub providers: GIPHY + Tenor
 *   payload shapes, rendition selection, caching, failover, stale-cache and
 *   error fallbacks) → polls (tallies
 *   broadcast, toggle votes, close permissions) → forwarding (origin label,
 *   membership check) → oversized upload rejected → JSON persistence (with legacy
 *   messages.json migration).
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

// Poll until fn() returns truthy (used to wait for broadcasts that don't have
// their own waitFor-able event shape).
async function waitUntil(fn, timeout = 4000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) return false;
    await sleep(50);
  }
  return true;
}

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

  // Stub GIF providers so /api/gifs can be exercised offline. Both configured
  // providers are served by one tiny server: GIPHY-shaped results under /giphy,
  // Tenor-shaped under /v1, which is what lets the failover be tested too.
  const GIF_PORT = Number(process.env.TEST_GIF_PORT || PORT + 1);
  const gifState = { fail: false, hits: [] };
  const giphyPayload = () => ({
    data: [
      {
        id: 'g1',
        title: 'party bob',
        images: {
          fixed_width: { url: 'https://media.giphy.com/media/g1/fixed_width.gif', width: '480', height: '360' },
          fixed_width_small: { url: 'https://media.giphy.com/media/g1/small.gif', width: '200', height: '150' },
          original: { url: 'https://media.giphy.com/media/g1/giphy.gif', width: '480', height: '360' },
        },
      },
      {
        id: 'g2',
        slug: 'confetti-cat',
        images: {
          fixed_width_downsampled: { url: 'https://media.giphy.com/media/g2/down.gif', width: '400', height: '300' },
          downsized_small: { url: 'https://media.giphy.com/media/g2/small.gif', width: '220', height: '165' },
          // mp4 renditions must never be offered: the message sanitizer would reject them
          looping: { url: 'https://media.giphy.com/media/g2/loop.mp4', width: '400', height: '300' },
        },
      },
      // junk that must be dropped: a javascript: url, and a gif with no renditions
      { id: 'g3', images: { original: { url: 'javascript:alert(1)' } } },
      { id: 'g4', images: {} },
    ],
  });
  const tenorPayload = () => ({
    results: [
      {
        id: 'p1',
        title: 'party bob',
        media: [
          {
            nanogif: { url: 'https://media.tenor.com/nano/party.gif', dims: { width: 220, height: 160 } },
            tinygif: { url: 'https://media.tenor.com/tiny/party.gif', dims: { width: 320, height: 240 } },
            gif: { url: 'https://media.tenor.com/full/party.gif', dims: { width: 498, height: 373 } },
          },
        ],
      },
      { id: 'p2', content_description: 'confetti cat', media_formats: { tinygif: { url: 'https://media.tenor.com/tiny/confetti.gif', dims: { w: 220, h: 165 } }, gif: { url: 'https://media.tenor.com/full/confetti.gif', dims: { w: 400, h: 300 } } } },
    ],
  });
  const gifMock = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${GIF_PORT}`);
    gifState.hits.push(url.pathname + url.search);
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (gifState.fail) return send(500, { error: 'provider down' });
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const isGiphy = url.pathname.startsWith('/giphy');
    if (q === 'boom') return send(500, { error: 'kaboom' });
    if (q === 'tenoronly' && isGiphy) return send(500, { error: 'giphy is down' });
    if (q === 'mp4only') return send(200, isGiphy
      ? { data: [{ id: 'v1', images: { looping: { url: 'https://media.giphy.com/media/v1/loop.mp4' } } }] }
      : { results: [{ id: 'v1', media_formats: { loop: { url: 'https://media.tenor.com/clip.mp4', dims: { w: 100, h: 100 } } } }] });
    if (q === 'nothing') return send(200, isGiphy ? { data: [] } : { results: [] });
    if (isGiphy && (url.pathname.endsWith('/search') || url.pathname.endsWith('/trending'))) return send(200, giphyPayload());
    if (!isGiphy && (url.pathname === '/v1/search' || url.pathname === '/v1/trending')) return send(200, tenorPayload());
    return send(404, { error: 'not found' });
  });
  await new Promise((r) => gifMock.listen(GIF_PORT, '127.0.0.1', r));

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
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      CALL_RING_TIMEOUT_MS: '1500',
      // point the GIF proxy at the stub, with a short TTL so cache expiry is testable
      GIF_PROVIDERS: 'giphy,klipy,tenor',
      GIPHY_API_BASE: `http://127.0.0.1:${GIF_PORT}/giphy`,
      TENOR_API_BASE: `http://127.0.0.1:${GIF_PORT}/v1`,
      GIF_CACHE_TTL_MS: '3000',
    },
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

    // MediaRecorder keeps codec params in the blob type and FileReader copies
    // them into the data URL — the upload must not reject those.
    const WAV_B64 = makeWavDataUrl().split(',')[1];
    const opusWebm = await httpPostJson(PORT, '/api/upload', {
      dataUrl: `data:audio/webm;codecs=opus;base64,${WAV_B64}`, name: 'voice-note.webm',
    });
    ok('data URL with codec params accepted (audio/webm;codecs=opus)',
      opusWebm.status === 200 && opusWebm.json.ok && opusWebm.json.url.endsWith('.webm'),
      JSON.stringify(opusWebm.json));
    const opusWebmServed = await httpGet(PORT, opusWebm.json.url);
    ok('voice note served as audio/webm (playable in <audio>)',
      opusWebmServed.status === 200 && (opusWebmServed.headers['content-type'] || '').startsWith('audio/webm'),
      opusWebmServed.headers['content-type']);
    ok('voice note supports range requests (seeking)',
      (opusWebmServed.headers['accept-ranges'] || '') === 'bytes');
    const safariMp4 = await httpPostJson(PORT, '/api/upload', {
      dataUrl: `data:audio/mp4;codecs=mp4a.40.2;base64,${WAV_B64}`, name: 'voice-note.m4a',
    });
    ok('Safari data URL accepted (audio/mp4;codecs=mp4a.40.2)',
      safariMp4.status === 200 && safariMp4.json.ok && safariMp4.json.url.endsWith('.m4a'),
      JSON.stringify(safariMp4.json));
    const junkUrl = await httpPostJson(PORT, '/api/upload', { dataUrl: 'data:audio/webm;base64,not-base64!!' });
    ok('malformed base64 payload still rejected (400)', junkUrl.status === 400);
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

    console.log('\n— message replies —');
    // Bob asks, Alice quotes him in her reply
    bob.send({ type: 'message', convoId: dmAB, kind: 'text', text: 'what is the plan?' });
    const origQ = await alice.waitFor('message', (e) => e.message.text === 'what is the plan?');
    alice.send({ type: 'message', convoId: dmAB, kind: 'text', text: 'dinner at 8!', replyTo: origQ.message.id });
    const replyB = await bob.waitFor('message', (e) => e.message.text === 'dinner at 8!');
    ok(
      'reply carries a replyTo snapshot of the original',
      !!replyB.message.replyTo && replyB.message.replyTo.id === origQ.message.id &&
        replyB.message.replyTo.from === 'Bob' && replyB.message.replyTo.text === 'what is the plan?',
      JSON.stringify(replyB.message.replyTo)
    );

    // a replyTo pointing at nothing is dropped, message still goes through
    bob.send({ type: 'message', convoId: dmAB, kind: 'text', text: 'no parent here', replyTo: 424242 });
    const bogus = await bob.waitFor('message', (e) => e.message.text === 'no parent here');
    ok('unknown replyTo id ignored (message still sent)', !bogus.message.replyTo);

    // replies also work in groups
    bob.send({ type: 'message', convoId: gid, kind: 'text', text: 'group question' });
    const gQ = await alice.waitFor('message', (e) => e.message.convoId === gid && e.message.text === 'group question');
    alice.send({ type: 'message', convoId: gid, kind: 'text', text: 'group answer', replyTo: gQ.message.id });
    const gReply = await bob.waitFor('message', (e) => e.message.convoId === gid && e.message.text === 'group answer');
    ok('replies work in group chats', !!gReply.message.replyTo && gReply.message.replyTo.id === gQ.message.id);

    console.log('\n— message edits —');
    const beforeForeignEdit = bob.events.length;
    bob.send({ type: 'edit', convoId: dmAB, id: replyB.message.id, text: 'Bob should not edit this' });
    await sleep(300);
    ok(
      'cannot edit someone else\'s message',
      !bob.events.slice(beforeForeignEdit).some((e) => e.type === 'message_edited')
    );

    alice.send({ type: 'edit', convoId: dmAB, id: replyB.message.id, text: 'dinner at 9!' });
    const editedB = await bob.waitFor('message_edited', (e) => e.id === replyB.message.id);
    ok('edit broadcast reaches the other side', editedB.text === 'dinner at 9!' && editedB.editedAt > 0);

    alice.send({ type: 'history', convoId: dmAB });
    const histAfterEdit = await alice.waitFor(
      'history',
      (e) => e.convoId === dmAB && (e.messages || []).some((m) => m.id === replyB.message.id && m.editedAt)
    );
    const editedMsg = histAfterEdit.messages.find((m) => m.id === replyB.message.id);
    ok('history persists edited text + editedAt', editedMsg.text === 'dinner at 9!' && Number.isFinite(editedMsg.editedAt));

    const beforeBlankEdit = alice.events.length;
    alice.send({ type: 'edit', convoId: dmAB, id: replyB.message.id, text: '   ' });
    await sleep(300);
    ok(
      'blank edit of a text message rejected',
      !alice.events.slice(beforeBlankEdit).some((e) => e.type === 'message_edited')
    );

    console.log('\n— message deletes —');
    const beforeForeignDel = alice.events.length;
    bob.send({ type: 'delete', convoId: dmAB, id: replyB.message.id });
    await sleep(300);
    ok(
      'cannot delete someone else\'s message',
      !alice.events.slice(beforeForeignDel).some((e) => e.type === 'message_deleted')
    );

    // a reaction on the message must vanish when the message is deleted
    bob.send({ type: 'react', convoId: dmAB, id: replyB.message.id, emoji: '👍', add: true });
    await alice.waitFor('reaction', (e) => e.id === replyB.message.id && (e.reactions['👍'] || []).includes('Bob'));

    alice.send({ type: 'delete', convoId: dmAB, id: replyB.message.id });
    const delB = await bob.waitFor('message_deleted', (e) => e.id === replyB.message.id);
    ok('delete broadcast reaches the other side', !!delB);

    alice.send({ type: 'history', convoId: dmAB });
    const histAfterDel = await alice.waitFor(
      'history',
      (e) => e.convoId === dmAB && (e.messages || []).some((m) => m.id === replyB.message.id && m.deleted)
    );
    const delMsg = histAfterDel.messages.find((m) => m.id === replyB.message.id);
    ok('history keeps a tombstone (text + media cleared)', delMsg.deleted === true && delMsg.text === '' && delMsg.media === null);
    ok('reactions cleared on delete', !delMsg.reactions || Object.keys(delMsg.reactions).length === 0);

    const beforeRevive = alice.events.length;
    alice.send({ type: 'edit', convoId: dmAB, id: replyB.message.id, text: 'back from the dead' });
    await sleep(300);
    ok(
      'deleted message cannot be edited',
      !alice.events.slice(beforeRevive).some((e) => e.type === 'message_edited')
    );

    // quoting a deleted message yields a tombstone snapshot
    bob.send({ type: 'message', convoId: dmAB, kind: 'text', text: 'what did it say?', replyTo: replyB.message.id });
    const delReply = await alice.waitFor('message', (e) => e.message.text === 'what did it say?');
    ok(
      'reply to a deleted message snapshots it as deleted',
      !!delReply.message.replyTo && delReply.message.replyTo.deleted === true && delReply.message.replyTo.text === '',
      JSON.stringify(delReply.message.replyTo)
    );

    const beforeDeadReact = bob.events.length;
    bob.send({ type: 'react', convoId: dmAB, id: replyB.message.id, emoji: '❤️', add: true });
    await sleep(300);
    ok(
      'reactions on deleted messages rejected',
      !bob.events.slice(beforeDeadReact).some((e) => e.type === 'reaction' && e.id === replyB.message.id)
    );

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

    console.log('\n— session restore (reopen) —');
    // Register a user, then simulate closing + reopening the tab: a NEW
    // connection that immediately joins with the stored {name, token}
    // (what the client sends from connect() onopen after restoring state).
    const zed = new Client('Zed');
    await zed.connect();
    zed.send({ type: 'register', username: 'Zed', password: 'zedpass1' });
    const zedAuth = await zed.waitFor('auth_ok');
    zed.send({ type: 'join', name: zedAuth.username, token: zedAuth.token });
    await zed.waitFor('joined');
    zed.close(); // close the tab
    await sleep(200);

    const zedAgain = new Client('ZedAgain');
    await zedAgain.connect();
    zedAgain.send({ type: 'join', name: 'Zed', token: zedAuth.token });
    const rejoin = await zedAgain.waitFor('joined');
    ok('reopen with stored session token rejoins as same user', rejoin.name === 'Zed');
    ok(
      'rejoin payload carries users/groups/rooms for render',
      Array.isArray(rejoin.users) && Array.isArray(rejoin.groups) && Array.isArray(rejoin.rooms)
    );
    zedAgain.close();

    // Stale token (e.g. server restarted, sessions wiped) must still join by
    // name rather than leaving the client stranded on a black screen.
    const stale = new Client('Stale');
    await stale.connect();
    stale.send({ type: 'join', name: 'Zed', token: 'dead-token-123' });
    const staleJoin = await stale.waitFor('joined');
    ok('join with stale token falls back to name', staleJoin.name === 'Zed');
    stale.close();

    console.log('\n— voice call signalling —');
    // bots and offline users cannot answer a call
    alice.send({ type: 'call_invite', convoId: 'dm::Alice::Aria' });
    const botCall = await alice.waitFor('call_failed', (e) => e.convoId === 'dm::Alice::Aria');
    ok('calling a bot reports "nobody" to call', botCall.reason === 'nobody', JSON.stringify(botCall));
    alice.send({ type: 'call_invite', convoId: 'dm::Alice::Nobody' });
    const offlineCall = await alice.waitFor('call_failed', (e) => e.convoId === 'dm::Alice::Nobody');
    ok('calling an offline user reports "offline"', offlineCall.reason === 'offline', JSON.stringify(offlineCall));

    // Alice rings Bob
    alice.send({ type: 'call_invite', convoId: dmAB });
    const created = await alice.waitFor('call_created', (e) => e.convoId === dmAB);
    const callId = created.callId;
    ok('caller gets call_created with a call id', typeof callId === 'string' && callId.length > 0);
    const inviteB = await bob.waitFor('call_invite', (e) => e.callId === callId);
    ok('callee is rung with caller + convo', inviteB.from === 'Alice' && inviteB.convoId === dmAB);

    // Bob answers: the earlier joiner (Alice) must be the one to offer SDP
    bob.send({ type: 'call_accept', callId });
    const joinA = await alice.waitFor('call_join', (e) => e.callId === callId);
    ok('caller is told to send the offer to the answerer', joinA.isYou === false && joinA.offerTo === 'Bob', JSON.stringify(joinA));
    const joinB = await bob.waitFor('call_join', (e) => e.callId === callId && e.isYou === true);
    ok('answerer receives the peers it should expect offers from', Array.isArray(joinB.peers) && joinB.peers.includes('Alice'));

    // SDP + ICE relay
    alice.send({ type: 'call_signal', callId, to: 'Bob', sdp: { type: 'offer', sdp: 'v=0\r\nfake-sdp' } });
    const sdpB = await bob.waitFor('call_signal', (e) => e.callId === callId && e.sdp);
    ok('SDP offer relayed with the sender attached', sdpB.from === 'Alice' && sdpB.sdp.type === 'offer');
    bob.send({
      type: 'call_signal', callId, to: 'Alice',
      candidate: { candidate: 'candidate:1 1 udp 2122 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    const iceA = await alice.waitFor('call_signal', (e) => e.callId === callId && e.candidate);
    ok('ICE candidate relayed back to the caller', iceA.from === 'Bob' && iceA.candidate.candidate.includes('udp'));

    // outsiders cannot inject signalling, and Bob reads as busy
    const intruder = new Client('Intruder');
    await intruder.connect();
    intruder.send({ type: 'join', name: 'Intruder' });
    await intruder.waitFor('joined');
    const signalsBefore = bob.events.length;
    intruder.send({ type: 'call_signal', callId, to: 'Bob', sdp: { type: 'offer', sdp: 'v=0\r\nintruder' } });
    await sleep(250);
    const leaked = bob.events.slice(signalsBefore).filter((e) => e.type === 'call_signal' && e.sdp && e.sdp.sdp.includes('intruder'));
    ok('non-participants cannot relay signalling into a call', leaked.length === 0);
    intruder.send({ type: 'call_invite', convoId: 'dm::Bob::Intruder' });
    const busy = await intruder.waitFor('call_failed', (e) => e.convoId === 'dm::Bob::Intruder');
    ok('calling someone already on a call reports "busy"', busy.reason === 'busy', JSON.stringify(busy));
    intruder.close();

    // Bob hangs up → caller notified, call logged in history
    bob.send({ type: 'call_leave', callId });
    await alice.waitFor('call_peer_left', (e) => e.callId === callId && e.name === 'Bob');
    ok('caller sees the peer leave', true);
    const endedA = await alice.waitFor('call_ended', (e) => e.callId === callId);
    ok('hang-up ends the call for the remaining side', endedA.reason === 'ended' && endedA.duration >= 0);
    alice.send({ type: 'history', convoId: dmAB });
    const afterCall = await alice.waitFor('history', (e) => e.convoId === dmAB && (e.messages || []).some((m) => m.kind === 'call'));
    const callMsg = afterCall.messages.filter((m) => m.kind === 'call').pop();
    ok('finished call is logged in history as kind "call"', callMsg.media.status === 'completed' && callMsg.from === 'Alice');
    ok('call log carries the participants', callMsg.media.members.includes('Bob'));

    // unanswered call → ring timeout (CALL_RING_TIMEOUT_MS=1500 for the test server)
    const carolBack = new Client('CarolBack');
    await carolBack.connect();
    carolBack.send({ type: 'join', name: 'Carol' });
    await carolBack.waitFor('joined');
    alice.send({ type: 'call_invite', convoId: 'dm::Alice::Carol' });
    const created2 = await alice.waitFor('call_created', (e) => e.convoId === 'dm::Alice::Carol');
    await carolBack.waitFor('call_invite', (e) => e.callId === created2.callId);
    const timedOut = await alice.waitFor('call_ended', (e) => e.callId === created2.callId, 8000);
    ok('unanswered call times out for the caller', timedOut.reason === 'timeout');
    await carolBack.waitFor('call_cancelled', (e) => e.callId === created2.callId, 8000);
    ok('ringing callee is told the call was cancelled', true);
    carolBack.send({ type: 'history', convoId: 'dm::Alice::Carol' });
    const missedH = await carolBack.waitFor('history', (e) => e.convoId === 'dm::Alice::Carol' && (e.messages || []).some((m) => m.kind === 'call'), 8000);
    const missed = missedH.messages.filter((m) => m.kind === 'call').pop();
    ok('missed call logged with status "missed" and 0s', missed.media.status === 'missed' && missed.media.duration === 0);
    carolBack.close();

    // declined call
    const dora = new Client('Dora');
    await dora.connect();
    dora.send({ type: 'join', name: 'Dora' });
    await dora.waitFor('joined');
    alice.send({ type: 'call_invite', convoId: 'dm::Alice::Dora' });
    const created3 = await alice.waitFor('call_created', (e) => e.convoId === 'dm::Alice::Dora');
    await dora.waitFor('call_invite', (e) => e.callId === created3.callId);
    dora.send({ type: 'call_reject', callId: created3.callId });
    const declined = await alice.waitFor('call_ended', (e) => e.callId === created3.callId, 8000);
    ok('declined call ends for the caller with reason "declined"', declined.reason === 'declined');
    dora.close();

    console.log('\n— video call signalling —');
    // Fresh users so every convoId below is new (waitFor also scans old events).
    const vera = new Client('Vera');
    const victor = new Client('Victor');
    await vera.connect();
    await victor.connect();
    vera.send({ type: 'join', name: 'Vera' });
    victor.send({ type: 'join', name: 'Victor' });
    await vera.waitFor('joined');
    await victor.waitFor('joined');
    const dmVV = 'dm::Vera::Victor';

    vera.send({ type: 'call_invite', convoId: dmVV, kind: 'video' });
    const vCreated = await vera.waitFor('call_created', (e) => e.convoId === dmVV);
    ok('video invite yields call_created with kind "video"',
      vCreated.kind === 'video' && typeof vCreated.callId === 'string', JSON.stringify(vCreated));
    const vInvite = await victor.waitFor('call_invite', (e) => e.callId === vCreated.callId);
    ok('callee rung with kind "video"', vInvite.kind === 'video' && vInvite.from === 'Vera');

    victor.send({ type: 'call_accept', callId: vCreated.callId });
    const vJoinVictor = await victor.waitFor('call_join', (e) => e.callId === vCreated.callId && e.isYou === true);
    ok('video answerer join echoes kind "video"', vJoinVictor.kind === 'video' && vJoinVictor.peers.includes('Vera'));
    const vJoinVera = await vera.waitFor('call_join', (e) => e.callId === vCreated.callId && e.isYou === false);
    ok('video caller told to offer (kind echoed)',
      vJoinVera.offerTo === 'Victor' && vJoinVera.kind === 'video', JSON.stringify(vJoinVera));

    vera.send({ type: 'call_signal', callId: vCreated.callId, to: 'Victor', sdp: { type: 'offer', sdp: 'v=0\r\nfake-video-sdp' } });
    const vSdp = await victor.waitFor('call_signal', (e) => e.callId === vCreated.callId && e.sdp);
    ok('SDP offer relayed on a video call', vSdp.from === 'Vera' && vSdp.sdp.type === 'offer');

    victor.send({ type: 'call_leave', callId: vCreated.callId });
    const vEnded = await vera.waitFor('call_ended', (e) => e.callId === vCreated.callId);
    ok('video hang-up ends the call with kind "video"', vEnded.reason === 'ended' && vEnded.kind === 'video');
    vera.send({ type: 'history', convoId: dmVV });
    const vHist = await vera.waitFor('history', (e) => e.convoId === dmVV && (e.messages || []).some((m) => m.kind === 'call'));
    const vCallMsg = vHist.messages.filter((m) => m.kind === 'call').pop();
    ok('video call logged with callKind "video" + participants',
      vCallMsg.media.callKind === 'video' && vCallMsg.media.status === 'completed' &&
      vCallMsg.media.members.includes('Vera') && vCallMsg.media.members.includes('Victor'));

    // Backwards compatibility: invites without kind (old clients) are voice.
    vera.send({ type: 'call_invite', convoId: dmVV });
    const wCreated = await vera.waitFor('call_created', (e) => e.convoId === dmVV && e.callId !== vCreated.callId);
    ok('invite without kind defaults to "voice"', wCreated.kind === 'voice');
    const wInvite = await victor.waitFor('call_invite', (e) => e.callId === wCreated.callId);
    ok('defaulted invite reaches the callee as "voice"', wInvite.kind === 'voice');
    victor.send({ type: 'call_reject', callId: wCreated.callId });
    const wEnded = await vera.waitFor('call_ended', (e) => e.callId === wCreated.callId, 8000);
    ok('defaulted voice call declines cleanly', wEnded.reason === 'declined' && wEnded.kind === 'voice');

    // ... and so is any unknown kind value.
    vera.send({ type: 'call_invite', convoId: dmVV, kind: 'hologram' });
    const hCreated = await vera.waitFor('call_created', (e) => e.callId !== vCreated.callId && e.callId !== wCreated.callId);
    ok('unknown kind normalised to "voice"', hCreated.kind === 'voice');
    victor.send({ type: 'call_reject', callId: hCreated.callId });
    await vera.waitFor('call_ended', (e) => e.callId === hCreated.callId, 8000);
    ok('normalised call declines cleanly', true);
    vera.close();
    victor.close();

    console.log('\n— group calls + adding people mid-call —');
    // Fresh members: Chloe + Dave join up front so the server knows their profiles
    const chloe = new Client('Chloe');
    const daveFirst = new Client('DaveFirst');
    await chloe.connect();
    await daveFirst.connect();
    chloe.send({ type: 'join', name: 'Chloe' });
    daveFirst.send({ type: 'join', name: 'Dave' });
    await chloe.waitFor('joined');
    await daveFirst.waitFor('joined');

    alice.send({ type: 'group_create', name: 'Call Crew', members: ['Bob', 'Chloe', 'Dave'] });
    const crew = await alice.waitFor('group_created', (e) => e.group.name === 'Call Crew');
    const crewId = crew.group.id;
    ok('group payload carries createdBy/createdAt for the info panel',
      crew.group.createdBy === 'Alice' && Number.isFinite(crew.group.createdAt), JSON.stringify(crew.group));

    // Dave goes offline before the call starts → he is not rung initially
    daveFirst.close();
    await sleep(300);
    alice.send({ type: 'call_invite', convoId: crewId, kind: 'voice' });
    const crewCall = await alice.waitFor('call_created', (e) => e.convoId === crewId);
    ok('group call rings every online human member (offline one skipped)',
      crewCall.callees.includes('Bob') && crewCall.callees.includes('Chloe') && crewCall.callees.length === 2,
      JSON.stringify(crewCall.callees));
    const crewCallId = crewCall.callId;
    const chloeRing = await chloe.waitFor('call_invite', (e) => e.callId === crewCallId);
    ok('group invite carries the group convo + kind', chloeRing.convoId === crewId && chloeRing.kind === 'voice' && chloeRing.from === 'Alice');

    // Chloe answers, Bob declines — the call goes on with the two of them
    chloe.send({ type: 'call_accept', callId: crewCallId });
    const chloeIn = await chloe.waitFor('call_join', (e) => e.callId === crewCallId && e.isYou);
    ok('first answerer joins the group call', chloeIn.peers.includes('Alice'));
    bob.send({ type: 'call_reject', callId: crewCallId });
    await alice.waitFor('call_declined', (e) => e.callId === crewCallId && e.from === 'Bob');
    const aliceMarkAfterDecline = alice.events.length;
    await sleep(300);
    ok('one member declining does not end a group call',
      !alice.events.slice(aliceMarkAfterDecline).some((e) => e.type === 'call_ended' && e.callId === crewCallId));

    // Dave comes back online and Alice pulls him into the live call
    const daveBack = new Client('DaveBack');
    await daveBack.connect();
    daveBack.send({ type: 'join', name: 'Dave' });
    await daveBack.waitFor('joined');
    alice.send({ type: 'call_add', callId: crewCallId, to: ['Dave'] });
    const daveRing = await daveBack.waitFor('call_invite', (e) => e.callId === crewCallId);
    ok('member offline at call start can be added to an ongoing call', daveRing.from === 'Alice' && daveRing.kind === 'voice');
    const ringNote = await alice.waitFor('call_peer_ringing', (e) => e.callId === crewCallId);
    ok('existing talkers are told who is being rung', (ringNote.names || []).includes('Dave'));

    daveBack.send({ type: 'call_accept', callId: crewCallId });
    const daveIn = await daveBack.waitFor('call_join', (e) => e.callId === crewCallId && e.isYou);
    ok('added member gets the full mesh of peers', daveIn.peers.includes('Alice') && daveIn.peers.includes('Chloe'),
      JSON.stringify(daveIn.peers));
    await alice.waitFor('call_join', (e) => e.callId === crewCallId && e.offerTo === 'Dave');
    await chloe.waitFor('call_join', (e) => e.callId === crewCallId && e.offerTo === 'Dave');
    ok('everyone already in the call offers to the late joiner', true);

    // guards: adding a bot / someone already in / a stranger changes nothing
    const chloeMark = chloe.events.length;
    alice.send({ type: 'call_add', callId: crewCallId, to: ['Aria', 'Dave', 'Ghost'] });
    await sleep(300);
    ok('bot / duplicate / non-member add targets are ignored',
      !chloe.events.slice(chloeMark).some((e) => e.type === 'call_peer_ringing'));

    // Chloe hangs up — Alice and Dave keep talking
    chloe.send({ type: 'call_leave', callId: crewCallId });
    await daveBack.waitFor('call_peer_left', (e) => e.callId === crewCallId && e.name === 'Chloe');
    const aliceMarkAfterLeave = alice.events.length;
    await sleep(300);
    ok('group call continues while 2+ members remain',
      !alice.events.slice(aliceMarkAfterLeave).some((e) => e.type === 'call_ended' && e.callId === crewCallId));

    // Dave hangs up — Alice is alone → call ends and is logged
    daveBack.send({ type: 'call_leave', callId: crewCallId });
    const crewEnd = await alice.waitFor('call_ended', (e) => e.callId === crewCallId);
    ok('call ends when fewer than 2 talkers remain', crewEnd.reason === 'ended', JSON.stringify(crewEnd));
    alice.send({ type: 'history', convoId: crewId });
    const crewHist = await alice.waitFor('history', (e) => e.convoId === crewId && (e.messages || []).some((m) => m.kind === 'call'));
    const crewLog = crewHist.messages.filter((m) => m.kind === 'call').pop();
    ok('group call log lists everyone who picked up',
      crewLog.media.members.includes('Alice') && crewLog.media.members.includes('Chloe') && crewLog.media.members.includes('Dave'),
      JSON.stringify(crewLog.media.members));

    chloe.close();
    daveBack.close();

    console.log('\n— privacy & ghost mode —');
    const ghosty = new Client('Ghosty');
    const watcher = new Client('Watcher');
    await ghosty.connect();
    await watcher.connect();
    ghosty.send({ type: 'join', name: 'Ghosty' });
    watcher.send({ type: 'join', name: 'Watcher' });
    const jg = await ghosty.waitFor('joined');
    await watcher.waitFor('joined');
    const dmGW = 'dm::Ghosty::Watcher';

    ok(
      'joined payload carries default privacy (everything on, ghost off)',
      jg.privacy && jg.privacy.ghost === false && jg.privacy.readReceipts === true &&
        jg.privacy.lastSeen === true && jg.privacy.typing === true,
      JSON.stringify(jg.privacy)
    );

    // read-receipts toggle
    ghosty.send({ type: 'privacy_set', privacy: { readReceipts: false } });
    await ghosty.waitFor('privacy_saved', (e) => e.privacy.readReceipts === false);
    watcher.send({ type: 'message', convoId: dmGW, kind: 'text', text: 'receipts off test' });
    await ghosty.waitFor('message', (e) => e.message.text === 'receipts off test');
    let mark = watcher.events.length;
    ghosty.send({ type: 'read', convoId: dmGW });
    await sleep(300);
    ok(
      'read receipts suppressed while disabled',
      !watcher.events.slice(mark).some((e) => e.type === 'status' && (e.readBy || []).includes('Ghosty'))
    );
    ghosty.send({ type: 'privacy_set', privacy: { readReceipts: true } });
    await ghosty.waitFor('privacy_saved', (e) => e.privacy.readReceipts === true);
    watcher.send({ type: 'message', convoId: dmGW, kind: 'text', text: 'receipts on test' });
    const ron = await ghosty.waitFor('message', (e) => e.message.text === 'receipts on test');
    ghosty.send({ type: 'read', convoId: dmGW });
    await watcher.waitFor('status', (e) => e.id === ron.message.id && (e.readBy || []).includes('Ghosty'));
    ok('read receipts flow again once re-enabled', true);

    // typing toggle
    ghosty.send({ type: 'privacy_set', privacy: { typing: false } });
    await ghosty.waitFor('privacy_saved', (e) => e.privacy.typing === false);
    mark = watcher.events.length;
    ghosty.send({ type: 'typing', convoId: dmGW, isTyping: true });
    await sleep(300);
    ok(
      'typing indicator hidden while disabled',
      !watcher.events.slice(mark).some((e) => e.type === 'typing' && e.from === 'Ghosty')
    );
    ghosty.send({ type: 'privacy_set', privacy: { typing: true } });
    await ghosty.waitFor('privacy_saved', (e) => e.privacy.typing === true);
    mark = watcher.events.length;
    ghosty.send({ type: 'typing', convoId: dmGW, isTyping: true });
    await watcher.waitFor('typing', (e) => e.from === 'Ghosty');
    ok('typing indicator visible again once enabled', true);

    // last-seen toggle (needs the user to go offline)
    ghosty.send({ type: 'privacy_set', privacy: { lastSeen: false } });
    await ghosty.waitFor('privacy_saved', (e) => e.privacy.lastSeen === false);
    ghosty.close();
    mark = watcher.events.length;
    const hiddenSeen = await waitUntil(() => watcher.events.slice(mark).some(
      (e) => e.type === 'users' && e.users.some((u) => u.name === 'Ghosty' && u.online === false && u.lastSeen === null)
    ));
    ok('last seen hidden while disabled (offline contact shows no timestamp)', hiddenSeen);

    // Ghost Mode
    const ghostyBack = new Client('GhostyBack');
    await ghostyBack.connect();
    ghostyBack.send({ type: 'join', name: 'Ghosty' });
    await ghostyBack.waitFor('joined');
    mark = watcher.events.length;
    ghostyBack.send({ type: 'privacy_set', privacy: { ghost: true } });
    await ghostyBack.waitFor('privacy_saved', (e) => e.privacy.ghost === true);
    const ghostOffline = await waitUntil(() => watcher.events.slice(mark).some(
      (e) => e.type === 'users' && e.users.some((u) => u.name === 'Ghosty' && u.online === false)
    ));
    ok('ghost appears offline even while connected', ghostOffline);

    // the ghost still receives messages live, but the sender never sees delivery
    watcher.send({ type: 'message', convoId: dmGW, kind: 'text', text: 'to the ghost' });
    const toGhost = await ghostyBack.waitFor('message', (e) => e.message.text === 'to the ghost');
    ok('ghost still receives messages live', !!toGhost);
    ok('ghost delivery hidden from the sender', (toGhost.message.deliveredBy || []).length === 0);

    mark = watcher.events.length;
    ghostyBack.send({ type: 'read', convoId: dmGW });
    await sleep(300);
    ok(
      'ghost read receipts suppressed',
      !watcher.events.slice(mark).some((e) => e.type === 'status' && (e.readBy || []).includes('Ghosty'))
    );
    mark = watcher.events.length;
    ghostyBack.send({ type: 'typing', convoId: dmGW, isTyping: true });
    await sleep(300);
    ok(
      'ghost typing suppressed',
      !watcher.events.slice(mark).some((e) => e.type === 'typing' && e.from === 'Ghosty')
    );

    // ghost cannot be called (appears offline to callers)
    watcher.send({ type: 'call_invite', convoId: dmGW });
    const ghostCall = await watcher.waitFor('call_failed', (e) => e.convoId === dmGW);
    ok('calling a ghost reports "offline"', ghostCall.reason === 'offline', JSON.stringify(ghostCall));

    // ghost can still send messages
    ghostyBack.send({ type: 'message', convoId: dmGW, kind: 'text', text: 'ghost says hi' });
    await watcher.waitFor('message', (e) => e.message.text === 'ghost says hi');
    ok('ghost can still send messages', true);

    // turning ghost off restores presence
    mark = watcher.events.length;
    ghostyBack.send({ type: 'privacy_set', privacy: { ghost: false } });
    await ghostyBack.waitFor('privacy_saved', (e) => e.privacy.ghost === false);
    const ghostVisible = await waitUntil(() => watcher.events.slice(mark).some(
      (e) => e.type === 'users' && e.users.some((u) => u.name === 'Ghosty' && u.online === true)
    ));
    ok('presence restored after leaving ghost mode', ghostVisible);

    // leave a distinctive final state to verify persistence below
    ghostyBack.send({ type: 'privacy_set', privacy: { readReceipts: false, lastSeen: false, typing: true, ghost: false } });
    await ghostyBack.waitFor('privacy_saved', (e) => e.privacy.readReceipts === false && e.privacy.lastSeen === false);

    ghostyBack.close();
    watcher.close();

    console.log('\n— GIF search API (provider chain) —');
    {
      const parse = (r) => JSON.parse(r.body.toString());
      const first = parse(await httpGet(PORT, '/api/gifs?q=party&limit=24'));
      ok('/api/gifs answers ok + a results array', first.ok === true && Array.isArray(first.results), JSON.stringify(first).slice(0, 200));
      ok('the configured primary provider answers first', first.source === 'giphy' && /GIPHY/.test(first.attribution || ''), JSON.stringify({ s: first.source, a: first.attribution }));
      ok('only the primary provider is called when it works', gifState.hits.every((h) => h.startsWith('/giphy')), gifState.hits.join(','));
      ok('unusable entries (javascript: url, no renditions) are dropped', first.results.length === 2, JSON.stringify(first.results));
      ok('the sent url is the crisp rendition, not the thumbnail', first.results[0].url === 'https://media.giphy.com/media/g1/fixed_width.gif', JSON.stringify(first.results[0]));
      ok('the picker preview uses the small rendition', first.results[0].previewUrl === 'https://media.giphy.com/media/g1/small.gif', first.results[0].previewUrl);
      ok('string dimensions and alt text are normalised', first.results[0].w === 480 && first.results[0].h === 360 && first.results[1].alt === 'confetti-cat', JSON.stringify(first.results[1]));

      const hitsSoFar = gifState.hits.length;
      const again = parse(await httpGet(PORT, '/api/gifs?q=party&limit=24'));
      ok('repeat query is served from the 5-minute cache (no provider hit)', again.cached === true && gifState.hits.length === hitsSoFar);
      const trend = parse(await httpGet(PORT, '/api/gifs?q=&limit=24'));
      ok('empty query uses trending instead of search', trend.ok === true && gifState.hits.some((h) => h.includes('/giphy/trending')), gifState.hits.join(','));
      parse(await httpGet(PORT, '/api/gifs?q=clamp&limit=999'));
      ok('limit is clamped to what a provider may return', /limit=50(&|$)/.test(gifState.hits[gifState.hits.length - 1]), gifState.hits[gifState.hits.length - 1]);
      ok('providers without a key (klipy) are skipped, not called', gifState.hits.every((h) => !/klipy/i.test(h)));

      const bad = await httpGet(PORT, '/api/gifs?q=boom');
      ok('every provider failing → 502 + ok:false (client shows its built-in list)', bad.status === 502 && parse(bad).ok === false);
      const mp4 = await httpGet(PORT, '/api/gifs?q=mp4only');
      ok('non-gif renditions are never handed to the client', mp4.status === 502 && parse(mp4).results.length === 0);
      const empty = await httpGet(PORT, '/api/gifs?q=nothing');
      ok('an empty result set is an error, not an empty success', empty.status === 502);
      const over = parse(await httpGet(PORT, '/api/gifs?q=tenoronly&limit=24'));
      ok('a dead primary provider fails over to the next one', over.ok === true && over.source === 'tenor', JSON.stringify({ s: over.source }));
      ok('failover keeps the same normalised shape', over.results[0].url === 'https://media.tenor.com/full/party.gif' && over.results[0].previewUrl === 'https://media.tenor.com/nano/party.gif', JSON.stringify(over.results[0]));

      // a searched GIF url must survive the server message sanitising, or the picker
      // would show results you cannot actually send
      alice.send({ type: 'message', convoId: dmAB, kind: 'gif', text: '', media: { url: first.results[0].url, w: first.results[0].w, h: first.results[0].h } });
      const gifMsg = await bob.waitFor('message', (e) => e.message.kind === 'gif');
      ok('searched gif url is accepted and relayed', gifMsg.message.media && gifMsg.message.media.url === first.results[0].url, JSON.stringify(gifMsg.message.media));
      const before = bob.events.filter((e) => e.type === 'message').length;
      alice.send({ type: 'message', convoId: dmAB, kind: 'gif', text: '', media: { url: 'http://plain-http.example/x.gif' } });
      alice.send({ type: 'message', convoId: dmAB, kind: 'gif', text: '', media: null });
      await sleep(250);
      ok('non-https / media-less gif messages are rejected (no empty bubbles)', bob.events.filter((e) => e.type === 'message').length === before);

      // stale cache keeps the picker alive after every provider dies
      gifState.fail = true;
      await sleep(3200); // > GIF_CACHE_TTL_MS (3s in tests)
      const stale = parse(await httpGet(PORT, '/api/gifs?q=party&limit=24'));
      ok('expired cache is served stale while the providers are down', stale.ok === true && /stale cache/.test(stale.source) && stale.results.length === 2, JSON.stringify(stale).slice(0, 160));
      const freshFail = parse(await httpGet(PORT, '/api/gifs?q=novelquery'));
      ok('unknown query with dead providers still degrades cleanly', freshFail.ok === false && freshFail.results.length === 0);
      gifState.fail = false;
    }

    console.log('\n— polls —');
    {
      alice.send({ type: 'message', convoId: gid, kind: 'poll', text: 'Pizza night?', media: { question: 'Pizza night?', options: [{ text: 'Yes' }, { text: 'No' }], multiple: false } });
      const poll = (await bob.waitFor('message', (e) => e.message.kind === 'poll')).message;
      ok('poll keeps question in media (card headline)', poll.media.question === 'Pizza night?');
      ok('poll keeps text for the sidebar preview (bubble renders it once)', poll.text === 'Pizza night?');
      ok('options arrive with vote arrays for the % bars', poll.media.options.length === 2 && Array.isArray(poll.media.options[0].votes) && poll.media.options[0].votes.length === 0);
      bob.send({ type: 'poll_vote', convoId: gid, id: poll.id, optionIndex: 0 });
      const upd = await alice.waitFor('poll_update', (e) => e.id === poll.id);
      ok('vote is broadcast to the other members', upd.media.options[0].votes.includes('Bob'));
      alice.send({ type: 'poll_vote', convoId: gid, id: poll.id, optionIndex: 1 });
      const upd2 = await bob.waitFor('poll_update', (e) => e.id === poll.id && e.media.options[1].votes.length === 1);
      ok('each option tallies independently (drives per-option % + bar width)', upd2.media.options[0].votes.length === 1 && upd2.media.options[1].votes.length === 1);
      bob.send({ type: 'poll_vote', convoId: gid, id: poll.id, optionIndex: 1 });
      const untally = await bob.waitFor('poll_update', (e) => e.id === poll.id && e.media.options[1].votes.length === 0);
      ok('tapping your option again removes the vote', !untally.media.options[1].votes.includes('Bob'));
      bob.send({ type: 'poll_close', convoId: gid, id: poll.id });
      await sleep(300);
      ok('a plain member cannot close someone else’s poll', !alice.events.some((e) => e.type === 'poll_update' && e.id === poll.id && e.media.closed));
      alice.send({ type: 'poll_close', convoId: gid, id: poll.id });
      const closed = await bob.waitFor('poll_update', (e) => e.id === poll.id && e.media.closed === true);
      ok('the poll author can close it (button then renders disabled)', !!closed);
      const marks = bob.events.length;
      bob.send({ type: 'poll_vote', convoId: gid, id: poll.id, optionIndex: 0 });
      await sleep(300);
      ok('votes on a closed poll are ignored', !bob.events.slice(marks).some((e) => e.type === 'poll_update' && e.id === poll.id));
    }

    console.log('\n— forward (header ↗️ + long-press share one path) —');
    {
      bob.send({ type: 'message', convoId: dmAB, kind: 'text', text: 'forward me please' });
      const src = (await alice.waitFor('message', (e) => e.message.text === 'forward me please')).message;
      alice.send({ type: 'forward', messageId: src.id, fromConvoId: dmAB, toConvoIds: [gid] });
      const fwd = await bob.waitFor('message', (e) => e.message.convoId === gid && e.message.forwarded);
      ok('the newest message can be forwarded into another chat', fwd.message.text === 'forward me please');
      ok('forwarded copy records who sent it and who it came from', fwd.message.from === 'Alice' && fwd.message.forwardedFrom === 'Bob', JSON.stringify({ from: fwd.message.from, f: fwd.message.forwardedFrom }));
      ok('the copy is a fresh message (own id, not a shared reference)', fwd.message.id !== src.id);
      alice.send({ type: 'forward', messageId: src.id, fromConvoId: dmAB, toConvoIds: ['dm::Bob::Vera'] });
      await sleep(250);
      ok('forwarding into a chat you are not a member of is ignored', !alice.events.some((e) => e.type === 'message' && e.message.convoId === 'dm::Bob::Vera'));
    }

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
    ok(
      'privacy settings persisted per user',
      usersRaw.Ghosty && usersRaw.Ghosty.privacy &&
        usersRaw.Ghosty.privacy.readReceipts === false && usersRaw.Ghosty.privacy.lastSeen === false,
      JSON.stringify(usersRaw.Ghosty && usersRaw.Ghosty.privacy)
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
    gifMock.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
