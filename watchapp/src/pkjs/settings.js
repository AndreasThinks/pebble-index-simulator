/*
 * Settings storage for the Index Notes companion.
 *
 * Settings are configured from the app's config page and kept in
 * localStorage. Endpoint hosts are overridable so the whole pipeline can
 * be pointed at the local ingestion simulator during development.
 */

'use strict';

var DEFAULTS = {
  // Firebase web config of the Pebble app's Firebase project.
  apiKey: '',
  projectId: '',

  // 'refresh_token' (paste a Firebase refresh token) or 'password'
  // (email/password sign-in, if the project has it enabled).
  authMode: 'refresh_token',
  refreshToken: '',
  email: '',
  password: '',

  // Title shown on the note in the Index feed.
  noteTitle: 'Pebble watch note',

  // Endpoint overrides (used by the simulator / tests).
  authHost: 'https://securetoken.googleapis.com',
  identityHost: 'https://identitytoolkit.googleapis.com',
  firestoreHost: 'https://firestore.googleapis.com'
};

function load() {
  var stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('settings') || '{}');
  } catch (e) {
    stored = {};
  }
  var merged = {};
  for (var k in DEFAULTS) {
    if (DEFAULTS.hasOwnProperty(k)) {
      merged[k] = (stored[k] !== undefined && stored[k] !== null) ? stored[k] : DEFAULTS[k];
    }
  }
  return merged;
}

function save(settings) {
  localStorage.setItem('settings', JSON.stringify(settings));
}

function isConfigured(settings) {
  if (!settings.apiKey || !settings.projectId) {
    return false;
  }
  if (settings.authMode === 'password') {
    return !!(settings.email && settings.password);
  }
  return !!settings.refreshToken;
}

module.exports = {
  DEFAULTS: DEFAULTS,
  load: load,
  save: save,
  isConfigured: isConfigured
};
