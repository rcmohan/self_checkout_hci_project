/* Single authoritative transaction state and its reducer. Pure with respect to
 * the DOM, storage and timers: asynchronous work is returned as "effects" and
 * telemetry as "events" for the controller to carry out. */
(function (SCO) {
  'use strict';

  var catalog = SCO.catalog;
  var scenario = SCO.scenario;

  var CLOSED = { resolved: true, canceled: true };
  var IDENTIFY_TYPES = { unreadable_barcode: true, unknown_product: true, produce_identification: true };
  var CHANGE_KINDS = { qty_increase: true, qty_decrease: true, removal: true };
  var PAYMENT_SCREENS = { payment_method: true, payment_card: true, processing: true };
  var PAYMENT_METHODS = ['debit', 'credit', 'cash', 'gift', 'mobile', 'ebt'];

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function emptyOrder() {
    return {
      lines: [], issues: [], requests: [], assists: [], payment: null, receipt: null,
      checkoutCompleted: false, recoveryIssueId: null, lastLineId: null,
      membership: false, unreadable: {}, failVerifications: 0, assistedSku: null
    };
  }

  function initialState() {
    var state = emptyOrder();
    state.session = { status: 'not_started', mode: null, endReason: null };
    state.ui = { screen: 'intro', params: {}, banner: null };
    state.tasks = { order: [], index: 0, activeId: null, records: [] };
    state.counters = { L: 0, I: 0, R: 0, H: 0, P: 0 };
    return state;
  }

  /* ---------- selectors ---------- */

  function lineAmount(line) {
    var item = catalog.get(line.sku);
    if (item.unit === 'lb') return Math.floor((line.weight * item.priceCents + 50) / 100);
    return line.qty * item.priceCents;
  }

  /* Totals derive only from committed lines. */
  function totals(state, config) {
    var subtotal = 0;
    var count = 0;
    state.lines.forEach(function (l) { subtotal += lineAmount(l); count += l.qty; });
    var tax = Math.floor((subtotal * config.taxRateBasisPoints + 5000) / 10000);
    return { subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax, itemCount: count };
  }

  function unresolved(state) { return state.issues.filter(function (i) { return !CLOSED[i.status]; }); }
  function byId(list, key, id) {
    for (var i = 0; i < list.length; i++) if (list[i][key] === id) return list[i];
    return null;
  }
  function lineById(s, id) { return byId(s.lines, 'lineId', id); }
  function issueById(s, id) { return byId(s.issues, 'issueId', id); }
  function requestById(s, id) { return byId(s.requests, 'requestId', id); }
  function assistById(s, id) { return byId(s.assists, 'assistId', id); }
  function countLine(s, sku) {
    return s.lines.filter(function (l) { return l.sku === sku && catalog.get(sku).unit === 'each'; })[0] || null;
  }
  function requestForIssue(s, issueId) {
    return s.requests.filter(function (r) { return r.issueId === issueId; })[0] || null;
  }
  function pendingChange(s, lineId) {
    return s.requests.filter(function (r) { return r.lineId === lineId && CHANGE_KINDS[r.kind]; })[0] || null;
  }
  function activeAssist(s, issueId) {
    return s.assists.filter(function (a) { return a.status === 'requested' && a.issueId === issueId; })[0] || null;
  }
  function awaitingBagging(s) { return s.lines.some(function (l) { return l.unbagged > 0; }); }

  /* One predicate for the UI and for transaction logic. */
  function paymentEligibility(state, config) {
    var reasons = [];
    if (state.session.status !== 'active') reasons.push('session_not_active');
    if (state.lines.length === 0) reasons.push('empty_order');
    if (state.checkoutCompleted) reasons.push('already_paid');
    if (awaitingBagging(state)) reasons.push('awaiting_bagging');
    if (unresolved(state).some(function (i) { return config.issuePolicy[i.type].blocking; })) {
      reasons.push('unresolved_issues');
    }
    if (state.requests.length > 0 && reasons.indexOf('awaiting_bagging') < 0 &&
        reasons.indexOf('unresolved_issues') < 0) reasons.push('pending_request');
    return { ok: reasons.length === 0, reasons: reasons };
  }

  /* Returns null when a new item may be added, otherwise a reason code.
   * `recoveringIssueId` lets recovery of that very issue proceed. */
  function addBlockReason(state, config, recoveringIssueId) {
    if (state.session.status !== 'active') return 'session_not_active';
    if (state.checkoutCompleted) return 'already_paid';
    if (PAYMENT_SCREENS[state.ui.screen]) return 'payment_in_progress';
    if (awaitingBagging(state)) return 'awaiting_bagging';
    var open = unresolved(state);
    for (var i = 0; i < open.length; i++) {
      var issue = open[i];
      if (issue.issueId === recoveringIssueId || issue.issueId === state.recoveryIssueId) continue;
      if (!config.issuePolicy[issue.type].deferrable) return 'blocking_issue';
      var req = requestForIssue(state, issue.issueId);
      if (req && issue.status !== 'deferred' && req.phase !== 'awaiting_approval' &&
          !activeAssist(state, issue.issueId) &&
          (CHANGE_KINDS[req.kind] || req.kind === 'item_cancel')) return 'pending_change';
    }
    return null;
  }

  /* ---------- reducer ---------- */

  function reduce(previous, action, ctx) {
    var s = clone(previous);
    var config = ctx.config;
    var out = {
      state: s, events: [], effects: [],
      outcome: 'accepted', reasonCode: null, errorCategory: null
    };
    var actor = action.actor || 'participant';
    var p = action.params || {};

    function emit(type, fields) {
      var ev = Object.assign({ type: type, actor: actor }, fields || {});
      if (ev.taskId === undefined) ev.taskId = s.tasks.activeId;
      if (ev.screen === undefined) ev.screen = s.ui.screen;
      out.events.push(ev);
      return ev;
    }
    /* categoryLogged: the domain event already carries the error category, so
     * action_result must not repeat it. */
    function reject(reason, category, categoryLogged) {
      out.outcome = 'rejected';
      out.reasonCode = reason;
      out.errorCategory = categoryLogged ? null : (category || null);
      return false;
    }
    function goto(screen, params) {
      s.ui.screen = screen;
      s.ui.params = params || {};
      if (screen === 'checkout') s.ui.fromWelcome = false;
    }
    function home() {
      goto(s.lines.length === 0 && s.issues.length === 0 && s.ui.fromWelcome ? 'welcome' : 'checkout');
    }
    function banner(kind, code, extra) { s.ui.banner = Object.assign({ kind: kind, code: code }, extra || {}); }
    function nextId(prefix) { s.counters[prefix] += 1; return prefix + s.counters[prefix]; }

    function violation(sku, oldQty, newQty) {
      return scenario.constraintViolation(config, s.tasks.activeId, sku, oldQty, newQty);
    }
    function noteViolation(reason) {
      if (reason) { out.errorCategory = 'participant_input'; out.reasonCode = reason; }
    }

    /* ----- issues, requests, assistance ----- */

    function openIssue(type, fields, eventExtra) {
      var issue = Object.assign({
        issueId: nextId('I'), type: type, status: 'open',
        sku: null, simItem: null, lineId: null
      }, fields || {});
      s.issues.push(issue);
      var details = { issueType: type };
      Object.assign(details, eventExtra || {});
      emit('issue_opened', {
        actor: details.userInitiated ? 'participant' : 'system',
        issueId: issue.issueId, lineId: issue.lineId || undefined,
        sku: issue.sku || undefined, details: details
      });
      return issue;
    }

    function dropRequest(requestId) {
      var req = requestById(s, requestId);
      if (!req) return;
      s.requests = s.requests.filter(function (r) { return r.requestId !== requestId; });
      out.effects.push({ type: 'cancel', key: requestId });
    }

    function cancelAssistFor(issueId) {
      s.assists.forEach(function (a) {
        if (a.status === 'requested' && a.issueId === issueId) {
          a.status = 'canceled';
          out.effects.push({ type: 'cancel', key: a.assistId });
          emit('assistance_completed', {
            actor: 'system', issueId: issueId || undefined, requestId: a.assistId,
            details: { outcome: 'canceled' }
          });
        }
      });
    }

    function closeIssue(issue, finalStatus, method, eventActor) {
      if (CLOSED[issue.status]) return;
      issue.status = finalStatus;
      s.requests.filter(function (r) { return r.issueId === issue.issueId; })
        .forEach(function (r) { dropRequest(r.requestId); });
      cancelAssistFor(issue.issueId);
      if (s.recoveryIssueId === issue.issueId) s.recoveryIssueId = null;
      emit('issue_resolved', {
        actor: eventActor || 'system', issueId: issue.issueId, lineId: issue.lineId || undefined,
        details: { issueType: issue.type, finalStatus: finalStatus, resolutionMethod: method }
      });
      if ((s.ui.screen === 'help' || s.ui.screen === 'assistance') && s.ui.params.issueId === issue.issueId) {
        goto('checkout');
      }
    }

    var methodByPhysical = { bag: 'bag_scale', return: 'return_area', check: 'placement_check',
      putback: 'bag_scale', takeout: 'bag_scale' };

    function startVerification(req) {
      req.phase = 'verifying';
      req.attempt += 1;
      var issue = req.issueId && issueById(s, req.issueId);
      if (issue && !CLOSED[issue.status]) issue.status = 'awaiting_verification';
      emit('verification_requested', {
        requestId: req.requestId, lineId: req.lineId || undefined, issueId: req.issueId || undefined,
        details: { method: req.physical ? methodByPhysical[req.physical] : 'weight_check', attempt: req.attempt }
      });
      out.effects.push({
        type: 'schedule', key: req.requestId, delayMs: config.delays.verificationMs,
        action: { type: 'system.verification', params: { requestId: req.requestId, attempt: req.attempt } }
      });
    }

    function newRequest(fields) {
      var req = Object.assign({
        requestId: nextId('R'), phase: 'awaiting_physical', physical: null, physicalDone: false,
        reverting: false, attempt: 0, lineId: null, sku: null, issueId: null, needsApproval: false
      }, fields);
      s.requests.push(req);
      return req;
    }

    /* Commit a count or weight line that the shopper (or associate) identified.
     * The new units wait for a bagging-area check. */
    function addLine(sku, qty, weight) {
      var item = catalog.get(sku);
      var line = item.unit === 'each' ? countLine(s, sku) : null;
      var oldQty = line ? line.qty : 0;
      if (!line) {
        line = { lineId: nextId('L'), sku: sku, qty: 0, weight: weight || null, unbagged: 0 };
        s.lines.push(line);
      }
      line.qty += qty;
      line.unbagged += qty;
      s.lastLineId = line.lineId;
      newRequest({ kind: 'scan_bagging', lineId: line.lineId, sku: sku, qty: qty, physical: 'bag' });
      return { line: line, oldQty: oldQty, newQty: line.qty };
    }

    function requestRestricted(sku, qty) {
      var issue = openIssue('authorization_required', { sku: sku, simItem: sku });
      newRequest({ kind: 'restricted_add', sku: sku, qty: qty, issueId: issue.issueId,
        phase: 'awaiting_approval', needsApproval: true });
      goto('help', { issueId: issue.issueId });
      emit('help_opened', { actor: 'system', issueId: issue.issueId,
        details: { context: 'authorization_required', trigger: 'automatic' } });
      return issue;
    }

    function deferOpenIdentificationIssues(exceptId) {
      unresolved(s).forEach(function (issue) {
        if (issue.issueId === exceptId || issue.status !== 'open') return;
        if (!config.issuePolicy[issue.type].deferrable) return;
        var req = requestForIssue(s, issue.issueId);
        if (req && CHANGE_KINDS[req.kind]) return;
        issue.status = 'deferred';
        emit('issue_deferred', { actor: 'system', issueId: issue.issueId,
          details: { issueType: issue.type, method: 'continued_scanning' } });
      });
    }

    /* Apply a verified or authorised change to committed lines. */
    function commit(req, resolution, eventActor) {
      var issue = req.issueId ? issueById(s, req.issueId) : null;
      var line = req.lineId ? lineById(s, req.lineId) : null;
      dropRequest(req.requestId);

      if (req.reverting) {
        if (issue) {
          if (issue.type === 'possible_duplicate') { issue.status = 'open'; }
          else closeIssue(issue, 'canceled', 'verified_cancellation', eventActor);
        }
        banner('success', 'change_canceled');
        return;
      }

      if (req.kind === 'scan_bagging') {
        if (line) line.unbagged = Math.max(0, line.unbagged - req.qty);
        if (issue) closeIssue(issue, 'resolved', resolution, eventActor);
        banner('success', 'item_bagged', { sku: req.sku });
      } else if (req.kind === 'qty_increase' || req.kind === 'qty_decrease') {
        if (line) {
          var oldQty = line.qty;
          var delta = req.toQty - req.fromQty;
          line.qty = Math.max(1, line.qty + delta);
          if (delta < 0) trimBagging(line, -delta);
          s.lastLineId = line.lineId;
          emit('quantity_committed', { actor: eventActor || 'system', lineId: line.lineId, sku: line.sku,
            requestId: req.requestId,
            details: { oldQty: oldQty, newQty: line.qty, method: req.method, reason: req.reason || undefined } });
          banner('success', 'quantity_updated', { sku: line.sku, qty: line.qty });
        }
        if (issue) closeIssue(issue, 'resolved', resolution, eventActor);
        if (line) closeDuplicates(line.lineId, line.qty, resolution);
      } else if (req.kind === 'removal') {
        if (line) {
          s.lines = s.lines.filter(function (l) { return l.lineId !== line.lineId; });
          s.requests.filter(function (r) { return r.lineId === line.lineId; })
            .forEach(function (r) { dropRequest(r.requestId); });
          emit('removal_committed', { actor: eventActor || 'system', lineId: line.lineId, sku: line.sku,
            requestId: req.requestId, details: { reason: req.reason, quantity: line.qty } });
          banner('success', 'item_removed', { sku: line.sku });
        }
        if (issue) closeIssue(issue, 'resolved', resolution, eventActor);
        if (line) {
          unresolved(s).filter(function (i) { return i.lineId === line.lineId; })
            .forEach(function (i) { closeIssue(i, 'resolved', 'line_removed', eventActor); });
        }
      } else if (req.kind === 'restricted_add') {
        var added = addLine(req.sku, req.qty);
        emit('quantity_committed', { actor: eventActor || 'system', lineId: added.line.lineId, sku: req.sku,
          requestId: req.requestId,
          details: { oldQty: added.oldQty, newQty: added.newQty, method: 'authorized' } });
        if (issue) closeIssue(issue, 'resolved', resolution, eventActor);
        banner('success', 'item_added', { sku: req.sku });
      } else if (req.kind === 'item_cancel') {
        if (issue) closeIssue(issue, 'canceled', 'verified_cancellation', eventActor);
        banner('success', 'item_not_purchased');
      } else {
        if (issue) closeIssue(issue, 'resolved', resolution, eventActor);
        banner('success', 'problem_cleared');
      }
    }

    function trimBagging(line, removed) {
      var left = Math.min(removed, line.unbagged);
      if (!left) return;
      line.unbagged -= left;
      s.requests.filter(function (r) { return r.kind === 'scan_bagging' && r.lineId === line.lineId; })
        .forEach(function (r) {
          var cut = Math.min(left, r.qty);
          r.qty -= cut;
          left -= cut;
          if (r.qty === 0) {
            if (r.issueId) closeIssue(issueById(s, r.issueId), 'resolved', 'quantity_corrected');
            dropRequest(r.requestId);
          }
        });
    }

    function closeDuplicates(lineId, qty, resolution) {
      unresolved(s).forEach(function (i) {
        if (i.type === 'possible_duplicate' && i.lineId === lineId && qty <= i.expectedQty &&
            !requestForIssue(s, i.issueId)) closeIssue(i, 'resolved', resolution);
      });
    }

    /* ----- scanning and identification ----- */

    function scan(simItemId, isRetry) {
      var physical = catalog.physical(simItemId);
      if (!physical) return reject('unknown_sim_item', 'technical');
      var matching = unresolved(s).filter(function (i) {
        return IDENTIFY_TYPES[i.type] && i.simItem === simItemId;
      })[0] || null;
      emit('scan_attempted', { details: { physicalItem: simItemId, retry: !!isRetry } });

      var blocked = addBlockReason(s, config, matching && matching.issueId);
      var item = catalog.get(simItemId);
      if (!blocked && item) {
        var existing = countLine(s, simItemId);
        if (existing && pendingChange(s, existing.lineId)) blocked = 'pending_change';
        if (item.restricted && unresolved(s).some(function (i) {
          return i.type === 'authorization_required' && i.sku === simItemId;
        })) blocked = 'pending_change';
      }
      if (blocked) {
        emit('scan_result', { details: { result: 'rejected', failureCode: blocked, errorCategory: 'policy_block' } });
        banner('error', blocked);
        if (!PAYMENT_SCREENS[s.ui.screen] && !s.checkoutCompleted) goto('checkout');
        return reject(blocked, 'policy_block', true);
      }

      var failures = s.unreadable[simItemId] || 0;
      var code = null;
      if (failures !== 0) {
        code = 'unreadable_barcode';
        if (failures > 0) s.unreadable[simItemId] = failures - 1;
      } else if (!item) {
        code = 'unknown_product';
      }
      if (code) {
        emit('scan_result', {
          actor: 'system', sku: code === 'unreadable_barcode' ? undefined : (item ? simItemId : undefined),
          details: { result: 'failure', failureCode: code, errorCategory: 'injected_scenario', physicalItem: simItemId }
        });
        var issue = matching || openIssue(code, { simItem: simItemId });
        var cancelReq = requestForIssue(s, issue.issueId);
        if (cancelReq && cancelReq.kind === 'item_cancel') dropRequest(cancelReq.requestId);
        if (!activeAssist(s, issue.issueId)) issue.status = 'open';
        goto('help', { issueId: issue.issueId, retried: !!isRetry });
        emit('help_opened', { actor: 'system', issueId: issue.issueId,
          details: { context: issue.type, trigger: 'automatic' } });
        return true;
      }

      var before = countLine(s, simItemId);
      var oldQty = before ? before.qty : 0;
      if (item.restricted) {
        emit('scan_result', { actor: 'system', sku: simItemId,
          details: { result: 'authorization_required', errorCategory: undefined } });
        noteViolation(violation(simItemId, oldQty, oldQty + 1));
        requestRestricted(simItemId, 1);
        return true;
      }
      if (item.unit === 'lb') {
        /* Weighed items go through the scale even if a barcode is presented. */
        emit('scan_result', { actor: 'system', sku: simItemId, details: { result: 'weighing_required' } });
        goto('weigh', { sku: simItemId, issueId: matching ? matching.issueId : null, placed: false });
        return true;
      }
      var recovery = s.recoveryIssueId && issueById(s, s.recoveryIssueId);
      var added = addLine(simItemId, 1);
      var bad = violation(simItemId, added.oldQty, added.newQty);
      var details = { result: 'success', oldQty: added.oldQty, newQty: added.newQty, repeat: added.oldQty > 0 };
      if (bad) { details.errorCategory = 'participant_input'; details.reasonCode = bad; }
      emit('scan_result', { actor: 'system', lineId: added.line.lineId, sku: simItemId, details: details });
      goto('checkout');
      s.ui.banner = null;
      if (matching) closeIssue(matching, 'resolved', 'rescan');
      if (recovery && !CLOSED[recovery.status]) closeIssue(recovery, 'resolved', 'rescan');
      deferOpenIdentificationIssues(null);
      return true;
    }

    /* Add an item chosen by lookup or code entry (not a scan). */
    function addIdentified(sku, qty, weight, method, issueId) {
      var item = catalog.get(sku);
      var issue = issueId ? issueById(s, issueId) : null;
      if (issue && CLOSED[issue.status]) issue = null;
      var blocked = addBlockReason(s, config, issue && issue.issueId);
      var existing = item.unit === 'each' ? countLine(s, sku) : null;
      if (!blocked && existing && pendingChange(s, existing.lineId)) blocked = 'pending_change';
      if (!blocked && item.restricted && unresolved(s).some(function (i) {
        return i.type === 'authorization_required' && i.sku === sku;
      })) blocked = 'pending_change';
      if (blocked) { banner('error', blocked); goto('checkout'); return reject(blocked, 'policy_block'); }
      var oldQty = existing ? existing.qty : 0;
      noteViolation(violation(sku, oldQty, oldQty + qty));
      if (item.restricted) {
        if (issue) closeIssue(issue, 'resolved', method);
        requestRestricted(sku, qty);
        return true;
      }
      var added = addLine(sku, qty, weight);
      emit('quantity_committed', { actor: 'system', lineId: added.line.lineId, sku: sku,
        details: { oldQty: added.oldQty, newQty: added.newQty, method: method, weight: weight || undefined } });
      goto('checkout');
      banner('success', 'item_added', { sku: sku });
      if (issue) closeIssue(issue, 'resolved', method);
      deferOpenIdentificationIssues(null);
      return true;
    }

    /* ----- quantity and removal ----- */

    function editableLine(lineId) {
      var line = lineById(s, lineId);
      if (!line) return reject('unknown_line', 'policy_block');
      if (s.checkoutCompleted) return reject('already_paid', 'policy_block');
      if (pendingChange(s, lineId)) { banner('error', 'pending_change'); return reject('pending_change', 'policy_block'); }
      return line;
    }

    function requestChange(line, toQty, reason, method) {
      var from = line.qty;
      var item = catalog.get(line.sku);
      var increase = toQty > from;
      if (increase) {
        var blocked = awaitingBagging(s) ? 'awaiting_bagging' : addBlockReason(s, config, null);
        if (blocked) { banner('error', blocked); goto('checkout'); return reject(blocked, 'policy_block'); }
      }
      noteViolation(violation(line.sku, from, toQty));
      var duplicate = !increase && reason === 'duplicate'
        ? unresolved(s).filter(function (i) {
          return i.type === 'possible_duplicate' && i.lineId === line.lineId && !requestForIssue(s, i.issueId);
        })[0] : null;
      emit('quantity_requested', { lineId: line.lineId, sku: line.sku,
        details: { oldQty: from, newQty: toQty, method: method, reason: reason || undefined } });
      var issue = duplicate || openIssue('quantity_change', { lineId: line.lineId, sku: line.sku });
      var needsApproval = increase ? !!item.restricted :
        (reason === 'duplicate' ? config.verification.approvalForDuplicateCorrection
          : config.verification.approvalForUnwantedRemoval);
      var req = newRequest({
        kind: increase ? 'qty_increase' : 'qty_decrease', lineId: line.lineId, sku: line.sku,
        fromQty: from, toQty: toQty, qty: Math.abs(toQty - from), reason: reason || null, method: method,
        issueId: issue.issueId, needsApproval: needsApproval,
        physical: increase ? 'bag' : (reason === 'unwanted' ? 'return' : null)
      });
      issue.requestId = req.requestId;
      issue.status = 'open';
      goto('checkout');
      beginRequest(req, issue);
      return true;
    }

    function beginRequest(req, issue) {
      if (req.physical) return;
      if (req.needsApproval) { req.phase = 'awaiting_approval'; issue.status = 'open'; }
      else startVerification(req);
    }

    function requestRemoval(line, reason) {
      noteViolation(violation(line.sku, line.qty, 0));
      emit('removal_requested', { lineId: line.lineId, sku: line.sku, details: { reason: reason, quantity: line.qty } });
      var duplicate = reason === 'duplicate' ? unresolved(s).filter(function (i) {
        return i.type === 'possible_duplicate' && i.lineId === line.lineId && !requestForIssue(s, i.issueId);
      })[0] : null;
      var issue = duplicate || openIssue('removal_pending', { lineId: line.lineId, sku: line.sku });
      var req = newRequest({
        kind: 'removal', lineId: line.lineId, sku: line.sku, qty: line.qty, reason: reason,
        issueId: issue.issueId, physical: reason === 'unwanted' ? 'return' : null,
        needsApproval: reason === 'duplicate' ? config.verification.approvalForDuplicateCorrection
          : config.verification.approvalForUnwantedRemoval
      });
      issue.status = 'open';
      goto('checkout');
      beginRequest(req, issue);
      return true;
    }

    function cancelRequest(req) {
      if (!req) return reject('unknown_request', 'policy_block');
      if (req.kind === 'scan_bagging' || req.kind === 'unexpected_item' || req.kind === 'placement_check') {
        return reject('not_cancelable', 'policy_block');
      }
      if (req.phase === 'verifying') return reject('verification_in_progress', 'policy_block');
      if (req.reverting) return reject('already_canceling', 'policy_block');
      var issue = req.issueId ? issueById(s, req.issueId) : null;
      if (issue) cancelAssistFor(issue.issueId);
      if (req.kind === 'restricted_add') return notBuying(issue);
      if (req.kind === 'item_cancel') {
        dropRequest(req.requestId);
        if (issue) {
          issue.status = 'open';
          if (issue.type === 'authorization_required') {
            newRequest({ kind: 'restricted_add', sku: issue.sku, qty: req.qty || 1, issueId: issue.issueId,
              phase: 'awaiting_approval', needsApproval: true });
          }
        }
        goto('checkout');
        return true;
      }
      if (req.physicalDone) {
        /* Something was physically moved: undo it and verify before clearing. */
        req.reverting = true;
        req.physical = req.kind === 'qty_increase' ? 'takeout' : 'putback';
        req.phase = 'awaiting_physical';
        if (issue) issue.status = 'open';
        goto('checkout');
        return true;
      }
      dropRequest(req.requestId);
      if (issue) {
        if (issue.type === 'possible_duplicate') issue.status = 'open';
        else closeIssue(issue, 'canceled', 'canceled_before_change', actor);
      }
      goto('checkout');
      banner('success', 'change_canceled');
      return true;
    }

    function notBuying(issue) {
      if (!issue || CLOSED[issue.status]) return reject('unknown_issue', 'policy_block');
      var current = requestForIssue(s, issue.issueId);
      if (current && current.kind === 'item_cancel') { goto('checkout'); return true; }
      if (current) dropRequest(current.requestId);
      cancelAssistFor(issue.issueId);
      newRequest({ kind: 'item_cancel', sku: issue.sku, qty: current ? current.qty : 1,
        issueId: issue.issueId, physical: 'return' });
      issue.status = 'open';
      goto('checkout');
      return true;
    }

    /* ----- assistance and help ----- */

    function requestAssistance(issueId) {
      var issue = issueId ? issueById(s, issueId) : null;
      if (issueId && (!issue || CLOSED[issue.status])) return reject('unknown_issue', 'policy_block');
      var returnTo = s.ui.screen === 'help' || s.ui.screen === 'assistance' ? 'checkout' : s.ui.screen;
      if (!issue) {
        var existing = unresolved(s).filter(function (i) { return i.type === 'general_assistance'; })[0];
        if (existing) { goto('assistance', { issueId: existing.issueId, returnTo: returnTo }); return reject('already_requested', 'policy_block'); }
        issue = openIssue('general_assistance', {}, { userInitiated: true });
      }
      if (activeAssist(s, issue.issueId)) {
        goto('assistance', { issueId: issue.issueId, returnTo: returnTo });
        return reject('already_requested', 'policy_block');
      }
      var req = requestForIssue(s, issue.issueId);
      if (req && req.phase === 'verifying') return reject('verification_in_progress', 'policy_block');
      var assist = { assistId: nextId('H'), issueId: issue.issueId, status: 'requested' };
      s.assists.push(assist);
      issue.status = 'awaiting_verification';
      emit('assistance_requested', { issueId: issue.issueId, requestId: assist.assistId,
        details: { issueType: issue.type } });
      out.effects.push({
        type: 'schedule', key: assist.assistId, delayMs: config.delays.assistanceMs,
        action: { type: 'system.assistance', params: { assistId: assist.assistId }, actor: 'simulated_employee' }
      });
      goto('assistance', { issueId: issue.issueId, returnTo: returnTo });
      return true;
    }

    function completeAssistance(assistId) {
      var assist = assistById(s, assistId);
      if (!assist || assist.status !== 'requested') return reject('stale_callback', 'technical');
      assist.status = 'completed';
      var issue = issueById(s, assist.issueId);
      emit('assistance_completed', { issueId: assist.issueId, requestId: assistId,
        details: { outcome: 'resolved', issueType: issue.type } });
      var wasViewing = s.ui.screen === 'assistance' && s.ui.params.issueId === issue.issueId;
      var returnTo = wasViewing ? s.ui.params.returnTo : null;
      var req = requestForIssue(s, issue.issueId);
      var by = 'simulated_employee';

      if (IDENTIFY_TYPES[issue.type]) {
        var sku = catalog.get(issue.simItem) ? issue.simItem : issue.assistedSku;
        if (req) dropRequest(req.requestId);
        if (sku && catalog.get(sku)) {
          var item = catalog.get(sku);
          var added = addLine(sku, 1, item.unit === 'lb' ? item.simWeight : null);
          emit('quantity_committed', { lineId: added.line.lineId, sku: sku,
            details: { oldQty: added.oldQty, newQty: added.newQty, method: 'assisted' } });
          closeIssue(issue, 'resolved', 'assistance', by);
          banner('success', 'item_added', { sku: sku });
        } else {
          closeIssue(issue, 'resolved', 'assistance_no_item', by);
          banner('success', 'assistance_no_item');
        }
      } else if (issue.type === 'possible_duplicate') {
        if (req) dropRequest(req.requestId);
        var line = lineById(s, issue.lineId);
        if (line && line.qty > issue.expectedQty) {
          var old = line.qty;
          line.qty = issue.expectedQty;
          trimBagging(line, old - line.qty);
          emit('quantity_committed', { lineId: line.lineId, sku: line.sku,
            details: { oldQty: old, newQty: line.qty, method: 'assisted', reason: 'duplicate' } });
        }
        closeIssue(issue, 'resolved', 'assistance', by);
        banner('success', 'problem_cleared');
      } else if (req) {
        commit(req, 'assistance', by);
        if (!CLOSED[issue.status]) closeIssue(issue, 'resolved', 'assistance', by);
      } else {
        closeIssue(issue, 'resolved', 'assistance', by);
        banner('success', 'problem_cleared');
      }
      if (wasViewing) returnFromAssistance(returnTo);
      return true;
    }

    function returnFromAssistance(returnTo) {
      if (s.checkoutCompleted) goto('payment_complete');
      else if (returnTo === 'payment_method' || returnTo === 'membership') goto(returnTo);
      else if (returnTo === 'welcome' && !s.lines.length) goto('welcome');
      else goto('checkout');
    }

    var HELP_OPTIONS = {
      general: ['report_unreadable', 'report_produce', 'report_quantity', 'report_unwanted', 'report_bagging', 'request_assistance'],
      incorrect_quantity: ['edit_quantity', 'request_assistance'],
      unwanted_item: ['initiate_removal', 'request_assistance'],
      unreadable_barcode: ['retry_scan', 'lookup_item', 'enter_code', 'request_assistance', 'set_aside', 'not_buying'],
      unknown_product: ['retry_scan', 'lookup_item', 'request_assistance', 'set_aside', 'not_buying'],
      produce_identification: ['search_produce', 'enter_code', 'request_assistance', 'set_aside', 'not_buying'],
      possible_duplicate: ['keep_both', 'remove_duplicate', 'request_assistance', 'set_aside'],
      bagging_mismatch: ['scan_again', 'remove_from_bagging', 'check_placement', 'request_assistance'],
      authorization_required: ['request_assistance', 'set_aside', 'not_buying'],
      quantity_change: ['cancel_change', 'retry_check', 'request_assistance', 'set_aside'],
      removal_pending: ['cancel_change', 'retry_check', 'request_assistance', 'set_aside']
    };

    function helpContext() {
      var params = s.ui.params;
      if (params.issueId) {
        var issue = issueById(s, params.issueId);
        if (issue) return issue.type;
      }
      return params.context || 'general';
    }

    function openHelpFor(issueId, trigger) {
      var issue = issueById(s, issueId);
      goto('help', { issueId: issueId });
      emit('help_opened', { actor: trigger === 'user' ? actor : 'system', issueId: issueId,
        details: { context: issue.type, trigger: trigger } });
    }

    function chooseHelp(option) {
      if (s.ui.screen !== 'help') return reject('invalid_screen', 'policy_block');
      var context = helpContext();
      if ((HELP_OPTIONS[context] || []).indexOf(option) < 0) return reject('invalid_option', 'policy_block');
      var issue = s.ui.params.issueId ? issueById(s, s.ui.params.issueId) : null;
      var lineId = s.ui.params.lineId || (issue && issue.lineId) || null;
      var req = issue ? requestForIssue(s, issue.issueId) : null;
      emit('help_action_selected', { issueId: issue ? issue.issueId : undefined,
        details: { context: context, optionId: option } });

      switch (option) {
        case 'retry_scan':
          if (issue.simItem) return scan(issue.simItem, true);
          goto('checkout'); banner('info', 'scan_again'); return true;
        case 'lookup_item':
          goto('lookup', { mode: 'item', issueId: issue.issueId }); return true;
        case 'search_produce':
          goto('lookup', { mode: 'produce', issueId: issue.issueId }); return true;
        case 'enter_code':
          goto('manual_entry', { issueId: issue.issueId }); return true;
        case 'request_assistance':
          return requestAssistance(issue ? issue.issueId : null);
        case 'set_aside':
          return deferIssue(issue);
        case 'not_buying':
          return notBuying(issue);
        case 'keep_both':
          if (req) return reject('pending_change', 'policy_block');
          noteViolation(keepViolation(issue));
          closeIssue(issue, 'resolved', 'kept_both', actor);
          goto('checkout'); banner('success', 'kept_both', { sku: issue.sku }); return true;
        case 'remove_duplicate': {
          if (req) { goto('checkout'); return reject('pending_change', 'policy_block'); }
          var dup = editableLine(issue.lineId);
          if (!dup) return false;
          if (dup.qty <= issue.expectedQty) { closeIssue(issue, 'resolved', 'already_corrected', actor); goto('checkout'); return true; }
          return requestChange(dup, dup.qty - 1, 'duplicate', 'duplicate_prompt');
        }
        case 'scan_again':
          s.recoveryIssueId = issue.issueId; goto('checkout'); banner('info', 'scan_again'); return true;
        case 'remove_from_bagging':
          if (!req) {
            newRequest({ kind: 'unexpected_item', issueId: issue.issueId, physical: 'return' });
          } else if (req.kind === 'placement_check') {
            req.kind = 'unexpected_item'; req.physical = 'return'; req.phase = 'awaiting_physical';
          }
          goto('checkout'); return true;
        case 'check_placement':
          if (!req) newRequest({ kind: 'placement_check', issueId: issue.issueId, physical: 'check' });
          goto('checkout'); banner('info', 'check_placement'); return true;
        case 'cancel_change':
          return cancelRequest(req);
        case 'retry_check':
          if (!req || req.phase !== 'failed') return reject('nothing_to_retry', 'policy_block');
          if (req.physical) req.physicalDone = req.physicalDone || !req.reverting;
          goto('checkout'); startVerification(req); return true;
        case 'edit_quantity':
          if (lineId && !req) {
            var target = editableLine(lineId);
            if (!target) return false;
            goto('qty_editor', { lineId: lineId }); return true;
          }
          goto('checkout'); banner('info', 'edit_quantity_hint'); return true;
        case 'initiate_removal':
          if (lineId) { var r = editableLine(lineId); if (!r) return false; goto('removal_confirm', { lineId: lineId }); return true; }
          goto('checkout'); banner('info', 'removal_hint'); return true;
        case 'report_quantity':
          goto('help', { context: 'incorrect_quantity' }); return true;
        case 'report_unwanted':
          goto('help', { context: 'unwanted_item' }); return true;
        case 'report_unreadable': {
          var a = openIssue('unreadable_barcode', {}, { userInitiated: true });
          openHelpFor(a.issueId, 'user'); return true;
        }
        case 'report_produce': {
          var b = openIssue('produce_identification', { assistedSku: s.assistedSku }, { userInitiated: true });
          openHelpFor(b.issueId, 'user'); return true;
        }
        case 'report_bagging': {
          var c = openIssue('bagging_mismatch', { variant: 'placement' }, { userInitiated: true });
          newRequest({ kind: 'placement_check', issueId: c.issueId, physical: 'check' });
          openHelpFor(c.issueId, 'user'); return true;
        }
      }
      return reject('invalid_option', 'policy_block');
    }

    function keepViolation(issue) {
      var line = lineById(s, issue.lineId);
      return line ? violation(line.sku, issue.expectedQty, line.qty) : null;
    }

    function deferIssue(issue) {
      if (!issue || CLOSED[issue.status]) return reject('unknown_issue', 'policy_block');
      if (!config.issuePolicy[issue.type].deferrable) return reject('not_deferrable', 'policy_block');
      if (!activeAssist(s, issue.issueId)) issue.status = 'deferred';
      emit('issue_deferred', { issueId: issue.issueId, details: { issueType: issue.type, method: 'participant' } });
      goto('checkout');
      return true;
    }

    /* ----- payment ----- */

    function blockPayment() {
      var check = paymentEligibility(s, config);
      if (check.ok) return false;
      emit('payment_blocked', { details: { blockingReason: check.reasons[0], reasons: check.reasons,
        errorCategory: 'policy_block' } });
      banner('error', 'payment_' + check.reasons[0]);
      if (PAYMENT_SCREENS[s.ui.screen]) { s.payment = null; goto('checkout'); }
      reject(check.reasons[0], 'policy_block', true);
      return true;
    }

    /* ----- tasks and session ----- */

    function currentRecord() { return s.tasks.records[s.tasks.index]; }

    function endTask(outcome, reason, evaluation) {
      var record = currentRecord();
      var taskId = record.taskId;
      var result = evaluation || scenario.evaluate(taskId, s);
      record.outcome = outcome;
      record.predicate = result;
      record.endMs = ctx.now();
      emit('task_ended', {
        actor: 'system', taskId: taskId,
        details: { outcome: outcome, reason: reason, predicatePassed: result.passed, criteria: result.criteria,
          firstSatisfiedMs: record.firstSatisfiedMs, censored: outcome === 'unfinished' || undefined }
      });
      s.tasks.activeId = null;
    }

    function endSession(reason) {
      if (s.tasks.activeId) endTask('unfinished', reason);
      var status = 'completed';
      if (s.session.mode === 'study' && s.tasks.records.some(function (r) {
        return r.outcome === 'not_started' || r.outcome === 'unfinished';
      })) status = 'abandoned';
      s.session.status = status;
      s.session.endReason = reason;
      s.payment = null;
      out.effects.push({ type: 'cancel_all' });
      goto('results');
      s.ui.banner = null;
      emit('session_ended', { details: { mode: s.session.mode, condition: config.condition,
        endReason: reason, status: status } });
    }

    function advance() {
      s.tasks.index += 1;
      if (s.tasks.index >= s.tasks.order.length) endSession('all_tasks_finished');
      else { goto('task_ready'); s.ui.banner = null; }
    }

    function resetOrder(reason) {
      emit('transaction_reset', { actor: 'system', details: { reasonCode: reason, lineCount: s.lines.length,
        discardedIssueIds: unresolved(s).map(function (i) { return i.issueId; }) } });
      Object.assign(s, emptyOrder());
      out.effects.push({ type: 'cancel_all' });
    }

    function startTask() {
      var record = currentRecord();
      var def = config.tasks[record.taskId];
      s.tasks.activeId = record.taskId;
      if (def.resetBefore) resetOrder('task_boundary');
      else s.checkoutCompleted = false;
      s.unreadable = Object.assign({}, def.unreadable || {});
      s.failVerifications = def.failVerifications || 0;
      s.assistedSku = def.assistedSku || null;
      var seeded = (def.seed || []).map(function (entry) {
        var item = catalog.get(entry.sku);
        var line = { lineId: nextId('L'), sku: entry.sku, qty: entry.qty,
          weight: item.unit === 'lb' ? item.simWeight : null, unbagged: 0 };
        s.lines.push(line);
        return { sku: line.sku, qty: line.qty, lineId: line.lineId };
      });
      s.ui.fromWelcome = def.start === 'welcome';
      goto(def.start === 'welcome' ? 'welcome' : 'checkout');
      s.ui.banner = null;
      record.outcome = 'active';
      record.startMs = ctx.now();
      emit('task_started', { details: { seeded: seeded } });
      if (def.duplicateRead) {
        var dupLine = countLine(s, def.duplicateRead);
        var expected = dupLine.qty;
        dupLine.qty += 1;
        s.lastLineId = dupLine.lineId;
        var issue = openIssue('possible_duplicate',
          { lineId: dupLine.lineId, sku: dupLine.sku, expectedQty: expected },
          { errorCategory: 'injected_scenario' });
        if (def.duplicatePresentation === 'prompt') openHelpFor(issue.issueId, 'automatic');
      }
    }

    /* ----- dispatch ----- */

    var type = action.type;
    if (type === 'session.start') {
      if (s.session.status !== 'not_started') return done(reject('already_started', 'policy_block'));
      var mode = p.mode === 'practice' ? 'practice' : 'study';
      /* The first-run tips are shown until finished or skipped, once per session. */
      s.session = { status: 'active', mode: mode, endReason: null, tour: 'pending' };
      var order = mode === 'study' ? (ctx.taskOrder || config.taskOrder).slice() : [];
      s.tasks = { order: order, index: 0, activeId: null,
        records: order.map(function (id) { return { taskId: id, outcome: 'not_started', startMs: null, endMs: null }; }) };
      emit('session_started', { screen: 'intro', details: { mode: mode, condition: config.condition, taskOrder: order } });
      if (mode === 'study') goto('task_ready');
      else {
        s.unreadable = Object.assign({}, config.practiceUnreadable);
        s.ui.fromWelcome = true;
        goto('welcome');
      }
      return done(true);
    }
    if (s.session.status !== 'active') return done(reject('session_not_active', 'policy_block'));
    if (actor === 'participant') s.ui.banner = null;

    var screen = s.ui.screen;
    var inKiosk = screen !== 'task_ready' && screen !== 'results' && screen !== 'intro';
    var SESSION_ACTIONS = { 'session.end': 1, 'task.start': 1, 'task.abandon': 1, 'system.visibility': 1,
      'system.verification': 1, 'system.assistance': 1, 'system.payment': 1, 'tour.finish': 1 };
    if (!inKiosk && !SESSION_ACTIONS[type]) return done(reject('invalid_screen', 'policy_block'));
    var locked = screen === 'processing' || screen === 'payment_complete' || screen === 'receipt';
    var LOCKED_OK = { 'receipt.choose': 1, 'receipt.done': 1, 'assist.request': 1, 'task.abandon': 1,
      'task.done': 1, 'scan.item': 1 };
    if (locked && !SESSION_ACTIONS[type] && !LOCKED_OK[type]) return done(reject('invalid_screen', 'policy_block'));

    switch (type) {
      case 'session.end':
        endSession('participant_ended');
        break;
      case 'tour.finish':
        if (s.session.tour !== 'pending') return done(reject('no_tour', 'policy_block'));
        if (p.result !== 'completed' && p.result !== 'skipped') return done(reject('invalid_result', 'technical'));
        s.session.tour = p.result;
        emit('tour_finished', { details: { result: p.result, stepsViewed: Number(p.stepsViewed) || 0 } });
        break;
      case 'task.start':
        if (screen !== 'task_ready') return done(reject('invalid_screen', 'policy_block'));
        startTask();
        break;
      case 'task.done': {
        if (!s.tasks.activeId) return done(reject('no_active_task', 'policy_block'));
        if (screen === 'processing') return done(reject('payment_in_progress', 'policy_block'));
        var result = scenario.evaluate(s.tasks.activeId, s);
        endTask(scenario.outcomeFor(s.tasks.activeId, result), 'participant_done', result);
        advance();
        break;
      }
      case 'task.abandon':
        if (!s.tasks.activeId) return done(reject('no_active_task', 'policy_block'));
        emit('task_abandoned', { details: { reasonCode: 'participant_gave_up' } });
        endTask('abandoned', 'participant_gave_up');
        s.payment = null;
        out.effects.push({ type: 'cancel_all' });
        advance();
        break;

      case 'kiosk.start': goto('checkout'); break;
      case 'membership.open': goto('membership'); break;
      case 'membership.apply':
        if (screen !== 'membership') return done(reject('invalid_screen', 'policy_block'));
        s.membership = true; goto('checkout'); banner('success', 'membership_applied');
        break;
      case 'nav.back':
        if (screen === 'weigh' || screen === 'count' || screen === 'manual_entry' || screen === 'lookup') {
          var from = s.ui.params.issueId && issueById(s, s.ui.params.issueId);
          if (from && !CLOSED[from.status]) { goto('help', { issueId: from.issueId }); break; }
        }
        if (screen === 'assistance') { returnFromAssistance(s.ui.params.returnTo); break; }
        home();
        break;

      case 'scan.item':
        if (screen === 'processing' || screen === 'payment_complete' || screen === 'receipt') {
          return done(reject('payment_in_progress', 'policy_block'));
        }
        scan(p.simItemId, false);
        break;
      case 'physical.confirm': {
        var req = requestById(s, p.requestId);
        if (!req) return done(reject('unknown_request', 'policy_block'));
        if (req.phase !== 'awaiting_physical' && req.phase !== 'failed') {
          return done(reject('not_awaiting_physical', 'policy_block'));
        }
        if (!req.physical) return done(reject('no_physical_step', 'policy_block'));
        if (!req.reverting) req.physicalDone = true;
        if (screen === 'help' || screen === 'assistance') goto('checkout');
        startVerification(req);
        break;
      }
      case 'request.cancel': cancelRequest(requestById(s, p.requestId)); break;
      case 'request.retry': {
        var rr = requestById(s, p.requestId);
        if (!rr || rr.phase !== 'failed') return done(reject('nothing_to_retry', 'policy_block'));
        startVerification(rr);
        break;
      }

      case 'lookup.open': {
        var blockedNow = addBlockReason(s, config, null);
        if (blockedNow) { banner('error', blockedNow); return done(reject(blockedNow, 'policy_block')); }
        goto('lookup', { mode: 'produce', issueId: null });
        break;
      }
      case 'lookup.search': break;
      case 'lookup.report':
        if (screen !== 'lookup') return done(reject('invalid_screen', 'policy_block'));
        var existingProduce = unresolved(s).filter(function (i) { return i.type === 'produce_identification'; })[0];
        var pi = existingProduce || openIssue('produce_identification', { assistedSku: s.assistedSku }, { userInitiated: true });
        openHelpFor(pi.issueId, 'user');
        break;
      case 'lookup.manual':
        if (screen !== 'lookup') return done(reject('invalid_screen', 'policy_block'));
        goto('manual_entry', { issueId: s.ui.params.issueId || null });
        break;
      case 'lookup.select': {
        if (screen !== 'lookup') return done(reject('invalid_screen', 'policy_block'));
        var chosen = catalog.get(p.sku);
        if (!chosen) return done(reject('unknown_sku', 'technical'));
        if (s.ui.params.mode !== 'item' && !chosen.produce) return done(reject('not_produce', 'policy_block'));
        var iid = s.ui.params.issueId;
        if (chosen.unit === 'lb') goto('weigh', { sku: p.sku, issueId: iid, placed: false });
        else if (chosen.produce) goto('count', { sku: p.sku, issueId: iid, qty: 1 });
        else addIdentified(p.sku, 1, null, 'lookup', iid);
        break;
      }
      case 'manual.submit': {
        if (screen !== 'manual_entry') return done(reject('invalid_screen', 'policy_block'));
        var code = String(p.code || '');
        var found = /^\d{4,6}$/.test(code) ? catalog.findByCode(code) : null;
        if (!found) {
          s.ui.params.error = 'invalid_code';
          return done(reject('invalid_code', 'participant_input'));
        }
        var fi = catalog.get(found);
        var origin = s.ui.params.issueId;
        if (fi.unit === 'lb') goto('weigh', { sku: found, issueId: origin, placed: false, method: 'manual_entry' });
        else if (fi.produce) goto('count', { sku: found, issueId: origin, qty: 1, method: 'manual_entry' });
        else addIdentified(found, 1, null, 'manual_entry', origin);
        break;
      }
      case 'scale.place':
        if (screen !== 'weigh' || s.ui.params.placed) return done(reject('invalid_screen', 'policy_block'));
        s.ui.params.placed = true;
        break;
      case 'weigh.confirm': {
        if (screen !== 'weigh' || !s.ui.params.placed) return done(reject('invalid_screen', 'policy_block'));
        var w = catalog.get(s.ui.params.sku);
        addIdentified(s.ui.params.sku, 1, w.simWeight, s.ui.params.method || 'lookup', s.ui.params.issueId);
        break;
      }
      case 'count.step': {
        if (screen !== 'count') return done(reject('invalid_screen', 'policy_block'));
        var nq = s.ui.params.qty + (p.delta > 0 ? 1 : -1);
        if (nq < 1 || nq > config.maxQuantity) return done(reject(nq < 1 ? 'invalid_quantity' : 'over_limit', 'participant_input'));
        s.ui.params.qty = nq;
        break;
      }
      case 'count.confirm': {
        if (screen !== 'count') return done(reject('invalid_screen', 'policy_block'));
        var cl = countLine(s, s.ui.params.sku);
        if ((cl ? cl.qty : 0) + s.ui.params.qty > config.maxQuantity) {
          s.ui.params.error = 'over_limit';
          return done(reject('over_limit', 'participant_input'));
        }
        addIdentified(s.ui.params.sku, s.ui.params.qty, null, s.ui.params.method || 'lookup', s.ui.params.issueId);
        break;
      }

      case 'qty.step': {
        var line = editableLine(p.lineId);
        if (!line) break;
        if (catalog.get(line.sku).unit !== 'each') return done(reject('weight_item', 'policy_block'));
        var target = line.qty + (p.delta > 0 ? 1 : -1);
        if (target < 1) goto('removal_confirm', { lineId: line.lineId });
        else if (target > config.maxQuantity) { banner('error', 'over_limit'); return done(reject('over_limit', 'participant_input')); }
        else if (target > line.qty) requestChange(line, target, null, 'stepper');
        else goto('decrease_reason', { lineId: line.lineId, toQty: target, method: 'stepper' });
        break;
      }
      case 'qty.open': {
        var ql = editableLine(p.lineId);
        if (!ql) break;
        if (catalog.get(ql.sku).unit !== 'each') return done(reject('weight_item', 'policy_block'));
        goto('qty_editor', { lineId: ql.lineId });
        break;
      }
      case 'qty.submit': {
        if (screen !== 'qty_editor' || s.ui.params.lineId !== p.lineId) return done(reject('invalid_screen', 'policy_block'));
        var el = editableLine(p.lineId);
        if (!el) break;
        var raw = String(p.value === undefined ? '' : p.value).trim();
        if (!/^\d{1,4}$/.test(raw)) { s.ui.params.error = 'invalid_quantity'; return done(reject('invalid_quantity', 'participant_input')); }
        var value = parseInt(raw, 10);
        if (value > config.maxQuantity) { s.ui.params.error = 'over_limit'; return done(reject('over_limit', 'participant_input')); }
        if (value === el.qty) { s.ui.params.error = 'no_change'; return done(reject('no_change')); }
        if (value === 0) goto('removal_confirm', { lineId: el.lineId });
        else if (value > el.qty) requestChange(el, value, null, 'direct_edit');
        else goto('decrease_reason', { lineId: el.lineId, toQty: value, method: 'direct_edit' });
        break;
      }
      case 'decrease.confirm': {
        if (screen !== 'decrease_reason') return done(reject('invalid_screen', 'policy_block'));
        if (p.reason !== 'duplicate' && p.reason !== 'unwanted') return done(reject('invalid_reason', 'technical'));
        var params = s.ui.params;
        var dl = editableLine(params.lineId);
        if (!dl) break;
        if (params.toQty >= dl.qty) { goto('checkout'); return done(reject('no_change')); }
        requestChange(dl, params.toQty, p.reason, params.method);
        break;
      }
      case 'remove.open': {
        var ol = editableLine(p.lineId);
        if (!ol) break;
        goto('removal_confirm', { lineId: ol.lineId });
        break;
      }
      case 'remove.confirm': {
        if (screen !== 'removal_confirm') return done(reject('invalid_screen', 'policy_block'));
        if (p.reason !== 'duplicate' && p.reason !== 'unwanted') return done(reject('invalid_reason', 'technical'));
        var rl = editableLine(s.ui.params.lineId);
        if (!rl) break;
        requestRemoval(rl, p.reason);
        break;
      }

      case 'issue.open': {
        var target2 = issueById(s, p.issueId);
        if (!target2 || CLOSED[target2.status]) return done(reject('unknown_issue', 'policy_block'));
        if (target2.type === 'general_assistance' || activeAssist(s, target2.issueId)) {
          goto('assistance', { issueId: target2.issueId, returnTo: 'checkout' });
          emit('help_opened', { issueId: target2.issueId, details: { context: target2.type, trigger: 'user' } });
          break;
        }
        if (target2.status === 'deferred') target2.status = 'open';
        openHelpFor(target2.issueId, 'user');
        break;
      }
      case 'issue.defer': deferIssue(issueById(s, p.issueId)); break;
      case 'attention.focus': goto('checkout'); break;
      case 'help.open': {
        if (screen === 'help') return done(reject('already_open', 'policy_block'));
        var line3 = p.lineId && lineById(s, p.lineId);
        goto('help', { context: 'general', lineId: line3 ? line3.lineId : undefined });
        emit('help_opened', { details: { context: 'general', trigger: 'user' } });
        break;
      }
      case 'help.choose': chooseHelp(p.option); break;
      case 'assist.request':
        if (screen === 'processing') return done(reject('payment_in_progress', 'policy_block'));
        requestAssistance(p.issueId || null);
        break;
      case 'assist.cancel': {
        var assist = s.assists.filter(function (a) { return a.status === 'requested' && a.issueId === p.issueId; })[0];
        if (!assist) return done(reject('no_active_request', 'policy_block'));
        var ai = issueById(s, assist.issueId);
        var cameFrom = screen === 'assistance' ? s.ui.params.returnTo : null;
        cancelAssistFor(assist.issueId);
        if (ai.type === 'general_assistance') closeIssue(ai, 'canceled', 'assistance_canceled', actor);
        else ai.status = 'open';
        returnFromAssistance(cameFrom);
        break;
      }

      case 'pay.start':
        emit('payment_attempted', {});
        if (!blockPayment()) goto('payment_method');
        break;
      case 'pay.method':
        if (screen !== 'payment_method' && screen !== 'payment_card') return done(reject('invalid_screen', 'policy_block'));
        if (PAYMENT_METHODS.indexOf(p.method) < 0) return done(reject('invalid_method', 'technical'));
        if (!blockPayment()) { s.ui.lastMethod = p.method; goto('payment_card', { method: p.method }); }
        break;
      case 'pay.other':
        if (screen !== 'payment_card') return done(reject('invalid_screen', 'policy_block'));
        goto('payment_method');
        break;
      case 'pay.tender': {
        if (screen !== 'payment_card') return done(reject('invalid_screen', 'policy_block'));
        if (blockPayment()) break;
        s.payment = { paymentId: nextId('P'), method: s.ui.params.method };
        goto('processing');
        out.effects.push({ type: 'schedule', key: s.payment.paymentId, delayMs: config.delays.paymentMs,
          action: { type: 'system.payment', params: { paymentId: s.payment.paymentId } } });
        break;
      }

      case 'receipt.choose':
        if (screen !== 'payment_complete') return done(reject('invalid_screen', 'policy_block'));
        goto('receipt', { option: p.option === 'email' ? 'email' : 'print' });
        break;
      case 'receipt.done':
        if (screen !== 'payment_complete' && screen !== 'receipt') return done(reject('invalid_screen', 'policy_block'));
        if (s.session.mode === 'study') {
          if (s.tasks.activeId) return done(reject('task_active', 'technical'));
          advance();
        } else {
          resetOrder('checkout_complete');
          s.unreadable = Object.assign({}, config.practiceUnreadable);
          s.ui.fromWelcome = true;
          goto('welcome');
        }
        break;

      case 'sim.unexpected_item': {
        if (s.session.mode !== 'practice') return done(reject('practice_only', 'policy_block'));
        if (unresolved(s).some(function (i) { return i.type === 'bagging_mismatch'; })) return done(reject('already_open', 'policy_block'));
        var u = openIssue('bagging_mismatch', { variant: 'unexpected' }, { errorCategory: 'injected_scenario' });
        openHelpFor(u.issueId, 'automatic');
        break;
      }
      case 'sim.fail_verification':
        if (s.session.mode !== 'practice') return done(reject('practice_only', 'policy_block'));
        s.failVerifications += 1;
        break;

      case 'system.verification': {
        var v = requestById(s, p.requestId);
        if (!v || v.phase !== 'verifying' || v.attempt !== p.attempt) return done(reject('stale_callback', 'technical'));
        var method = v.physical ? methodByPhysical[v.physical] : 'weight_check';
        var fail = s.failVerifications > 0;
        if (fail) s.failVerifications -= 1;
        var vd = { result: fail ? 'failure' : 'success', method: method, attempt: v.attempt };
        if (fail) vd.errorCategory = 'injected_scenario';
        emit('verification_result', { requestId: v.requestId, lineId: v.lineId || undefined,
          issueId: v.issueId || undefined, details: vd });
        if (fail) {
          v.phase = 'failed';
          var vi = v.issueId && issueById(s, v.issueId);
          if (v.kind === 'scan_bagging' && !vi) {
            vi = openIssue('bagging_mismatch', { variant: 'placement', lineId: v.lineId, sku: v.sku });
            v.issueId = vi.issueId;
          }
          if (vi) vi.status = 'open';
          banner('error', 'verification_failed');
        } else if (v.needsApproval && !v.reverting) {
          v.phase = 'awaiting_approval';
          var wi = v.issueId && issueById(s, v.issueId);
          if (wi) wi.status = 'open';
          banner('info', 'approval_needed');
        } else {
          commit(v, 'verified');
        }
        break;
      }
      case 'system.assistance': completeAssistance(p.assistId); break;
      case 'system.payment': {
        if (!s.payment || s.payment.paymentId !== p.paymentId || s.ui.screen !== 'processing') {
          return done(reject('stale_callback', 'technical'));
        }
        if (blockPayment()) break;
        var t = totals(s, config);
        s.checkoutCompleted = true;
        s.receipt = { method: s.payment.method, totals: t };
        emit('checkout_completed', { details: { finalTotalCents: t.totalCents, itemCount: t.itemCount,
          method: s.payment.method } });
        s.payment = null;
        goto('payment_complete');
        if (s.tasks.activeId) {
          var fin = scenario.evaluate(s.tasks.activeId, s);
          endTask(scenario.outcomeFor(s.tasks.activeId, fin), 'checkout_completed', fin);
        }
        break;
      }
      case 'system.visibility':
        emit('visibility_changed', { actor: 'system', details: { state: p.state === 'hidden' ? 'hidden' : 'visible' } });
        break;
      default:
        return done(reject('unknown_action', 'technical'));
    }
    return done(true);

    function done() {
      /* Any way of leaving the help screen closes help. */
      if (previous.ui.screen === 'help' && s.ui.screen !== 'help') {
        var prior = previous.ui.params.issueId && issueById(previous, previous.ui.params.issueId);
        emit('help_closed', { taskId: previous.tasks.activeId, issueId: previous.ui.params.issueId,
          details: { context: prior ? prior.type : (previous.ui.params.context || 'general') } });
      }
      /* Remember the first moment the active task's predicate became true. */
      if (s.tasks.activeId) {
        var record = s.tasks.records[s.tasks.index];
        if (record && record.firstSatisfiedMs === undefined &&
            scenario.evaluate(record.taskId, s).passed) record.firstSatisfiedMs = ctx.now();
      }
      return out;
    }
  }

  SCO.tx = {
    initialState: initialState,
    reduce: reduce,
    totals: totals,
    lineAmount: lineAmount,
    unresolved: unresolved,
    paymentEligibility: paymentEligibility,
    addBlockReason: addBlockReason,
    requestForIssue: requestForIssue,
    pendingChange: pendingChange,
    activeAssist: activeAssist,
    PAYMENT_METHODS: PAYMENT_METHODS
  };
})(window.SCO = window.SCO || {});
