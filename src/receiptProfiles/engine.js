'use strict';

// Runs a transformer's `transform` entrypoint against a copy of a parsed
// receipt, then AUTO-DERIVES the change/audit trail by diffing input vs output
// and recomputes totals. Transformer authors write only the logic; the result
// shape ({ store, items, totals, changes }) is identical to the old engine's.

function deepCopy(v) {
  return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
}

// Fields we report diffs on (everything a transformer is expected to touch).
const STORE_FIELDS = ['name', 'date'];
const ITEM_FIELDS = ['description', 'sku', 'qty', 'unitPrice', 'price', 'discount'];

// Mirrors parser.finalize so a profile result reports totals like a parse does.
const SUBTOTAL_TOLERANCE = 0.02;

function recomputeTotals(items, base) {
  const b = base || {};
  const sumOfItems =
    Math.round(items.reduce((acc, it) => acc + (Number(it && it.price) || 0), 0) * 100) / 100;
  const subtotal = b.subtotal ?? null;
  const subtotalMatch =
    subtotal == null ? null : Math.abs(sumOfItems - subtotal) <= SUBTOTAL_TOLERANCE;
  return {
    subtotal,
    tax: b.tax ?? null,
    total: b.total ?? null,
    itemCount: items.length,
    sumOfItems,
    subtotalMatch,
  };
}

function norm(v) {
  return v === undefined ? null : v;
}

// Identity used to align items across a transform. Prefer the item number
// (stable across renames and price edits, so a rewrite shows as a field change),
// and fall back to the description when there's no SKU. This lets an inserted or
// removed line — e.g. a discount line folded into its item — show as a clean
// add/remove instead of cascading into bogus positional "renames".
function itemIdent(it) {
  const sku = norm(it && it.sku);
  if (sku !== null && String(sku).trim() !== '') return 's:' + String(sku).trim();
  return 'd:' + String(norm(it && it.description) ?? '');
}

function itemFieldChanges(b, a, itemIndex) {
  const out = [];
  for (const k of ITEM_FIELDS) {
    if (norm(b[k]) !== norm(a[k])) {
      out.push({ field: `item.${k}`, from: norm(b[k]), to: norm(a[k]), itemIndex });
    }
  }
  return out;
}

// Align the before/after item lists by LCS over their identities (lists are
// short), then report field changes on matched pairs and add/remove on the rest.
function diffItems(bi, ai) {
  const n = bi.length;
  const m = ai.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        itemIdent(bi[i]) === itemIdent(ai[j])
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const changes = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (itemIdent(bi[i]) === itemIdent(ai[j])) {
      changes.push(...itemFieldChanges(bi[i], ai[j], j));
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      changes.push({ field: 'item', from: norm(bi[i].description), to: null, itemIndex: i, removed: true });
      i++;
    } else {
      changes.push({ field: 'item', from: null, to: norm(ai[j].description), itemIndex: j, added: true });
      j++;
    }
  }
  for (; i < n; i++) {
    changes.push({ field: 'item', from: norm(bi[i].description), to: null, itemIndex: i, removed: true });
  }
  for (; j < m; j++) {
    changes.push({ field: 'item', from: null, to: norm(ai[j].description), itemIndex: j, added: true });
  }
  return changes;
}

function diff(before, after) {
  const changes = [];

  const bs = before.store || {};
  const as = after.store || {};
  for (const k of STORE_FIELDS) {
    if (norm(bs[k]) !== norm(as[k])) {
      changes.push({ field: `store.${k}`, from: norm(bs[k]), to: norm(as[k]) });
    }
  }

  changes.push(...diffItems(before.items || [], after.items || []));
  return changes;
}

/**
 * Apply a transformer to a receipt record.
 * @param {object} record   the durable receipt record (read-only here)
 * @param {Function} transformFn  a transformer's `transform` entrypoint
 * @param {object} ctx       { receiptId, config, log }
 * @returns {{store:object, items:object[], totals:object, changes:object[]}}
 */
function applyProfile(record, transformFn, ctx) {
  const before = {
    store: deepCopy((record && record.store)) || { name: null, date: null },
    items: deepCopy((record && record.items)) || [],
    totals: deepCopy((record && record.totals)) || {},
  };
  // The transformer mutates this copy (or returns a new draft).
  const draft = {
    store: deepCopy(before.store),
    items: deepCopy(before.items),
    totals: deepCopy(before.totals),
  };

  const returned = transformFn(draft, ctx);
  const out = returned && typeof returned === 'object' ? returned : draft;
  const store = out.store || { name: null, date: null };
  const items = Array.isArray(out.items) ? out.items : [];

  return {
    store,
    items,
    totals: recomputeTotals(items, before.totals),
    changes: diff(before, { store, items }),
  };
}

module.exports = { applyProfile, recomputeTotals };
