/* Append-only semantic event log with a monotonic session clock. */
(function (SCO) {
  'use strict';

  var FIELD_ORDER = ['actor', 'taskId', 'screen', 'actionId', 'lineId', 'issueId', 'requestId', 'sku', 'details'];

  /* `now` must be monotonic (performance.now). A resumed log continues from the
   * last recorded tMs; the offline gap is recorded separately, never added. */
  function createLog(sessionId, now, saved) {
    var events = saved ? saved.events.slice() : [];
    var base = events.length ? events[events.length - 1].tMs : 0;
    var start = now();
    var frozen = saved ? !!saved.frozen : false;

    function elapsed() {
      var last = events.length ? events[events.length - 1].tMs : 0;
      return Math.max(last, Math.round(base + (now() - start)));
    }

    function add(type, fields) {
      if (frozen) return null;
      var event = { seq: events.length + 1, tMs: elapsed(), type: type };
      FIELD_ORDER.forEach(function (key) {
        var value = fields ? fields[key] : undefined;
        if (value === undefined) return;
        if (value === null && key !== 'taskId') return;
        event[key] = value;
      });
      if (event.details) event.details = JSON.parse(JSON.stringify(event.details));
      events.push(event);
      return event;
    }

    return {
      sessionId: sessionId,
      add: add,
      elapsed: elapsed,
      events: events,
      freeze: function () { frozen = true; },
      isFrozen: function () { return frozen; },
      snapshot: function () { return { sessionId: sessionId, events: events, frozen: frozen }; }
    };
  }

  SCO.telemetry = { createLog: createLog };
})(window.SCO = window.SCO || {});
