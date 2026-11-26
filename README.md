# Self-Checkout Prototype

An interactive, browser-based self-checkout simulation for a CS6750 HCI evaluation. It covers quantity editing, selective removal, Contextual Help, persistent unresolved issues, six study tasks, and a JSON behavior log that the participant submits with a separate survey.

Everything is simulated. There is no real scanner, scale, payment, employee or retailer system, and a simulated "verification" says nothing about physical item identity or loss-prevention effectiveness. The prototype has not been shown to improve usability; that is what the evaluation is for.

## Contents

- [Launch](#launch)
- [Before you publish it](#before-you-publish-it)
- [Using the prototype](#using-the-prototype)
- [Screenshot mapping](#screenshot-mapping)
- [Assumptions, conflicts and missing screens](#assumptions-conflicts-and-missing-screens)
- [Scenario configuration](#scenario-configuration)
- [Event dictionary](#event-dictionary)
- [Export format and sample](#export-format-and-sample)
- [Survey integration](#survey-integration)
- [Privacy and persistence](#privacy-and-persistence)
- [Architecture](#architecture)
- [Tests](#tests)
- [Manual test checklist](#manual-test-checklist)
- [Known limitations](#known-limitations)
- [Researcher decisions still open](#researcher-decisions-still-open)

## Launch

| Way | Steps |
|---|---|
| Open locally | Double-click `index.html`. |
| Single file | Open `dist/self-checkout-standalone.html`. It has all CSS and JavaScript inside it. |
| Local server (optional) | `python -m http.server 8000`, then visit `http://localhost:8000/`. |

No build step, backend, dependency or network connection is needed to run it. Scripts are classic `<script>` files (not ES modules), so `file://` works.

After editing anything in `css/`, `js/` or `index.html`, refresh the single file:

```
python tools/build_standalone.py
```

URL options for the researcher:

| Option | Effect |
|---|---|
| `?mode=practice` | Preselects practice mode on the notice page. |
| `?order=T2,T1,T3,T5,T4,T6` | Sets the study task order (counterbalancing). Ignored if any ID is unknown or repeated. |

## Before you publish it

**Do not publish this whole folder.** `project.tex`, `Self_Checkout_HCI_Project.pdf`, `implementation.md` and `images/` are research material; the report sources contain team names, email addresses and raw interview responses.

For GitHub Pages, use one of these in a separate publishing repository or branch:

- copy `dist/self-checkout-standalone.html` and rename it `index.html`; or
- copy only `index.html`, `css/`, `js/` and `.nojekyll`.

## Using the prototype

1. The notice page explains what is recorded. Nothing is recorded or stored until **Start**.
2. **First-run tips** appear after Start: three spotlight tooltips that point out the Simulation panel, the basket scan buttons and the yellow next-step button. Next, Back, Skip tips and Esc work. They are shown once per session (each new participant sees them), return after a reload only if unfinished, and end before the first task, so no task time includes them. They deliberately do not mention kiosk features under study, such as Help or Needs attention.
3. **Study tasks** runs the tasks in order. Each task shows its goal, then **I've finished this task** or **I can't complete it**. A task also ends by itself when payment completes.
4. **Practice** is free exploration with extra simulated events.
5. The dashed **Simulation panel** is not part of the kiosk. It stands in for the participant's hands, the scanner, the scale, the bagging and return areas, and the card reader. The highlighted yellow button is the next physical step. On wide screens that section stays pinned at the top while the panel scrolls, and the kiosk says when to use it.
6. **End session** (always visible) freezes the log and opens the results page. **Copy session JSON** gives a compressed form for pasting; **Download JSON** gives the full readable file.

There is no employee-approval button anywhere. An associate "arrives" a fixed 3 seconds after an assistance request.

### Interaction rules worth knowing

| Situation | Behavior |
|---|---|
| Scan a count-priced item | Added to one row per product; Pay and further scans wait for the bagging step. |
| Raise a quantity (+ or typed) | Charged quantity stays the same until the extra items are bagged and checked. |
| Lower a quantity | Asks "mistake" or "don't want it". A mistake needs no physical step; unwanted needs a move to the return area. |
| Trash | Removes the whole line after the same question. Weighed items can only be removed, not count-edited. |
| Pending change | Blocks scanning until completed, canceled or set aside. |
| Cancel after moving items | Requires the items to be moved back and checked before the issue clears. |
| Unreadable or unknown barcode | Creates an unidentified, unpriced issue under Needs attention. |
| Restricted item | Not charged until simulated approval; scanning may continue. |
| Unexpected item in bagging area, general assistance | Not deferrable: new items are blocked until cleared. |
| **Scan again** on an unexpected item | The kiosk and panel ask for a scan. Identifying an item by scan, produce lookup, code or associate clears the problem. |
| Pay | Unavailable while any item awaits bagging or any issue is unresolved; the reason and a link to Needs attention are shown. |

Limits: quantity 1–12 per row (0 means remove).

## Screenshot mapping

Layouts, wording and colors were taken from `images/`. Colors were sampled from the files.

| Reference | Screen | State ID | Changes |
|---|---|---|---|
| `Page-1.png` | Welcome | `welcome` | Help button added to footer. |
| `Page-2.png` | Empty order | `checkout` | None beyond the footer. |
| `Page-3.png` | Place item in bagging area | `checkout` (item awaiting bagging) | Row controls, reason under Pay. |
| `Page-4.png` | Scan next item | `checkout` | Row controls. |
| `Page-5.png` | Long, scrolling order | `checkout` | Identical items share one row. |
| `Error-1.png` | Unexpected item in bagging area | `help` (`bagging_mismatch`) | Back link. Shown in practice mode only. |
| `Error-2.png` | Possible double scan | `help` (`possible_duplicate`) | "Decide later" and Back. Used by task T2. |
| `Error-3.png` | Scan while awaiting bagging | `checkout` + error banner | Same message text. |
| `Error-4.png` | Item cannot be scanned | `help` (`unreadable_barcode`) | "Set aside", "I'm not buying this item", Back. |
| `Error-5.png` | Barcode not identified | `help` (`unknown_product`) | Same additions. |
| `Assistance.png` | Help is on the way | `assistance` | Text and buttons differ for deferrable issues. |
| `Payment.png` | Payment methods | `payment_method` | None. |
| `CreditCard.png`, `DebitCard.png`, `GiftCard.png`, `MobilePay.png`, `EBT.png` | Card instructions | `payment_card` | Card is "tapped" from the simulation panel. |
| `Cash.png` | Cash instructions | `payment_card` | Cash is "inserted" from the panel. |
| `Processing.png` | Processing | `processing` | Cash shows "Please wait." |
| `PaymentComplete.png` | Payment complete | `payment_complete` | Cash omits "and your card". |

## Assumptions, conflicts and missing screens

### Conflicts and how they were resolved

| Conflict | Resolution |
|---|---|
| `Page-5` and `Error-3` list identical items on separate rows; the specification requires aggregation. | One row per count-priced product. |
| `Assistance.png` says checkout is paused; the specification and the Continue Checkout concept allow continuing. | "Paused" wording only for non-deferrable issues. Otherwise the screen offers Continue scanning. |
| Reference error screens have no way back or to set a problem aside. | Added both. Leaving a screen never resolves its issue. |
| Specification lists only retry and assistance for an unknown product; `Error-5` also has Look up item. | Kept the existing Look up item. |
| Report figures show "Remove Last Item" and "Call for Assistance"; the screenshots show "Employee Assistance". | Screenshot wording used. Per-row trash replaces Remove Last Item. |
| The report's design note suggests tapping a row to reveal the trash icon; the specification requires an icon on each row. | Icon on every row. |
| Report term "Guided Error Recovery". | Replaced by "Help" / Contextual Help. |
| Gift card, Mobile Pay and EBT use different icons on the method list and the instruction screen. | Preserved as shown. |
| Disabled Pay text in the references has low contrast. | Darkened. |
| Specification asks for compact JSON when copying; full sessions are too large for many text fields. | Copy and the text box give gzip + base64 inside a small JSON wrapper (team decision). Download is unchanged. |

### Screens with no reference (newly designed)

Study notice, first-run tips, task card, results page, resume/discard prompt, simulation panel, quantity editor, "why lower the quantity", removal confirmation, Needs attention section, pending-change prompts, general Help, wrong-quantity and unwanted-item help, produce lookup, item lookup, code entry, scale, count picker, restricted-item approval, placement mismatch, membership, simulated receipt.

Please review these with the team: they are design proposals, not existing functionality.

### Assumptions

- Tax is 6% of the subtotal, rounded half up (matches every reference total).
- Prices for eggs, milk, bread, juice and cereal come from the references and report figures. All other products, barcodes and weights are invented. Bananas weigh 2.10 lb at $0.59/lb to give the referenced $1.24.
- Membership applies no discount and collects nothing.
- Weights are fixed per product.
- A repeated scan never triggers the double-scan prompt. Only a scenario-injected double read does, so intentional repeat scanning is not interrupted.
- A single bagging check (1 s) covers each physical step.
- No baseline condition was built. `condition` is a label in the export.

## Scenario configuration

All settings are in [js/config.js](js/config.js).

| Setting | Default | Meaning |
|---|---|---|
| `delays.verificationMs` | 1000 | Bagging/return/order check. |
| `delays.assistanceMs` | 3000 | Associate response. |
| `delays.paymentMs` | 2500 | Payment processing. |
| `verification.approvalForDuplicateCorrection` | false | Require associate approval for mistake corrections. |
| `verification.approvalForUnwantedRemoval` | false | Require approval after returning an unwanted item. |
| `maxQuantity` | 12 | Row limit. |
| `issuePolicy` | see file | `deferrable` and `blocking` per issue type. |
| `taskOrder` | T1–T6 | Study order. |
| `surveyUrl` | empty | Adds an "Open survey" link (http/https only). |
| `condition` | `redesign` | Export label. |

Per task: `goal`, `resetBefore`, `start`, `seed`, `basket`, `duplicateRead`, `duplicatePresentation` (`prompt` or `needs_attention`), `unreadable` (failures before a read; `-1` never), `failVerifications` (number of checks that fail first, default 0), `assistedSku`, `intended`.

### Study tasks (proposed defaults, not validated)

Every task starts with a fresh order (`resetBefore: true`). The task card says so and a `transaction_reset` event records it.

| ID | Participant sees | Setup | Success (checked from state, any path) |
|---|---|---|---|
| T1 | Buy three cans of Tomato Soup; add all three. | Empty order. | Soup quantity 3, verified, no open soup issue. |
| T2 | You have one carton of eggs and one loaf of bread; make the order match. | Bread, eggs, then an injected double read of eggs. | Eggs quantity 1, verified, duplicate issue cleared. |
| T3 | You no longer want the Whole Milk; make sure you are not charged. | Milk is the oldest of five rows. | No milk line; nothing pending for milk. |
| T4 | Add the box of Cereal. | Cereal barcode never reads. | Cereal quantity 1, verified, unreadable issue cleared (code, lookup or associate). |
| T5 | Add the Gala Apples. | Eggs on the order. | Exactly one weighed Gala Apples line, verified. |
| T6 | Buy Paper Towels and Orange Juice; towels first; if they cause a problem, add the juice before sorting it out; then pay. | Towel barcode never reads. | Juice added, every towel problem resolved as Paper Towels, one towel line, checkout complete. Resolving it as another item fails `original_issue_resolved`, even if corrected later. |

Outcomes: `success`; `partial` (some progress criterion met); `failure`; `abandoned`; `unfinished` (session ended mid-task; duration is null); `not_started`.

A **participant error** is recorded only when an observable action contradicts a task's `intended` quantities (`item_not_in_task`, `quantity_above_intended`, `unintended_removal`; choosing "Keep both" in T2 counts) or an input rule (`invalid_quantity`, `over_limit`, `invalid_code`). It is recorded even if the participant later cancels. Practice mode has no task errors.

## Event dictionary

Every event has `seq` (from 1), `tMs` (monotonic, from session start), `type`, `actor` (`participant`, `system`, `simulated_employee`), `taskId` (nullable) and `screen`. Optional: `actionId`, `lineId`, `issueId`, `requestId`, `sku`, `details`. `actionId` links an attempt to its results, including delayed ones.

| Type | Main `details` |
|---|---|
| `session_started` / `session_ended` | `mode`, `condition`, `taskOrder` / `endReason`, `status` |
| `session_resumed` | `offlineGapMs` (null if unknown) |
| `tour_finished` | `result` (`completed`, `skipped`), `stepsViewed`. Its `tMs` is the time spent from Start, since the tips come first. |
| `task_started` / `task_ended` | `seeded` / `outcome`, `reason`, `predicatePassed`, `criteria`, `firstSatisfiedMs`, `censored` |
| `task_abandoned` | `reasonCode` |
| `transaction_reset` | `reasonCode` (`task_boundary`, `checkout_complete`), `lineCount`, `discardedIssueIds` |
| `screen_changed` | `from`, `to` |
| `action_attempted` / `action_result` | `actionName`, `target` / `outcome` (`accepted`, `rejected`, `error`), `reasonCode`, `errorCategory` |
| `scan_attempted` / `scan_result` | `physicalItem`, `retry` / `result`, `failureCode`, `oldQty`, `newQty`, `repeat` |
| `quantity_requested` / `quantity_committed` | `oldQty`, `newQty`, `method`, `reason`, `weight` |
| `removal_requested` / `removal_committed` | `reason`, `quantity` |
| `help_opened` / `help_action_selected` / `help_closed` | `context`, `trigger` (`user`, `automatic`) / `optionId` |
| `issue_opened` / `issue_deferred` / `issue_resolved` | `issueType` / `method` / `finalStatus` (`resolved`, `canceled`), `resolutionMethod`; for identification problems also `physicalItem`, `resolvedSku`, `identificationMatch` |
| `verification_requested` / `verification_result` | `method` (`bag_scale`, `return_area`, `weight_check`, `placement_check`), `attempt` / `result` |
| `assistance_requested` / `assistance_completed` | `issueType` / `outcome` (`resolved`, `canceled`); `requestId` is the assistance ID |
| `payment_attempted` / `payment_blocked` / `checkout_completed` | none / `blockingReason`, `reasons` / `finalTotalCents`, `itemCount`, `method` |
| `visibility_changed` | `state` (`hidden`, `visible`). Not proof of distraction. |

`quantity_committed` is written for quantity changes, lookups, code entry, approvals and assisted additions. An addition by scanning is recorded in `scan_result` only, so each change appears once.

**Methods:** `stepper`, `direct_edit`, `duplicate_prompt`, `lookup`, `manual_entry`, `assisted`, `authorized`.

**Error categories** (`details.errorCategory`, attached to exactly one event per occurrence):

| Category | Meaning |
|---|---|
| `injected_scenario` | Failure the scenario caused (unreadable or unknown barcode, double read, forced check failure). Never a participant mistake. |
| `participant_input` | Observable task or input violation. |
| `policy_block` | The kiosk refused an action in its current state. |
| `technical` | Unexpected software failure. |

## Export format and sample

Filename: `self-checkout-session-<sessionId>.json`. **Download** gives formatted JSON. **Copy** and the results text box give the same data compressed:

```json
{"encoding": "gzip+base64", "sessionId": "random-uuid", "data": "H4sIAAAA..."}
```

Decode pasted responses (one response per input file):

```
python tools/decode_export.py response1.txt response2.txt -o decoded
```

The script also accepts plain session JSON, which is what a browser without `CompressionStream` offers, and reports truncated or altered text as an error. The log is frozen at session end, so repeated exports are identical in the same browser.

[docs/sample-export.json](docs/sample-export.json) is a complete six-task export produced by the automated browser test. Its delays were shortened and a script did the clicking, so **its timings are meaningless**; use it to check structure and parsing.

Abbreviated shape:

```json
{
  "schemaVersion": "1.1",
  "prototypeVersion": "1.2.1",
  "scenarioVersion": "1.1",
  "sessionId": "random-uuid",
  "condition": "redesign",
  "mode": "study",
  "status": "completed",
  "endReason": "all_tasks_finished",
  "durationMs": 18420,
  "resumes": 0,
  "offlineGapMs": 0,
  "taskOrder": ["T1"],
  "tasks": [{"taskId": "T1", "outcome": "success", "durationMs": 18420, "censoredAtMs": null}],
  "summary": {"tasksCompleted": 1, "participantErrors": 0, "scenarioFailures": 0, "unresolvedIssues": 0},
  "events": [{"seq": 1, "tMs": 0, "type": "session_started", "actor": "participant", "taskId": null, "screen": "intro"}]
}
```

### Summary fields

All are derived from the event log and task records.

| Field | Definition |
|---|---|
| `tasks*` | Counts by outcome. |
| `participantErrors`, `scenarioFailures`, `errorsByCategory` | Counts of events carrying that category. |
| `helpOpens` / `helpShownAutomatically` / `helpByContext` | Participant-opened help / system-shown / both by context. |
| `helpActionsSelected` / `recoveryAttempts` | All help options chosen / the same excluding "set aside". |
| `assistanceRequests` / `assistanceCompleted` | Requested / resolved by the simulated associate. |
| `scanAttempts` / `repeatedScans` | All scans / successful scans of an item already on the order. |
| `quantityEdits` | `quantity_requested` events (includes changes later canceled). |
| `removalAttempts` / `removalsCompleted` | Whole-line removals requested / committed. |
| `paymentAttempts` / `blockedPayments` / `checkoutsCompleted` | Payment flow counts. |
| `rejectedActions` | `action_result` events with `rejected`. |
| `hiddenIntervals`, `hiddenDurationMs`, `hiddenIntervalUnfinished` | Time the tab was hidden. Do not read it as inactivity. |
| `hiddenIntervalsInterruptedByReload` | Hidden periods cut off by a reload. Not in the two fields above; their time is in `offlineGapMs`. |
| `wrongIdentifications` | Identification problems resolved as a different item from the one in hand. |
| `issues[]` | Per issue: opened, closed, `durationMs` (null if unresolved), final status, method. |
| `unresolvedIssues` | Issues never resolved or canceled, including those discarded at a task boundary. |
| `screenTrajectory`, `actionTrajectory` | Ordered names. |

Each entry in `tasks[]` also carries its own error, help, assistance, edit, repeat-scan, blocked-payment and wrong-identification counts, `spansReload`, and the success criteria, plus:

- `hiddenDurationMs`: measured hidden time inside the task. It is included in `durationMs`.
- `firstSatisfiedAfterMs`: time from task start until the goal was first met (null if never), even if later undone.

## Survey integration

1. Optionally set `surveyUrl` in `js/config.js` and rebuild the single file.
2. In the survey, add these instructions: *"Complete the tasks, end the session, then paste the session JSON below (or upload the file). Then answer the remaining questions."*
3. **Prefer a file upload question.** For a text field, copied responses are compressed: a six-task automated run was about 7,700 characters (46,000 uncompressed), and one hand-run 355-event session would be about 10,000. Longer sessions are larger. Check your platform's limit and never truncate: a cut-off response cannot be decoded.
4. Ask participants for the session ID shown on the results page if you need to match a pasted log to a file.
5. Pilot the full handoff with a long session before deployment.

The prototype sends nothing and cannot confirm that the survey received anything.

## Privacy and persistence

- No names, identity, IP address, fingerprint, free text, typed codes or quantities as raw input, search text, mouse movement, or payment data are recorded. Validated quantities and catalog IDs are.
- A random session ID is generated in the browser.
- A Content Security Policy blocks network connections (`connect-src 'none'`). The browser tests observed no network requests. The optional survey link is an ordinary link the participant chooses to open.
- The session is checkpointed to `localStorage` after every action and system event. It stays until deleted. Export does not delete it.
- On reload: **Resume**, **End it and export**, or **Discard**. Resume logs `session_resumed`; time away is reported as a gap and not added to `tMs`; pending delays restart.
- If storage is blocked or full, a warning says refreshing may lose data.
- A second tab never merges with or silently replaces another tab's saved session; the tab that cannot save shows a warning. Use one tab.
- On shared computers, delete the session after submitting.

## Architecture

| File | Role |
|---|---|
| `js/config.js` | Researcher settings and task definitions. |
| `js/catalog.js` | Products. |
| `js/scenario.js` | Task success predicates and constraint checks. |
| `js/transaction.js` | Single state, validated actions, `paymentEligibility` and `addBlockReason`. Returns events and delayed effects. |
| `js/telemetry.js` | Append-only log and monotonic clock. |
| `js/export.js` | Derived metrics, export and compression. |
| `tools/decode_export.py` | Decodes pasted responses. |
| `js/persistence.js` | Guarded local checkpoints. |
| `js/controller.js` | Dispatcher, timers, resume and reset. No DOM. |
| `js/ui.js`, `css/styles.css` | Rendering and input. |
| `js/main.js` | Startup and URL options. |

Lines, issues, requests and assistance have stable IDs. Delayed callbacks are canceled on reset and also validated against request ID and attempt number, so stale or repeated callbacks change nothing.

## Tests

Requirements for testing only: Python 3, `pip install websockets`, and Chrome or Edge (or set `CHROME` to a browser path).

```
python tests/run_tests.py          # logic tests (or just open tests/tests.html)
python tests/e2e.py                # real clicks, taps and keys on both builds
python tools/build_standalone.py --check
```

### Last run: 25 November 2026, Windows 11, headless Chrome

| Suite | Result |
|---|---|
| Logic (`tests/tests.js`) | 52 of 52 passed |
| Browser (`tests/e2e.py`) | 135 of 135 passed |

| Acceptance criterion | Covered by |
|---|---|
| Quantity 1→3 after verification; repeat scanning | Logic; browser (keypad and keyboard) |
| Duplicate vs physical return; cancel | Logic |
| Weighed and restricted workflows | Logic |
| Unpriced failed-scan issue and correct resolution | Logic |
| Multiple issues stay visible while scrolling | Logic; browser layout at 1280×720, 1024×768, 1366×768, 1920×1080 |
| Deferrable vs non-deferrable | Logic |
| Payment cannot be forced | Logic (direct actions and completion callback) |
| Rapid taps and stale callbacks | Logic; browser double-click on Pay |
| Keyboard, touch, status without color | Browser (emulated touch; 44 px, names and contrast on sampled screens) |
| Export order, predicates, summaries | Logic; browser |
| Injected vs participant error; cancel not committed | Logic |
| Completed and abandoned export; clipboard fallback; repeatability | Browser (clipboard stubbed); logic |
| Reload/resume, storage disabled, distinct reset | Browser; logic |
| No network requests or personal data | Browser; logic |
| First-run tips: once per session, before tasks, placement at five sizes | Logic; browser |

The logic suite also runs 150 random action sequences, checking state invariants and that every issue can still be cleared.

## Manual test checklist

**None of these have been run.** Automated tests do not replace them.

- [ ] Open both builds by double-click in Chrome, Edge, Firefox and Safari.
- [ ] Load the hosted GitHub Pages copy.
- [ ] Run all six tasks on the actual touchscreen or tablet in landscape.
- [ ] Finger-operate the steppers, trash, keypad and list scrolling.
- [ ] Check the first-run tips on the study device, including rotation, and that a new participant can find the Simulation panel afterwards.
- [ ] Complete T1 and T3 with keyboard only.
- [ ] Use a screen reader (NVDA or VoiceOver): headings, row controls, banners, Needs attention, dialogs.
- [ ] Zoom to 200% and check nothing becomes unreachable.
- [ ] Copy the JSON with the real clipboard, paste it into the real survey field, export the response and decode it.
- [ ] Check the results page on the oldest browser participants may use.
- [ ] Download and upload the file to the real survey.
- [ ] Refresh mid-task and resume; try a private window.
- [ ] Switch tabs and lock the device mid-task, then check `hiddenDurationMs` and `tMs`.
- [ ] In practice mode, trigger the unscanned item and forced check failure.
- [ ] Pilot task wording with at least one person who has not seen the prototype.

## Known limitations

- Verified only in headless Chrome on Windows.
- Pasted (compressed) responses must be decoded before reading.
- Only T6 fails when a problem is resolved as the wrong item. T4 still succeeds if the participant later adds the right item; check `wrongIdentifications`.
- Data from `prototypeVersion` 1.1.0 and earlier scores T6 differently and lacks the 1.2.0 fields.
- The tips cannot be reopened after they are finished or skipped. Session `durationMs` includes time spent on them; task durations do not.
- Data from `prototypeVersion` 1.0.0 had no tips; do not pool it with later data without noting the difference.
- Physical actions are buttons. This may itself confuse participants; separate that from interface problems during analysis (the earlier evaluation saw this).
- On windows narrower than 981 px the simulation panel sits below the kiosk and requires scrolling. Use a wide landscape screen for the study.
- An associate identifies items from scenario ground truth. For a help issue the participant opened with no associated item, assistance clears it without adding anything (except produce in T5).
- If a participant identifies an unreadable item as the wrong product, the kiosk accepts it; a real weight check might not.
- "Keep both" remains the highlighted button on the double-scan screen, as in the reference. This could bias T2.
- T6 wording tells participants the order of events ("add the juice before you sort it out"), which may hint at setting the problem aside.
- Task outcomes are scored when the participant says they are done, or at payment. `firstSatisfiedMs` records when the goal was first met.
- Some browsers pause the monotonic clock during device sleep.
- Browsers may share `localStorage` between local files, and may clear it on their own.
- Icons are emoji and the font is Inter only if installed (otherwise a system font), so appearance varies by device.
- A technically capable participant could inspect or alter local data.

## Researcher decisions still open

- Task wording and order, and counterbalancing.
- Verification and approval policies.
- Whether a baseline condition is needed (none is included).
- Consent procedure and data retention. The in-app notice does not replace consent.
- Survey platform field size or attachment support.
- A pilot of the complete prototype-to-survey handoff with a realistic long session.
