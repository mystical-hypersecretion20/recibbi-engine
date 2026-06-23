'use strict';

// Fixtures derived from the real sample receipt at
//   ../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/costco-boca-raton-2026-05-26-original.jpg
// — a Costco Wholesale (Boca Raton #345) receipt.
//
// Two representations of the same receipt:
//   * `structured` — the clean JSON a vision model (Anthropic/OpenAI) returns.
//   * `rawOcrText` — a realistic Tesseract dump (with header/footer noise),
//                    used to exercise the heuristic text parser.
// Keeping both lets us test the two extraction paths against one ground truth.

const path = require('path');

const SAMPLE_IMAGE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'codex-receipt-ocr-human-reviewed-ground-truth',
  'samples',
  'costco',
  'costco-boca-raton-2026-05-26-original.jpg'
);

// What the vision model is expected to return for this receipt.
const structured = {
  store: { name: 'Costco', date: '2026-05-26' },
  items: [
    { description: 'KS WATER GAL', sku: '931484', qty: 1, unitPrice: 4.99, price: 4.99 },
    { description: 'KS ORG R2 PR', sku: '1462714', qty: 1, unitPrice: 12.99, price: 12.99 },
    { description: 'BUTER CROISS', sku: '1199652', qty: 1, unitPrice: 5.99, price: 5.99 },
    { description: 'SAN PELL MIN', sku: '975416', qty: 1, unitPrice: 23.74, price: 23.74 },
    { description: 'TRIMO YOGURT', sku: '1948524', qty: 1, unitPrice: 8.99, price: 8.99 },
    { description: 'KS FR 20Z', sku: '1738408', qty: 1, unitPrice: 4.89, price: 4.89 },
    { description: '3LB ORG ENVY', sku: '7017', qty: 1, unitPrice: 5.99, price: 5.99 },
    { description: 'SWISS', sku: '99006', qty: 1, unitPrice: 16.33, price: 16.33 },
    { description: 'US WAGYUBEEF', sku: '1455728', qty: 1, unitPrice: 19.99, price: 19.99 },
    { description: 'MIXED PEPPER', sku: '60357', qty: 1, unitPrice: 7.49, price: 7.49 },
    { description: 'SOUR CREAM', sku: '331222', qty: 1, unitPrice: 5.59, price: 5.59 },
    { description: 'YELLOW ONION', sku: '7812', qty: 1, unitPrice: 3.99, price: 3.99 },
  ],
  totals: { subtotal: 115.22, tax: 1.15, total: 116.37 },
};

// A realistic raw-OCR dump of the same receipt, including the noise lines
// (store header, member number, payment/totals) that the heuristic parser
// must filter out. Note the discount line ("-5.75") and the SUBTOTAL line that
// sits just above TOTAL — the latter is a regression guard for a real bug where
// the "total" grab matched "SUBTOTAL" instead of "TOTAL".
const rawOcrText = [
  'COSTCO WHOLESALE',
  'Boca Raton #345',
  '17800 Congress Ave.',
  'Boca Raton, FL 33487',
  '',
  'Member 111203236T013',
  '',
  'E 931484 KS WATER GAL    4.99',
  'E 1462714 KS ORG R2 PR  12.99',
  'E 1199652 BUTER CROISS   5.99',
  'E 975416 SAN PELL MIN   23.74',
  'E 0000379335 / 975416   -5.75',
  'E 1948524 TRIMO YOGURT   8.99',
  'E 1738408 KS FR 20Z      4.89',
  'E 7017 3LB ORG ENVY      5.99',
  'E 99006 SWISS           16.33',
  'E 1455728 US WAGYUBEEF  19.99',
  'E 60357 MIXED PEPPER     7.49',
  'E 331222 SOUR CREAM      5.59',
  'E 7812 YELLOW ONION      3.99',
  '',
  'SUBTOTAL               115.22',
  'TAX                      1.15',
  'TOTAL                  116.37',
  '',
  'VISA                   116.37',
  'AID: A0000000031010',
  'CHANGE                   0.00',
  'THANK YOU',
].join('\n');

// Ground-truth assertions both paths should agree on.
const expected = {
  storeName: 'Costco',
  subtotal: 115.22,
  tax: 1.15,
  total: 116.37,
  // Items the parser must surface (description fragments).
  mustContain: ['WAGYUBEEF', 'SAN PELL MIN', 'YELLOW ONION', 'KS WATER GAL'],
  // Noise that must never appear as a line item.
  mustNotContain: ['SUBTOTAL', 'TOTAL', 'TAX', 'VISA', 'CHANGE', 'Member', 'THANK YOU'],
};

module.exports = { SAMPLE_IMAGE_PATH, structured, rawOcrText, expected };
