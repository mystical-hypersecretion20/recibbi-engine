'use strict';

// Transformer EVALUATION harness (reporting tool, not a pass/fail unit test).
//
// For a transformer, it measures how close the pipeline gets to the ground truth
// stored in that transformer's eval fixtures (each fixture carries `input` = the
// OCR parse and `groundTruth` = the verbatim vision reference), BEFORE and AFTER
// the transformer, then compares the AFTER numbers to the baseline table recorded
// in the transformer's own header comment. Flags any regression.
//
//   node test/transformers/eval.js                    # all transformers (suite)
//   node test/transformers/eval.js tesseractGroceryUs # one transformer
//
// npm:  npm run eval   |   npm run eval:tesseractGroceryUs
//
// To add an eval for another (e.g. non-Tesseract) transformer, give its fixtures
// a `groundTruth` block and (optionally) a "## Quality baseline" markdown table
// in its header comment — this harness discovers it automatically.

const fs = require('fs');
const path = require('path');

const { applyToInput } = require('./_helpers');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TRANSFORMERS_SRC = path.join(__dirname, '..', '..', 'src', 'receiptProfiles', 'transformers');

// ---------- metric definitions (label must match the header-comment table) ----------

const METRICS = [
  { key: 'storeAccuracy', label: 'Store-name accuracy' },
  { key: 'exactDescRate', label: 'Exact description match' },
  { key: 'meanDescSim', label: 'Mean description similarity' },
  { key: 'itemPrecision', label: 'Item precision (matched/cand)' },
  { key: 'itemRecall', label: 'Item recall (matched/GT)' },
  { key: 'priceMatchRate', label: 'Price match (matched items)' },
  { key: 'skuRecall', label: 'SKU recall' },
  { key: 'reconRate', label: 'Subtotal reconciliation' },
];

// ---------- comparison helpers (moved from analysis/evaluate.js) ----------

function norm(s) {
  return String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}
function skuDigits(v) {
  return String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
}
const STORE_ALIASES = {
  Costco: ['costco wholesale', 'costco'],
  "Sam's Club": ["sam's club", 'sams club', 'sam’s club'],
};
function canonStore(name) {
  const hay = String(name ?? '').toLowerCase();
  for (const [canon, vars] of Object.entries(STORE_ALIASES)) {
    if (vars.some((v) => hay.includes(v))) return canon;
  }
  return name ? String(name).trim() : null;
}
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}
function similarity(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x && !y) return 1;
  const d = levenshtein(x, y);
  return 1 - d / Math.max(x.length, y.length);
}
// Align candidate items to ground truth: by SKU digits first, then by best
// description similarity (>= 0.5) on the leftovers.
function align(candItems, gtItems) {
  const cand = candItems.map((it) => ({ it, used: false }));
  const gt = gtItems.map((it) => ({ it, used: false }));
  const pairs = [];
  for (const g of gt) {
    const gd = skuDigits(g.it.sku);
    if (!gd) continue;
    const c = cand.find((c) => !c.used && skuDigits(c.it.sku) === gd);
    if (c) {
      c.used = true;
      g.used = true;
      pairs.push({ cand: c.it, gt: g.it });
    }
  }
  for (const g of gt) {
    if (g.used) continue;
    let best = null;
    let bestSim = 0.5;
    for (const c of cand) {
      if (c.used) continue;
      const s = similarity(c.it.description, g.it.description);
      if (s >= bestSim) {
        bestSim = s;
        best = c;
      }
    }
    if (best) {
      best.used = true;
      g.used = true;
      pairs.push({ cand: best.it, gt: g.it });
    }
  }
  return { pairs, candTotal: cand.length, gtTotal: gt.length };
}
function priceEq(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;
}
function evalReceipt(candItems, gt, gtSubtotal) {
  const a = align(candItems, gt.items);
  let simSum = 0,
    exact = 0,
    priceMatch = 0;
  for (const p of a.pairs) {
    simSum += similarity(p.cand.description, p.gt.description);
    if (norm(p.cand.description) === norm(p.gt.description)) exact++;
    if (priceEq(p.cand.price, p.gt.price)) priceMatch++;
  }
  const candSkus = new Set(candItems.map((i) => skuDigits(i.sku)).filter(Boolean));
  const gtSkus = gt.items.map((i) => skuDigits(i.sku)).filter(Boolean);
  const skuHits = gtSkus.filter((s) => candSkus.has(s)).length;
  const sum = Math.round(candItems.reduce((s, i) => s + (Number(i.price) || 0), 0) * 100) / 100;
  return {
    matched: a.pairs.length,
    candTotal: a.candTotal,
    gtTotal: a.gtTotal,
    simSum,
    exact,
    priceMatch,
    skuHits,
    gtSkuTotal: gtSkus.length,
    reconciles: gtSubtotal == null ? null : Math.abs(sum - gtSubtotal) <= 0.02,
  };
}
function aggregate(rows, storeOk, storeN) {
  let matched = 0,
    candTotal = 0,
    gtTotal = 0,
    simSum = 0,
    exact = 0,
    priceMatch = 0,
    skuHits = 0,
    gtSkuTotal = 0,
    recOk = 0,
    recN = 0;
  for (const r of rows) {
    matched += r.matched;
    candTotal += r.candTotal;
    gtTotal += r.gtTotal;
    simSum += r.simSum;
    exact += r.exact;
    priceMatch += r.priceMatch;
    skuHits += r.skuHits;
    gtSkuTotal += r.gtSkuTotal;
    if (r.reconciles != null) {
      recN++;
      if (r.reconciles) recOk++;
    }
  }
  return {
    storeAccuracy: storeN ? storeOk / storeN : 0,
    itemRecall: gtTotal ? matched / gtTotal : 0,
    itemPrecision: candTotal ? matched / candTotal : 0,
    meanDescSim: matched ? simSum / matched : 0,
    exactDescRate: matched ? exact / matched : 0,
    priceMatchRate: matched ? priceMatch / matched : 0,
    skuRecall: gtSkuTotal ? skuHits / gtSkuTotal : 0,
    reconRate: recN ? recOk / recN : 0,
  };
}

// ---------- baseline (parsed from the transformer's header-comment table) ----------

// Reads the markdown table embedded as `// |...|...|` comment lines and returns
// { label -> baselinePercent } from the LAST column (the "After" baseline).
function readBaseline(transformerId) {
  for (const ext of ['.ts', '.js']) {
    const p = path.join(TRANSFORMERS_SRC, transformerId + ext);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const baseline = {};
    for (const line of src.split(/\r?\n/)) {
      const m = line.match(/^\s*\/\/\s*\|(.+)\|\s*$/);
      if (!m) continue;
      const cells = m[1].split('|').map((c) => c.trim());
      if (cells.length < 2) continue;
      const label = cells[0];
      const after = cells[cells.length - 1];
      if (/^-+$/.test(label) || !label) continue; // separator row
      const num = after.match(/(\d+(?:\.\d+)?)\s*%/);
      if (num) baseline[label] = parseFloat(num[1]);
    }
    return Object.keys(baseline).length ? baseline : null;
  }
  return null;
}

// ---------- run one transformer ----------

function loadFixtures(transformerId) {
  const dir = path.join(FIXTURES_DIR, transformerId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((fx) => fx.groundTruth && fx.input)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function pct(x) {
  return (x * 100).toFixed(1) + '%';
}

function evalTransformer(transformerId) {
  const fixtures = loadFixtures(transformerId);
  if (fixtures.length === 0) {
    console.log(`\n• ${transformerId}: no eval dataset (fixtures need a "groundTruth" block) — skipped.`);
    return { skipped: true, regressions: 0 };
  }

  const rawRows = [];
  const cleanRows = [];
  let storeRawOk = 0,
    storeCleanOk = 0,
    storeN = 0;

  for (const fx of fixtures) {
    const gt = fx.groundTruth;
    const gtSubtotal = gt.totals && gt.totals.subtotal != null ? gt.totals.subtotal : null;
    const gtStore = canonStore(gt.store && gt.store.name);

    rawRows.push(evalReceipt(fx.input.items || [], gt, gtSubtotal));
    const after = applyToInput(transformerId, fx.input);
    cleanRows.push(evalReceipt(after.items, gt, gtSubtotal));

    if (gtStore) {
      storeN++;
      if (canonStore(fx.input.store && fx.input.store.name) === gtStore) storeRawOk++;
      if (canonStore(after.store && after.store.name) === gtStore) storeCleanOk++;
    }
  }

  const raw = aggregate(rawRows, storeRawOk, storeN);
  const clean = aggregate(cleanRows, storeCleanOk, storeN);
  const baseline = readBaseline(transformerId);

  console.log(`\n=== ${transformerId} — ${fixtures.length} receipts ===`);
  const head = ['Metric', 'raw', 'after', 'baseline', 'status'];
  const rows = [head];
  let regressions = 0;
  for (const { key, label } of METRICS) {
    const cur = clean[key] * 100;
    const base = baseline ? baseline[label] : undefined;
    let status = '—';
    if (base != null) {
      const delta = cur - base;
      if (delta < -0.05) {
        status = `REGRESSION ${delta.toFixed(1)}pp`;
        regressions++;
      } else if (delta > 0.05) {
        status = `improved +${delta.toFixed(1)}pp`;
      } else {
        status = 'ok';
      }
    }
    rows.push([
      label,
      pct(raw[key]),
      pct(clean[key]),
      base != null ? base.toFixed(1) + '%' : 'n/a',
      status,
    ]);
  }
  // pretty-print aligned columns
  const widths = head.map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (let i = 0; i < rows.length; i++) {
    console.log(
      '  ' + rows[i].map((cell, c) => String(cell).padEnd(widths[c])).join('  ') + (i === 0 ? '' : '')
    );
    if (i === 0) console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  }
  if (!baseline) {
    console.log('\n  (no baseline table found in the transformer comment — reporting measured values only)');
  } else if (regressions) {
    console.log(`\n  ⚠ ${regressions} metric(s) regressed below the recorded baseline.`);
  } else {
    console.log('\n  ✓ all metrics at or above the recorded baseline.');
  }
  return { skipped: false, regressions };
}

// ---------- CLI ----------

function allTransformerIds() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((d) => fs.statSync(path.join(FIXTURES_DIR, d)).isDirectory())
    .sort();
}

function main() {
  const arg = process.argv[2];
  const ids = arg ? [arg] : allTransformerIds();
  if (ids.length === 0) {
    console.error('No transformer eval datasets found under test/transformers/fixtures/.');
    process.exit(1);
  }
  let totalRegressions = 0;
  let evaluated = 0;
  for (const id of ids) {
    const { skipped, regressions } = evalTransformer(id);
    if (!skipped) evaluated++;
    totalRegressions += regressions;
  }
  if (evaluated === 0) {
    console.log('\nNo evaluable transformers (none have a groundTruth dataset).');
  }
  console.log('');
  process.exit(totalRegressions > 0 ? 1 : 0);
}

main();
