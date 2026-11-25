/* Renderer and input handling. Reads state, never mutates it: every change goes
 * through app.dispatch. Buttons are native elements, so touch, mouse and
 * keyboard all produce the same actions. */
(function (SCO) {
  'use strict';

  var catalog = SCO.catalog;
  var tx = SCO.tx;

  var METHODS = {
    debit: { label: 'Debit Card', icon: '💳' },
    credit: { label: 'Credit Card', icon: '💳' },
    cash: { label: 'Cash', icon: '💵' },
    gift: { label: 'Gift Card', icon: '🎁', cardIcon: '💳' },
    mobile: { label: 'Mobile Pay', icon: '▣', cardIcon: '💳' },
    ebt: { label: 'EBT / Benefits', icon: '▥', cardIcon: '💳' }
  };

  var MESSAGES = {
    awaiting_bagging: 'Please place the item in the bagging area before scanning.',
    pending_change: 'Finish, set aside, or cancel the pending change first.',
    blocking_issue: 'Resolve the item under Needs attention before continuing.',
    payment_in_progress: 'Payment is open. Go back to your items to make changes.',
    already_paid: 'This order has already been paid.',
    payment_empty_order: 'Add an item before paying.',
    payment_awaiting_bagging: 'Place your item in the bagging area before paying.',
    payment_unresolved_issues: 'Resolve the items under Needs attention before paying.',
    payment_pending_request: 'Wait for the current check to finish before paying.',
    over_limit: 'That is more than the limit for one item. Ask for assistance if you need more.',
    verification_failed: 'We couldn’t confirm the bagging area. Check item placement and try again.',
    approval_needed: 'An associate needs to approve this change. Choose Employee Assistance.',
    item_bagged: 'Bagged: {name}',
    quantity_updated: 'Quantity updated: {name} × {qty}',
    item_removed: 'Removed: {name}',
    item_added: 'Added: {name}',
    change_canceled: 'Change canceled. Your order is as it was before.',
    item_not_purchased: 'Item returned. You will not be charged for it.',
    problem_cleared: 'Problem cleared.',
    kept_both: 'Keeping both: {name}',
    assistance_no_item: 'An associate helped. Scan or look up the item again.',
    membership_applied: 'Demo membership applied.',
    scan_again: 'Scan the item again.',
    check_placement: 'Check that your items are placed in the bagging area, then confirm.',
    edit_quantity_hint: 'Use − or +, or tap the number, on the item’s row.',
    removal_hint: 'Tap the trash button on the item’s row.'
  };

  /* First-run tips. They cover only the simulation panel: coaching the kiosk
   * features under study would bias the results. */
  var TOUR = [
    { target: '.dock', title: 'This panel is your hands',
      text: 'The kiosk is only the screen. To handle items, such as scanning or bagging them, use this dashed Simulation panel.' },
    { target: '.dock [data-tour="basket"]', title: 'Your items are here',
      text: 'To scan an item, press its Scan button. Loose produce has no barcode, so it has no Scan button.' },
    { target: '.dock [data-tour="next"]', title: 'Watch for the yellow button',
      text: 'When the kiosk asks you to move an item or tap a card, a yellow button appears here. Press it to continue.' }
  ];

  var ENTRY_ERRORS = {
    invalid_quantity: 'Enter a whole number, such as 2.',
    over_limit: 'The limit for one item is {max}.',
    no_change: 'That is already the quantity.',
    invalid_code: 'We don’t recognize that number. Check it and try again.'
  };

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(cents) { return '$' + (cents / 100).toFixed(2); }
  function pounds(w) { return (w / 100).toFixed(2) + ' lb'; }
  function nameOf(id) { var item = catalog.physical(id); return item ? item.name : 'Item'; }
  function fill(text, data) {
    return text.replace(/\{(\w+)\}/g, function (_, k) { return data[k] !== undefined ? data[k] : ''; });
  }

  /* Button that dispatches an application action. */
  function act(label, action, params, opts) {
    opts = opts || {};
    var json = JSON.stringify(params || {});
    var key = opts.key || (action + json);
    return '<button type="button" class="' + (opts.cls || 'btn') + '" data-action="' + action + '"' +
      ' data-params="' + esc(json) + '" data-fk="' + esc(key) + '"' +
      (opts.label ? ' aria-label="' + esc(opts.label) + '"' : '') +
      (opts.disabled ? ' aria-disabled="true"' : '') +
      (opts.describedby ? ' aria-describedby="' + opts.describedby + '"' : '') +
      '>' + label + '</button>';
  }
  /* Button handled by the page itself (not a transaction action). */
  function local(label, command, opts) {
    opts = opts || {};
    return '<button type="button" class="' + (opts.cls || 'btn') + '" data-ui="' + command + '"' +
      (opts.value !== undefined ? ' data-value="' + esc(opts.value) + '"' : '') +
      ' data-fk="' + esc(command + (opts.value !== undefined ? opts.value : '')) + '"' +
      (opts.label ? ' aria-label="' + esc(opts.label) + '"' : '') + '>' + label + '</button>';
  }
  function assistLabel(text) { return '<span aria-hidden="true">✌️</span><span>' + (text || 'Employee Assistance') + '</span>'; }

  function createUI(app, root) {
    var live = document.getElementById('live');
    var view = {
      mode: 'study', confirm: null, entry: '', search: '', searchLogged: false,
      copyMessage: '', screenKey: '', lastScreenChange: 0, lastAnnounced: '', lastLineSig: '',
      tourStep: 0, tourSeen: 1
    };

    function touring(state) {
      return state.session.status === 'active' && state.session.tour === 'pending' && !state.tasks.activeId;
    }

    /* ---------- selectors ---------- */

    function request(state, issueId) { return tx.requestForIssue(state, issueId); }
    function issueById(state, id) { return state.issues.filter(function (i) { return i.issueId === id; })[0]; }
    function lineById(state, id) { return state.lines.filter(function (l) { return l.lineId === id; })[0]; }

    function issueTitle(state, issue) {
      if (issue.type === 'bagging_mismatch') return 'Bagging area';
      if (issue.type === 'general_assistance') return 'Associate request';
      if (issue.sku) return nameOf(issue.sku);
      return issue.type === 'produce_identification' ? 'Unidentified produce' : 'Unidentified item';
    }

    function issueDescription(state, issue) {
      var req = request(state, issue.issueId);
      if (req && req.reverting) return 'Canceling change';
      if (req && req.kind === 'item_cancel') return 'Not buying. Waiting for it to be returned.';
      switch (issue.type) {
        case 'unreadable_barcode': return 'Barcode could not be read. Not charged.';
        case 'unknown_product': return 'Barcode not recognized. Not charged.';
        case 'produce_identification': return 'Produce not identified. Not charged.';
        case 'possible_duplicate':
          return req ? 'Duplicate removal pending' : 'May have been scanned twice';
        case 'quantity_change': return req ? 'Quantity ' + req.fromQty + ' → ' + req.toQty + ' pending' : 'Quantity change pending';
        case 'removal_pending': return 'Removal pending';
        case 'authorization_required': return 'Age-restricted: needs associate approval. Not yet charged.';
        case 'bagging_mismatch':
          return issue.variant === 'unexpected' ? 'Unexpected item in the bagging area' : 'Bagging area doesn’t match';
        default: return 'Waiting for an associate';
      }
    }

    function issueStatus(state, issue) {
      var req = request(state, issue.issueId);
      if (tx.activeAssist(state, issue.issueId)) return { icon: '⏳', text: 'Associate on the way', tone: 'wait' };
      if (issue.status === 'deferred') return { icon: '⏸', text: 'Set aside', tone: 'aside' };
      if (req && req.phase === 'failed') return { icon: '✖', text: 'Check failed: try again', tone: 'bad' };
      if (issue.status === 'awaiting_verification') return { icon: '⏳', text: 'Checking', tone: 'wait' };
      if (req && req.phase === 'awaiting_approval') return { icon: '✋', text: 'Needs approval', tone: 'act' };
      if (req && req.phase === 'awaiting_physical') return { icon: '●', text: 'Waiting for you', tone: 'act' };
      return { icon: '●', text: 'Needs your action', tone: 'act' };
    }

    /* Wording for a physical step: used on the kiosk and in the simulator. */
    function physicalText(req) {
      var name = req.sku ? nameOf(req.sku) : 'the item';
      var n = req.qty || 1;
      if (req.reverting && req.physical === 'takeout') {
        return { title: 'Take the added items out', detail: 'Remove ' + n + ' × ' + name + ' that you added to the bagging area.',
          button: 'Take ' + n + ' × ' + name + ' out of the bagging area' };
      }
      if (req.reverting) {
        return { title: 'Put the items back', detail: 'Return ' + n + ' × ' + name + ' to the bagging area.',
          button: 'Put ' + n + ' × ' + name + ' back in the bagging area' };
      }
      switch (req.kind) {
        case 'scan_bagging':
          return { title: 'Place item in the bagging area', detail: 'The scanner will be ready to continue.',
            button: 'Place ' + (n > 1 ? n + ' × ' : '') + name + ' in the bagging area' };
        case 'qty_increase':
          return { title: 'Place ' + n + ' more in the bagging area',
            detail: name + ': quantity ' + req.fromQty + ' → ' + req.toQty + '. Your total changes after the bagging area is checked.',
            button: 'Place ' + n + ' more × ' + name + ' in the bagging area' };
        case 'qty_decrease':
        case 'removal':
          return { title: 'Remove ' + n + ' from the bagging area',
            detail: 'Take ' + n + ' × ' + name + ' out of the bagging area and place ' + (n > 1 ? 'them' : 'it') + ' in the designated return area.',
            button: 'Move ' + n + ' × ' + name + ' to the return area' };
        case 'item_cancel':
          return { title: 'Place the item in the return area', detail: 'Put the item you are not buying in the designated return area.',
            button: 'Put ' + (req.sku ? name : 'the item') + ' in the return area' };
        case 'unexpected_item':
          return { title: 'Remove the unexpected item', detail: 'Take the item that was not scanned out of the bagging area.',
            button: 'Remove the unexpected item from the bagging area' };
        default:
          return { title: 'Check item placement', detail: 'Make sure each item is resting fully in the bagging area.',
            button: 'Straighten the items in the bagging area' };
      }
    }

    /* ---------- kiosk screens ---------- */

    function bannerHtml(state) {
      var b = state.ui.banner;
      if (!b) return '';
      var text = fill(MESSAGES[b.code] || '', { name: b.sku ? nameOf(b.sku) : '', qty: b.qty });
      if (!text) return '';
      var icon = b.kind === 'error' ? '▲' : (b.kind === 'success' ? '✓' : 'ℹ');
      return '<div class="banner banner-' + b.kind + '"><span aria-hidden="true">' + icon + '</span> ' + esc(text) + '</div>';
    }

    function lineRow(state, line) {
      var item = catalog.get(line.sku);
      var pending = tx.pendingChange(state, line.lineId);
      var name = item.name;
      var badges = '';
      if (pending) {
        badges += '<span class="badge badge-pending">⏳ ' + (pending.reverting ? 'Canceling change' :
          pending.kind === 'removal' ? 'Removal pending' :
          'Requested ' + pending.toQty + ' (charged for ' + line.qty + ')') + '</span>';
      }
      if (line.unbagged > 0) badges += '<span class="badge badge-pending">🛍️ Waiting for bagging</span>';
      if (state.issues.some(function (i) {
        return i.type === 'possible_duplicate' && i.lineId === line.lineId &&
          i.status !== 'resolved' && i.status !== 'canceled';
      })) badges += '<span class="badge badge-pending">! Possible duplicate</span>';

      var sub = item.unit === 'lb' ? pounds(line.weight) + ' @ ' + money(item.priceCents) + '/lb'
        : money(item.priceCents) + ' each';
      var qty;
      if (item.unit === 'lb') qty = '<span class="weight">' + pounds(line.weight) + '</span>';
      else {
        var id = line.lineId;
        qty = '<div class="stepper">' +
          act('−', 'qty.step', { lineId: id, delta: -1 }, { cls: 'step', label: 'Decrease quantity of ' + name, disabled: !!pending }) +
          act(pending && pending.toQty ? line.qty + '<small>→' + pending.toQty + '</small>' : String(line.qty), 'qty.open', { lineId: id },
            { cls: 'qty', label: 'Edit quantity of ' + name + ', currently ' + line.qty, disabled: !!pending }) +
          act('+', 'qty.step', { lineId: id, delta: 1 }, { cls: 'step', label: 'Increase quantity of ' + name, disabled: !!pending }) +
          '</div>';
      }
      var cls = (state.lastLineId === line.lineId ? 'recent ' : '') + (pending ? 'pending' : '');
      return '<tr class="' + cls + '" data-line="' + line.lineId + '">' +
        '<th scope="row"><span class="item-name">' + esc(name) + '</span><span class="item-sub">' + sub + '</span>' + badges + '</th>' +
        '<td class="col-qty">' + qty + '</td>' +
        '<td class="col-price">' + money(tx.lineAmount(line)) + '</td>' +
        '<td class="col-remove">' + act('<span aria-hidden="true">🗑️</span>', 'remove.open', { lineId: line.lineId },
          { cls: 'trash', label: 'Remove ' + name, disabled: !!pending }) + '</td></tr>';
    }

    function attentionHtml(state) {
      var open = tx.unresolved(state);
      if (!open.length) return '';
      return '<section class="attention" id="attention" aria-labelledby="attention-title">' +
        '<h2 id="attention-title"><span aria-hidden="true">⚠</span> Needs attention (' + open.length + ')</h2>' +
        '<ul data-scroll="attention">' + open.map(function (issue) {
          var status = issueStatus(state, issue);
          var title = issueTitle(state, issue);
          return '<li data-issue="' + issue.issueId + '"><div class="att-text"><strong>' + esc(title) + '</strong>' +
            '<span>' + esc(issueDescription(state, issue)) + '</span></div>' +
            '<span class="status status-' + status.tone + '"><span aria-hidden="true">' + status.icon + '</span> ' + status.text + '</span>' +
            act('Resolve', 'issue.open', { issueId: issue.issueId },
              { cls: 'btn btn-resolve', label: 'Resolve: ' + title + ', ' + status.text }) + '</li>';
        }).join('') + '</ul></section>';
    }

    function promptHtml(state) {
      var live = state.requests.filter(function (r) {
        var issue = r.issueId && issueById(state, r.issueId);
        return !issue || (issue.status !== 'deferred' && !tx.activeAssist(state, issue.issueId));
      });
      function first(test) { return live.filter(test)[0]; }
      var failed = first(function (r) { return r.phase === 'failed'; });
      var bag = first(function (r) { return r.kind === 'scan_bagging' && r.phase === 'awaiting_physical'; });
      var checking = first(function (r) { return r.phase === 'verifying'; });
      var physical = first(function (r) { return r.phase === 'awaiting_physical'; });
      var approval = first(function (r) { return r.phase === 'awaiting_approval' && r.kind !== 'restricted_add'; });
      var blocking = tx.unresolved(state).filter(function (i) { return !app.config.issuePolicy[i.type].deferrable; })[0];

      function panel(tone, icon, title, detail, buttons) {
        return '<div class="prompt prompt-' + tone + '"><div class="prompt-icon" aria-hidden="true">' + icon + '</div>' +
          '<h1 class="prompt-title">' + esc(title) + '</h1><p>' + esc(detail) + '</p>' +
          (buttons ? '<div class="prompt-actions">' + buttons + '</div>' : '') + '</div>';
      }
      function requestButtons(r) {
        if (!r.issueId) return '';
        var issue = issueById(state, r.issueId);
        var html = '';
        if (r.phase === 'failed' && !r.physical) {
          html += act('Try again', 'request.retry', { requestId: r.requestId }, { cls: 'btn btn-small btn-primary' });
        }
        if (['qty_increase', 'qty_decrease', 'removal', 'item_cancel'].indexOf(r.kind) >= 0 && !r.reverting) {
          html += act(r.kind === 'item_cancel' ? 'Keep the item' : 'Cancel change', 'request.cancel', { requestId: r.requestId }, { cls: 'btn btn-small' });
        }
        if (app.config.issuePolicy[issue.type].deferrable) {
          html += act('Set aside', 'issue.defer', { issueId: issue.issueId }, { cls: 'btn btn-small' });
        }
        if (r.phase !== 'awaiting_physical') {
          html += act(assistLabel(), 'assist.request', { issueId: issue.issueId }, { cls: 'btn btn-small btn-assist' });
        }
        return html;
      }

      if (failed) return panel('bad', '⚠️', 'We couldn’t confirm that step',
        failed.physical ? physicalText(failed).detail + ' Then try again.' : 'The order check did not pass.', requestButtons(failed));
      if (bag) { var b = physicalText(bag); return panel('wait', '🛍️', b.title, b.detail); }
      if (checking) return panel('wait', '<span class="spinner"></span>', checking.physical ? 'Checking the bagging area…' : 'Checking your order…',
        checking.physical ? 'This takes a moment.' : 'Keep the items you are buying in the bagging area. Nothing needs to move.');
      if (physical) { var t = physicalText(physical); return panel('wait', '🛍️', t.title, t.detail, requestButtons(physical)); }
      if (approval) return panel('wait', '✋', 'Associate approval needed', 'This change is waiting for approval.', requestButtons(approval));
      if (blocking) return panel('bad', '⚠️', 'Checkout needs attention', 'Choose Resolve under Needs attention to continue.');
      var firstItem = state.lines.length === 0 && state.issues.length === 0;
      return panel('ready', '▦', firstItem ? 'Scan your first item' : 'Scan next item',
        'Hold the barcode toward the scanner, or look up an item below.');
    }

    function checkoutScreen(state) {
      var totals = tx.totals(state, app.config);
      var pay = tx.paymentEligibility(state, app.config);
      var waiting = state.assists.some(function (a) { return a.status === 'requested'; });
      var reason = '';
      var open = tx.unresolved(state).length;
      if (!pay.ok && state.lines.length + open > 0) {
        if (open) reason = 'To pay, resolve ' + open + (open === 1 ? ' item' : ' items') + ' under Needs attention.';
        else if (pay.reasons.indexOf('awaiting_bagging') >= 0) reason = 'To pay, place your item in the bagging area.';
      }
      var rows = state.lines.map(function (l) { return lineRow(state, l); }).join('');
      return '<div class="checkout">' +
        '<div class="order card">' +
        '<div class="list" data-scroll="list" tabindex="0" role="region" aria-label="Scanned items">' +
        '<table><thead><tr><th scope="col">Item</th><th scope="col" class="col-qty">Qty</th>' +
        '<th scope="col" class="col-price">Price</th><th scope="col" class="col-remove"><span class="sr-only">Remove</span></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' +
        attentionHtml(state) +
        '<dl class="totals"><div><dt>Subtotal</dt><dd data-total="subtotal">' + money(totals.subtotalCents) + '</dd></div>' +
        '<div><dt>Tax</dt><dd>' + money(totals.taxCents) + '</dd></div>' +
        '<div class="grand"><dt>Total</dt><dd data-total="total">' + money(totals.totalCents) + '</dd></div></dl>' +
        '</div>' +
        '<div class="side">' + bannerHtml(state) +
        (waiting ? '<div class="banner banner-assist"><strong>Help is on the way</strong><span>An associate has been notified. You can continue scanning.</span></div>' : '') +
        promptHtml(state) +
        act('<span aria-hidden="true">🍏</span> Look Up Produce', 'lookup.open', {}, { cls: 'btn btn-lookup' }) +
        act('Pay' + (totals.totalCents ? ' ' + money(totals.totalCents) : ''), 'pay.start', {},
          { cls: 'btn btn-pay', disabled: !pay.ok, key: 'pay', describedby: reason ? 'pay-reason' : '' }) +
        (reason ? '<div class="pay-reason"><span id="pay-reason">' + reason + '</span>' +
          (open ? local('Go to Needs attention', 'goto-attention', { cls: 'link' }) : '') + '</div>' : '') +
        '</div></div>';
    }

    function dialog(opts) {
      return '<div class="center"><div class="card dialog ' + (opts.cls || '') + '">' +
        (opts.icon || '') +
        '<h1 class="dialog-title ' + (opts.tone || '') + '" tabindex="-1" data-heading>' + esc(opts.title) + '</h1>' +
        (opts.text ? '<p class="dialog-text">' + esc(opts.text) + '</p>' : '') +
        (opts.body || '') +
        (opts.buttons ? '<div class="options ' + (opts.stack ? 'stack' : '') + (opts.three ? 'three' : '') + '">' + opts.buttons + '</div>' : '') +
        (opts.footer ? '<div class="dialog-footer">' + opts.footer + '</div>' : '') +
        '</div></div>';
    }

    var ERROR_ICON = '<div class="alert-icon alert-red" aria-hidden="true">!</div>';
    var WARN_ICON = '<div class="alert-icon alert-amber" aria-hidden="true">!</div>';

    function option(label, id, primary) {
      return act(label, 'help.choose', { option: id }, { cls: 'btn ' + (primary ? 'btn-primary' : '') });
    }
    function assistOption() {
      return act(assistLabel(), 'help.choose', { option: 'request_assistance' }, { cls: 'btn btn-assist' });
    }
    function back(label) { return act(label || '← Back to my order', 'nav.back', {}, { cls: 'link', key: 'back' }); }

    function helpScreen(state) {
      var params = state.ui.params;
      var issue = params.issueId ? issueById(state, params.issueId) : null;
      if (!issue) {
        if (params.context === 'incorrect_quantity') {
          return dialog({ title: 'Fix a quantity', text: 'Use − or + on the item’s row, or tap the number to type a quantity.',
            buttons: option('Edit quantity', 'edit_quantity', true) + assistOption(), footer: back() });
        }
        if (params.context === 'unwanted_item') {
          return dialog({ title: 'Remove an item you don’t want',
            text: 'Tap the trash button on the item’s row. If the item is in your bagging area, you will move it to the return area.',
            buttons: option('Choose the item', 'initiate_removal', true) + assistOption(), footer: back() });
        }
        return dialog({ title: 'How can we help?', text: 'Choose what is happening.',
          buttons: option('An item won’t scan', 'report_unreadable') + option('I can’t find my produce', 'report_produce') +
            option('A quantity is wrong', 'report_quantity') + option('I don’t want an item', 'report_unwanted') +
            option('Bagging area problem', 'report_bagging') + assistOption(), footer: back() });
      }

      var req = request(state, issue.issueId);
      var aside = option('Set aside and keep scanning', 'set_aside');
      var secondary = function (extra) { return (extra || '') + back(); };

      if (req && ['qty_increase', 'qty_decrease', 'removal', 'item_cancel'].indexOf(req.kind) >= 0) {
        var step = req.physical ? physicalText(req) : null;
        var failed = req.phase === 'failed';
        var title = failed ? 'We couldn’t confirm that step' : (step ? step.title : 'Change waiting for approval');
        var detail = step ? step.detail + ' Use the highlighted step in the simulation panel.' : 'An associate needs to check this change.';
        if (req.phase === 'verifying') { title = 'Checking…'; detail = 'This takes a moment.'; }
        var buttons = '';
        if (failed) buttons += option('Try again', 'retry_check', true);
        if (req.kind === 'item_cancel') {
          buttons += act('Keep the item', 'request.cancel', { requestId: req.requestId }, { cls: 'btn' });
        } else if (!req.reverting) {
          buttons += option('Cancel change', 'cancel_change', !failed);
        }
        buttons += assistOption() + aside;
        return dialog({ icon: failed ? ERROR_ICON : WARN_ICON, title: title, tone: failed ? 'red' : '',
          text: issueTitle(state, issue) + '. ' + detail, buttons: buttons, footer: back() });
      }

      var notBuy = option('I’m not buying this item', 'not_buying');
      switch (issue.type) {
        case 'unreadable_barcode':
          return dialog({ icon: ERROR_ICON, tone: 'red', title: 'Item cannot be scanned',
            text: (params.retried ? 'It still did not scan. ' : '') + 'Choose an option to continue.',
            buttons: option('Try again', 'retry_scan', true) + option('Look up item', 'lookup_item') +
              option('Enter Produce PLU or Barcode', 'enter_code') + assistOption(),
            footer: secondary('<div class="options">' + aside + notBuy + '</div>') });
        case 'unknown_product':
          return dialog({ icon: ERROR_ICON, tone: 'red', title: 'We couldn\'t identify the barcode',
            text: (params.retried ? 'It was still not recognized. ' : '') + 'Choose an option to continue.',
            buttons: option('Scan another barcode', 'retry_scan', true) + option('Look up item', 'lookup_item') + assistOption(),
            footer: secondary('<div class="options">' + aside + notBuy + '</div>') });
        case 'produce_identification':
          return dialog({ icon: WARN_ICON, title: 'Let’s identify your produce', text: 'Choose an option to continue.',
            buttons: option('Search produce', 'search_produce', true) + option('Enter PLU or item number', 'enter_code') + assistOption(),
            footer: secondary('<div class="options">' + aside + notBuy + '</div>') });
        case 'possible_duplicate':
          return dialog({ icon: WARN_ICON, title: 'Looks like this item may have been scanned twice.', text: nameOf(issue.sku),
            stack: true, buttons: option('Keep both', 'keep_both', true) + option('Remove duplicate', 'remove_duplicate') + assistOption(),
            footer: secondary('<div class="options stack">' + option('Decide later', 'set_aside') + '</div>') });
        case 'authorization_required':
          return dialog({ icon: WARN_ICON, title: 'Approval needed', stack: true,
            text: nameOf(issue.sku) + ' is age-restricted. An associate must approve it before it is added to your order.',
            buttons: act(assistLabel(), 'help.choose', { option: 'request_assistance' }, { cls: 'btn btn-assist' }) +
              option('Continue scanning', 'set_aside') + notBuy, footer: back() });
        case 'bagging_mismatch':
          if (issue.variant === 'unexpected') {
            return dialog({ icon: ERROR_ICON, tone: 'red', title: 'Unexpected Item in the Bagging Area',
              text: 'Remove the unexpected item, then choose an option to continue.',
              buttons: option('Scan again', 'scan_again', true) + option('Remove from Bagging area', 'remove_from_bagging') + assistOption(),
              footer: back() });
          }
          return dialog({ icon: ERROR_ICON, tone: 'red', title: 'Bagging area doesn’t match',
            text: 'Check that each item is placed in the bagging area.',
            buttons: option('Check item placement', 'check_placement', true) + assistOption(), footer: back() });
        default:
          return dialog({ title: 'Help', buttons: assistOption(), footer: back() });
      }
    }

    function assistanceScreen(state) {
      var issue = issueById(state, state.ui.params.issueId);
      var active = issue && tx.activeAssist(state, issue.issueId);
      var deferrable = issue && app.config.issuePolicy[issue.type].deferrable;
      return '<div class="center"><div class="help-panel">' +
        '<div class="big-icon" aria-hidden="true">✌️</div>' +
        '<h1 tabindex="-1" data-heading>Help is on the way</h1>' +
        '<p>An associate has been notified and will be with you shortly. ' +
        (deferrable ? 'You can continue scanning while you wait.' : 'Please wait. Checkout is paused until the associate arrives.') + '</p>' +
        '<div class="options">' +
        (deferrable ? act('Continue scanning', 'nav.back', {}, { cls: 'btn btn-primary' }) : '') +
        (active ? act('Cancel request', 'assist.cancel', { issueId: issue.issueId }) : back()) +
        '</div></div></div>';
    }

    function keypad() {
      var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];
      return '<div class="keypad" role="group" aria-label="Number pad">' + keys.map(function (k) {
        var label = k === 'clear' ? 'Clear' : (k === 'del' ? '⌫' : k);
        return local(label, 'key', { cls: 'key', value: k, label: k === 'del' ? 'Delete last digit' : undefined });
      }).join('') + '</div>';
    }

    function entryForm(state, opts) {
      var error = state.ui.params.error;
      return '<form class="entry" data-form="' + opts.form + '" novalidate>' +
        '<div><label for="entry">' + opts.label + '</label>' +
        '<input id="entry" data-fk="entry" type="text" inputmode="numeric" autocomplete="off" maxlength="' + opts.max + '"' +
        ' value="' + esc(view.entry) + '"' + (error ? ' aria-invalid="true" aria-describedby="entry-error"' : '') + '>' +
        (error ? '<p class="field-error" id="entry-error" role="alert">▲ ' + esc(fill(ENTRY_ERRORS[error] || '', { max: app.config.maxQuantity })) + '</p>' : '') +
        '<button type="submit" class="btn btn-primary" data-fk="submit">' + opts.submit + '</button>' +
        back(opts.back) + '</div>' + keypad() + '</form>';
    }

    function qtyScreen(state) {
      var line = lineById(state, state.ui.params.lineId);
      return dialog({ cls: 'wide', title: 'Change quantity',
        text: nameOf(line.sku) + ' · current quantity ' + line.qty + ' · enter 0 to remove',
        body: entryForm(state, { form: 'qty', label: 'New quantity', max: 3, submit: 'Update quantity', back: 'Cancel' }) });
    }

    function manualScreen(state) {
      return dialog({ cls: 'wide', title: 'Enter Produce PLU or Barcode',
        text: 'Type the number printed on the item or its sticker.',
        body: entryForm(state, { form: 'code', label: 'PLU or barcode number', max: 6, submit: 'Enter', back: '← Back' }) });
    }

    function decreaseScreen(state) {
      var line = lineById(state, state.ui.params.lineId);
      var to = state.ui.params.toQty;
      return dialog({ icon: WARN_ICON, title: 'Why are you lowering the quantity?', stack: true,
        text: nameOf(line.sku) + ': ' + line.qty + ' → ' + to,
        buttons: act('<b>Entered by mistake</b><small>I don’t have the extra ' + (line.qty - to > 1 ? 'items' : 'item') + '.</small>',
          'decrease.confirm', { reason: 'duplicate' }, { cls: 'btn btn-two' }) +
          act('<b>I don’t want ' + (line.qty - to > 1 ? 'them' : 'it') + '</b><small>I have the extra ' + (line.qty - to > 1 ? 'items' : 'item') + ' but won’t buy ' + (line.qty - to > 1 ? 'them' : 'it') + '.</small>',
            'decrease.confirm', { reason: 'unwanted' }, { cls: 'btn btn-two' }),
        footer: back('Cancel') });
    }

    function removalScreen(state) {
      var line = lineById(state, state.ui.params.lineId);
      var many = line.qty > 1;
      return dialog({ icon: WARN_ICON, title: 'Remove ' + nameOf(line.sku) + '?', stack: true,
        text: many ? 'This removes the entire line (all ' + line.qty + '). To remove just one, choose Cancel and use the − button. Why are you removing it?'
          : 'Why are you removing it?',
        buttons: act('<b>Entered by mistake (duplicate)</b><small>I am not holding an extra item for this entry.</small>',
          'remove.confirm', { reason: 'duplicate' }, { cls: 'btn btn-two' }) +
          act('<b>I don’t want this item</b><small>I have it and won’t buy it.</small>',
            'remove.confirm', { reason: 'unwanted' }, { cls: 'btn btn-two' }),
        footer: back('Cancel') });
    }

    function lookupScreen(state) {
      var itemMode = state.ui.params.mode === 'item';
      var tiles = catalog.skus.filter(function (sku) { return itemMode || catalog.get(sku).produce; }).map(function (sku) {
        var item = catalog.get(sku);
        var price = money(item.priceCents) + (item.unit === 'lb' ? '/lb' : ' each');
        var hit = item.name.toLowerCase().indexOf(view.search.toLowerCase()) >= 0;
        return '<li data-name="' + esc(item.name.toLowerCase()) + '"' + (hit ? '' : ' hidden') + '>' +
          act('<b>' + esc(item.name) + '</b><small>' + (item.plu ? 'PLU ' + item.plu + ' · ' : '') + price + '</small>',
            'lookup.select', { sku: sku }, { cls: 'tile' }) + '</li>';
      }).join('');
      return '<div class="lookup card"><div class="lookup-head"><h1 tabindex="-1" data-heading>' +
        (itemMode ? 'Look up item' : 'Look Up Produce') + '</h1>' +
        '<label>Search by name <input type="search" data-search data-fk="search" autocomplete="off" value="' + esc(view.search) + '"></label></div>' +
        '<ul class="tiles" data-scroll="tiles">' + tiles + '</ul><div class="lookup-foot">' + back('← Back') +
        act('Enter PLU or item number', 'lookup.manual', {}) +
        (!itemMode && !state.ui.params.issueId ? act('I can’t find it', 'lookup.report', {}) : '') + '</div></div>';
    }

    function weighScreen(state) {
      var item = catalog.get(state.ui.params.sku);
      if (!state.ui.params.placed) {
        return dialog({ icon: '<div class="big-icon" aria-hidden="true">⚖️</div>', title: 'Place ' + item.name + ' on the scale',
          text: money(item.priceCents) + ' per lb', footer: back('Cancel') });
      }
      var amount = Math.floor((item.simWeight * item.priceCents + 50) / 100);
      return dialog({ icon: '<div class="big-icon" aria-hidden="true">⚖️</div>', title: item.name, stack: true,
        text: pounds(item.simWeight) + ' × ' + money(item.priceCents) + '/lb', body: '<p class="amount">' + money(amount) + '</p>',
        buttons: act('Add to order', 'weigh.confirm', {}, { cls: 'btn btn-primary' }), footer: back('Cancel') });
    }

    function countScreen(state) {
      var item = catalog.get(state.ui.params.sku);
      var q = state.ui.params.qty;
      return dialog({ title: 'How many ' + item.name + '?', stack: true, text: money(item.priceCents) + ' each',
        body: '<div class="stepper big">' + act('−', 'count.step', { delta: -1 }, { cls: 'step', label: 'One fewer' }) +
          '<output aria-live="polite">' + q + '</output>' + act('+', 'count.step', { delta: 1 }, { cls: 'step', label: 'One more' }) + '</div>' +
          (state.ui.params.error ? '<p class="field-error" role="alert">▲ ' + fill(ENTRY_ERRORS[state.ui.params.error], { max: app.config.maxQuantity }) + '</p>' : ''),
        buttons: act('Add to order', 'count.confirm', {}, { cls: 'btn btn-primary' }), footer: back('Cancel') });
    }

    function welcomeScreen(state) {
      return '<div class="welcome">' + bannerHtml(state) + '<h1 tabindex="-1" data-heading>Welcome</h1>' +
        '<p>Touch Start, or scan your first item, to begin.</p><div class="welcome-actions">' +
        act('Start', 'kiosk.start', {}, { cls: 'btn btn-primary' }) +
        act('Scan membership / phone number', 'membership.open', {}) + '</div></div>';
    }

    function membershipScreen() {
      return dialog({ title: 'Scan membership / phone number', stack: true,
        text: 'Simulation only: no card or phone number is collected.',
        buttons: act('Use demo membership', 'membership.apply', {}, { cls: 'btn btn-primary' }), footer: back('← Back') });
    }

    function paymentScreen(state) {
      var totals = tx.totals(state, app.config);
      return '<div class="payment">' + bannerHtml(state) + '<div class="card due"><h1 tabindex="-1" data-heading>Amount due</h1><span>' +
        money(totals.totalCents) + '</span></div><div class="methods">' + tx.PAYMENT_METHODS.map(function (m) {
          return act('<span class="method-icon" aria-hidden="true">' + METHODS[m].icon + '</span><b>' + METHODS[m].label + '</b>',
            'pay.method', { method: m }, { cls: 'method' });
        }).join('') + '</div>' + act('← Back to Items', 'nav.back', {}, { cls: 'link' }) + '</div>';
    }

    function paymentCardScreen(state) {
      var m = METHODS[state.ui.params.method];
      return dialog({ cls: 'pay-card', stack: true,
        icon: '<div class="big-icon" aria-hidden="true">' + (m.cardIcon || m.icon) + '</div>', title: m.label,
        body: bannerHtml(state) + '<p class="amount">' + money(tx.totals(state, app.config).totalCents) + '</p><p class="dialog-text">' +
          (state.ui.params.method === 'cash' ? 'Insert cash into the cash acceptor.' : 'Insert, tap, or swipe your card on the card reader.') + '</p>',
        buttons: act('Choose another payment method', 'pay.other', {}) });
    }

    function processingScreen(state) {
      var cash = state.payment && state.payment.method === 'cash';
      return dialog({ icon: '<div class="spinner big" aria-hidden="true"></div>', title: 'Processing payment…',
        text: cash ? 'Please wait.' : 'Please do not remove your card.' });
    }

    function completeScreen(state) {
      var cash = state.receipt && state.receipt.method === 'cash';
      return dialog({ cls: 'wide', three: true, icon: '<div class="big-icon" aria-hidden="true">✅</div>', title: 'Thank you! Payment complete.',
        text: cash ? 'Please take your items.' : 'Please take your items and your card.',
        buttons: act('Print Receipt', 'receipt.choose', { option: 'print' }) + act('Email Receipt', 'receipt.choose', { option: 'email' }) +
          act('No Receipt / Done', 'receipt.done', {}, { cls: 'btn btn-primary' }) });
    }

    function receiptScreen(state) {
      var totals = state.receipt.totals;
      var rows = state.lines.map(function (l) {
        var item = catalog.get(l.sku);
        return '<tr><th scope="row">' + esc(item.name) + '</th><td>' + (item.unit === 'lb' ? pounds(l.weight) : '× ' + l.qty) +
          '</td><td>' + money(tx.lineAmount(l)) + '</td></tr>';
      }).join('');
      return '<div class="center"><div class="card receipt"><h1 tabindex="-1" data-heading>Simulated receipt</h1>' +
        '<p>' + (state.ui.params.option === 'email' ? 'Simulation: no email address is collected and nothing is sent.'
          : 'Simulation: nothing is printed.') + ' No real payment was made.</p>' +
        '<div class="receipt-body" data-scroll="receipt" tabindex="0" role="region" aria-label="Receipt"><table><tbody>' + rows + '</tbody><tfoot>' +
        '<tr><th scope="row" colspan="2">Subtotal</th><td>' + money(totals.subtotalCents) + '</td></tr>' +
        '<tr><th scope="row" colspan="2">Tax</th><td>' + money(totals.taxCents) + '</td></tr>' +
        '<tr class="grand"><th scope="row" colspan="2">Paid: ' + METHODS[state.receipt.method].label + '</th><td>' + money(totals.totalCents) + '</td></tr>' +
        '</tfoot></table></div>' + act('Done', 'receipt.done', {}, { cls: 'btn btn-primary' }) + '</div></div>';
    }

    var SCREENS = {
      welcome: welcomeScreen, membership: membershipScreen, checkout: checkoutScreen, help: helpScreen,
      assistance: assistanceScreen, qty_editor: qtyScreen, manual_entry: manualScreen,
      decrease_reason: decreaseScreen, removal_confirm: removalScreen, lookup: lookupScreen, weigh: weighScreen,
      count: countScreen, payment_method: paymentScreen, payment_card: paymentCardScreen,
      processing: processingScreen, payment_complete: completeScreen, receipt: receiptScreen
    };

    function kiosk(state) {
      var screen = state.ui.screen;
      var count = tx.totals(state, app.config).itemCount;
      var footer = '';
      var waiting = state.assists.filter(function (a) { return a.status === 'requested'; })[0];
      var assist = waiting
        ? act(assistLabel('Help is on the way'), 'issue.open', { issueId: waiting.issueId }, { cls: 'btn btn-assist active', key: 'footer-assist' })
        : act(assistLabel(), 'assist.request', {}, { cls: 'btn btn-assist', key: 'footer-assist' });
      if (['welcome', 'checkout', 'membership', 'payment_method', 'payment_card', 'assistance'].indexOf(screen) >= 0) {
        footer = act('<span aria-hidden="true">❓</span> Help', 'help.open', {}, { cls: 'btn btn-help', key: 'footer-help' }) + assist;
      } else if (screen === 'payment_complete') footer = assist;
      /* Banners are shown inside checkout, welcome and payment screens. */
      return '<section class="kiosk" aria-label="Self checkout kiosk">' +
        '<header class="k-head"><span class="logo" aria-hidden="true">▦</span><span class="brand">Self Checkout</span>' +
        (state.membership ? '<span class="member">Demo member</span>' : '') +
        (count && screen !== 'welcome' ? '<span class="count">Items: ' + count + '</span>' : '') + '</header>' +
        '<div class="k-body screen-' + screen + '">' + SCREENS[screen](state) + '</div>' +
        '<footer class="k-foot">' + footer + '</footer></section>';
    }

    function dock(state) {
      var screen = state.ui.screen;
      var steps = state.requests.filter(function (r) {
        return r.physical && (r.phase === 'awaiting_physical' || r.phase === 'failed');
      }).map(function (r) {
        var text = physicalText(r).button;
        return act((r.phase === 'failed' ? 'Try again: ' : '') + esc(text), 'physical.confirm', { requestId: r.requestId },
          { cls: 'sim-btn sim-next' });
      });
      if (screen === 'weigh' && !state.ui.params.placed) {
        steps.unshift(act('Place ' + esc(nameOf(state.ui.params.sku)) + ' on the scale', 'scale.place', {}, { cls: 'sim-btn sim-next' }));
      }
      if (screen === 'payment_card') {
        steps.unshift(act(state.ui.params.method === 'cash' ? 'Insert simulated cash' : 'Tap simulated card', 'pay.tender', {},
          { cls: 'sim-btn sim-next' }));
      }
      var practice = state.session.mode === 'practice';
      var basket = practice ? app.config.practiceBasket
        : app.config.tasks[state.tasks.order[state.tasks.index]].basket;
      var scannable = [];
      var produce = [];
      basket.forEach(function (id) {
        var item = catalog.physical(id);
        if (item.produce) {
          produce.push('<li>' + esc(item.name) + ' <span>sticker PLU ' + item.plu + '</span></li>');
        } else {
          var note = practice && app.config.practiceUnreadable[id] ? ' · damaged label' : (practice && item.restricted ? ' · age-restricted' : '');
          scannable.push('<li>' + act('<b>Scan ' + esc(item.name) + '</b><small>barcode ' + item.barcode + note + '</small>',
            'scan.item', { simItemId: id }, { cls: 'sim-btn' }) + '</li>');
        }
      });
      var scanning = screen !== 'processing' && screen !== 'payment_complete' && screen !== 'receipt';
      var next = steps.length ? '<div class="sim-list">' + steps.join('') + '</div>'
        : (touring(app.getState()) ? '<div class="sim-btn sim-next sim-example"><small>Example</small>Place the item in the bagging area</div>'
          : '<p class="dock-empty">Nothing to move right now.</p>');
      return '<aside class="dock" aria-label="Simulation panel" data-scroll="dock">' +
        '<h2>Simulation panel</h2><p class="dock-note">Not part of the kiosk. These stand in for your hands, the scanner and the bagging area.</p>' +
        '<div data-tour="next"><h3>Next physical step</h3>' + next + '</div>' +
        (scanning ? '<div data-tour="basket">' +
          (scannable.length ? '<h3>Your basket</h3><ul class="sim-list">' + scannable.join('') + '</ul>' : '') +
          (produce.length ? '<h3>Loose produce (no barcode)</h3><ul class="produce-list">' + produce.join('') + '</ul>' : '') + '</div>' : '') +
        (practice && scanning ? '<h3>Practice events</h3><div class="sim-list">' +
          act('Put an unscanned item in the bagging area', 'sim.unexpected_item', {}, { cls: 'sim-btn' }) +
          act('Make the next bagging check fail', 'sim.fail_verification', {}, { cls: 'sim-btn' }) + '</div>' : '') +
        '</aside>';
    }

    /* ---------- pages ---------- */

    function warningHtml() {
      var problem = app.storageProblem();
      if (!problem) return '';
      return '<div class="warning" role="status">▲ ' + (problem === 'conflict'
        ? 'Another tab is using this browser’s saved session. This tab is not saving, so refreshing may lose its data.'
        : 'Progress can’t be saved in this browser. Refreshing or closing the page may lose your data.') + '</div>';
    }

    function introPage() {
      var saved = app.savedSession();
      var start = saved
        ? '<div class="saved"><h2>A saved session was found</h2><p>It is an unfinished ' + esc(saved.mode || '') + ' session stored in this browser.</p>' +
          '<div class="row">' + local('Resume session', 'resume', { cls: 'btn btn-primary' }) +
          local('End it and export', 'resume-end') + local('Discard saved session', 'ask-delete') + '</div></div>'
        : '<fieldset><legend>Choose a mode</legend>' +
          ['study', 'practice'].map(function (mode) {
            return '<label class="choice"><input type="radio" name="mode" value="' + mode + '" data-fk="mode-' + mode + '"' +
              (view.mode === mode ? ' checked' : '') + '><span><b>' + (mode === 'study' ? 'Study tasks' : 'Practice (free exploration)') +
              '</b><small>' + (mode === 'study' ? app.config.taskOrder.length + ' short shopping tasks.' : 'Try the kiosk without tasks.') + '</small></span></label>';
          }).join('') + '</fieldset>' + local('Start', 'start', { cls: 'btn btn-primary btn-wide' });
      return '<main class="page">' + warningHtml() + '<div class="card sheet"><h1 tabindex="-1" data-heading>Self Checkout prototype study</h1>' +
        '<p>This is a simulation. Nothing is bought, and you will never be asked for card, membership or personal details.</p>' +
        '<h2>Before you start</h2><ul>' +
        '<li><b>Recorded:</b> the actions you take in this prototype (such as scanning or removing an item), screen changes, timings, task results, and whether this tab is hidden. It is saved under a random session ID.</li>' +
        '<li><b>Not recorded:</b> your name or identity, typed text or numbers, mouse movement, screen or audio, or anything outside this page.</li>' +
        '<li><b>Storage:</b> data stays in this browser so you can resume after a refresh. It remains until you delete it.</li>' +
        '<li><b>Sharing:</b> nothing is sent automatically. At the end you decide whether to copy or download the session file and submit it with the survey.</li>' +
        '<li><b>Voluntary:</b> you can stop at any time with End session, and you can delete the data.</li></ul>' +
        '<p class="muted">This notice does not replace the research team’s consent process. Nothing is recorded until you choose Start.</p>' +
        start + '</div></main>';
    }

    function resultsPage(state) {
      var data = app.getExport();
      var done = state.session.status === 'completed';
      var url = app.config.surveyUrl;
      return '<main class="page">' + warningHtml() + '<div class="card sheet"><h1 tabindex="-1" data-heading>Session ended</h1>' +
        '<dl class="meta"><div><dt>Session ID</dt><dd id="session-id">' + esc(data.sessionId) + '</dd></div>' +
        '<div><dt>Status</dt><dd id="session-status">' + (done ? '✓ Completed' : '● Incomplete (ended early)') + '</dd></div></dl>' +
        '<ol><li>Copy the session JSON into the designated survey field, or upload the downloaded file if the survey accepts attachments.</li>' +
        '<li>Then answer the survey questions.</li></ol>' +
        '<p class="muted">Nothing has been sent. This page cannot tell whether the survey received your data.</p>' +
        '<div class="row">' + local('Copy session JSON', 'copy', { cls: 'btn btn-primary' }) + local('Download JSON', 'download') +
        (url && /^https?:\/\//.test(url) ? '<a class="btn" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open survey</a>' : '') + '</div>' +
        '<p id="copy-status" class="copy-status" role="status">' + esc(view.copyMessage) + '</p>' +
        '<label for="json">Session JSON (' + data.compact.length.toLocaleString('en-US') + ' characters). Select all to copy by hand.</label>' +
        '<textarea id="json" data-fk="json" readonly spellcheck="false">' + esc(data.compact) + '</textarea>' +
        '<p class="muted">The data stays in this browser until you delete it. Copying or downloading does not delete it.</p>' +
        local('Delete local session / Start new session', 'ask-delete') + '</div></main>';
    }

    function studyBar(state) {
      var info;
      var buttons = '';
      if (state.session.mode === 'practice') {
        info = '<b>Practice mode</b><span>Explore freely. Use End session when you are done.</span>';
      } else {
        var n = state.tasks.index + 1;
        var def = app.config.tasks[state.tasks.order[state.tasks.index]];
        if (state.tasks.activeId) {
          info = '<b>Task ' + n + ' of ' + state.tasks.order.length + '</b><span>' + esc(def.goal) + '</span>';
          buttons = act('I’ve finished this task', 'task.done', {}, { cls: 'btn btn-dark' }) +
            local('I can’t complete it', 'ask-abandon');
        } else if (state.ui.screen === 'task_ready') {
          info = '<b>Study tasks</b>';
        } else {
          info = '<b>Task ' + n + ' finished</b><span>Choose a receipt option on the kiosk to continue.</span>';
        }
      }
      return '<header class="studybar"><div class="task" aria-live="polite">' + info + '</div><div class="bar-actions">' + buttons +
        local('End session', 'ask-end') + '</div></header>';
    }

    function sessionPage(state) {
      var stage;
      /* In study mode the tips need the kiosk and panel on screen before the
       * first task card, so draw an idle preview without changing state. */
      var shown = state;
      if (touring(state) && state.ui.screen === 'task_ready') {
        shown = Object.assign({}, state, { ui: Object.assign({}, state.ui, { screen: 'welcome', params: {}, banner: null }) });
      }
      if (shown.ui.screen === 'task_ready') {
        var n = state.tasks.index + 1;
        var def = app.config.tasks[state.tasks.order[state.tasks.index]];
        stage = '<div class="center ready"><div class="card sheet"><h1 tabindex="-1" data-heading>Task ' + n + ' of ' + state.tasks.order.length + '</h1>' +
          '<p class="goal">' + esc(def.goal) + '</p><p class="muted">' +
          (def.resetBefore ? 'A new order will be set up for this task.' : 'Your current order carries over to this task.') + '</p>' +
          act('Start task', 'task.start', {}, { cls: 'btn btn-primary btn-wide' }) + '</div></div>';
      } else stage = '<div class="stage">' + kiosk(shown) + dock(shown) + '</div>';
      return studyBar(state) + warningHtml() + '<main class="main">' + stage + '</main>';
    }

    function confirmHtml() {
      var c = {
        end: ['End the session?', 'Recording stops and you will see your session data. You can’t continue this session afterwards.', 'End session'],
        abandon: ['Stop this task?', 'It will be marked as not completed and you will move on.', 'Move on'],
        delete: ['Delete this session?', 'The session data stored in this browser will be permanently deleted. Copy or download it first if you want to keep it.', 'Delete']
      }[view.confirm];
      return '<div class="overlay"><div class="card confirm" role="alertdialog" aria-modal="true" aria-labelledby="c-title" aria-describedby="c-text">' +
        '<h2 id="c-title">' + c[0] + '</h2><p id="c-text">' + c[1] + '</p><div class="row">' +
        local('Keep going', 'confirm-no', { cls: 'btn' }) + local(c[2], 'confirm-yes', { cls: 'btn btn-primary' }) + '</div></div></div>';
    }

    /* ---------- first-run tips ---------- */

    function tourHtml() {
      var step = TOUR[view.tourStep];
      var last = view.tourStep === TOUR.length - 1;
      return '<div class="tour"><div class="tour-spot" aria-hidden="true"></div>' +
        '<div class="card tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text">' +
        '<span class="tour-arrow" aria-hidden="true"></span>' +
        '<p class="tour-count">Tip ' + (view.tourStep + 1) + ' of ' + TOUR.length + '</p>' +
        '<h2 id="tour-title">' + esc(step.title) + '</h2><p id="tour-text">' + esc(step.text) + '</p>' +
        '<div class="tour-actions">' + (last ? '' : local('Skip tips', 'tour-skip', { cls: 'link' })) +
        '<span class="tour-gap"></span>' + (view.tourStep ? local('Back', 'tour-back') : '') +
        local(last ? 'Got it' : 'Next', 'tour-next', { cls: 'btn btn-primary' }) + '</div></div></div>';
    }

    /* Spotlight the current target and put the tip beside it without covering it. */
    function placeTour(scroll) {
      var card = root.querySelector('.tour-card');
      if (!card) return;
      var spot = root.querySelector('.tour-spot');
      var target = root.querySelector(TOUR[view.tourStep].target);
      var vw = document.documentElement.clientWidth;
      var vh = document.documentElement.clientHeight;
      var w = card.offsetWidth;
      var h = card.offsetHeight;
      var pad = 6;
      var gap = 16;
      var edge = 8;
      function clamp(n, low, high) { return Math.max(low, Math.min(n, high)); }
      if (scroll) target.scrollIntoView({ block: target.offsetHeight > vh - h - 40 ? 'start' : 'nearest' });
      var r = target.getBoundingClientRect();
      var d = target.closest('.dock').getBoundingClientRect();
      var box = {
        left: Math.max(2, Math.max(r.left, d.left) - pad), top: Math.max(2, Math.max(r.top, d.top) - pad),
        right: Math.min(vw - 2, Math.min(r.right, d.right) + pad), bottom: Math.min(vh - 2, Math.min(r.bottom, d.bottom) + pad)
      };
      var side, x, y;
      if (box.left - gap - w >= edge) {
        side = 'left'; x = box.left - gap - w; y = clamp(box.top, edge, vh - h - edge);
      } else {
        x = clamp(box.left, edge, vw - w - edge);
        if (box.bottom + gap + h <= vh - edge) { side = 'below'; y = box.bottom + gap; }
        else if (box.top - gap - h >= edge) { side = 'above'; y = box.top - gap - h; }
        else { side = 'over'; y = vh - h - edge; box.bottom = Math.min(box.bottom, y - gap); }
      }
      spot.style.left = box.left + 'px';
      spot.style.top = box.top + 'px';
      spot.style.width = Math.max(0, box.right - box.left) + 'px';
      spot.style.height = Math.max(0, box.bottom - box.top) + 'px';
      card.style.left = x + 'px';
      card.style.top = y + 'px';
      card.setAttribute('data-side', side);
      var arrow = side === 'left' ? clamp((box.top + Math.min(box.bottom, y + h)) / 2 - y, 20, h - 20)
        : clamp((box.left + box.right) / 2 - x, 20, w - 20);
      card.style.setProperty('--arrow', arrow + 'px');
    }

    function showTip(index) {
      view.tourStep = index;
      view.tourSeen = Math.max(view.tourSeen, index + 1);
      view.lastScreenChange = Date.now();
      render();
    }

    function finishTour(result) {
      var seen = view.tourSeen;
      view.tourStep = 0;
      view.tourSeen = 1;
      var panel = root.querySelector('.dock');
      if (panel) panel.scrollTop = 0;
      window.scrollTo(0, 0);
      app.dispatch('tour.finish', { result: result, stepsViewed: seen });
    }

    /* ---------- render ---------- */

    function render() {
      var state = app.getState();
      var screen = state.ui.screen;
      var params = state.ui.params || {};
      var tips = touring(state);
      var screenKey = [screen, params.issueId, params.lineId, params.mode, params.sku, params.context, state.tasks.index, tips].join('|');
      var changed = screenKey !== view.screenKey;
      if (changed) {
        view.screenKey = screenKey;
        view.lastScreenChange = Date.now();
        view.entry = '';
        view.search = '';
        view.searchLogged = false;
      }

      var active = document.activeElement;
      var focusKey = active && root.contains(active) ? active.getAttribute('data-fk') : null;
      var focusArea = active && active.closest ? (active.closest('.dock') ? 'dock' : (active.closest('.kiosk') ? 'kiosk' : null)) : null;
      var scrolls = {};
      root.querySelectorAll('[data-scroll]').forEach(function (el) { scrolls[el.getAttribute('data-scroll')] = el.scrollTop; });

      var page = screen === 'intro' ? introPage() : (screen === 'results' ? resultsPage(state) : sessionPage(state));
      root.innerHTML = '<div class="app"' + (view.confirm || tips ? ' inert' : '') + '>' + page + '</div>' +
        (view.confirm ? confirmHtml() : (tips ? tourHtml() : ''));

      root.querySelectorAll('[data-scroll]').forEach(function (el) {
        var key = el.getAttribute('data-scroll');
        if (scrolls[key] !== undefined) el.scrollTop = scrolls[key];
      });
      /* Bring a newly added or changed row into view, once. */
      var line = state.lines.filter(function (l) { return l.lineId === state.lastLineId; })[0];
      var sig = line ? line.lineId + ':' + line.qty : '';
      var list = root.querySelector('.list');
      if (list && sig && sig !== view.lastLineSig) {
        var row = list.querySelector('[data-line="' + state.lastLineId + '"]');
        if (row) {
          var bottom = row.offsetTop + row.offsetHeight;
          if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
          else if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 40;
        }
        view.lastLineSig = sig;
      }

      placeTour(true);
      restoreFocus(changed, focusKey, focusArea);
      announce(state);
    }

    function findKey(key, scope) {
      var all = (scope || root).querySelectorAll('[data-fk]');
      for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-fk') === key) return all[i];
      return null;
    }

    function restoreFocus(changed, key, area) {
      if (view.confirm) { var no = findKey('confirm-no'); if (no) no.focus(); return; }
      var target = null;
      if (root.querySelector('.tour')) {
        target = (key && key.indexOf('tour-') === 0 && findKey(key)) || findKey('tour-next');
      } else if (area === 'dock') {
        target = (key && findKey(key)) || root.querySelector('.dock .sim-next') || root.querySelector('.dock button');
      } else if (changed) {
        target = root.querySelector('#entry') || root.querySelector('[data-heading]') ||
          root.querySelector('.kiosk button');
      } else if (key) {
        target = findKey(key) || (area === 'kiosk' ? root.querySelector('.kiosk [data-heading], .kiosk button') : null);
      }
      if (target) {
        target.focus({ preventScroll: true });
        /* A background update must not move the caret while someone types. */
        if (target.tagName === 'INPUT' && target.setSelectionRange && target.type !== 'radio') {
          target.setSelectionRange(target.value.length, target.value.length);
        }
      }
    }

    function announce(state) {
      var parts = [];
      var b = state.ui.banner;
      if (b && MESSAGES[b.code]) parts.push(fill(MESSAGES[b.code], { name: b.sku ? nameOf(b.sku) : '', qty: b.qty }));
      var title = root.querySelector('.prompt-title');
      if (title) parts.push(title.textContent);
      if (touring(state)) parts = [TOUR[view.tourStep].title, TOUR[view.tourStep].text];
      var text = parts.join('. ');
      if (text !== view.lastAnnounced) { live.textContent = text; view.lastAnnounced = text; }
    }

    /* ---------- export helpers ---------- */

    function setCopyMessage(text) {
      view.copyMessage = text;
      var el = document.getElementById('copy-status');
      if (el) el.textContent = text;
    }

    function copyJson() {
      var data = app.getExport();
      if (!data) return;
      function manual() {
        var box = document.getElementById('json');
        box.focus();
        box.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
        setCopyMessage(ok ? '✓ Copied to the clipboard.'
          : '▲ Copying did not work. The text below is selected: press Ctrl+C (⌘C on Mac), or use your device’s Copy command.');
      }
      setCopyMessage('');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(data.compact).then(function () { setCopyMessage('✓ Copied to the clipboard.'); }, manual);
      } else manual();
    }

    function download() {
      var data = app.getExport();
      if (!data) return;
      var url = URL.createObjectURL(new Blob([data.pretty], { type: 'application/json' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    /* ---------- input ---------- */

    function closeConfirm() { view.confirm = null; render(); }

    function runLocal(command, value) {
      switch (command) {
        case 'start':
          view.tourStep = 0;
          view.tourSeen = 1;
          app.dispatch('session.start', { mode: view.mode });
          break;
        case 'tour-next':
          if (view.tourStep < TOUR.length - 1) showTip(view.tourStep + 1);
          else finishTour('completed');
          break;
        case 'tour-back': showTip(Math.max(0, view.tourStep - 1)); break;
        case 'tour-skip': finishTour('skipped'); break;
        case 'resume': app.resume(); break;
        case 'resume-end': app.resume(); app.dispatch('session.end', {}); break;
        case 'ask-end': view.confirm = 'end'; render(); break;
        case 'ask-abandon': view.confirm = 'abandon'; render(); break;
        case 'ask-delete': view.confirm = 'delete'; render(); break;
        case 'confirm-no': closeConfirm(); break;
        case 'confirm-yes': {
          var what = view.confirm;
          view.confirm = null;
          view.copyMessage = '';
          if (what === 'end') app.dispatch('session.end', {});
          else if (what === 'abandon') app.dispatch('task.abandon', {});
          else app.reset();
          break;
        }
        case 'goto-attention': {
          app.dispatch('attention.focus', {});
          var first = root.querySelector('.attention .btn-resolve');
          if (first) { first.scrollIntoView({ block: 'nearest' }); first.focus(); }
          break;
        }
        case 'key': {
          var input = document.getElementById('entry');
          if (!input) return;
          if (value === 'clear') view.entry = '';
          else if (value === 'del') view.entry = view.entry.slice(0, -1);
          else if (view.entry.length < input.maxLength) view.entry += value;
          input.value = view.entry;
          break;
        }
        case 'copy': copyJson(); break;
        case 'download': download(); break;
      }
    }

    root.addEventListener('click', function (event) {
      var button = event.target.closest('[data-action], [data-ui]');
      if (!button || !root.contains(button)) return;
      /* The second tap of a double tap must not hit whatever appeared underneath. */
      if (event.detail > 1 && Date.now() - view.lastScreenChange < 500) return;
      if (button.hasAttribute('data-action')) {
        /* aria-disabled buttons still dispatch so blocked attempts are explained and logged. */
        app.dispatch(button.getAttribute('data-action'), JSON.parse(button.getAttribute('data-params')));
      } else runLocal(button.getAttribute('data-ui'), button.getAttribute('data-value'));
    });

    root.addEventListener('submit', function (event) {
      event.preventDefault();
      var kind = event.target.getAttribute('data-form');
      var state = app.getState();
      if (kind === 'qty') app.dispatch('qty.submit', { lineId: state.ui.params.lineId, value: view.entry });
      else if (kind === 'code') app.dispatch('manual.submit', { code: view.entry });
    });

    root.addEventListener('input', function (event) {
      var el = event.target;
      if (el.id === 'entry') view.entry = el.value;
      else if (el.hasAttribute('data-search')) {
        view.search = el.value;
        var q = view.search.toLowerCase();
        root.querySelectorAll('.tiles li').forEach(function (li) { li.hidden = li.getAttribute('data-name').indexOf(q) < 0; });
        /* Log that search was used, never what was typed. */
        if (!view.searchLogged) { view.searchLogged = true; app.dispatch('lookup.search', {}); }
      }
    });

    root.addEventListener('change', function (event) {
      if (event.target.name === 'mode') view.mode = event.target.value;
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (view.confirm) { closeConfirm(); return; }
      if (touring(app.getState())) { finishTour('skipped'); return; }
      var screen = app.getState().ui.screen;
      if (['help', 'qty_editor', 'manual_entry', 'decrease_reason', 'removal_confirm', 'lookup', 'weigh', 'count', 'membership'].indexOf(screen) >= 0) {
        app.dispatch('nav.back', {});
      }
    });

    window.addEventListener('resize', function () { placeTour(true); });
    window.addEventListener('scroll', function () { placeTour(false); }, true);

    app.subscribe(render);
    render();
    return { render: render, setMode: function (mode) { view.mode = mode; render(); } };
  }

  SCO.createUI = createUI;
})(window.SCO = window.SCO || {});
