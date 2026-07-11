/*
 * Minimal Firebase Auth + Firestore REST client for PebbleKit JS.
 *
 * Authenticates as the user's own Pebble-app (Core) account and writes
 * RecordingDocument objects into the same Firestore collection the app's
 * multi-device sync listens on:
 *
 *     recordings/{uid}/recordings/{docId}
 *
 * The mobile app's snapshot listener (RecordingProcessingQueue) ingests
 * anything that appears there, so a document written here shows up in the
 * Index feed like a recording synced from another device.
 *
 * Document field shapes mirror coredevices/mobileapp exactly:
 *  - Instants are written as {epochSeconds, nanosecondsOfSecond} maps
 *    (the app's TolerantInstantSerializer write shape).
 *  - `updated` is epoch milliseconds as an integer.
 *  - entry status uses the RecordingEntryStatus enum names.
 */

'use strict';

var ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Auth token cache: {idToken, uid, expiresAt (ms)}
var authCache = null;

function loadAuthCache() {
  if (authCache) {
    return authCache;
  }
  try {
    authCache = JSON.parse(localStorage.getItem('authCache') || 'null');
  } catch (e) {
    authCache = null;
  }
  return authCache;
}

function saveAuthCache(cache) {
  authCache = cache;
  localStorage.setItem('authCache', JSON.stringify(cache));
}

function clearAuthCache() {
  authCache = null;
  localStorage.removeItem('authCache');
}

/** Firestore-style 20-char document id, same alphabet the app uses. */
function newDocumentId() {
  var id = '';
  for (var i = 0; i < 20; i++) {
    id += ID_ALPHABET.charAt(Math.floor(Math.random() * ID_ALPHABET.length));
  }
  return id;
}

function request(method, url, headers, body, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open(method, url);
  for (var h in headers) {
    if (headers.hasOwnProperty(h)) {
      xhr.setRequestHeader(h, headers[h]);
    }
  }
  xhr.timeout = 15000;
  xhr.onload = function () {
    var parsed = null;
    try {
      parsed = JSON.parse(xhr.responseText || 'null');
    } catch (e) { /* leave null */ }
    cb(null, xhr.status, parsed);
  };
  xhr.onerror = function () { cb(new Error('network error'), 0, null); };
  xhr.ontimeout = function () { cb(new Error('timeout'), 0, null); };
  xhr.send(body || null);
}

function formEncode(params) {
  var parts = [];
  for (var k in params) {
    if (params.hasOwnProperty(k)) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  }
  return parts.join('&');
}

/** Exchange a refresh token for an ID token via the secure token service. */
function refreshIdToken(settings, cb) {
  var url = settings.authHost + '/v1/token?key=' + encodeURIComponent(settings.apiKey);
  var body = formEncode({
    grant_type: 'refresh_token',
    refresh_token: settings.refreshToken
  });
  request('POST', url, { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    function (err, status, resp) {
      if (err) { return cb(err); }
      if (status !== 200 || !resp || !resp.id_token) {
        var msg = (resp && resp.error && resp.error.message) || ('token HTTP ' + status);
        return cb(new Error(msg));
      }
      // Google rotates refresh tokens; persist the newest one.
      if (resp.refresh_token && resp.refresh_token !== settings.refreshToken) {
        settings.refreshToken = resp.refresh_token;
        require('./settings').save(settings);
      }
      var cache = {
        idToken: resp.id_token,
        uid: resp.user_id,
        expiresAt: Date.now() + (parseInt(resp.expires_in, 10) - 60) * 1000
      };
      saveAuthCache(cache);
      cb(null, cache);
    });
}

/** Email/password sign-in (only works if the project has it enabled). */
function passwordSignIn(settings, cb) {
  var url = settings.identityHost + '/v1/accounts:signInWithPassword?key=' +
    encodeURIComponent(settings.apiKey);
  var body = JSON.stringify({
    email: settings.email,
    password: settings.password,
    returnSecureToken: true
  });
  request('POST', url, { 'Content-Type': 'application/json' }, body,
    function (err, status, resp) {
      if (err) { return cb(err); }
      if (status !== 200 || !resp || !resp.idToken) {
        var msg = (resp && resp.error && resp.error.message) || ('signIn HTTP ' + status);
        return cb(new Error(msg));
      }
      if (resp.refreshToken) {
        settings.refreshToken = resp.refreshToken;
        settings.authMode = 'refresh_token';
        require('./settings').save(settings);
      }
      var cache = {
        idToken: resp.idToken,
        uid: resp.localId,
        expiresAt: Date.now() + (parseInt(resp.expiresIn, 10) - 60) * 1000
      };
      saveAuthCache(cache);
      cb(null, cache);
    });
}

function ensureAuth(settings, cb) {
  var cache = loadAuthCache();
  if (cache && cache.idToken && cache.expiresAt > Date.now()) {
    return cb(null, cache);
  }
  if (settings.authMode === 'password' && (!settings.refreshToken)) {
    return passwordSignIn(settings, cb);
  }
  return refreshIdToken(settings, cb);
}

/** {epochSeconds, nanosecondsOfSecond} map, Firestore REST encoding. */
function instantValue(epochSeconds) {
  return {
    mapValue: {
      fields: {
        epochSeconds: { integerValue: String(epochSeconds) },
        nanosecondsOfSecond: { integerValue: '0' }
      }
    }
  };
}

/**
 * Build the Firestore REST `fields` for a text-only RecordingDocument —
 * the same shape the app writes for a transcribed note (an entry with
 * status `completed` and no audio fileName).
 */
function buildRecordingFields(text, epochSeconds, title) {
  return {
    timestamp: instantValue(epochSeconds),
    updated: { integerValue: String(Date.now()) },
    entries: {
      arrayValue: {
        values: [{
          mapValue: {
            fields: {
              timestamp: instantValue(epochSeconds),
              status: { stringValue: 'completed' },
              transcription: { stringValue: text }
            }
          }
        }]
      }
    },
    assistant_session: {
      mapValue: {
        fields: {
          title: { stringValue: title },
          messages: { arrayValue: {} }
        }
      }
    }
  };
}

/**
 * Create the recording document. Calls cb(err). A 409 ALREADY_EXISTS is
 * treated as success so retried queue items stay idempotent.
 */
function uploadRecording(settings, note, cb) {
  ensureAuth(settings, function (err, auth) {
    if (err) { return cb(err); }
    var url = settings.firestoreHost + '/v1/projects/' +
      encodeURIComponent(settings.projectId) +
      '/databases/(default)/documents/recordings/' +
      encodeURIComponent(auth.uid) +
      '/recordings?documentId=' + encodeURIComponent(note.docId);
    var body = JSON.stringify({
      fields: buildRecordingFields(note.text, note.epoch, settings.noteTitle)
    });
    request('POST', url, {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + auth.idToken
    }, body, function (err2, status, resp) {
      if (err2) { return cb(err2); }
      if (status === 200 || status === 409) { return cb(null); }
      if (status === 401 || status === 403) {
        // Token no longer valid — drop the cache so the next attempt
        // re-authenticates from scratch.
        clearAuthCache();
      }
      var msg = (resp && resp.error && resp.error.message) || ('HTTP ' + status);
      cb(new Error(msg));
    });
  });
}

module.exports = {
  newDocumentId: newDocumentId,
  ensureAuth: ensureAuth,
  uploadRecording: uploadRecording,
  buildRecordingFields: buildRecordingFields,
  clearAuthCache: clearAuthCache
};
