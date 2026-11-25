/* Researcher configuration. Participants never see these controls.
 * After editing, re-run `python tools/build_standalone.py` to refresh dist/.
 */
(function (SCO) {
  'use strict';

  SCO.config = {
    schemaVersion: '1.0',
    prototypeVersion: '1.1.0',
    scenarioVersion: '1.0',

    /* Label written into every export. Only a "redesign" interface ships here. */
    condition: 'redesign',

    /* Optional survey link shown on the results screen. Empty string hides it.
     * Nothing is ever sent to this address by the prototype. */
    surveyUrl: '',

    /* 600 basis points = 6%, matching the reference screenshots. */
    taxRateBasisPoints: 600,

    /* Largest quantity a shopper may request on one count-priced row. */
    maxQuantity: 12,

    /* Fixed, deterministic simulation delays in milliseconds. */
    delays: {
      verificationMs: 1000,
      assistanceMs: 3000,
      paymentMs: 2500
    },

    /* Simulated retailer validation policy. */
    verification: {
      approvalForDuplicateCorrection: false,
      approvalForUnwantedRemoval: false
    },

    /* deferrable: the shopper may set the issue aside and keep scanning.
     * blocking:   payment is unavailable while the issue is unresolved. */
    issuePolicy: {
      unreadable_barcode: { deferrable: true, blocking: true },
      unknown_product: { deferrable: true, blocking: true },
      produce_identification: { deferrable: true, blocking: true },
      possible_duplicate: { deferrable: true, blocking: true },
      quantity_change: { deferrable: true, blocking: true },
      removal_pending: { deferrable: true, blocking: true },
      authorization_required: { deferrable: true, blocking: true },
      bagging_mismatch: { deferrable: false, blocking: true },
      general_assistance: { deferrable: false, blocking: true }
    },

    /* Study-mode task order. Can be overridden per participant with
     * index.html?order=T2,T1,T3,T5,T4,T6 for counterbalancing. */
    taskOrder: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'],

    /* Physical items offered in the practice-mode simulation panel. */
    practiceBasket: ['eggs', 'milk', 'bread', 'juice', 'cereal', 'soup',
      'paper_towels', 'wine', 'unknown_snack', 'bananas', 'gala_apples',
      'roma_tomatoes', 'avocado', 'lime'],

    /* Practice mode: this item fails to read twice, then reads. */
    practiceUnreadable: { paper_towels: 2 },

    /*
     * resetBefore: start the task with a fresh order (logged as transaction_reset).
     * start:       first kiosk screen, "welcome" or "checkout".
     * seed:        items already on the order (pre-verified), oldest first.
     * duplicateRead: inject a scanner double read of this SKU.
     * duplicatePresentation: "prompt" shows the duplicate screen immediately,
     *              "needs_attention" only lists it under Needs attention.
     * unreadable:  { sku: n } barcode fails n times; -1 means it never reads.
     * failVerifications: number of bagging/return checks that fail first.
     * assistedSku: item an associate identifies for a produce lookup problem.
     * intended:    quantities the participant should end up with; used to score
     *              observable constraint violations (never to guide the UI).
     */
    tasks: {
      T1: {
        goal: 'You are buying three cans of Tomato Soup. Add all three to your order.',
        resetBefore: true, start: 'welcome', seed: [],
        basket: ['soup', 'bread', 'milk'],
        intended: { soup: 3 }
      },
      T2: {
        goal: 'You have one carton of Large Eggs and one loaf of Sandwich Bread. Make sure your order matches what you are buying.',
        resetBefore: true, start: 'checkout',
        seed: [{ sku: 'bread', qty: 1 }, { sku: 'eggs', qty: 1 }],
        duplicateRead: 'eggs', duplicatePresentation: 'prompt',
        basket: ['eggs', 'bread'],
        intended: { bread: 1, eggs: 1 }
      },
      T3: {
        goal: 'You have changed your mind and no longer want to buy the Whole Milk. Make sure you are not charged for it.',
        resetBefore: true, start: 'checkout',
        seed: [{ sku: 'milk', qty: 1 }, { sku: 'bread', qty: 1 }, { sku: 'juice', qty: 1 },
          { sku: 'cereal', qty: 1 }, { sku: 'bananas', qty: 1 }],
        basket: ['milk', 'bread', 'juice', 'cereal'],
        intended: { bread: 1, juice: 1, cereal: 1, bananas: 1 }
      },
      T4: {
        goal: 'Add the box of Cereal in your basket to your order.',
        resetBefore: true, start: 'checkout',
        seed: [{ sku: 'eggs', qty: 1 }, { sku: 'bread', qty: 1 }],
        unreadable: { cereal: -1 },
        basket: ['cereal'],
        intended: { eggs: 1, bread: 1, cereal: 1 }
      },
      T5: {
        goal: 'Add the Gala Apples in your basket to your order.',
        resetBefore: true, start: 'checkout',
        seed: [{ sku: 'eggs', qty: 1 }],
        assistedSku: 'gala_apples',
        basket: ['gala_apples', 'bananas'],
        intended: { eggs: 1, gala_apples: 1 }
      },
      T6: {
        goal: 'Buy the Paper Towels and the Orange Juice. Start with the Paper Towels. If there is a problem with them, add the Orange Juice before you sort it out. Then pay.',
        resetBefore: true, start: 'welcome', seed: [],
        unreadable: { paper_towels: -1 },
        basket: ['paper_towels', 'juice'],
        intended: { paper_towels: 1, juice: 1 }
      }
    }
  };
})(window.SCO = window.SCO || {});
