'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis, stubFetch, jsonResponse, textResponse } = require('./helpers/harness');

useTempDataDir('enrich-test');
const fakeRedis = installFakeRedis(); // must precede requiring enrich (it pulls in ../redis)
const config = require('../src/config');
const { enrichItems } = require('../src/enrich');

// A canned Tavily search response.
function tavilyHit(query) {
  return {
    images: [{ url: `https://img.example/${encodeURIComponent(query)}.jpg`, description: `photo of ${query}` }],
    results: [{ title: `${query} — buy online`, url: 'https://shop.example/x', content: 'Great product. '.repeat(40) }],
  };
}

let restoreFetch;
beforeEach(() => {
  // Default: enrichment on, with a (fake) Tavily key.
  config.enrich.enabled = true;
  config.enrich.maxItems = 40;
  config.enrich.tavily.apiKey = 'tvly-test-key';
  fakeRedis.store.clear();
  fakeRedis.calls.get = fakeRedis.calls.set = 0;
});
afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
});

test('skips enrichment entirely when disabled (no key)', async () => {
  config.enrich.enabled = false;
  restoreFetch = stubFetch(() => {
    throw new Error('fetch should not be called when enrichment is disabled');
  });
  const items = [{ description: 'KS WATER GAL', enrichment: null }];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(items[0].enrichment, null, 'item left un-enriched');
  assert.equal(stats.enriched, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(restoreFetch.calls.length, 0, 'no network calls');
});

test('enriches an item with image + metadata from Tavily', async () => {
  restoreFetch = stubFetch((url, opts) => {
    assert.match(url, /\/search$/, 'calls the Tavily search endpoint');
    const body = JSON.parse(opts.body);
    assert.equal(body.include_images, true, 'requests images');
    return jsonResponse(tavilyHit(body.query));
  });
  const items = [{ description: 'US WAGYUBEEF', enrichment: null }];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.enriched, 1);
  assert.ok(items[0].enrichment.imageUrl.startsWith('https://img.example/'));
  assert.ok(items[0].enrichment.title.includes('WAGYUBEEF'));
  assert.ok(items[0].enrichment.snippet.length <= 280, 'snippet is truncated');
  // The store name is folded into the query so lookups are store-aware.
  assert.ok(restoreFetch.calls.some((c) => JSON.parse(c.options.body).query.includes('Costco')));
});

test('caches lookups so a repeat item does not re-spend API credits', async () => {
  let networkCalls = 0;
  restoreFetch = stubFetch((url, opts) => {
    networkCalls += 1;
    return jsonResponse(tavilyHit(JSON.parse(opts.body).query));
  });
  // Same description twice -> identical query -> one network call, one cache hit.
  const items = [
    { description: 'SOUR CREAM', enrichment: null },
    { description: 'SOUR CREAM', enrichment: null },
  ];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.enriched, 2, 'both items end up enriched');
  assert.equal(networkCalls, 1, 'second lookup served from cache');
  assert.ok(fakeRedis.calls.set >= 1, 'result was written to the cache');
  assert.ok(fakeRedis.calls.get >= 2, 'cache was consulted for each item');
});

test('respects ENRICH_MAX_ITEMS and skips the overflow', async () => {
  config.enrich.maxItems = 1;
  restoreFetch = stubFetch((url, opts) => jsonResponse(tavilyHit(JSON.parse(opts.body).query)));
  const items = [
    { description: 'KS WATER GAL', enrichment: null },
    { description: 'SWISS', enrichment: null },
  ];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.enriched, 1);
  assert.equal(stats.skipped, 1);
  assert.ok(items[0].enrichment, 'first item enriched');
  assert.equal(items[1].enrichment, null, 'capped item left alone');
});

test('degrades gracefully when a lookup errors (record marked, others continue)', async () => {
  restoreFetch = stubFetch((url, opts) => {
    const q = JSON.parse(opts.body).query;
    if (/SWISS/.test(q)) return textResponse('rate limited', { ok: false, status: 429 });
    return jsonResponse(tavilyHit(q));
  });
  const items = [
    { description: 'SWISS', enrichment: null }, // will error
    { description: 'YELLOW ONION', enrichment: null }, // will succeed
  ];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.errors, 1);
  assert.equal(stats.enriched, 1);
  assert.ok(items[0].enrichment.error, 'failed item carries an error note, not a crash');
  assert.ok(items[1].enrichment.imageUrl, 'subsequent item still enriched');
});

test('treats an empty-key Tavily response as a skip, not an error', async () => {
  config.enrich.tavily.apiKey = ''; // searchItem returns null without a key
  restoreFetch = stubFetch(() => {
    throw new Error('should not fetch without an api key');
  });
  const items = [{ description: 'MIXED PEPPER', enrichment: null }];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.errors, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(items[0].enrichment, null);
});
