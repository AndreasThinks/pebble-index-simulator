/*
 * Durable note queue in localStorage. Notes survive companion restarts
 * and upload whenever connectivity/auth allows, oldest first.
 */

'use strict';

var KEY = 'noteQueue';

function load() {
  try {
    var q = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(q) ? q : [];
  } catch (e) {
    return [];
  }
}

function save(queue) {
  localStorage.setItem(KEY, JSON.stringify(queue));
}

function push(note) {
  var queue = load();
  queue.push(note);
  save(queue);
  return queue.length;
}

function size() {
  return load().length;
}

/**
 * Upload queued notes sequentially with uploadFn(note, cb). Stops at the
 * first failure (order preserved). Calls done(lastError, remaining).
 */
function flush(uploadFn, done) {
  var queue = load();
  var next = function () {
    if (queue.length === 0) {
      save(queue);
      return done(null, 0);
    }
    uploadFn(queue[0], function (err) {
      if (err) {
        save(queue);
        return done(err, queue.length);
      }
      queue.shift();
      save(queue);
      next();
    });
  };
  next();
}

module.exports = {
  load: load,
  push: push,
  size: size,
  flush: flush
};
