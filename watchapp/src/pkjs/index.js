/*
 * Index Notes companion (PebbleKit JS).
 *
 * Receives dictated note text from the watch, then writes it into the
 * Pebble mobile app's Index feed by creating a RecordingDocument in the
 * user's Firestore recordings collection (the same path the app's
 * multi-device sync ingests from). Notes that can't be uploaded are
 * queued in localStorage and retried.
 *
 * Result codes sent back to the watch:
 *   0 = uploaded, visible in the Index feed
 *   1 = queued on the phone, will upload later
 *   2 = companion not configured (open settings)
 *   3 = upload error (detail in RESULT_TEXT)
 */

'use strict';

var settingsStore = require('./settings');
var firebase = require('./firebase');
var queue = require('./queue');

var CONFIG_PAGE_URL = 'https://andreasthinks.github.io/pebble-index-simulator/';

/*
 * If the Pebble mobile app ever ships the proposed official ingestion API
 * (see docs/upstream-proposal.md), use it: zero configuration, and notes
 * get full agent processing. Otherwise fall back to writing the sync
 * collection directly via Firebase.
 */
function nativeIndexAvailable() {
  return typeof Pebble.addIndexNote === 'function';
}

function submitViaNativeApi(note, cb) {
  try {
    Pebble.addIndexNote(note.text, function () {
      cb(null);
    }, function (err) {
      cb(new Error(err ? String(err) : 'addIndexNote failed'));
    });
  } catch (e) {
    cb(e);
  }
}

function sendResult(code, text, queueSize) {
  Pebble.sendAppMessage({
    RESULT_CODE: code,
    RESULT_TEXT: text || '',
    QUEUE_SIZE: queueSize || 0
  }, function () {}, function () {});
}

function shortError(err) {
  var msg = (err && err.message) ? err.message : 'unknown error';
  return msg.length > 60 ? msg.slice(0, 57) + '...' : msg;
}

function flushAndReport(reportEvenIfIdle) {
  var settings = settingsStore.load();
  var useNative = nativeIndexAvailable();
  if (!useNative && !settingsStore.isConfigured(settings)) {
    if (queue.size() > 0 || reportEvenIfIdle) {
      sendResult(2, 'not configured', queue.size());
    }
    return;
  }
  if (queue.size() === 0) {
    return;
  }
  queue.flush(function (note, cb) {
    if (useNative) {
      submitViaNativeApi(note, cb);
    } else {
      firebase.uploadRecording(settings, note, cb);
    }
  }, function (err, remaining) {
    if (err) {
      // Network-ish failures mean "queued, will retry"; anything else is
      // surfaced as an upload error so the user knows to check settings.
      var networky = /network|timeout/i.test(err.message || '');
      sendResult(networky ? 1 : 3, shortError(err), remaining);
    } else {
      sendResult(0, 'ok', 0);
    }
  });
}

Pebble.addEventListener('ready', function () {
  console.log('Index Notes companion ready; queued notes: ' + queue.size());
  // Push any notes left over from a previous session.
  flushAndReport(false);
});

Pebble.addEventListener('appmessage', function (e) {
  var payload = e.payload || {};
  var text = payload.NOTE_TEXT;
  if (!text) {
    return;
  }
  var epoch = payload.NOTE_EPOCH || Math.floor(Date.now() / 1000);
  queue.push({
    docId: firebase.newDocumentId(),
    text: String(text),
    epoch: epoch
  });
  flushAndReport(true);
});

Pebble.addEventListener('showConfiguration', function () {
  var settings = settingsStore.load();
  // Don't leak the password into the URL fragment; everything else is
  // needed to prefill the form.
  var forPage = JSON.parse(JSON.stringify(settings));
  delete forPage.password;
  Pebble.openURL(CONFIG_PAGE_URL + '#' +
    encodeURIComponent(JSON.stringify(forPage)));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) {
    return;
  }
  var incoming;
  try {
    incoming = JSON.parse(decodeURIComponent(e.response));
  } catch (err) {
    console.log('Bad config response: ' + err.message);
    return;
  }
  var settings = settingsStore.load();
  for (var k in incoming) {
    if (incoming.hasOwnProperty(k) && incoming[k] !== undefined && incoming[k] !== '') {
      settings[k] = incoming[k];
    }
  }
  settingsStore.save(settings);
  // Credentials may have changed — force re-auth and verify them now.
  firebase.clearAuthCache();
  if (settingsStore.isConfigured(settings)) {
    firebase.ensureAuth(settings, function (err, auth) {
      if (err) {
        console.log('Auth check failed: ' + err.message);
        sendResult(3, 'auth: ' + shortError(err), queue.size());
      } else {
        console.log('Authenticated as uid ' + auth.uid);
        flushAndReport(false);
      }
    });
  }
});
