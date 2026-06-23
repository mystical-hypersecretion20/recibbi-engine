'use strict';

// LIVE TEST — Option 3: the full running stack (the real app).
// Exercises the exact path the CLI / Telegram bot use: POST the sample photo to
// the REST API, let the worker process it through Redis/BullMQ, poll until done,
// then print the contents. Skips automatically when the API isn't reachable.
//
// Bring the stack up first (see README), then:
//   docker compose up --build -d        # or: podman compose up --build -d
//   npm run test:live:stack
//   API_URL=http://my-host:8080 npm run test:live:stack   # remote host

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { formatReceipt, SAMPLE_IMAGE_PATH } = require('./_shared');

const API_URL = (process.env.API_URL || 'http://localhost:8080').replace(/\/$/, '');
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 180000);

async function reachable() {
  try {
    const res = await fetch(`${API_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

test('upload to the live API, wait for processing, and print the receipt', { timeout: POLL_TIMEOUT_MS + 30000 }, async (t) => {
  if (!(await reachable())) {
    t.skip(`API not reachable at ${API_URL} — bring the stack up (docker/podman compose up -d)`);
    return;
  }

  // 1. Upload the real sample photo via multipart/form-data (field "receipt").
  const bytes = fs.readFileSync(SAMPLE_IMAGE_PATH);
  const form = new FormData();
  form.append('receipt', new Blob([bytes], { type: 'image/jpeg' }), 'costco.jpg');
  form.append('source', 'live-test');

  const up = await fetch(`${API_URL}/api/receipts`, { method: 'POST', body: form });
  assert.equal(up.status, 202, 'API accepts the upload with 202 Accepted');
  const { id, statusUrl } = await up.json();
  assert.ok(id, 'API returned a receipt id');
  console.log(`\n  uploaded → id=${id}`);

  // 2. Poll the status URL until the worker finishes.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let record;
  while (Date.now() < deadline) {
    const res = await fetch(statusUrl || `${API_URL}/api/receipts/${id}`);
    record = await res.json();
    if (record.status === 'done' || record.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 3. Print whatever the stack produced.
  console.log('\n' + formatReceipt(record, { provider: `stack/${record.extraction?.provider || '?'}` }));
  console.log(`  view: ${API_URL}/receipts/${id}/view`);
  if (record.summary) console.log(`  summary: ${record.summary}`);

  assert.notEqual(record.status, 'failed', `processing failed: ${record.error || 'unknown error'}`);
  assert.equal(record.status, 'done', 'receipt reached "done" within the timeout');
  assert.ok(Array.isArray(record.items) && record.items.length > 0, 'items were extracted');
});
