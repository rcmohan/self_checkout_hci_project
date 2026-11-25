/* Best-effort browser-local checkpointing. Storage may be missing, blocked or
 * full; every failure is reported so the UI can warn the participant. */
(function (SCO) {
  'use strict';

  var KEY = 'sco.session.v1';

  function createStore(getStorage) {
    var problem = null;
    var storage = null;
    try {
      storage = getStorage();
      if (!storage) throw new Error('unavailable');
      storage.setItem(KEY + '.probe', '1');
      storage.removeItem(KEY + '.probe');
    } catch (err) {
      storage = null;
      problem = 'unavailable';
    }

    function read() {
      if (!storage) return null;
      try {
        var raw = storage.getItem(KEY);
        if (!raw) return null;
        var data = JSON.parse(raw);
        if (!data || data.v !== 1 || !data.log || !data.state) return null;
        return data;
      } catch (err) {
        problem = 'read_failed';
        return null;
      }
    }

    return {
      read: read,
      /* Refuses to overwrite a checkpoint that another tab or session owns, so
       * different sessions are never merged or silently replaced. */
      write: function (data, claim) {
        if (!storage) return false;
        var current = read();
        if (!claim && current && (current.owner !== data.owner ||
            current.log.sessionId !== data.log.sessionId)) {
          problem = 'conflict';
          return false;
        }
        try {
          storage.setItem(KEY, JSON.stringify(data));
          problem = null;
          return true;
        } catch (err) {
          problem = 'write_failed';
          return false;
        }
      },
      clear: function () {
        if (!storage) return false;
        try { storage.removeItem(KEY); return true; } catch (err) { problem = 'write_failed'; return false; }
      },
      problem: function () { return problem; }
    };
  }

  SCO.persistence = { createStore: createStore, KEY: KEY };
})(window.SCO = window.SCO || {});
