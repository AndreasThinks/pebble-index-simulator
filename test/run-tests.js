/*
 * End-to-end tests: run the real PebbleKit JS companion code (unmodified)
 * in Node against the Index ingestion simulator, with the watch side and
 * the PKJS runtime (Pebble global, localStorage, XMLHttpRequest) faked.
 *
 * Usage: node test/run-tests.js
 */

'use strict';

const http = require('http');
const path = require('path');
const assert = require('assert');
const { createSimulator } = require('../simulator/server');

const PKJS_DIR = path.join(__dirname, '..', 'watchapp', 'src', 'pkjs');

/* ── fakes for the PKJS runtime ───────────────────────────────────── */

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

class FakeXHR {
  open(method, url) {
    this._method = method;
    this._url = url;
    this._headers = {};
  }
  setRequestHeader(k, v) { this._headers[k] = v; }
  send(body) {
    const req = http.request(this._url, {
      method: this._method,
      headers: this._headers
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        this.status = res.statusCode;
        this.responseText = data;
        if (this.onload) this.onload();
      });
    });
    req.on('error', () => { if (this.onerror) this.onerror(); });
    req.setTimeout(this.timeout || 15000, () => {
      req.destroy();
      if (this.ontimeout) this.ontimeout();
    });
    req.end(body || undefined);
  }
}

function makePebble() {
  const handlers = {};
  const sent = [];
  return {
    addEventListener: (ev, fn) => {
      (handlers[ev] = handlers[ev] || []).push(fn);
    },
    sendAppMessage: (dict, ok) => {
      sent.push(dict);
      if (ok) setImmediate(ok);
    },
    openURL: (url) => { sent.push({ __openURL: url }); },
    emit: (ev, arg) => (handlers[ev] || []).forEach((fn) => fn(arg)),
    sent
  };
}

/** (Re)load the companion with a fresh module graph and runtime fakes. */
function loadCompanion(localStorage) {
  for (const mod of ['index.js', 'settings.js', 'firebase.js', 'queue.js']) {
    delete require.cache[path.join(PKJS_DIR, mod)];
  }
  global.localStorage = localStorage;
  global.XMLHttpRequest = FakeXHR;
  const pebble = makePebble();
  global.Pebble = pebble;
  require(path.join(PKJS_DIR, 'index.js'));
  return pebble;
}

function waitFor(predicate, what, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  return new Promise((resolve, reject) => {
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out waiting for ' + what));
      setTimeout(poll, 20);
    })();
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function configFor(port) {
  const base = `http://127.0.0.1:${port}`;
  return {
    apiKey: 'sim-api-key',
    projectId: 'sim-project',
    authMode: 'refresh_token',
    refreshToken: 'sim-refresh-alice',
    noteTitle: 'Pebble watch note',
    authHost: base,
    identityHost: base,
    firestoreHost: base
  };
}

/* ── tests ────────────────────────────────────────────────────────── */

let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

async function main() {
  console.log('Index Notes end-to-end tests\n');

  const sim = createSimulator();
  const port = await listen(sim);

  await test('note dictated on watch lands in the simulated Index feed', async () => {
    const ls = makeLocalStorage();
    ls.setItem('settings', JSON.stringify(configFor(port)));
    const pebble = loadCompanion(ls);
    pebble.emit('ready');

    const epoch = 1750000000;
    pebble.emit('appmessage', {
      payload: { NOTE_TEXT: 'remember to water the plants', NOTE_EPOCH: epoch }
    });

    await waitFor(() => pebble.sent.some((m) => m.RESULT_CODE === 0), 'RESULT_CODE 0');

    const recs = await getJson(port, '/recordings');
    assert.strictEqual(recs.length, 1);
    const doc = recs[0].document;
    assert.strictEqual(recs[0].uid, 'alice');
    assert.strictEqual(doc.entries[0].transcription, 'remember to water the plants');
    assert.strictEqual(doc.entries[0].status, 'completed');
    assert.strictEqual(doc.timestamp.epochSeconds, epoch);
    assert.strictEqual(doc.entries[0].timestamp.epochSeconds, epoch);
    assert.strictEqual(doc.assistant_session.title, 'Pebble watch note');
    assert.ok(typeof doc.updated === 'number' && doc.updated > 1e12,
      'updated is epoch millis');
    assert.ok(/^[A-Za-z0-9]{20}$/.test(recs[0].docId), 'firestore-style doc id');
  });

  await test('duplicate upload (retry after success) is idempotent via 409', async () => {
    const ls = makeLocalStorage();
    ls.setItem('settings', JSON.stringify(configFor(port)));
    loadCompanion(ls);
    const firebase = require(path.join(PKJS_DIR, 'firebase.js'));
    const settings = require(path.join(PKJS_DIR, 'settings.js')).load();
    const note = { docId: 'AAAAAAAAAAAAAAAAAAAA', text: 'dupe test', epoch: 1750000001 };

    await new Promise((res, rej) =>
      firebase.uploadRecording(settings, note, (e) => (e ? rej(e) : res())));
    // Second attempt of the same docId → simulator answers 409 → success.
    await new Promise((res, rej) =>
      firebase.uploadRecording(settings, note, (e) => (e ? rej(e) : res())));

    const recs = await getJson(port, '/recordings');
    const dupes = recs.filter((r) => r.docId === 'AAAAAAAAAAAAAAAAAAAA');
    assert.strictEqual(dupes.length, 1);
  });

  await test('unreachable Firestore queues the note; next launch uploads it', async () => {
    const ls = makeLocalStorage();
    const offline = configFor(port);
    offline.firestoreHost = 'http://127.0.0.1:1'; // nothing listens here
    ls.setItem('settings', JSON.stringify(offline));
    let pebble = loadCompanion(ls);
    pebble.emit('ready');
    pebble.emit('appmessage', { payload: { NOTE_TEXT: 'offline note', NOTE_EPOCH: 1750000002 } });

    await waitFor(() => pebble.sent.some((m) => m.RESULT_CODE === 1), 'queued result');
    const queued = pebble.sent.find((m) => m.RESULT_CODE === 1);
    assert.strictEqual(queued.QUEUE_SIZE, 1);

    // "Come back online": fix the endpoint, restart the companion.
    ls.setItem('settings', JSON.stringify(configFor(port)));
    pebble = loadCompanion(ls);
    pebble.emit('ready');
    await waitFor(() => pebble.sent.some((m) => m.RESULT_CODE === 0), 'flush on ready');

    const recs = await getJson(port, '/recordings');
    assert.ok(recs.some((r) => r.document.entries[0].transcription === 'offline note'));
    assert.strictEqual(JSON.parse(ls.getItem('noteQueue')).length, 0);
  });

  await test('invalid refresh token surfaces an upload error to the watch', async () => {
    const ls = makeLocalStorage();
    const bad = configFor(port);
    bad.refreshToken = 'garbage';
    ls.setItem('settings', JSON.stringify(bad));
    const pebble = loadCompanion(ls);
    pebble.emit('appmessage', { payload: { NOTE_TEXT: 'doomed note', NOTE_EPOCH: 1750000003 } });

    await waitFor(() => pebble.sent.some((m) => m.RESULT_CODE === 3), 'error result');
    const err = pebble.sent.find((m) => m.RESULT_CODE === 3);
    assert.ok(/INVALID_REFRESH_TOKEN/.test(err.RESULT_TEXT), err.RESULT_TEXT);
  });

  await test('unconfigured companion tells the watch to open settings', async () => {
    const ls = makeLocalStorage();
    const pebble = loadCompanion(ls);
    pebble.emit('appmessage', { payload: { NOTE_TEXT: 'note with no config', NOTE_EPOCH: 1 } });

    await waitFor(() => pebble.sent.some((m) => m.RESULT_CODE === 2), 'config-needed result');
  });

  await test('email/password sign-in works and swaps to a refresh token', async () => {
    const ls = makeLocalStorage();
    const cfg = configFor(port);
    cfg.authMode = 'password';
    cfg.refreshToken = '';
    cfg.email = 'bob@example.com';
    cfg.password = 'hunter2';
    ls.setItem('settings', JSON.stringify(cfg));
    const pebble = loadCompanion(ls);
    pebble.emit('appmessage', { payload: { NOTE_TEXT: 'password auth note', NOTE_EPOCH: 1750000004 } });

    await waitFor(() => pebble.sent.some((m) => m.RESULT_CODE === 0), 'upload via password auth');
    const recs = await getJson(port, '/recordings');
    assert.ok(recs.some((r) => r.uid === 'bob' &&
      r.document.entries[0].transcription === 'password auth note'));
    // Companion should have stored the rotated refresh token for next time.
    const saved = JSON.parse(ls.getItem('settings'));
    assert.strictEqual(saved.refreshToken, 'sim-refresh-bob');
  });

  await test('proposed native Pebble.addIndexNote API is preferred, needs no config', async () => {
    const ls = makeLocalStorage(); // deliberately unconfigured
    const pebble = loadCompanion(ls);
    const nativeNotes = [];
    // Simulate a Pebble app build that ships the upstream-proposal API.
    pebble.addIndexNote = (text, ok) => {
      nativeNotes.push(text);
      setImmediate(ok);
    };
    pebble.emit('appmessage', { payload: { NOTE_TEXT: 'native path note', NOTE_EPOCH: 1750000005 } });

    await waitFor(() => pebble.sent.some((m) => m.RESULT_CODE === 0), 'native upload result');
    assert.deepStrictEqual(nativeNotes, ['native path note']);
    assert.strictEqual(JSON.parse(ls.getItem('noteQueue')).length, 0);
    // Nothing should have been written to Firestore for this note.
    const recs = await getJson(port, '/recordings');
    assert.ok(!recs.some((r) => r.document.entries[0].transcription === 'native path note'));
  });

  sim.close();
  console.log(`\nAll ${passed} tests passed.`);
}

main().catch((err) => {
  console.error('\n✗ FAILED: ' + err.message);
  console.error(err.stack);
  process.exit(1);
});
