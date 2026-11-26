/* Central action dispatcher: the only path that mutates state. It runs the
 * reducer, writes telemetry, owns timers and checkpoints. No DOM access, so it
 * can be tested with a fake clock and scheduler. */
(function (SCO) {
  'use strict';

  /* Only these parameters may appear in telemetry. Typed input (codes,
   * quantities, search text) is deliberately absent. */
  var TARGET_KEYS = ['lineId', 'issueId', 'requestId', 'simItemId', 'sku', 'option', 'reason', 'method', 'mode', 'delta'];
  var SAFE_VALUE = /^[A-Za-z0-9_\-]{1,40}$/;

  function randomUuid() {
    var c = window.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    var bytes = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map.call(bytes, function (b) { return (b + 256).toString(16).slice(1); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function createApp(options) {
    options = options || {};
    var config = options.config || SCO.config;
    var now = options.now || function () { return window.performance.now(); };
    var wallNow = options.wallNow || function () { return Date.now(); };
    var setTimer = options.setTimer || function (fn, ms) { return window.setTimeout(fn, ms); };
    var clearTimer = options.clearTimer || function (id) { window.clearTimeout(id); };
    var uuid = options.uuid || randomUuid;
    var store = options.store || SCO.persistence.createStore(options.getStorage || function () { return window.localStorage; });
    var owner = uuid();

    var state = SCO.tx.initialState();
    var log = null;
    var epoch = 0;
    var timers = {};
    var actionCounter = 0;
    var listeners = [];
    var exportCache = null;
    var saved = store.read();

    function notify() { listeners.forEach(function (fn) { fn(); }); }

    /* Only an explicit resume claims an existing checkpoint. */
    function checkpoint(claim) {
      if (!log) return;
      store.write({ v: 1, owner: owner, savedAt: wallNow(), actionCounter: actionCounter,
        state: state, log: log.snapshot() }, claim);
    }

    function cancelTimer(key) {
      if (timers[key] !== undefined) { clearTimer(timers[key]); delete timers[key]; }
    }
    function cancelAll() {
      Object.keys(timers).forEach(cancelTimer);
      epoch += 1;
    }

    function schedule(effect, actionId) {
      cancelTimer(effect.key);
      var myEpoch = epoch;
      timers[effect.key] = setTimer(function () {
        if (myEpoch !== epoch) return;
        delete timers[effect.key];
        dispatch(effect.action.type, effect.action.params, effect.action.actor || 'system', actionId);
      }, effect.delayMs);
    }

    function targetOf(params) {
      var target = {};
      var any = false;
      TARGET_KEYS.forEach(function (key) {
        var value = params[key];
        if (typeof value === 'number' || (typeof value === 'string' && SAFE_VALUE.test(value))) {
          target[key] = value;
          any = true;
        }
      });
      return any ? target : undefined;
    }

    function dispatch(type, params, actor, correlationId) {
      params = params || {};
      actor = actor || 'participant';
      if (log && log.isFrozen()) return { outcome: 'rejected', reasonCode: 'session_ended' };
      var starting = type === 'session.start';
      if (!log && !starting) return { outcome: 'rejected', reasonCode: 'session_not_active' };
      if (starting && state.session.status !== 'not_started') return { outcome: 'rejected', reasonCode: 'already_started' };

      if (starting) {
        log = SCO.telemetry.createLog(uuid(), now);
        saved = null;
        exportCache = null;
      }
      var participant = actor === 'participant';
      var logActions = participant && !starting;
      var actionId = correlationId || ('A' + (++actionCounter));
      var screenBefore = state.ui.screen;
      var taskBefore = state.tasks.activeId;

      if (logActions) {
        log.add('action_attempted', { actor: actor, taskId: taskBefore, screen: screenBefore, actionId: actionId,
          details: { actionName: type, target: targetOf(params) } });
      }

      var result;
      try {
        result = SCO.tx.reduce(state, { type: type, params: params, actor: actor }, {
          config: config, taskOrder: options.taskOrder,
          now: function () { return log.elapsed(); }
        });
      } catch (err) {
        if (window.console) window.console.error(err);
        log.add('action_result', { actor: actor, taskId: taskBefore, screen: screenBefore, actionId: actionId,
          details: { actionName: type, outcome: 'error', reasonCode: 'exception', errorCategory: 'technical' } });
        checkpoint();
        notify();
        return { outcome: 'error', reasonCode: 'exception' };
      }

      if (result.reasonCode === 'stale_callback') return result;
      state = result.state;

      var ending = null;
      result.events.forEach(function (event) {
        if (event.type === 'session_ended') { ending = event; return; }
        event.actionId = actionId;
        log.add(event.type, event);
      });
      if (state.ui.screen !== screenBefore) {
        log.add('screen_changed', { actor: participant ? actor : 'system', taskId: state.tasks.activeId,
          screen: state.ui.screen, actionId: actionId, details: { from: screenBefore, to: state.ui.screen } });
      }
      if (logActions) {
        log.add('action_result', { actor: 'system', taskId: taskBefore, screen: state.ui.screen, actionId: actionId,
          details: { actionName: type, outcome: result.outcome, reasonCode: result.reasonCode || undefined,
            errorCategory: result.errorCategory || undefined } });
      }
      if (ending) {
        ending.actionId = actionId;
        ending.actor = actor;
        log.add(ending.type, ending);
        log.freeze();
      }

      result.effects.forEach(function (effect) {
        if (effect.type === 'schedule') schedule(effect, actionId);
        else if (effect.type === 'cancel') cancelTimer(effect.key);
        else if (effect.type === 'cancel_all') cancelAll();
      });
      checkpoint();
      notify();
      return result;
    }

    function resume() {
      if (!saved) return false;
      cancelAll();
      var gap = typeof saved.savedAt === 'number' ? wallNow() - saved.savedAt : null;
      if (gap !== null && gap < 0) gap = null;
      state = saved.state;
      actionCounter = saved.actionCounter || 0;
      log = SCO.telemetry.createLog(saved.log.sessionId, now, saved.log);
      var ended = log.isFrozen();
      saved = null;
      exportCache = null;
      if (!ended) {
        state.ui.banner = null;
        log.add('session_resumed', { actor: 'participant', taskId: state.tasks.activeId, screen: state.ui.screen,
          details: { offlineGapMs: gap } });
        /* Timers did not survive the reload: restart each outstanding one. */
        state.requests.forEach(function (r) {
          if (r.phase === 'verifying') schedule({ key: r.requestId, delayMs: config.delays.verificationMs,
            action: { type: 'system.verification', params: { requestId: r.requestId, attempt: r.attempt } } });
        });
        state.assists.forEach(function (a) {
          if (a.status === 'requested') schedule({ key: a.assistId, delayMs: config.delays.assistanceMs,
            action: { type: 'system.assistance', params: { assistId: a.assistId }, actor: 'simulated_employee' } });
        });
        if (state.payment) schedule({ key: state.payment.paymentId, delayMs: config.delays.paymentMs,
          action: { type: 'system.payment', params: { paymentId: state.payment.paymentId } } });
      }
      checkpoint(true);
      notify();
      return true;
    }

    /* Used both to discard a saved session and to delete the current one. */
    function reset() {
      cancelAll();
      store.clear();
      state = SCO.tx.initialState();
      log = null;
      saved = null;
      exportCache = null;
      actionCounter = 0;
      notify();
    }

    function getExport() {
      if (!log || !log.isFrozen()) return null;
      if (!exportCache) {
        var doc = SCO.exporter.build(state, log, config);
        var built = {
          sessionId: log.sessionId,
          filename: SCO.exporter.filename(log.sessionId),
          compact: JSON.stringify(doc),
          pretty: JSON.stringify(doc, null, 2),
          paste: null
        };
        /* Compression is asynchronous; `paste` is filled in when it finishes. */
        built.ready = SCO.exporter.pack(built.compact, built.sessionId).then(function (text) {
          built.paste = text;
          return text;
        });
        exportCache = built;
      }
      return exportCache;
    }

    var app = {
      config: config,
      dispatch: dispatch,
      resume: resume,
      reset: reset,
      getExport: getExport,
      getState: function () { return state; },
      getEvents: function () { return log ? log.events : []; },
      getSessionId: function () { return log ? log.sessionId : null; },
      savedSession: function () {
        return saved ? { ended: !!saved.log.frozen, mode: saved.state.session.mode } : null;
      },
      storageProblem: function () { return store.problem(); },
      subscribe: function (fn) { listeners.push(fn); }
    };

    /* A finished session reopens on its results screen with the same log. */
    if (saved && saved.log.frozen) resume();
    return app;
  }

  SCO.createApp = createApp;
})(window.SCO = window.SCO || {});
