/* Boot: read researcher URL options, create the app and the UI. */
(function (SCO) {
  'use strict';

  function options() {
    var query = new URLSearchParams(window.location.search);
    var result = { mode: query.get('mode') === 'practice' ? 'practice' : 'study', taskOrder: null };
    var order = (query.get('order') || '').split(',').filter(Boolean);
    var unique = order.filter(function (id, i) { return SCO.config.tasks[id] && order.indexOf(id) === i; });
    if (order.length && unique.length === order.length) result.taskOrder = unique;
    return result;
  }

  var opts = options();
  if (opts.taskOrder) SCO.config.taskOrder = opts.taskOrder;
  var app = SCO.createApp({});
  var ui = SCO.createUI(app, document.getElementById('root'));
  if (opts.mode === 'practice') ui.setMode('practice');

  document.addEventListener('visibilitychange', function () {
    if (app.getState().session.status === 'active' && app.getSessionId()) {
      app.dispatch('system.visibility', { state: document.visibilityState }, 'system');
    }
  });

  SCO.app = app;
})(window.SCO = window.SCO || {});
