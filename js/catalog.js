/* Simulated product catalog. All prices are integer cents. Weights are integer
 * hundredths of a pound. Codes are invented for this simulation. */
(function (SCO) {
  'use strict';

  var items = {
    eggs: { name: 'Large Eggs, 12 ct', unit: 'each', priceCents: 449, barcode: '100101' },
    milk: { name: 'Whole Milk, 1 gal', unit: 'each', priceCents: 399, barcode: '100102' },
    bread: { name: 'Sandwich Bread', unit: 'each', priceCents: 279, barcode: '100103' },
    juice: { name: 'Orange Juice, 52 fl oz', unit: 'each', priceCents: 429, barcode: '100104' },
    cereal: { name: 'Cereal, 18 oz', unit: 'each', priceCents: 549, barcode: '100105' },
    soup: { name: 'Tomato Soup, 10.75 oz', unit: 'each', priceCents: 129, barcode: '100106' },
    paper_towels: { name: 'Paper Towels, 2 rolls', unit: 'each', priceCents: 649, barcode: '100107' },
    wine: { name: 'Red Wine, 750 mL', unit: 'each', priceCents: 1099, barcode: '100108', restricted: true },
    bananas: { name: 'Bananas', unit: 'lb', priceCents: 59, plu: '4011', produce: true, simWeight: 210 },
    gala_apples: { name: 'Gala Apples', unit: 'lb', priceCents: 169, plu: '4135', produce: true, simWeight: 240 },
    roma_tomatoes: { name: 'Roma Tomatoes', unit: 'lb', priceCents: 199, plu: '4087', produce: true, simWeight: 150 },
    avocado: { name: 'Avocado', unit: 'each', priceCents: 125, plu: '4046', produce: true },
    lime: { name: 'Lime', unit: 'each', priceCents: 50, plu: '4048', produce: true }
  };

  /* Physical items that exist in the basket but not in the catalog. */
  var uncataloged = {
    unknown_snack: { name: 'Imported Snack', barcode: '100999' }
  };

  function get(sku) {
    return Object.prototype.hasOwnProperty.call(items, sku) ? items[sku] : null;
  }

  function physical(id) {
    if (get(id)) return items[id];
    return Object.prototype.hasOwnProperty.call(uncataloged, id) ? uncataloged[id] : null;
  }

  function findByCode(code) {
    var found = null;
    Object.keys(items).forEach(function (sku) {
      if (items[sku].barcode === code || items[sku].plu === code) found = sku;
    });
    return found;
  }

  SCO.catalog = {
    items: items,
    get: get,
    physical: physical,
    findByCode: findByCode,
    skus: Object.keys(items)
  };
})(window.SCO = window.SCO || {});
