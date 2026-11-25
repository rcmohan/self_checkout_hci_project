/* Scenario engine: task success predicates and constraint checks. Predicates
 * look only at transaction state, so they do not depend on the path taken. */
(function (SCO) {
  'use strict';

  var CLOSED = { resolved: true, canceled: true };

  function unresolved(state) {
    return state.issues.filter(function (i) { return !CLOSED[i.status]; });
  }

  function linesFor(state, sku) {
    return state.lines.filter(function (l) { return l.sku === sku; });
  }

  /* Count-priced items: units. Weighed items: number of weighings. */
  function quantityOf(state, sku) {
    return linesFor(state, sku).reduce(function (n, l) { return n + l.qty; }, 0);
  }

  function verified(state, sku) {
    return linesFor(state, sku).every(function (l) {
      return l.unbagged === 0 && !state.requests.some(function (r) { return r.lineId === l.lineId; });
    });
  }

  function noOpenIssueFor(state, sku) {
    return !unresolved(state).some(function (i) { return i.sku === sku || i.simItem === sku; });
  }

  function noOpenType(state, type) {
    return !unresolved(state).some(function (i) { return i.type === type; });
  }

  var predicates = {
    T1: function (s) {
      return {
        correct_quantity: quantityOf(s, 'soup') === 3,
        verified: linesFor(s, 'soup').length > 0 && verified(s, 'soup'),
        no_open_issue: noOpenIssueFor(s, 'soup')
      };
    },
    T2: function (s) {
      return {
        intended_quantity: quantityOf(s, 'eggs') === 1,
        verified: verified(s, 'eggs'),
        issue_cleared: noOpenType(s, 'possible_duplicate') && noOpenIssueFor(s, 'eggs')
      };
    },
    T3: function (s) {
      return {
        line_removed: quantityOf(s, 'milk') === 0,
        verification_complete: noOpenIssueFor(s, 'milk') &&
          !s.requests.some(function (r) { return r.sku === 'milk'; })
      };
    },
    T4: function (s) {
      return {
        item_identified: quantityOf(s, 'cereal') === 1,
        verified: linesFor(s, 'cereal').length > 0 && verified(s, 'cereal'),
        recovery_complete: noOpenType(s, 'unreadable_barcode')
      };
    },
    T5: function (s) {
      var lines = linesFor(s, 'gala_apples');
      return {
        correct_produce: lines.length === 1,
        weight_committed: lines.length === 1 && lines[0].weight > 0,
        verified: lines.length === 1 && verified(s, 'gala_apples'),
        no_open_issue: noOpenType(s, 'produce_identification')
      };
    },
    T6: function (s) {
      /* After payment the order is the receipt snapshot held in state.lines. */
      var original = s.issues.filter(function (i) { return i.simItem === 'paper_towels'; });
      return {
        other_item_committed: quantityOf(s, 'juice') >= 1,
        original_issue_resolved: original.length > 0 &&
          original.every(function (i) { return i.status === 'resolved'; }) &&
          quantityOf(s, 'paper_towels') === 1,
        checkout_completed: s.checkoutCompleted === true
      };
    }
  };

  function evaluate(taskId, state) {
    var fn = predicates[taskId];
    if (!fn) return { passed: false, criteria: {} };
    var criteria = fn(state);
    return {
      passed: Object.keys(criteria).every(function (k) { return criteria[k]; }),
      criteria: criteria
    };
  }

  /* Outcome when the participant says they are done. "partial" means at least
   * one criterion that reflects progress toward the goal is met. */
  var progressKeys = {
    T1: ['correct_quantity'],
    T2: ['intended_quantity'],
    T3: ['line_removed'],
    T4: ['item_identified'],
    T5: ['correct_produce'],
    T6: ['other_item_committed', 'original_issue_resolved', 'checkout_completed']
  };

  function outcomeFor(taskId, result) {
    if (result.passed) return 'success';
    var progressed = (progressKeys[taskId] || []).some(function (k) { return result.criteria[k]; });
    return progressed ? 'partial' : 'failure';
  }

  /* Returns a reason code when changing `sku` from oldQty to newQty violates
   * the active task's stated goal, otherwise null. */
  function constraintViolation(config, taskId, sku, oldQty, newQty) {
    var task = taskId && config.tasks[taskId];
    if (!task) return null;
    var intended = task.intended[sku] || 0;
    if (newQty > oldQty && newQty > intended) {
      return intended === 0 ? 'item_not_in_task' : 'quantity_above_intended';
    }
    if (newQty < oldQty && newQty < intended) return 'unintended_removal';
    return null;
  }

  SCO.scenario = {
    evaluate: evaluate,
    outcomeFor: outcomeFor,
    constraintViolation: constraintViolation,
    quantityOf: quantityOf,
    unresolved: unresolved
  };
})(window.SCO = window.SCO || {});
