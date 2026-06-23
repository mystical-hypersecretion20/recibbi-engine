'use strict';

const store = require('../store');
const ocr = require('../ocr');
const parser = require('../parse/receiptParser');
const { enrichItems } = require('../enrich');
const identity = require('../identity');
const logger = require('../logger');

function money(n) {
  return n === null || n === undefined ? 'n/a' : `$${Number(n).toFixed(2)}`;
}

function buildSummary(record) {
  const storeName = record.store?.name || 'Unknown store';
  const date = record.store?.date ? ` on ${record.store.date}` : '';
  const { itemCount, subtotal, total, sumOfItems } = record.totals;
  const enrichedCount = record.items.filter((i) => i.enrichment && i.enrichment.imageUrl).length;
  const totalStr = total != null ? money(total) : money(sumOfItems) + ' (summed from items)';
  // Flag a *shortfall*: items summing to less than the printed subtotal is a
  // hint that a line was missed during extraction. An overage is expected when
  // the model excludes a discount/savings line, so it isn't flagged.
  const warn = subtotal != null && sumOfItems + 0.02 < subtotal
    ? ` ⚠ items sum to ${money(sumOfItems)} — under the ${money(subtotal)} subtotal (a line may be missing)`
    : '';
  return (
    `${storeName}${date}: ${itemCount} item(s), total ${totalStr}. ` +
    `${enrichedCount} item(s) matched with images/metadata.${warn}`
  );
}

/**
 * Run the full pipeline for a receipt id, updating the durable record at each
 * stage so progress is observable even if a later stage fails.
 */
async function processReceipt(receiptId) {
  const t0 = Date.now();
  await store.update(receiptId, { status: 'processing', error: null });

  // 1. Extraction (vision or tesseract)
  const ocrStart = Date.now();
  const { rawText, structured, provider } = await ocr.extract(await store.get(receiptId));
  await store.update(receiptId, {
    extraction: { provider, rawText: rawText ? rawText.slice(0, 20000) : null },
    timings: { ocrMs: Date.now() - ocrStart },
  });

  // 2. Parse into canonical structure
  const parsed = structured
    ? parser.normalizeStructured(structured, rawText)
    : parser.parseText(rawText);
  await store.update(receiptId, {
    store: parsed.store,
    items: parsed.items,
    totals: parsed.totals,
  });
  logger.info({ id: receiptId, items: parsed.items.length, provider }, 'parsed receipt');

  // 3. Enrich items (Tavily); mutates items in place. The enrichment cache is
  // tenant-scoped, so pass the receipt's tenant (parsed from its composite id).
  const enrichStart = Date.now();
  const items = parsed.items;
  const { tenantId } = identity.scopeOf(receiptId);
  const enrichStats = await enrichItems(items, parsed.store?.name, { tenantId });
  const current = await store.get(receiptId);
  current.items = items;
  current.timings = { ...current.timings, enrichMs: Date.now() - enrichStart };
  await store.save(current);
  logger.info({ id: receiptId, ...enrichStats }, 'enrichment complete');

  // 4. Summarize and finalize
  const finalRecord = await store.get(receiptId);
  finalRecord.summary = buildSummary(finalRecord);
  finalRecord.status = 'done';
  finalRecord.timings = { ...finalRecord.timings, totalMs: Date.now() - t0 };
  await store.save(finalRecord);

  return finalRecord;
}

module.exports = { processReceipt };
