/* Acceptance tests for the logic layer, using a fake clock and scheduler.
 * Open tests/tests.html in a browser, or run `python tests/run_tests.py`. */
(function (SCO) {
  'use strict';

  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  function ok(value, message) { if (!value) throw new Error(message || 'expected truthy'); }
  function equal(actual, expected, message) {
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    if (a !== e) throw new Error((message ? message + ': ' : '') + 'expected ' + e + ', got ' + a);
  }

  function memoryStorage() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; }
    };
  }

  var uuidCounter = 0;
  function harness(options) {
    options = options || {};
    var h = { time: 0, wall: options.wall || 1000000, timers: [], nextTimer: 0 };
    h.config = JSON.parse(JSON.stringify(SCO.config));
    if (options.configure) options.configure(h.config);
    h.storage = options.storage === undefined ? memoryStorage() : options.storage;
    h.app = SCO.createApp({
      config: h.config,
      taskOrder: options.taskOrder,
      now: function () { return h.time; },
      wallNow: function () { return h.wall; },
      uuid: function () { uuidCounter += 1; return 'test-uuid-' + uuidCounter; },
      getStorage: function () { if (h.storage === 'throw') throw new Error('SecurityError'); return h.storage; },
      setTimer: function (fn, ms) { h.nextTimer += 1; h.timers.push({ id: h.nextTimer, at: h.time + ms, fn: fn }); return h.nextTimer; },
      clearTimer: function (id) { h.timers = h.timers.filter(function (t) { return t.id !== id; }); }
    });
    h.run = function (ms) {
      var end = h.time + (ms === undefined ? 60000 : ms);
      for (;;) {
        h.timers.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
        if (!h.timers.length || h.timers[0].at > end) break;
        var t = h.timers.shift();
        h.time = t.at;
        t.fn();
      }
      if (ms !== undefined) h.time = end;
    };
    h.d = function (type, params) { h.time += 100; return h.app.dispatch(type, params); };
    h.s = function () { return h.app.getState(); };
    h.events = function (type) { return h.app.getEvents().filter(function (e) { return !type || e.type === type; }); };
    h.qty = function (sku) { return SCO.scenario.quantityOf(h.s(), sku); };
    h.line = function (sku) { return h.s().lines.filter(function (l) { return l.sku === sku; })[0]; };
    h.open = function (type) {
      return SCO.tx.unresolved(h.s()).filter(function (i) { return !type || i.type === type; });
    };
    h.total = function () { return SCO.tx.totals(h.s(), h.config); };
    h.steps = function () {
      return h.s().requests.filter(function (r) {
        return r.physical && (r.phase === 'awaiting_physical' || r.phase === 'failed');
      });
    };
    /* Perform every outstanding physical step and wait for verification. */
    h.perform = function () {
      h.steps().forEach(function (r) { h.d('physical.confirm', { requestId: r.requestId }); });
      h.run(h.config.delays.verificationMs);
    };
    h.scan = function (sku) { var r = h.d('scan.item', { simItemId: sku }); return r; };
    h.add = function (sku) { h.scan(sku); h.perform(); };
    h.practice = function () { h.d('session.start', { mode: 'practice' }); h.d('kiosk.start'); return h; };
    h.study = function (taskId) {
      h.config.taskOrder = taskId ? [taskId] : h.config.taskOrder;
      h.d('session.start', { mode: 'study' });
      h.d('task.start');
      return h;
    };
    h.pay = function () {
      h.d('pay.start');
      h.d('pay.method', { method: 'credit' });
      h.d('pay.tender');
      h.run(h.config.delays.paymentMs);
    };
    h.doc = function () { return JSON.parse(h.app.getExport().compact); };
    return h;
  }

  function checkInvariants(h) {
    var s = h.s();
    var seen = {};
    s.lines.forEach(function (l) {
      var item = SCO.catalog.get(l.sku);
      ok(l.qty >= 1, 'line quantity below 1');
      ok(l.unbagged >= 0 && l.unbagged <= l.qty, 'unbagged out of range ' + l.unbagged + '/' + l.qty);
      var bagging = s.requests.filter(function (r) { return r.kind === 'scan_bagging' && r.lineId === l.lineId; })
        .reduce(function (n, r) { return n + r.qty; }, 0);
      if (!s.checkoutCompleted) equal(bagging, l.unbagged, 'bagging requests match unbagged units for ' + l.sku);
      if (item.unit === 'each') { ok(!seen[l.sku], 'duplicate count row for ' + l.sku); seen[l.sku] = true; }
    });
    s.requests.forEach(function (r) {
      if (r.lineId) ok(s.lines.some(function (l) { return l.lineId === r.lineId; }), 'request points at missing line');
      if (r.issueId) {
        ok(SCO.tx.unresolved(s).some(function (i) { return i.issueId === r.issueId; }), 'request for a closed issue');
      }
    });
    var subtotal = s.lines.reduce(function (n, l) { return n + SCO.tx.lineAmount(l); }, 0);
    equal(h.total().subtotalCents, subtotal, 'subtotal derives from lines');
    ok(h.events().every(function (e) { return !(e.details && e.details.errorCategory === 'technical'); }), 'technical error logged');
  }

  /* ---------- quantity editing ---------- */

  test('Totals use integer cents and match the reference screenshots', function () {
    var h = harness().practice();
    h.add('eggs');
    equal([h.total().subtotalCents, h.total().taxCents, h.total().totalCents], [449, 27, 476]);
    h.add('eggs');
    equal(h.total().totalCents, 952);
  });

  test('Repeated scanning aggregates into one row and needs bagging', function () {
    var h = harness().practice();
    h.scan('soup');
    equal(h.scan('soup').reasonCode, 'awaiting_bagging');
    equal(h.qty('soup'), 1);
    h.perform();
    h.add('soup');
    h.add('soup');
    equal([h.s().lines.length, h.qty('soup')], [1, 3]);
    equal(h.events('scan_result').filter(function (e) { return e.details.repeat; }).length, 2);
  });

  test('Quantity 1 to 3 commits only after verification', function () {
    var h = harness().practice();
    h.add('soup');
    var line = h.line('soup').lineId;
    h.d('qty.open', { lineId: line });
    h.d('qty.submit', { lineId: line, value: '3' });
    equal([h.qty('soup'), h.total().subtotalCents], [1, 129]);
    equal(h.events('quantity_committed').length, 0);
    var req = h.steps()[0];
    h.d('physical.confirm', { requestId: req.requestId });
    equal(h.qty('soup'), 1, 'still pending while verifying');
    h.run(h.config.delays.verificationMs - 1);
    equal(h.qty('soup'), 1);
    h.run(1);
    equal([h.qty('soup'), h.total().subtotalCents], [3, 387]);
    equal(h.open().length, 0);
    checkInvariants(h);
  });

  test('Quantity input is validated and zero routes through removal', function () {
    var h = harness().practice();
    h.add('soup');
    var line = h.line('soup').lineId;
    h.d('qty.open', { lineId: line });
    ['', 'abc', '-2', '1.5'].forEach(function (value) {
      equal(h.d('qty.submit', { lineId: line, value: value }).reasonCode, 'invalid_quantity', 'value ' + value);
    });
    equal(h.d('qty.submit', { lineId: line, value: '13' }).reasonCode, 'over_limit');
    equal(h.s().ui.screen, 'qty_editor');
    h.d('qty.submit', { lineId: line, value: '0' });
    equal([h.s().ui.screen, h.qty('soup')], ['removal_confirm', 1]);
    var errors = h.events('action_result').filter(function (e) { return e.details.errorCategory === 'participant_input'; });
    equal(errors.length, 5);
    ok(h.app.getEvents().every(function (e) { return JSON.stringify(e).indexOf('abc') < 0; }), 'typed text must not be logged');
  });

  test('Cancel leaves committed quantity unchanged, before the physical step', function () {
    var h = harness().practice();
    h.add('soup');
    h.d('qty.step', { lineId: h.line('soup').lineId, delta: 1 });
    h.d('request.cancel', { requestId: h.s().requests[0].requestId });
    h.run();
    equal([h.qty('soup'), h.s().requests.length, h.open().length], [1, 0, 0]);
    equal(h.events('quantity_committed').length, 0);
    equal(h.events('issue_resolved')[0].details.finalStatus, 'canceled');
  });

  test('Cancel after items were moved requires a verified reversal', function () {
    var h = harness({ configure: function (c) { c.verification.approvalForUnwantedRemoval = true; } }).practice();
    h.add('soup');
    h.add('soup');
    h.d('qty.step', { lineId: h.line('soup').lineId, delta: -1 });
    h.d('decrease.confirm', { reason: 'unwanted' });
    h.perform();
    var req = h.s().requests[0];
    equal(req.phase, 'awaiting_approval');
    h.d('request.cancel', { requestId: req.requestId });
    equal([h.s().requests[0].physical, h.open().length], ['putback', 1], 'not cleared by the tap alone');
    equal(h.d('pay.start').reasonCode, 'unresolved_issues');
    h.perform();
    equal([h.qty('soup'), h.s().requests.length, h.open().length], [2, 0, 0]);
    checkInvariants(h);
  });

  test('Decrease distinguishes duplicate correction from physical return', function () {
    var h = harness().practice();
    h.add('soup');
    h.add('soup');
    var line = h.line('soup').lineId;
    h.d('qty.step', { lineId: line, delta: -1 });
    equal(h.s().ui.screen, 'decrease_reason');
    h.d('decrease.confirm', { reason: 'duplicate' });
    equal(h.steps().length, 0, 'no physical removal for a duplicate entry');
    equal(h.qty('soup'), 2);
    h.run();
    equal(h.qty('soup'), 1);
    h.add('soup');
    h.d('qty.step', { lineId: line, delta: -1 });
    h.d('decrease.confirm', { reason: 'unwanted' });
    equal(h.steps()[0].physical, 'return');
    h.run();
    equal(h.qty('soup'), 2, 'waits for the return step');
    h.perform();
    equal(h.qty('soup'), 1);
  });

  /* ---------- removal ---------- */

  test('Trash removes the whole line after verification, with cancel', function () {
    var h = harness().practice();
    h.add('milk');
    h.add('soup');
    h.add('soup');
    var milk = h.line('milk').lineId;
    h.d('remove.open', { lineId: milk });
    h.d('nav.back');
    equal(h.qty('milk'), 1);
    h.d('remove.open', { lineId: milk });
    h.d('remove.confirm', { reason: 'unwanted' });
    equal([h.qty('milk'), h.total().subtotalCents], [1, 399 + 258]);
    h.d('request.cancel', { requestId: h.s().requests[0].requestId });
    equal([h.qty('milk'), h.open().length], [1, 0]);
    h.d('remove.open', { lineId: h.line('soup').lineId });
    h.d('remove.confirm', { reason: 'duplicate' });
    equal(h.steps().length, 0);
    h.run();
    equal([h.qty('soup'), h.total().subtotalCents], [0, 399]);
    equal(h.events('removal_committed')[0].details.quantity, 2);
    checkInvariants(h);
  });

  test('A failed verification is visible and can be retried or canceled', function () {
    var h = harness().practice();
    h.add('milk');
    h.d('sim.fail_verification');
    h.d('remove.open', { lineId: h.line('milk').lineId });
    h.d('remove.confirm', { reason: 'unwanted' });
    h.perform();
    equal([h.s().requests[0].phase, h.qty('milk'), h.s().ui.banner.code], ['failed', 1, 'verification_failed']);
    equal(h.events('verification_result').slice(-1)[0].details.errorCategory, 'injected_scenario');
    h.perform();
    equal(h.qty('milk'), 0);
  });

  /* ---------- special items ---------- */

  test('Weighed produce keeps its weighing workflow and has no count editing', function () {
    var h = harness().practice();
    h.d('lookup.open');
    h.d('lookup.select', { sku: 'bananas' });
    equal(h.d('weigh.confirm').outcome, 'rejected', 'must weigh first');
    h.d('scale.place');
    h.d('weigh.confirm');
    h.perform();
    equal(h.total().subtotalCents, 124);
    var line = h.line('bananas').lineId;
    equal(h.d('qty.step', { lineId: line, delta: 1 }).reasonCode, 'weight_item');
    equal(h.d('qty.open', { lineId: line }).reasonCode, 'weight_item');
  });

  test('Restricted items need authorization, including quantity increases', function () {
    var h = harness().practice();
    h.scan('wine');
    equal([h.qty('wine'), h.total().subtotalCents, h.open('authorization_required').length], [0, 0, 1]);
    equal(h.d('pay.start').reasonCode, 'empty_order');
    h.d('nav.back');
    h.add('soup');
    equal(h.qty('soup'), 1, 'scanning continues while authorization is pending');
    equal(h.d('pay.start').reasonCode, 'unresolved_issues');
    h.d('assist.request', { issueId: h.open()[0].issueId });
    h.run(h.config.delays.assistanceMs);
    equal(h.qty('wine'), 1);
    h.perform();
    h.d('qty.step', { lineId: h.line('wine').lineId, delta: 1 });
    h.perform();
    equal([h.qty('wine'), h.s().requests[0].phase], [1, 'awaiting_approval']);
    h.d('assist.request', { issueId: h.open()[0].issueId });
    h.run(h.config.delays.assistanceMs);
    equal([h.qty('wine'), h.open().length], [2, 0]);
    checkInvariants(h);
  });

  /* ---------- scanning problems and issues ---------- */

  test('A failed scan creates an unidentified, unpriced issue', function () {
    var h = harness().practice();
    h.scan('paper_towels');
    var issue = h.open('unreadable_barcode')[0];
    equal([issue.sku, h.s().lines.length, h.total().subtotalCents, h.total().itemCount], [null, 0, 0, 0]);
    equal(h.events('scan_result')[0].sku, undefined);
    equal(h.events('scan_result')[0].details.errorCategory, 'injected_scenario');
    equal(SCO.exporter.metrics(h.events()).participantErrors, 0);
  });

  test('Retry does not duplicate the issue; a later successful read resolves it', function () {
    var h = harness().practice();
    h.scan('paper_towels');
    h.d('help.choose', { option: 'retry_scan' });
    equal(h.open().length, 1);
    h.d('help.choose', { option: 'retry_scan' });
    equal([h.open().length, h.qty('paper_towels')], [0, 1]);
    equal(h.events('issue_resolved')[0].details.resolutionMethod, 'rescan');
  });

  test('Resolving one issue leaves the others open', function () {
    var h = harness().practice();
    h.scan('paper_towels');
    h.d('help.choose', { option: 'set_aside' });
    h.scan('unknown_snack');
    h.d('help.choose', { option: 'set_aside' });
    h.add('soup');
    equal(h.open().length, 2);
    var unreadable = h.open('unreadable_barcode')[0];
    h.d('issue.open', { issueId: unreadable.issueId });
    h.d('help.choose', { option: 'enter_code' });
    equal(h.d('manual.submit', { code: '999999' }).reasonCode, 'invalid_code');
    h.d('manual.submit', { code: '100107' });
    h.perform();
    equal([h.qty('paper_towels'), h.open().length, h.open()[0].type], [1, 1, 'unknown_product']);
    ok(JSON.stringify(h.events()).indexOf('999999') < 0 && JSON.stringify(h.events()).indexOf('100107') < 0, 'codes not logged');
  });

  test('Not buying an unidentified item needs a verified return', function () {
    var h = harness().practice();
    h.scan('unknown_snack');
    h.d('help.choose', { option: 'not_buying' });
    equal(h.open().length, 1);
    h.perform();
    equal(h.open().length, 0);
    equal(h.events('issue_resolved')[0].details.finalStatus, 'canceled');
  });

  test('Deferrable issues permit scanning; non-deferrable issues block it', function () {
    var h = harness().practice();
    h.add('milk');
    h.d('sim.unexpected_item');
    equal(h.scan('soup').reasonCode, 'blocking_issue');
    equal(h.d('qty.step', { lineId: h.line('milk').lineId, delta: 1 }).reasonCode, 'blocking_issue');
    equal(h.d('lookup.open').reasonCode, 'blocking_issue');
    h.d('issue.open', { issueId: h.open()[0].issueId });
    equal(h.d('help.choose', { option: 'set_aside' }).outcome, 'rejected');
    h.d('help.choose', { option: 'remove_from_bagging' });
    h.perform();
    equal([h.open().length, h.scan('soup').outcome], [0, 'accepted']);
  });

  test('Scan again recovers from an unexpected item', function () {
    var h = harness().practice();
    h.d('sim.unexpected_item');
    h.d('help.choose', { option: 'scan_again' });
    h.scan('soup');
    equal(h.open().length, 0);
  });

  test('A pending change blocks scanning until it is set aside', function () {
    var h = harness().practice();
    h.add('milk');
    h.d('qty.step', { lineId: h.line('milk').lineId, delta: 1 });
    equal(h.scan('soup').reasonCode, 'pending_change');
    h.d('issue.defer', { issueId: h.open()[0].issueId });
    h.scan('soup');
    /* Bag only the new scan; leave the set-aside step undone. */
    h.d('physical.confirm', { requestId: h.steps().filter(function (r) { return r.kind === 'scan_bagging'; })[0].requestId });
    h.run();
    equal([h.qty('soup'), h.qty('milk'), h.open().length], [1, 1, 1]);
  });

  test('Closing help does not resolve an issue', function () {
    var h = harness().practice();
    h.scan('unknown_snack');
    h.d('nav.back');
    equal(h.open().length, 1);
    equal(h.events('help_closed').length, 1);
  });

  test('Every help context offers a path that clears its issue', function () {
    ['report_unreadable', 'report_produce', 'report_bagging'].forEach(function (option) {
      var h = harness().practice();
      h.d('help.open');
      h.d('help.choose', { option: option });
      equal(h.open().length, 1, option);
      h.d('help.choose', { option: 'request_assistance' });
      h.run();
      equal(h.open().length, 0, option);
    });
    var h2 = harness().practice();
    h2.d('assist.request');
    equal(h2.scan('soup').reasonCode, 'blocking_issue');
    h2.run();
    equal(h2.open().length, 0);
  });

  test('Assistance uses the fixed documented delay and can be canceled', function () {
    var h = harness().practice();
    h.d('assist.request');
    h.run(2999);
    equal(h.open().length, 1);
    h.run(1);
    equal(h.open().length, 0);
    equal(h.events('assistance_completed')[0].actor, 'simulated_employee');
    h.d('assist.request');
    h.d('assist.cancel', { issueId: h.open()[0].issueId });
    h.run();
    equal(h.events('assistance_completed').map(function (e) { return e.details.outcome; }), ['resolved', 'canceled']);
  });

  /* ---------- payment and concurrency ---------- */

  test('Payment cannot be forced through direct actions while blocked', function () {
    var h = harness().practice();
    h.add('milk');
    h.scan('unknown_snack');
    h.d('nav.back');
    equal(h.d('pay.start').reasonCode, 'unresolved_issues');
    equal(h.d('pay.method', { method: 'credit' }).outcome, 'rejected');
    equal(h.d('pay.tender').outcome, 'rejected');
    h.d('system.payment', { paymentId: 'P1' });
    h.run();
    equal([h.s().checkoutCompleted, h.events('checkout_completed').length, h.events('payment_blocked').length], [false, 0, 1]);
  });

  test('Payment is re-checked when processing completes', function () {
    var h = harness().practice();
    h.add('milk');
    h.d('pay.start');
    h.d('pay.method', { method: 'credit' });
    h.d('pay.tender');
    /* Corrupt eligibility mid-flight, as a late issue would. */
    h.s().issues.push({ issueId: 'IX', type: 'general_assistance', status: 'open' });
    h.run();
    equal([h.s().checkoutCompleted, h.s().ui.screen], [false, 'checkout']);
  });

  test('Rapid taps cannot double-commit', function () {
    var h = harness().practice();
    h.add('soup');
    var line = h.line('soup').lineId;
    h.d('qty.step', { lineId: line, delta: 1 });
    equal(h.d('qty.step', { lineId: line, delta: 1 }).reasonCode, 'pending_change');
    var req = h.steps()[0].requestId;
    h.d('physical.confirm', { requestId: req });
    equal(h.d('physical.confirm', { requestId: req }).outcome, 'rejected');
    h.run();
    h.d('system.verification', { requestId: req, attempt: 1 });
    equal([h.qty('soup'), h.events('quantity_committed').length], [2, 1]);
    h.d('remove.open', { lineId: line });
    h.d('remove.confirm', { reason: 'duplicate' });
    equal(h.d('remove.confirm', { reason: 'duplicate' }).outcome, 'rejected');
    h.run();
    equal(h.events('removal_committed').length, 1);
    h.add('soup');
    h.d('pay.start');
    h.d('pay.method', { method: 'cash' });
    h.d('pay.tender');
    equal(h.d('pay.tender').outcome, 'rejected');
    h.run();
    equal(h.events('checkout_completed').length, 1);
  });

  test('Stale callbacks are ignored after cancel and reset', function () {
    var h = harness().practice();
    h.d('assist.request');
    var stale = h.timers.slice();
    h.app.reset();
    equal(h.timers.length, 0);
    h.practice();
    h.add('soup');
    var before = JSON.stringify(h.s().lines);
    stale.forEach(function (t) { t.fn(); });
    equal(JSON.stringify(h.s().lines), before);
    equal(h.events('assistance_completed').length, 0);
  });

  /* ---------- study tasks ---------- */

  function finish(h) { h.d('task.done'); return h.doc(); }

  test('T1 succeeds by repeated scanning or by direct quantity entry', function () {
    var a = harness().study('T1');
    a.d('kiosk.start');
    a.add('soup'); a.add('soup'); a.add('soup');
    equal(finish(a).tasks[0].outcome, 'success');
    var b = harness().study('T1');
    b.add('soup');
    var line = b.line('soup').lineId;
    b.d('qty.open', { lineId: line });
    b.d('qty.submit', { lineId: line, value: '3' });
    b.perform();
    equal(finish(b).tasks[0].outcome, 'success');
  });

  test('T1 is not successful while verification is pending', function () {
    var h = harness().study('T1');
    h.add('soup');
    var line = h.line('soup').lineId;
    h.d('qty.open', { lineId: line });
    h.d('qty.submit', { lineId: line, value: '3' });
    var doc = finish(h);
    equal([doc.tasks[0].outcome, doc.tasks[0].criteria.correct_quantity], ['failure', false]);
  });

  test('T2 succeeds via the duplicate prompt, minus button, or associate', function () {
    var a = harness().study('T2');
    equal([a.s().ui.screen, a.qty('eggs')], ['help', 2]);
    a.d('help.choose', { option: 'remove_duplicate' });
    a.run();
    equal(finish(a).tasks[0].outcome, 'success');

    var b = harness().study('T2');
    b.d('help.choose', { option: 'set_aside' });
    b.d('qty.step', { lineId: b.line('eggs').lineId, delta: -1 });
    b.d('decrease.confirm', { reason: 'duplicate' });
    b.run();
    equal(finish(b).tasks[0].outcome, 'success');

    var c = harness().study('T2');
    c.d('help.choose', { option: 'request_assistance' });
    c.run();
    equal(finish(c).tasks[0].outcome, 'success');
  });

  test('T2 Keep both is a participant error and not a success', function () {
    var h = harness().study('T2');
    h.d('help.choose', { option: 'keep_both' });
    var doc = finish(h);
    equal([doc.tasks[0].outcome, doc.summary.participantErrors, doc.summary.scenarioFailures], ['failure', 1, 1]);
  });

  test('Canceling duplicate removal restores the duplicate issue', function () {
    var h = harness({ configure: function (c) { c.verification.approvalForDuplicateCorrection = true; } }).study('T2');
    h.d('help.choose', { option: 'remove_duplicate' });
    h.d('request.cancel', { requestId: h.s().requests[0].requestId });
    equal([h.open().length, h.open()[0].type, h.qty('eggs')], [1, 'possible_duplicate', 2]);
  });

  test('T3 succeeds by trash; removing a wrong line is an error', function () {
    var a = harness().study('T3');
    a.d('remove.open', { lineId: a.line('milk').lineId });
    a.d('remove.confirm', { reason: 'unwanted' });
    a.perform();
    var doc = finish(a);
    equal([doc.tasks[0].outcome, doc.summary.participantErrors], ['success', 0]);
    var b = harness().study('T3');
    b.d('remove.open', { lineId: b.line('bread').lineId });
    b.d('remove.confirm', { reason: 'unwanted' });
    equal(finish(b).summary.participantErrors, 1);
  });

  test('T4 succeeds by code entry, lookup, or associate', function () {
    var a = harness().study('T4');
    a.scan('cereal');
    a.d('help.choose', { option: 'retry_scan' });
    equal(a.open().length, 1, 'cereal never reads in T4');
    a.d('help.choose', { option: 'enter_code' });
    a.d('manual.submit', { code: '100105' });
    a.perform();
    equal(finish(a).tasks[0].outcome, 'success');
    var b = harness().study('T4');
    b.scan('cereal');
    b.d('help.choose', { option: 'lookup_item' });
    b.d('lookup.select', { sku: 'cereal' });
    b.perform();
    equal(finish(b).tasks[0].outcome, 'success');
    var c = harness().study('T4');
    c.scan('cereal');
    c.d('help.choose', { option: 'request_assistance' });
    c.run();
    c.perform();
    equal(finish(c).tasks[0].outcome, 'success');
  });

  test('T5 succeeds by search or PLU entry', function () {
    var a = harness().study('T5');
    a.d('lookup.open');
    a.d('lookup.select', { sku: 'gala_apples' });
    a.d('scale.place');
    a.d('weigh.confirm');
    a.perform();
    equal(finish(a).tasks[0].outcome, 'success');
    var b = harness().study('T5');
    b.d('lookup.open');
    b.d('lookup.manual');
    b.d('manual.submit', { code: '4135' });
    b.d('scale.place');
    b.d('weigh.confirm');
    b.perform();
    equal(finish(b).tasks[0].outcome, 'success');
  });

  function runT6(h) {
    h.d('kiosk.start');
    h.scan('paper_towels');
    h.d('help.choose', { option: 'set_aside' });
    h.add('juice');
    h.d('issue.open', { issueId: h.open()[0].issueId });
    h.d('help.choose', { option: 'enter_code' });
    h.d('manual.submit', { code: '100107' });
    h.perform();
    h.pay();
  }

  test('T6 ends automatically at checkout with success', function () {
    var h = harness().study('T6');
    runT6(h);
    equal([h.s().ui.screen, h.s().tasks.activeId], ['payment_complete', null]);
    h.d('receipt.done');
    var doc = h.doc();
    equal([doc.status, doc.tasks[0].outcome, doc.summary.checkoutsCompleted], ['completed', 'success', 1]);
    equal(h.events('task_ended')[0].details.reason, 'checkout_completed');
  });

  test('A full six-task session reconciles summaries with events', function () {
    var h = harness();
    h.d('session.start', { mode: 'study' });
    h.d('task.start'); h.add('soup'); h.add('soup'); h.add('soup'); h.d('task.done');
    h.d('task.start'); h.d('help.choose', { option: 'remove_duplicate' }); h.run(); h.d('task.done');
    h.d('task.start'); h.d('remove.open', { lineId: h.line('milk').lineId });
    h.d('remove.confirm', { reason: 'unwanted' }); h.perform(); h.d('task.done');
    h.d('task.start'); h.scan('cereal'); h.d('help.choose', { option: 'request_assistance' }); h.run(); h.perform(); h.d('task.done');
    h.d('task.start'); h.d('task.abandon');
    h.d('task.start'); runT6(h); h.d('receipt.done');
    var doc = h.doc();
    equal(doc.tasks.map(function (t) { return t.outcome; }),
      ['success', 'success', 'success', 'success', 'abandoned', 'success']);
    equal(doc.status, 'completed');
    doc.events.forEach(function (e, i) {
      equal(e.seq, i + 1);
      ok(i === 0 || e.tMs >= doc.events[i - 1].tMs, 'time ordered');
      ok(['participant', 'system', 'simulated_employee'].indexOf(e.actor) >= 0, 'actor ' + e.actor);
      ok('taskId' in e && e.screen, 'taskId and screen present');
    });
    equal(doc.events[0].type, 'session_started');
    equal(doc.events[doc.events.length - 1].type, 'session_ended');
    function n(type) { return doc.events.filter(function (e) { return e.type === type; }).length; }
    equal([n('task_started'), n('task_ended'), n('task_abandoned'), n('transaction_reset')], [6, 6, 1, 6]);
    equal(doc.summary.tasksCompleted, 5);
    equal(doc.summary.quantityEdits, n('quantity_requested'));
    equal(doc.summary.removalsCompleted, n('removal_committed'));
    equal(doc.summary.assistanceRequests, n('assistance_requested'));
    equal(doc.summary.participantErrors, 0);
    equal(doc.summary.scenarioFailures, 3, 'duplicate read, cereal, paper towels');
    equal(doc.summary.unresolvedIssues, 0);
    equal(n('action_attempted') - 1, n('action_result') - 1);
    var ids = {};
    doc.events.forEach(function (e) { if (e.type === 'action_attempted') ids[e.actionId] = true; });
    doc.events.filter(function (e) { return e.type === 'verification_result'; }).forEach(function (e) {
      ok(ids[e.actionId], 'async result correlates with an attempted action');
    });
    ['session_started', 'session_ended', 'task_started', 'task_ended', 'screen_changed', 'action_attempted',
      'action_result', 'scan_attempted', 'scan_result', 'quantity_requested', 'quantity_committed',
      'removal_requested', 'removal_committed', 'help_opened', 'help_action_selected', 'help_closed',
      'issue_opened', 'issue_deferred', 'issue_resolved', 'verification_requested', 'verification_result',
      'assistance_requested', 'assistance_completed', 'payment_attempted', 'checkout_completed',
      'task_abandoned', 'transaction_reset'].forEach(function (type) {
      if (type === 'quantity_requested') return;
      ok(n(type) > 0, 'missing event type ' + type);
    });
  });

  /* ---------- first-run tips ---------- */

  test('Tips are pending once per session and finish before any task starts', function () {
    var h = harness();
    h.d('session.start', { mode: 'study' });
    equal(h.s().session.tour, 'pending');
    equal(h.d('tour.finish', { result: 'other' }).reasonCode, 'invalid_result');
    h.d('tour.finish', { result: 'completed', stepsViewed: 3 });
    equal([h.s().session.tour, h.s().ui.screen, h.s().tasks.activeId], ['completed', 'task_ready', null]);
    equal(h.d('tour.finish', { result: 'skipped' }).reasonCode, 'no_tour');
    h.d('task.start');
    var done = h.events('tour_finished');
    equal([done.length, done[0].taskId, done[0].details], [1, null, { result: 'completed', stepsViewed: 3 }]);
    ok(done[0].seq < h.events('task_started')[0].seq);
  });

  test('Finished tips stay finished after reload; a new session shows them again', function () {
    var a = harness().practice();
    var pending = harness({ storage: a.storage });
    pending.app.resume();
    equal(pending.s().session.tour, 'pending', 'unfinished tips return after reload');
    pending.d('tour.finish', { result: 'skipped', stepsViewed: 1 });
    var again = harness({ storage: a.storage });
    again.app.resume();
    equal(again.s().session.tour, 'skipped');
    again.app.reset();
    again.practice();
    equal(again.s().session.tour, 'pending');
  });

  /* ---------- export, persistence, privacy ---------- */

  test('Abandoned sessions export, censored durations are null, export repeats identically', function () {
    var h = harness();
    h.d('session.start', { mode: 'study' });
    h.d('task.start');
    h.scan('soup');
    equal(h.app.getExport(), null, 'no export before the log is frozen');
    h.d('session.end');
    var first = h.app.getExport();
    var doc = JSON.parse(first.compact);
    equal([doc.status, doc.tasks[0].outcome, doc.tasks[0].durationMs, doc.tasks[1].outcome, doc.tasks[1].durationMs],
      ['abandoned', 'unfinished', null, 'not_started', null]);
    ok(doc.tasks[0].censoredAtMs > 0);
    equal(JSON.parse(first.pretty), doc);
    equal(first.filename, 'self-checkout-session-' + doc.sessionId + '.json');
    var count = h.events().length;
    h.d('scan.item', { simItemId: 'soup' });
    h.d('system.visibility', { state: 'hidden' });
    h.run();
    equal(h.events().length, count, 'frozen log');
    equal(h.app.getExport().compact, first.compact);
  });

  test('Hidden-tab time is recorded separately', function () {
    var h = harness().practice();
    h.app.dispatch('system.visibility', { state: 'hidden' }, 'system');
    h.time += 5000;
    h.app.dispatch('system.visibility', { state: 'visible' }, 'system');
    h.d('session.end');
    equal(h.doc().summary.hiddenDurationMs, 5000);
  });

  test('Reload resumes in order, records the gap and restarts pending timers', function () {
    var a = harness().practice();
    a.add('milk');
    a.d('assist.request');
    var before = a.events().length;
    var lastT = a.events()[before - 1].tMs;
    var b = harness({ storage: a.storage, wall: a.wall + 45000 });
    equal(b.app.savedSession(), { ended: false, mode: 'practice' });
    b.app.resume();
    var resumed = b.events('session_resumed')[0];
    equal([resumed.seq, resumed.details.offlineGapMs], [before + 1, 45000]);
    ok(resumed.tMs >= lastT && resumed.tMs < lastT + 1000, 'offline time not added to tMs');
    equal(b.app.getSessionId(), a.app.getSessionId());
    b.run();
    equal(b.open().length, 0);
    b.d('session.end');
    equal([b.doc().offlineGapMs, b.doc().resumes], [45000, 1]);
    var c = harness({ storage: a.storage });
    equal(c.s().ui.screen, 'results');
    equal(c.app.getExport().compact, b.app.getExport().compact, 'ended session reloads unchanged');
  });

  test('Discard or reset creates a distinct session', function () {
    var a = harness().practice();
    var id = a.app.getSessionId();
    a.app.reset();
    equal(a.storage.getItem(SCO.persistence.KEY), null);
    a.practice();
    ok(a.app.getSessionId() !== id);
    equal(a.events()[0].seq, 1);
  });

  test('A second tab does not overwrite another session', function () {
    var a = harness().practice();
    var b = harness({ storage: a.storage });
    b.app.resume();
    a.add('milk');
    equal(a.app.storageProblem(), 'conflict');
  });

  test('Starting in a second tab does not replace the first checkpoint', function () {
    var storage = memoryStorage();
    var first = harness({ storage: storage });
    var second = harness({ storage: storage });
    first.practice();
    second.practice();
    var saved = JSON.parse(storage.getItem(SCO.persistence.KEY));
    equal([saved.log.sessionId, second.app.storageProblem()], [first.app.getSessionId(), 'conflict']);
  });

  test('Disabled or full storage still works and reports a problem', function () {
    var h = harness({ storage: 'throw' }).practice();
    h.add('milk');
    h.d('session.end');
    equal(h.app.storageProblem(), 'unavailable');
    equal(h.doc().status, 'completed');
    var full = memoryStorage();
    var set = full.setItem;
    full.setItem = function (k, v) { if (k === SCO.persistence.KEY) throw new Error('QuotaExceededError'); set(k, v); };
    var q = harness({ storage: full }).practice();
    equal(q.app.storageProblem(), 'write_failed');
  });

  test('Nothing is recorded before Start', function () {
    var h = harness();
    h.d('scan.item', { simItemId: 'milk' });
    h.d('system.visibility', { state: 'hidden' });
    equal([h.events().length, h.storage.getItem(SCO.persistence.KEY)], [0, null]);
  });

  test('Telemetry ignores unexpected parameters', function () {
    var h = harness().practice();
    h.d('help.open', { note: 'Jane Doe', reason: 'free text with spaces' });
    ok(JSON.stringify(h.events()).indexOf('Jane') < 0);
    ok(JSON.stringify(h.events()).indexOf('free text') < 0);
  });

  test('Random action sequences keep state consistent and never dead-end', function () {
    var seed = 12345;
    function rand(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; }
    function pick(list) { return list[rand(list.length)]; }
    for (var round = 0; round < 150; round++) {
      var h = harness({ configure: function (c) {
        c.verification.approvalForDuplicateCorrection = round % 3 === 0;
        c.verification.approvalForUnwantedRemoval = round % 4 === 0;
      } });
      h.practice();
      for (var step = 0; step < 120; step++) {
        var s = h.s();
        var line = s.lines.length ? pick(s.lines).lineId : 'L0';
        var req = s.requests.length ? pick(s.requests).requestId : 'R0';
        var open = SCO.tx.unresolved(s);
        var issue = open.length ? pick(open).issueId : null;
        var choice = rand(24);
        try {
          if (choice === 0) h.scan(pick(h.config.practiceBasket));
          else if (choice === 1) h.d('physical.confirm', { requestId: req });
          else if (choice === 2) h.d('qty.step', { lineId: line, delta: pick([1, -1]) });
          else if (choice === 3) h.d('decrease.confirm', { reason: pick(['duplicate', 'unwanted']) });
          else if (choice === 4) h.d('remove.open', { lineId: line });
          else if (choice === 5) h.d('remove.confirm', { reason: pick(['duplicate', 'unwanted']) });
          else if (choice === 6) h.d('request.cancel', { requestId: req });
          else if (choice === 7) h.d('issue.open', { issueId: issue });
          else if (choice === 8 || choice === 9) h.d('help.choose', { option: pick(['retry_scan', 'lookup_item', 'enter_code',
            'search_produce', 'request_assistance', 'set_aside', 'not_buying', 'keep_both', 'remove_duplicate',
            'scan_again', 'remove_from_bagging', 'check_placement', 'cancel_change', 'retry_check', 'edit_quantity',
            'initiate_removal', 'report_unreadable', 'report_produce', 'report_bagging', 'report_quantity', 'report_unwanted']) });
          else if (choice === 10) h.run(pick([500, 1000, 3000]));
          else if (choice === 11) h.d('nav.back');
          else if (choice === 12) h.d('lookup.open');
          else if (choice === 13) h.d('lookup.select', { sku: pick(SCO.catalog.skus) });
          else if (choice === 14) { h.d('scale.place'); h.d('weigh.confirm'); }
          else if (choice === 15) h.d('count.confirm');
          else if (choice === 16) h.d('assist.request', { issueId: rand(2) ? issue : null });
          else if (choice === 17) h.d('assist.cancel', { issueId: issue });
          else if (choice === 18) h.d(pick(['sim.unexpected_item', 'sim.fail_verification', 'help.open']));
          else if (choice === 19) { h.d('pay.start'); h.d('pay.method', { method: 'debit' }); }
          else if (choice === 20) { h.d('pay.tender'); }
          else if (choice === 21) { h.d('receipt.done'); }
          else if (choice === 22) h.d('request.retry', { requestId: req });
          else h.d('manual.submit', { code: pick(['100101', '100108', '4011', '4046', '1']) });
          checkInvariants(h);
        } catch (err) {
          throw new Error('round ' + round + ' step ' + step + ' choice ' + choice + ': ' + err.message);
        }
      }
      /* Every remaining state must be recoverable to a payable or empty order. */
      h.run();
      if (h.s().ui.screen === 'payment_complete' || h.s().ui.screen === 'receipt') continue;
      for (var pass = 0; pass < 20 && (h.open().length || h.s().requests.length); pass++) {
        h.s().failVerifications = 0;
        h.d('attention.focus');
        h.perform();
        h.s().requests.filter(function (r) { return r.phase === 'failed'; })
          .forEach(function (r) { h.d('request.retry', { requestId: r.requestId }); });
        h.run();
        h.open().forEach(function (i) { h.d('assist.request', { issueId: i.issueId }); h.run(); });
      }
      equal([h.open().length, h.s().requests.length], [0, 0], 'dead end in round ' + round);
      checkInvariants(h);
      if (h.s().lines.length) {
        h.d('attention.focus');
        ok(SCO.tx.paymentEligibility(h.s(), h.config).ok, 'not payable in round ' + round);
      }
    }
  });

  /* ---------- runner ---------- */

  var failed = [];
  var list = document.getElementById('results');
  tests.forEach(function (t) {
    var li = document.createElement('li');
    try {
      t.fn();
      li.className = 'pass';
      li.textContent = 'PASS  ' + t.name;
    } catch (err) {
      failed.push({ name: t.name, error: String(err && err.message || err) });
      li.className = 'fail';
      li.textContent = 'FAIL  ' + t.name;
      var pre = document.createElement('pre');
      pre.textContent = String(err && err.stack || err);
      li.appendChild(pre);
    }
    list.appendChild(li);
  });
  document.getElementById('summary').textContent = (tests.length - failed.length) + ' of ' + tests.length + ' passed';
  window.testResults = { total: tests.length, failed: failed, names: tests.map(function (t) { return t.name; }) };
})(window.SCO);
