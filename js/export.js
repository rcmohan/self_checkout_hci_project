/* Derived metrics and the export document. Everything is computed from the event
 * log and the task records; there are no independent counters. */
(function (SCO) {
  'use strict';

  function count(events, predicate) { return events.filter(predicate).length; }
  function ofType(events, type) { return events.filter(function (e) { return e.type === type; }); }
  function tally(list) {
    return list.reduce(function (acc, key) { acc[key] = (acc[key] || 0) + 1; return acc; }, {});
  }

  function metrics(events) {
    var categories = { participant_input: 0, injected_scenario: 0, policy_block: 0, technical: 0 };
    events.forEach(function (e) {
      var c = e.details && e.details.errorCategory;
      if (c && categories[c] !== undefined) categories[c] += 1;
    });
    var helpOpened = ofType(events, 'help_opened');
    var userHelp = helpOpened.filter(function (e) { return e.details.trigger === 'user'; });
    var scans = ofType(events, 'scan_result');
    return {
      participantErrors: categories.participant_input,
      scenarioFailures: categories.injected_scenario,
      errorsByCategory: categories,
      helpOpens: userHelp.length,
      helpShownAutomatically: helpOpened.length - userHelp.length,
      helpByContext: tally(helpOpened.map(function (e) { return e.details.context; })),
      helpActionsSelected: ofType(events, 'help_action_selected').length,
      recoveryAttempts: count(events, function (e) {
        return e.type === 'help_action_selected' && e.details.optionId !== 'set_aside';
      }),
      assistanceRequests: ofType(events, 'assistance_requested').length,
      assistanceCompleted: count(events, function (e) {
        return e.type === 'assistance_completed' && e.details.outcome === 'resolved';
      }),
      scanAttempts: ofType(events, 'scan_attempted').length,
      repeatedScans: count(scans, function (e) { return e.details.result === 'success' && e.details.repeat; }),
      quantityEdits: ofType(events, 'quantity_requested').length,
      removalAttempts: ofType(events, 'removal_requested').length,
      removalsCompleted: ofType(events, 'removal_committed').length,
      paymentAttempts: ofType(events, 'payment_attempted').length,
      blockedPayments: ofType(events, 'payment_blocked').length,
      checkoutsCompleted: ofType(events, 'checkout_completed').length,
      rejectedActions: count(events, function (e) {
        return e.type === 'action_result' && e.details.outcome === 'rejected';
      })
    };
  }

  function issueTimeline(events) {
    var list = [];
    var open = {};
    events.forEach(function (e) {
      if (e.type === 'issue_opened') {
        var entry = { issueId: e.issueId, type: e.details.issueType, taskId: e.taskId, openedMs: e.tMs,
          closedMs: null, durationMs: null, finalStatus: 'unresolved', resolutionMethod: null };
        /* Issue ids are unique per session, even across order resets. */
        open[e.issueId] = entry;
        list.push(entry);
      } else if (e.type === 'issue_resolved' && open[e.issueId]) {
        var found = open[e.issueId];
        found.closedMs = e.tMs;
        found.durationMs = e.tMs - found.openedMs;
        found.finalStatus = e.details.finalStatus;
        found.resolutionMethod = e.details.resolutionMethod;
        delete open[e.issueId];
      }
    });
    return list;
  }

  function hidden(events) {
    var total = 0;
    var since = null;
    var intervals = 0;
    events.forEach(function (e) {
      if (e.type === 'visibility_changed') {
        if (e.details.state === 'hidden') { if (since === null) { since = e.tMs; intervals += 1; } }
        else if (since !== null) { total += e.tMs - since; since = null; }
      } else if (e.type === 'session_resumed') since = null;
    });
    return { hiddenIntervals: intervals, hiddenDurationMs: total, hiddenIntervalUnfinished: since !== null };
  }

  function taskResults(state, events) {
    return state.tasks.records.map(function (record) {
      var id = record.taskId;
      var mine = events.filter(function (e) { return e.taskId === id; });
      var started = ofType(mine, 'task_started')[0];
      var ended = ofType(mine, 'task_ended')[0];
      var censored = !!started && (!ended || ended.details.outcome === 'unfinished');
      var m = metrics(mine);
      return {
        taskId: id,
        outcome: ended ? ended.details.outcome : (started ? 'unfinished' : 'not_started'),
        durationMs: started && ended && !censored ? ended.tMs - started.tMs : null,
        censoredAtMs: censored ? (ended || mine[mine.length - 1]).tMs - started.tMs : null,
        spansReload: started ? events.some(function (e) {
          return e.type === 'session_resumed' && e.seq > started.seq && (!ended || e.seq < ended.seq);
        }) : false,
        predicatePassed: ended ? ended.details.predicatePassed : null,
        criteria: ended ? ended.details.criteria : null,
        participantErrors: m.participantErrors,
        scenarioFailures: m.scenarioFailures,
        helpOpens: m.helpOpens,
        assistanceRequests: m.assistanceRequests,
        quantityEdits: m.quantityEdits,
        repeatedScans: m.repeatedScans,
        blockedPayments: m.blockedPayments
      };
    });
  }

  function build(state, log, config) {
    var events = log.events;
    var tasks = taskResults(state, events);
    var issues = issueTimeline(events);
    var gaps = ofType(events, 'session_resumed');
    var unknownGaps = count(gaps, function (e) { return e.details.offlineGapMs === null; });
    var summary = {
      tasksTotal: tasks.length,
      tasksCompleted: count(tasks, function (t) { return t.outcome === 'success'; }),
      tasksPartial: count(tasks, function (t) { return t.outcome === 'partial'; }),
      tasksFailed: count(tasks, function (t) { return t.outcome === 'failure'; }),
      tasksAbandoned: count(tasks, function (t) { return t.outcome === 'abandoned'; }),
      tasksUnfinished: count(tasks, function (t) { return t.outcome === 'unfinished'; }),
      tasksNotStarted: count(tasks, function (t) { return t.outcome === 'not_started'; })
    };
    Object.assign(summary, metrics(events), hidden(events));
    summary.unresolvedIssues = count(issues, function (i) { return i.finalStatus === 'unresolved'; });
    summary.issues = issues;
    summary.screenTrajectory = ofType(events, 'screen_changed').map(function (e) { return e.details.to; });
    summary.actionTrajectory = ofType(events, 'action_attempted').map(function (e) { return e.details.actionName; });

    var started = ofType(events, 'session_started')[0];
    return {
      schemaVersion: config.schemaVersion,
      prototypeVersion: config.prototypeVersion,
      scenarioVersion: config.scenarioVersion,
      sessionId: log.sessionId,
      condition: started ? started.details.condition : config.condition,
      mode: state.session.mode,
      status: state.session.status,
      endReason: state.session.endReason,
      durationMs: events.length ? events[events.length - 1].tMs : null,
      resumes: gaps.length,
      offlineGapMs: gaps.length === 0 ? 0 : (unknownGaps ? null :
        gaps.reduce(function (n, e) { return n + e.details.offlineGapMs; }, 0)),
      taskOrder: state.tasks.order,
      tasks: tasks,
      summary: summary,
      events: events
    };
  }

  SCO.exporter = {
    build: build,
    metrics: metrics,
    filename: function (sessionId) { return 'self-checkout-session-' + sessionId + '.json'; }
  };
})(window.SCO = window.SCO || {});
