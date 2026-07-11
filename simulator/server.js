/*
 * Index ingestion simulator.
 *
 * A zero-dependency stand-in for the two Google endpoints the watchapp
 * companion talks to, plus a feed view that mimics what the Pebble mobile
 * app's RecordingProcessingQueue.ingestRemoteRecording() would accept:
 *
 *   POST /v1/token                        — securetoken.googleapis.com
 *   POST /v1/accounts:signInWithPassword  — identitytoolkit.googleapis.com
 *   POST /v1/projects/{pid}/databases/(default)/documents/
 *        recordings/{uid}/recordings      — firestore.googleapis.com
 *   GET  /recordings                      — ingested docs, decoded (JSON)
 *   GET  /                                — simple HTML feed view
 *
 * Documents are validated against the RecordingDocument shape from
 * coredevices/mobileapp (TolerantInstantSerializer instants, entry status
 * enum, assistant_session) so a document accepted here is one the real
 * app would ingest.
 */

'use strict';

const http = require('http');
const { URL } = require('url');

const VALID_STATUSES = new Set([
  'pending', 'agent_processing', 'completed', 'transcription_error', 'agent_error'
]);

function makeState() {
  return {
    // uid -> Map(docId -> {fields, decoded, receivedAt})
    users: new Map(),
    tokens: new Map() // idToken -> uid
  };
}

function readBody(req, cb) {
  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => cb(data));
}

function json(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function parseForm(body) {
  const out = {};
  for (const pair of body.split('&')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      out[decodeURIComponent(pair.slice(0, idx))] =
        decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    }
  }
  return out;
}

/* ── Firestore REST value decoding ────────────────────────────────── */

function decodeValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFields((v.mapValue && v.mapValue.fields) || {});
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(decodeValue);
  return v;
}

function decodeFields(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) {
    out[k] = decodeValue(fields[k]);
  }
  return out;
}

/* ── RecordingDocument shape validation ───────────────────────────── */

function validateInstant(value, path, errors) {
  if (!value || typeof value !== 'object' ||
      typeof value.epochSeconds !== 'number' || isNaN(value.epochSeconds)) {
    errors.push(path + ' must be an {epochSeconds, nanosecondsOfSecond} map');
  }
}

function validateRecordingDocument(doc) {
  const errors = [];
  validateInstant(doc.timestamp, 'timestamp', errors);
  if (typeof doc.updated !== 'number') {
    errors.push('updated must be an integer (epoch millis)');
  }
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
    errors.push('entries must be a non-empty array');
  } else {
    doc.entries.forEach((entry, i) => {
      validateInstant(entry.timestamp, `entries[${i}].timestamp`, errors);
      if (!VALID_STATUSES.has(entry.status)) {
        errors.push(`entries[${i}].status "${entry.status}" is not a RecordingEntryStatus`);
      }
      if (typeof entry.transcription !== 'string' || entry.transcription.length === 0) {
        errors.push(`entries[${i}].transcription must be a non-empty string`);
      }
    });
  }
  if (doc.assistant_session !== undefined && doc.assistant_session !== null) {
    if (typeof doc.assistant_session !== 'object') {
      errors.push('assistant_session must be a map');
    } else if (doc.assistant_session.messages !== undefined &&
               !Array.isArray(doc.assistant_session.messages)) {
      errors.push('assistant_session.messages must be an array');
    }
  }
  return errors;
}

/* ── request handling ─────────────────────────────────────────────── */

const FIRESTORE_PATH = /^\/v1\/projects\/([^/]+)\/databases\/\(default\)\/documents\/recordings\/([^/]+)\/recordings$/;

function handle(state, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  // securetoken.googleapis.com: refresh token -> id token
  if (req.method === 'POST' && path === '/v1/token') {
    return readBody(req, (body) => {
      const form = parseForm(body);
      if (form.grant_type !== 'refresh_token' || !form.refresh_token) {
        return json(res, 400, { error: { message: 'INVALID_GRANT_TYPE' } });
      }
      const m = /^sim-refresh-(.+)$/.exec(form.refresh_token);
      if (!m) {
        return json(res, 400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
      }
      const uid = m[1];
      const idToken = 'sim-id-' + uid + '-' + Date.now();
      state.tokens.set(idToken, uid);
      json(res, 200, {
        access_token: idToken,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: form.refresh_token,
        id_token: idToken,
        user_id: uid,
        project_id: 'sim-project'
      });
    });
  }

  // identitytoolkit.googleapis.com: email/password sign-in
  if (req.method === 'POST' && path === '/v1/accounts:signInWithPassword') {
    return readBody(req, (body) => {
      let creds = {};
      try { creds = JSON.parse(body); } catch (e) { /* fall through */ }
      if (!creds.email || !creds.password) {
        return json(res, 400, { error: { message: 'MISSING_EMAIL_OR_PASSWORD' } });
      }
      const uid = creds.email.split('@')[0];
      const idToken = 'sim-id-' + uid + '-' + Date.now();
      state.tokens.set(idToken, uid);
      json(res, 200, {
        idToken,
        email: creds.email,
        refreshToken: 'sim-refresh-' + uid,
        expiresIn: '3600',
        localId: uid
      });
    });
  }

  // firestore.googleapis.com: createDocument on the recordings collection
  const fsMatch = req.method === 'POST' && FIRESTORE_PATH.exec(path);
  if (fsMatch) {
    const pathUid = fsMatch[2];
    const auth = req.headers.authorization || '';
    const idToken = auth.replace(/^Bearer\s+/i, '');
    const tokenUid = state.tokens.get(idToken);
    if (!tokenUid) {
      return json(res, 401, { error: { message: 'UNAUTHENTICATED', status: 'UNAUTHENTICATED' } });
    }
    if (tokenUid !== pathUid) {
      // Mirrors user-scoped security rules: you can only write your own data.
      return json(res, 403, { error: { message: 'PERMISSION_DENIED', status: 'PERMISSION_DENIED' } });
    }
    return readBody(req, (body) => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {
        return json(res, 400, { error: { message: 'INVALID_JSON' } });
      }
      const docId = url.searchParams.get('documentId') || ('auto' + Date.now());
      const decoded = decodeFields(parsed.fields || {});
      const errors = validateRecordingDocument(decoded);
      if (errors.length > 0) {
        return json(res, 400, {
          error: { message: 'INVALID_ARGUMENT: ' + errors.join('; '), status: 'INVALID_ARGUMENT' }
        });
      }
      if (!state.users.has(pathUid)) {
        state.users.set(pathUid, new Map());
      }
      const docs = state.users.get(pathUid);
      if (docs.has(docId)) {
        return json(res, 409, { error: { message: 'ALREADY_EXISTS', status: 'ALREADY_EXISTS' } });
      }
      docs.set(docId, { fields: parsed.fields, decoded, receivedAt: new Date().toISOString() });
      console.log(`[simulator] INGESTED recording ${docId} for ${pathUid}: ` +
        JSON.stringify(decoded.entries[0].transcription));
      json(res, 200, {
        name: `projects/${fsMatch[1]}/databases/(default)/documents/recordings/${pathUid}/recordings/${docId}`,
        fields: parsed.fields,
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString()
      });
    });
  }

  // Inspection endpoints
  if (req.method === 'GET' && path === '/recordings') {
    const out = [];
    for (const [uid, docs] of state.users) {
      for (const [docId, doc] of docs) {
        out.push({ uid, docId, receivedAt: doc.receivedAt, document: doc.decoded });
      }
    }
    return json(res, 200, out);
  }

  if (req.method === 'GET' && path === '/') {
    let items = '';
    for (const [uid, docs] of state.users) {
      for (const [docId, doc] of docs) {
        const d = doc.decoded;
        const title = (d.assistant_session && d.assistant_session.title) || 'Note';
        const text = d.entries.map((e) => e.transcription).join(' / ');
        const when = new Date(d.timestamp.epochSeconds * 1000).toISOString();
        items += `<li><b>${title}</b> <i>(${when}, ${uid}/${docId})</i><br>${text}</li>\n`;
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(
      '<!doctype html><meta http-equiv="refresh" content="2">' +
      '<h1>Index feed (simulated)</h1>' +
      (items ? `<ul>${items}</ul>` : '<p>No recordings ingested yet.</p>'));
  }

  json(res, 404, { error: { message: 'NOT_FOUND' } });
}

function createSimulator() {
  const state = makeState();
  const server = http.createServer((req, res) => handle(state, req, res));
  server.simulatorState = state;
  return server;
}

module.exports = { createSimulator };

if (require.main === module) {
  const port = parseInt(process.env.PORT || '8688', 10);
  createSimulator().listen(port, () => {
    console.log(`Index ingestion simulator listening on http://localhost:${port}`);
    console.log('Feed view:  http://localhost:' + port + '/');
    console.log('Test refresh token: sim-refresh-<any-uid>   e.g. sim-refresh-alice');
  });
}
