// Transformer: clean noisy *Tesseract* OCR output for US grocery receipts so it
// matches the receipt's printed text as closely as possible.
//
// Rewritten (v3) against a VERBATIM vision ground truth: the reference now keeps
// the receipt's own abbreviations and UPPERCASE styling ("KS SPARK WAT", not
// "Kirkland Signature Sparkling Water") and keeps discounts as separate negative
// lines. So this transformer's job is *de-noising toward the printed text*, not
// human-friendly normalization. Concretely it:
//   1. recovers the store name from item shape (the header is usually garbled),
//   2. drops phantom rows the heuristic parser emits (quantity-breakdown lines,
//      OCR-mangled register/summary lines, pure-garbage rows),
//   3. re-signs discount lines (Tesseract drops their trailing "-") and keeps
//      them as their own negative line, like the ground truth,
//   4. strips the leading OCR junk + embedded SKU (already captured in item.sku)
//      and stray OCR punctuation, then UPPER-cases — without expanding or
//      Title-Casing, which would diverge from the printed text.
// Character-level misreads (BWISS<-SWISS) need the pixels and are left as-is.
// See analysis/PATTERNS.md for the evidence behind each rule.
//
// ---------------------------------------------------------------------------
// ## Quality baseline — v3 (keep this updated when the logic changes)
//
// Measured by `analysis/evaluate.js` over the 14-receipt sample corpus
// (10 Costco + 4 Sam's Club), comparing the pipeline to the VERBATIM vision
// ground truth, RAW Tesseract parse vs AFTER this transformer:
//
// | Metric                      | Raw Tesseract | After (v3)      |
// |-----------------------------|---------------|-----------------|
// | Store-name accuracy         | 28.6% (4/14)  | 92.9% (13/14)   |
// | Exact description match     | 0.0%          | 73.9%           |
// | Mean description similarity | 49.5%         | 94.9%           |
// | Item precision (matched/cand)| 82.2%        | 97.9%           |
// | Item recall (matched/GT)    | 72.1%         | 75.4%           |
// | Price match (matched items) | 95.5%         | 95.7%           |
// | SKU recall                  | 66.1%         | 65.3%           |
// | Subtotal reconciliation     | 25.0%         | 25.0%           |
//
// Recall and reconciliation are bounded by Tesseract *dropping whole lines*
// upstream (blank-price products, garbled discounts) — an image-quality ceiling
// this transformer cannot lift, not a cleanup gap. Future improvements should
// move recall/exact-match up without regressing precision; re-run evaluate.js
// and update this table.
// ---------------------------------------------------------------------------

import type { Item, Store, Transform, TransformContext, TransformerMeta } from './types';

export const meta: TransformerMeta = {
  name: 'tesseractGroceryUs',
  description:
    "De-noise Tesseract OCR for US grocery receipts toward the printed text: infer the store (Costco/Sam's Club) from item shape, drop phantom register/quantity rows, re-sign discount lines, and strip junk + embedded SKU codes (preserving the receipt's abbreviations and casing).",
  version: 3,
};

// Canonical store name -> printed variants (lowercase). Longest variant wins.
const STORE_ALIASES: Record<string, string[]> = {
  Costco: ['costco wholesale', 'costco'],
  "Sam's Club": ["sam's club", 'sams club', 'sam’s club'],
  Sprouts: ['sprouts farmers market', 'sprouts'],
  Walmart: ['walmart', 'wal-mart'],
  'Whole Foods': ['whole foods market', 'whole foods'],
};

// Register/summary keywords the parser's own noise filter misses once OCR mangles
// them (TRAX<-TAX, SUBTOTA<-SUBTOTAL, ...). Matched on the raw description.
const REGISTER_NOISE_RE =
  /\b(amount|subtot\w*|tax|trax|total|change|tender|balance|redemption|shopping\s+card|items?\s+sold|cash\s+back|reward)\b/i;

// Sam's quantity-breakdown row ("2 AT 1 FOR 6.57 13.14"): a phantom item, because
// the real product line above it had a blank price column.
const QTY_ROW_RE = /(^|\s)\d+\s+at\s+\d+\s+for\b/i;

// Sam's instant-savings marker ("Dog Chow (Inst Sv)", "Ins? SY DoG CHOW"): an
// "Ins…" token followed by an "Sv"/"Sy" token, tolerant of OCR punctuation between.
const SAMS_DISCOUNT_RE = /\bin?s\w*\b[\s?().,-]*\bs[vy]\b/i;

// A Costco discount reference: two slash-separated item numbers ("0000377227 / 99006").
const COSTCO_DISCOUNT_RE = /\d{3,}\s*\/\s*\d{3,}/;

// OCR-noise glyphs the receipt doesn't actually print. Real separators (/ _ - .)
// and alphanumerics are kept.
const NOISE_GLYPHS_RE = /[|~©»«®™¥#*\[\]{}<>§£•·"`]+/g;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function skuDigits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

function canonicalStore(name: string): string | null {
  const hay = name.toLowerCase();
  const match = Object.entries(STORE_ALIASES)
    .flatMap(([canonical, variants]) => variants.map((v) => ({ canonical, v })))
    .sort((a, b) => b.v.length - a.v.length)
    .find(({ v }) => hay.includes(v));
  return match ? match.canonical : null;
}

// Strip the leading OCR junk + SKU and stray noise glyphs, leaving the printed
// product name in UPPERCASE. No abbreviation expansion / Title-Casing — the
// ground truth is the receipt's own (abbreviated, upper-case) text.
function cleanName(desc: string): string {
  const original = desc.replace(/\s+/g, ' ').trim();
  // Leading junk + SKU. The optional `\d{1,3}\s+` absorbs a lone digit standing
  // where Costco's "E" line-marker mis-read ("8 1948524 …" / "| 3 7950 …").
  let d = original.replace(/^\D*(?:\d{1,3}\s+)?\d{3,}[\s:/|\[\].]*/, '');
  // Embedded >=4-digit SKU the leading pass missed (sizes are <=3 digits).
  d = d.replace(/\b\d{4,}\b/g, ' ');
  // Stray OCR-noise glyphs, then leftover leading punctuation (keep a leading
  // digit glued to a size like "3LB"/"4LB"/"1 GALLON").
  d = d.replace(NOISE_GLYPHS_RE, ' ').replace(/^[^A-Za-z0-9]+/, '');
  d = d.replace(/\s+/g, ' ').trim();
  if (!d) d = original;
  return d.toUpperCase();
}

function hasRealWord(name: string): boolean {
  return /[A-Za-z]{3,}/.test(name);
}

// --- store inference (the header is usually garbled past the alias map) ---

function looksLikeCostco(items: Item[]): boolean {
  return items.some((it) => /\bks\b/i.test(it.description || ''));
}

function looksLikeSamsClub(items: Item[]): boolean {
  return items.filter((it) => /^0\d{8,}$/.test(String(it.sku ?? '').trim())).length >= 2;
}

// --- discount lines: re-sign and keep as their own negative line (like GT) ---

function asCostcoDiscount(it: Item): Item | null {
  const m = String(it.description || '').match(/\d{3,}\s*\/\s*\d{3,}/);
  if (!m || typeof it.price !== 'number') return null;
  // Keep the printed reference text ("0000377227 / 99006"), drop any junk prefix.
  const ref = m[0].replace(/\s*\/\s*/, ' / ');
  return { ...it, description: ref, price: -Math.abs(it.price) };
}

function asSamsDiscount(it: Item): Item | null {
  if (!SAMS_DISCOUNT_RE.test(String(it.description || '')) || typeof it.price !== 'number') return null;
  return { ...it, description: cleanName(it.description), price: -Math.abs(it.price) };
}

export const transform: Transform = (receipt, ctx) => {
  const { store } = receipt;
  const log = (ctx && ctx.log) || (() => {});
  const subtotal = (receipt.totals && (receipt.totals as any).subtotal) ?? null;
  const total = (receipt.totals && (receipt.totals as any).total) ?? null;

  // 1. Store name: canonicalize whatever parsed; else infer from item shape
  //    (Sam's first — its SKU signature is unambiguous; then Costco from KS).
  const samsClub = looksLikeSamsClub(receipt.items);
  if (store.name) store.name = canonicalStore(store.name) || store.name;
  if (!store.name) {
    if (samsClub) store.name = "Sam's Club";
    else if (looksLikeCostco(receipt.items)) store.name = 'Costco';
  }

  // 2. Clean each row: re-sign discounts, drop phantoms, de-noise the name.
  const out: Item[] = [];
  for (const it of receipt.items) {
    const raw = String(it.description || '');

    // Discount line (re-signed negative, kept as its own line like the GT).
    if (COSTCO_DISCOUNT_RE.test(raw)) {
      const d = asCostcoDiscount(it);
      if (d) {
        out.push(d);
        log('re-signed Costco discount line', { ref: d.description, price: d.price });
        continue;
      }
    }
    if (SAMS_DISCOUNT_RE.test(raw)) {
      const d = asSamsDiscount(it);
      if (d) {
        out.push(d);
        log('re-signed Sam\'s discount line', { item: d.description, price: d.price });
        continue;
      }
    }

    // Phantom rows the noisy parser emitted (not real products).
    if (QTY_ROW_RE.test(raw)) continue; // "2 AT 1 FOR 6.57 13.14"
    if (REGISTER_NOISE_RE.test(raw)) continue; // TAX/TRAX/SUBTOTA/AMOUNT/...
    // A line whose price equals the printed subtotal/total is a misread summary
    // line (e.g. "HOLA: 62.94"), trusted only on a multi-item receipt.
    if (
      receipt.items.length > 1 &&
      typeof it.price === 'number' &&
      ((subtotal != null && Math.abs(it.price - subtotal) < 0.005) ||
        (total != null && Math.abs(it.price - total) < 0.005))
    ) {
      continue;
    }

    const name = cleanName(raw);
    if (!hasRealWord(name)) continue; // pure OCR garbage ("Eo", "Ff A")
    out.push({ ...it, description: name });
  }

  receipt.items = out;
  return receipt;
};
