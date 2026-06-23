// Example transformer: normalize common US grocery receipts. This replaces the
// former two-stage JSON rules with plain TypeScript — context-sensitive logic is
// just ordinary control flow.

import type { Item, Store, Transform, TransformContext, TransformerMeta } from './types';

export const meta: TransformerMeta = {
  name: 'usGrocery',
  description:
    'Normalize common US grocery receipts (store name + date), fold per-item discount lines into the discounted item, and a context-sensitive item rewrite.',
  version: 2,
};

// Canonical store name -> known variants (lowercase). Longest variant wins.
const STORE_ALIASES: Record<string, string[]> = {
  Costco: ['costco wholesale', 'costco'],
  Sprouts: ['sprouts farmers market', 'sprouts'],
  Walmart: ['walmart', 'wal-mart'],
  'Whole Foods': ['whole foods market', 'whole foods'],
  "Sam's Club": ["sam's club", 'sams club'],
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// A discount/promo line is a line the model captured inline with a negative
// price (e.g. a Costco instant rebate or a Sam's Club "Instant Savings" line).
function isDiscountLine(it: Item): boolean {
  return typeof it.price === 'number' && it.price < 0;
}

// Normalize a SKU/item-number to its significant digits (drop padding zeros and
// any non-digit punctuation), so "0000372064", "975416" and "/ 99006" compare
// cleanly. Returns '' when there are no digits.
function skuDigits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

// The discount line carries a reference to the item it applies to. Costco prints
// the discounted item's SKU either in the description ("Discount 975416",
// "975416", "Discount / 99006") or as the line's own item number, so collect
// both as candidate references.
function costcoRefSkus(d: Item): string[] {
  const refs = new Set<string>();
  for (const m of String(d.description || '').matchAll(/\d{3,}/g)) {
    refs.add(skuDigits(m[0]));
  }
  const own = skuDigits(d.sku);
  if (own) refs.add(own);
  return [...refs].filter(Boolean);
}

function lastPriced(kept: Item[]): Item | null {
  for (let i = kept.length - 1; i >= 0; i--) {
    if (!isDiscountLine(kept[i])) return kept[i];
  }
  return null;
}

// Costco: the discount line sits immediately after the item it discounts and
// references its SKU. Prefer the most recent kept item whose SKU matches a
// reference; fall back to the immediately preceding priced item (adjacency).
function matchCostco(d: Item, kept: Item[]): Item | null {
  const refs = costcoRefSkus(d);
  for (let i = kept.length - 1; i >= 0; i--) {
    const it = kept[i];
    if (isDiscountLine(it)) continue;
    if (refs.includes(skuDigits(it.sku))) return it;
  }
  return lastPriced(kept);
}

// Sam's Club: a single "Instant Savings" line is printed at the bottom and names
// the item ("Dog Chow (Inst Sv)"). Match by description; no positional fallback,
// since the line is nowhere near its item and a wrong guess would mislead.
function matchSamsClub(d: Item, items: Item[]): Item | null {
  const name = String(d.description || '')
    .replace(/\(?\s*inst\.?\s*sv\.?\s*\)?/i, '') // strip the "(Inst Sv)" marker
    .replace(/[()]/g, '')
    .trim()
    .toLowerCase();
  if (!name) return null;
  return (
    items.find(
      (it) => !isDiscountLine(it) && String(it.description || '').trim().toLowerCase() === name
    ) || null
  );
}

// Fold each discount line into the price of the item it belongs to, then drop
// the discount line so the net price shows on a single row. Association is
// store-specific (see matchers); a discount that can't be matched is left as its
// own line rather than guessed onto the wrong item.
function foldDiscounts(store: Store, items: Item[], log: TransformContext['log']): Item[] {
  const storeName = store.name;
  const kept: Item[] = [];
  for (const it of items) {
    if (!isDiscountLine(it)) {
      kept.push(it);
      continue;
    }
    let target: Item | null = null;
    if (storeName === 'Costco') target = matchCostco(it, kept);
    else if (storeName === "Sam's Club") target = matchSamsClub(it, items);
    else target = lastPriced(kept); // generic: nearest preceding priced line

    if (!target) {
      kept.push(it); // unmatched — keep it visible rather than misattribute
      continue;
    }
    const amount = it.price as number;
    target.price = round2((target.price ?? 0) + amount);
    target.discount = round2((target.discount ?? 0) + amount);
    log('folded discount into item', {
      store: storeName,
      item: target.description,
      discount: amount,
      netPrice: target.price,
    });
  }
  return kept;
}

export const transform: Transform = (receipt, ctx) => {
  const { store, items } = receipt;

  // 1. Canonicalize the store name (case-insensitive, longest alias first).
  if (store.name) {
    const hay = store.name.toLowerCase();
    const match = Object.entries(STORE_ALIASES)
      .flatMap(([canonical, variants]) => variants.map((v) => ({ canonical, v })))
      .sort((a, b) => b.v.length - a.v.length)
      .find(({ v }) => hay.includes(v));
    if (match) store.name = match.canonical;
  }

  // 2. Reformat the date YYYY-MM-DD -> MM-DD-YYYY.
  if (store.date) {
    store.date = store.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2-$3-$1');
  }

  // 3. Fold per-item discount lines into the discounted item (store-specific).
  receipt.items = foldDiscounts(store, items, ctx.log);

  // 4. Context-sensitive item rewrite: at Costco, "water" -> "Water 5 Liter".
  if (store.name === 'Costco') {
    for (const item of receipt.items) {
      if (/water/i.test(item.description)) item.description = 'Water 5 Liter';
    }
  }

  return receipt;
};
