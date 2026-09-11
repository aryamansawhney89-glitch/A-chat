'use strict';

/**
 * A-Chat UI test — drives the real client (public/app.js against a real server)
 * inside jsdom and asserts the interactive layer actually works: panel toggles,
 * click handlers, rendered bubble/poll markup, debounced GIF search.
 *
 * scripts/smoke-test.js covers the wire protocol; it cannot see that a button has
 * no listener attached, that a bubble renders its text twice, or that a panel
 * closes itself in the same click. Those are the bugs this file locks down:
 *
 *   - 🎭 opens the emoji panel on the GIF tab and keeps it open (a document-level
 *     outside-click handler used to hide it again inside the same click)
 *   - GIF search: debounced typing, "Searching…" / "No GIFs found" / provider
 *     attribution, preview vs. send rendition, and the built-in-list fallback
 *     when the provider is unreachable
 *   - 📊 with no chat selected explains itself ("Open a chat first") instead of
 *     doing nothing, and a poll renders its question once, as a card with radios,
 *     percentages, live bars, per-option tallies and a total vote count
 *   - ↗️ forwards the newest message, ⋮ opens the per-chat menu, 🔍 filters the
 *     message list and restores it on close
 *
 * No network access is needed: the client's WebSocket is bridged to the real
 * server and the GIF provider chain is pointed at a stub Tenor server.
 *
 * Run: npm run test:ui   (needs devDependencies: npm install)
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocket: NodeWS } = require('ws');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch {
  console.error('jsdom is required for the UI test — run `npm install` first.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const USER = 'UIUser';
const WATCHDOG_MS = Number(process.env.UI_TEST_TIMEOUT_MS || 120000);
const VERBOSE = !!process.env.UI_TEST_VERBOSE;
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

// Poll until fn() is truthy; throws instead of hanging forever on a broken build.
async function until(fn, timeout = 6000, label = '') {
  const start = Date.now();
  for (;;) {
    let value;
    try {
      value = await fn(); // works for sync and async predicates
    } catch {
      value = false; // selector not there yet / fetch refused — keep polling
    }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${label || fn.toString()}`);
    await sleep(40);
  }
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });

/* ------------------------------ stub GIF provider ------------------------------ */

const GIF_FIXTURE = {
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
    {
      id: 'p2',
      content_description: 'confetti cat',
      media_formats: {
        tinygif: { url: 'https://media.tenor.com/tiny/confetti.gif', dims: { w: 220, h: 165 } },
        gif: { url: 'https://media.tenor.com/full/confetti.gif', dims: { w: 400, h: 300 } },
      },
    },
  ],
};

function startGifMock(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.hits.push(url.pathname + url.search);
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (state.fail || q === 'boom') return send(500, { error: 'provider down' });
    if (q === 'mp4only') return send(200, { results: [{ id: 'v', media_formats: { loop: { url: 'https://media.tenor.com/clip.mp4', dims: { w: 10, h: 10 } } } }] });
    if (url.pathname === '/v1/search' || url.pathname === '/v1/trending') return send(200, GIF_FIXTURE);
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/* ------------------------------ jsdom plumbing --------------------------------
 * window.WebSocket bridges to a node `ws` client (jsdom's own is unusable here),
 * and window.fetch resolves the client's relative URLs against the test server. */

function makeFakeWS() {
  class FakeWS {
    constructor(url) {
      this.readyState = FakeWS.CONNECTING;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._socket = new NodeWS(url);
      this._socket.on('open', () => {
        this.readyState = FakeWS.OPEN;
        if (this.onopen) this.onopen({});
      });
      this._socket.on('message', (data) => {
        if (this.onmessage) this.onmessage({ data: data.toString() });
      });
      this._socket.on('close', () => {
        this.readyState = FakeWS.CLOSED;
        if (this.onclose) this.onclose({});
      });
      this._socket.on('error', () => {
        if (this.onerror) this.onerror({});
      });
    }
    send(data) {
      this._socket.send(data);
    }
    close() {
      this._socket.close();
    }
  }
  Object.assign(FakeWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  return FakeWS;
}

function buildPage() {
  // Inline app.js and drop the stylesheet: the assertions are about classes and
  // structure, and this keeps the run offline with no resource loader.
  const html = fs
    .readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
    .replace(/__BUILD__/g, 'uitest')
    .replace(/__VERSION__/g, 'uitest')
    .replace(/<link rel="stylesheet"[^>]*>/, '')
    .replace(/<script src="app\.js[^"]*"><\/script>/, () => `<script>${fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')}</script>`);
  return html;
}

(async () => {
  const watchdog = setTimeout(() => {
    console.error('\nFATAL: ui test exceeded its watchdog');
    process.exit(1);
  }, WATCHDOG_MS);
  watchdog.unref();

  const gifState = { hits: [], fail: false };
  const { server: gifMock, port: gifPort } = await startGifMock(gifState);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a-chat-ui-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  console.log(`Starting server on :${port} (data: ${dataDir}, stub provider on :${gifPort})`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      // pin the provider chain to the stub so results (and its failures) are deterministic
      GIF_PROVIDERS: 'tenor',
      TENOR_API_BASE: `http://127.0.0.1:${gifPort}/v1`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  const relay = (d) => {
    const text = String(d).trimEnd();
    serverLog.push(text);
    if (VERBOSE) process.stdout.write('[server] ' + text + '\n');
  };
  server.stdout.on('data', relay);
  server.stderr.on('data', relay);
  const cleanup = () => {
    try {
      server.kill('SIGKILL');
    } catch {}
    try {
      gifMock.close();
    } catch {}
  };
  process.on('exit', cleanup);
  process.on('uncaughtException', (e) => {
    console.error('FATAL:', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e);
    console.log(`\n${passed} passed, ${failed + 1} failed (aborted)`);
    cleanup();
    process.exit(1);
  });

  try {
    await until(async () => (await fetch(base + '/healthz')).ok, 15000, 'server up');
    await startUiTest();
  } finally {
    cleanup();
  }

  async function startUiTest() {
    const clientErrors = [];
    // jsdom has no navigation, media or layout engine: keep that noise out of the
    // report (real page errors are captured from the window below instead).
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (e) => {
      if (VERBOSE && !/not implemented/i.test(String(e && e.message))) console.error('[jsdom]', e && e.message);
    });
    const dom = new JSDOM(buildPage(), {
      url: base + '/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.WebSocket = makeFakeWS();
        window.fetch = (input, init) => fetch(new URL(String(input), base), init);
        window.confirm = () => true;
        window.alert = (msg) => clientErrors.push('alert: ' + msg);
        window.addEventListener('error', (e) => clientErrors.push(String((e && e.message) || e.error)));
        const realError = window.console.error;
        window.console.error = (...args) => {
          clientErrors.push(args.join(' '));
          if (VERBOSE) realError(...args);
        };
      },
    });
    const win = dom.window;
    const doc = win.document;
    const $ = (id) => doc.getElementById(id);
    const click = (node) => node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }));
    const input = (node, value) => {
      node.value = value;
      node.dispatchEvent(new win.Event('input', { bubbles: true }));
    };
    const evalIn = (code) => win.eval(code);
    const rows = () => doc.querySelectorAll('#messages [data-msg-id]');
    const lastMsg = () => JSON.parse(evalIn('JSON.stringify(getChat(state.active).messages.slice(-1)[0])'));

    console.log('\n— boot & join —');
    await until(() => evalIn('state.connected') === true, 15000, 'websocket open');
    ok('client booted with no script errors', clientErrors.length === 0, clientErrors.join(' | ').slice(0, 400));
    $('nameInput').value = USER;
    evalIn('startJoin()'); // the form's submit is a navigation jsdom can't do
    await until(() => doc.querySelectorAll('.chat-item').length >= 3, 10000, 'chat list');
    ok('joined and the chat list rendered (bots included)', evalIn('state.me') === USER);
    ok('no chat is open yet', evalIn('state.active') === null);

    console.log('\n— 📊 poll button with no chat —');
    click($('pollBtn'));
    ok('the modal stays closed', $('pollModal').classList.contains('hidden'));
    ok('and the toast says why', /open a chat first/i.test($('toast').textContent), $('toast').textContent);

    const aria = [...doc.querySelectorAll('.chat-item')].find((c) => c.querySelector('.ci-name').textContent.startsWith('Aria'));
    click(aria);
    await until(() => String(evalIn('state.active') || '').startsWith('dm::'), 8000, 'chat open');

    console.log('\n— 🎭 / GIF picker —');
    click($('emojiBtn'));
    ok('😊 opens the emoji panel', !$('emojiPanel').classList.contains('hidden'));
    click($('emojiBtn'));
    ok('😊 closes it again', $('emojiPanel').classList.contains('hidden'));
    click($('stickerBtn'));
    ok('🎭 opens the panel and it stays open', !$('emojiPanel').classList.contains('hidden'));
    ok('🎭 lands on the GIF tab', doc.querySelector('.emoji-tab[data-tab="gif"]').classList.contains('active'));
    ok('GIF tab visible, sticker tab not', !$('gifTabContent').classList.contains('hidden') && $('stickerTabContent').classList.contains('hidden'));

    await until(() => doc.querySelectorAll('#gifGrid .gif-thumb').length >= 2, 10000, 'trending gifs');
    ok('an empty search loads trending from the provider', gifState.hits.some((h) => h.startsWith('/v1/trending')), gifState.hits.join(',').slice(0, 200));
    const thumb = doc.querySelector('#gifGrid .gif-thumb');
    ok('the grid previews the small rendition', thumb.src === 'https://media.tenor.com/nano/party.gif', thumb.src);
    ok('thumbs carry alt text', thumb.alt === 'party bob', thumb.alt);
    ok('provider attribution is shown', !$('gifAttrib').classList.contains('hidden') && /powered by tenor/i.test($('gifAttrib').textContent), $('gifAttrib').textContent);

    const beforeSend = evalIn('getChat(state.active).messages.length');
    click(thumb);
    await until(() => evalIn('getChat(state.active).messages.length') > beforeSend, 8000, 'gif message');
    ok('clicking a thumb sends a gif message', lastMsg().kind === 'gif');
    ok('it sends the full-size url, not the preview', lastMsg().media.url === 'https://media.tenor.com/full/party.gif', JSON.stringify(lastMsg().media));
    ok('the panel closes after sending', $('emojiPanel').classList.contains('hidden'));
    ok('the bubble renders the gif', [...doc.querySelectorAll('#messages .photo-img')].some((img) => img.src.endsWith('/full/party.gif')));

    click($('stickerBtn'));
    const hitsBefore = gifState.hits.length;
    input($('gifSearch'), 'party');
    ok('typing reports "Searching…" straight away', /searching/i.test($('gifStatus').textContent), $('gifStatus').textContent);
    await sleep(120);
    ok('the request is debounced (nothing sent yet)', gifState.hits.length === hitsBefore, `${gifState.hits.length} vs ${hitsBefore}`);
    await until(() => gifState.hits.length > hitsBefore, 6000, 'debounced request');
    await until(() => !/searching/i.test($('gifStatus').textContent), 8000, 'search response applied');
    ok('one provider request per burst of typing', gifState.hits.filter((h) => /q=party/.test(h)).length === 1, gifState.hits.join(',').slice(-200));

    input($('gifSearch'), 'mp4only'); // provider answers, but with nothing sendable
    await until(() => doc.querySelector('#gifGrid .gif-empty'), 8000, 'empty state');
    ok('no usable results → "No GIFs found"', /no gifs found/i.test(doc.querySelector('#gifGrid .gif-empty').textContent));

    gifState.fail = true; // provider goes down entirely
    input($('gifSearch'), 'happy');
    await until(() => doc.querySelectorAll('#gifGrid .gif-thumb').length >= 1, 8000, 'built-in fallback');
    ok('unreachable provider → the built-in list still renders', doc.querySelectorAll('#gifGrid .gif-thumb').length >= 1);
    ok('and the status line explains the fallback', /built-in/i.test($('gifStatus').textContent), $('gifStatus').textContent);
    gifState.fail = false;
    click($('stickerBtn')); // close the panel

    console.log('\n— 📊 poll card —');
    input($('msgInput'), 'a poll is coming');
    evalIn('sendMessage()');
    await until(() => evalIn('getChat(state.active).messages.some(m => m.text === "a poll is coming")'), 8000, 'text message');
    await sleep(1500); // let the bot reply land before anything counts rows
    click($('pollBtn'));
    ok('📊 with a chat open opens the modal', !$('pollModal').classList.contains('hidden'));
    $('pollQuestion').value = 'Pineapple on pizza?';
    const optionInputs = [...doc.querySelectorAll('.poll-opt')];
    optionInputs[0].value = 'Obviously';
    optionInputs[1].value = 'Never';
    click($('pollCreateBtn'));
    ok('creating a poll closes the modal', $('pollModal').classList.contains('hidden'));
    await until(() => doc.querySelector('#messages .poll-wrap'), 8000, 'poll card');

    const pollRow = [...rows()].find((r) => r.querySelector('.poll-wrap'));
    const bubble = pollRow.querySelector('.bubble');
    ok('the bubble is marked up as a poll', bubble.classList.contains('poll-bubble'));
    ok('the card has a header', /poll/i.test(bubble.querySelector('.poll-head').textContent), bubble.querySelector('.poll-head').textContent);
    ok('the question renders once, in the card', (bubble.textContent.match(/Pineapple on pizza\?/g) || []).length === 1, JSON.stringify(bubble.textContent).slice(0, 200));
    ok('both options are tappable rows', bubble.querySelectorAll('button.poll-option').length === 2);
    ok('unvoted options show an empty radio', [...bubble.querySelectorAll('.poll-radio')].every((r) => r.textContent === '○'));
    ok('each option starts at 0%', [...bubble.querySelectorAll('.poll-pct')].map((p) => p.textContent).join(',') === '0%,0%');
    ok('each bar starts empty', [...bubble.querySelectorAll('.poll-fill')].every((f) => f.style.width === '0%'));
    ok('the footer counts votes', /no votes yet/i.test(bubble.querySelector('.poll-total').textContent));
    ok('the author can close it', /close poll/i.test(bubble.textContent));

    click(bubble.querySelectorAll('.poll-option')[0]);
    await until(() => /100%/.test(doc.querySelector('#messages .poll-pct').textContent), 8000, 'vote broadcast back');
    const card = [...doc.querySelectorAll('#messages .poll-wrap')].pop(); // row was replaced on patch
    ok('your option is marked as voted', card.querySelectorAll('.poll-option')[0].classList.contains('voted'));
    ok('the radio fills in', card.querySelectorAll('.poll-radio')[0].textContent === '●', card.querySelectorAll('.poll-radio')[0].textContent);
    ok('percentage and bar move together', card.querySelectorAll('.poll-pct')[0].textContent === '100%' && card.querySelectorAll('.poll-fill')[0].style.width === '100%');
    ok('the tally and total agree', /1 vote/i.test(card.querySelectorAll('.poll-count')[0].textContent) && /1 vote/i.test(card.querySelector('.poll-total').textContent));
    ok('it says you voted', /you voted/i.test(card.querySelectorAll('.poll-count')[0].textContent));
    ok('the sidebar preview still shows the question', /Pineapple on pizza/.test(evalIn(`previewText(getChat(state.active).messages.filter(m => m.kind === 'poll').pop())`)));
    click([...doc.querySelectorAll('#messages .poll-option')].slice(-2)[0]);
    await until(() => /no votes yet/i.test([...doc.querySelectorAll('#messages .poll-total')].pop().textContent), 8000, 'vote removed');
    const afterRemove = [...doc.querySelectorAll('#messages .poll-wrap')].pop();
    ok('tapping your option again withdraws the vote', !afterRemove.querySelectorAll('.poll-option')[0].classList.contains('voted') && afterRemove.querySelectorAll('.poll-radio')[0].textContent === '○');

    console.log('\n— header buttons —');
    ok('in-chat search starts closed', $('chatSearchBar').classList.contains('hidden'));
    const rowCount = rows().length;
    click($('headerSearchBtn'));
    ok('🔍 opens the search bar', !$('chatSearchBar').classList.contains('hidden'));
    ok('🔍 focuses the input', doc.activeElement === $('chatSearchInput'), String(doc.activeElement && doc.activeElement.id));
    input($('chatSearchInput'), 'pineapple');
    await until(() => rows().length === 1, 5000, 'filtered to the poll');
    ok('typing filters to the matches', rows().length === 1, String(rows().length));
    ok('it matches inside poll cards, not just texts', !!doc.querySelector('#messages .poll-wrap'));
    input($('chatSearchInput'), 'nothing-matches-this');
    await until(() => doc.querySelector('#messages .chat-search-empty'), 5000, 'no-match note');
    ok('no match says so inline', /No messages match/.test(doc.querySelector('#messages .chat-search-empty').textContent));
    click($('chatSearchClose'));
    ok('✕ hides the bar', $('chatSearchBar').classList.contains('hidden'));
    ok('✕ restores the full list', rows().length === rowCount, `${rows().length} vs ${rowCount}`);
    ok('✕ clears the query', $('chatSearchInput').value === '');
    click($('headerSearchBtn'));
    const openAgain = !$('chatSearchBar').classList.contains('hidden');
    click($('headerSearchBtn'));
    ok('🔍 toggles', openAgain && $('chatSearchBar').classList.contains('hidden'));

    click($('forwardHeaderBtn'));
    ok('↗️ opens the forward picker', !$('forwardModal').classList.contains('hidden'));
    const checkboxes = [...$('forwardList').querySelectorAll('input[type=checkbox]')];
    ok('the picker lists your chats', checkboxes.length >= 3, String(checkboxes.length));
    const expected = JSON.parse(evalIn('JSON.stringify(getChat(state.active).messages.filter(m => !m.deleted).slice(-1)[0])'));
    const maxChat = checkboxes.find((cb) => /Max/.test(cb.parentNode.textContent));
    maxChat.checked = true;
    const maxBefore = evalIn(`getChat("${maxChat.value}").messages.length`);
    click($('forwardSendBtn'));
    ok('forwarding closes the picker', $('forwardModal').classList.contains('hidden'));
    await until(() => evalIn(`getChat("${maxChat.value}").messages.length`) > maxBefore, 8000, 'forwarded copy');
    const copy = JSON.parse(evalIn(`JSON.stringify(getChat("${maxChat.value}").messages.slice(-1)[0])`));
    ok('the newest message lands in the other chat', copy.forwarded === true && copy.kind === expected.kind, JSON.stringify(copy).slice(0, 200));
    ok('the copy keeps the original sender label', copy.forwardedFrom === expected.from, JSON.stringify({ got: copy.forwardedFrom, want: expected.from }));
    ok('the copy is its own message', copy.id !== expected.id);

    ok('no ⋮ menu in the DOM yet', !doc.querySelector('.chat-menu'));
    click($('chatMenuBtn'));
    await until(() => doc.querySelector('.chat-menu'), 5000, 'menu opens');
    const items = [...doc.querySelectorAll('.chat-menu-item')].map((b) => b.textContent.trim());
    ok('⋮ opens the per-chat menu', items.length === 6, JSON.stringify(items));
    ok(
      'menu offers search / pin / mute / disappearing / wallpaper / clear',
      ['Search in chat', 'Pin chat', 'Mute notifications', 'Disappearing messages', 'Wallpaper', 'Clear chat'].every((label) => items.some((i) => i.includes(label))),
      JSON.stringify(items)
    );
    ok('the ⋮ button shows an active state', $('chatMenuBtn').classList.contains('active'));
    click([...doc.querySelectorAll('.chat-menu-item')].find((b) => /Mute notifications/.test(b.textContent)));
    ok('choosing an item closes the menu', !doc.querySelector('.chat-menu'));
    await until(() => evalIn('isMuted(state.active)') === true, 5000, 'mute applied');
    ok('the mute item muted this chat', $('muteChatBtn').textContent === '🔇', $('muteChatBtn').textContent);
    click($('chatMenuBtn'));
    await until(() => doc.querySelector('.chat-menu'), 5000, 'menu reopens');
    ok('menu labels reflect state ("Unmute notifications" now)', /Unmute notifications/.test([...doc.querySelectorAll('.chat-menu-item')].map((b) => b.textContent).join('|')));
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(80);
    ok('Escape closes the menu', !doc.querySelector('.chat-menu'));
    click($('chatMenuBtn'));
    await until(() => doc.querySelector('.chat-menu'), 5000, 'menu opens');
    click([...doc.querySelectorAll('.chat-menu-item')].find((b) => /Wallpaper/.test(b.textContent)));
    ok('Wallpaper opens the wallpaper modal', !$('wallpaperModal').classList.contains('hidden'));
    click($('wallpaperDoneBtn'));
    click($('chatMenuBtn'));
    await until(() => doc.querySelector('.chat-menu'), 5000, 'menu opens');
    click([...doc.querySelectorAll('.chat-menu-item')].find((b) => /Clear chat/.test(b.textContent)));
    await until(() => evalIn('getChat(state.active).messages.length') === 0, 8000, 'chat cleared');
    ok('Clear chat empties the open chat', rows().length === 0, String(rows().length));
    ok('the ⋮ menu is closed afterwards', !doc.querySelector('.chat-menu'));

    console.log('\n— after the menu actions —');
    input($('msgInput'), 'sent after clearing');
    evalIn('sendMessage()');
    await until(() => rows().length >= 1, 8000, 'new message renders');
    ok('sending still works after clearing the chat', lastMsg().text === 'sent after clearing');
    click($('chatMenuBtn'));
    await until(() => doc.querySelector('.chat-menu'), 5000, 'menu opens again');
    ok('the menu still opens with an emptied-then-refilled chat', doc.querySelectorAll('.chat-menu-item').length === 6);
    click(doc.querySelector('.chat-menu-head')); // click inside the menu must not close it
    ok('clicking a non-item area inside the menu keeps it open', !!doc.querySelector('.chat-menu'));

    ok('no client errors accumulated during the run', clientErrors.length === 0, clientErrors.join(' | ').slice(0, 400));

    win.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed && VERBOSE) console.error(serverLog.join('\n').slice(-2000));
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => {
  console.error('FATAL:', e.message);
  console.log(`\n${passed} passed, ${failed + 1} failed (aborted)`);
  process.exit(1);
});
