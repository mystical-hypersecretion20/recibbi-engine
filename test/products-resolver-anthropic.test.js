'use strict';

// Unit tests for the default Anthropic product resolver. Hermetic: global fetch
// is stubbed (see helpers/harness), so no network and no API key are needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, stubFetch, jsonResponse, textResponse } = require('./helpers/harness');

useTempDataDir('products-resolver-test');

const resolver = require('../src/products/resolvers/anthropic');

function cfg({ webSearch = true, emoji = true } = {}) {
  return {
    products: {
      emoji,
      anthropic: {
        apiKey: 'test-key',
        model: 'claude-haiku-4-5',
        version: '2023-06-01',
        baseUrl: 'https://api.anthropic.com',
        webSearch,
      },
    },
  };
}

const PRODUCT_JSON = JSON.stringify({
  productTitle: 'Kirkland Signature Sparkling Water',
  productDescription: 'Costco house-brand sparkling water.',
  productUrl: 'https://www.costco.com/kirkland-sparkling-water.html',
  brand: 'Kirkland Signature',
  category: 'Beverages',
  emoji: '🥤',
  confidence: 0.82,
});

test('buildUserPrompt adapts to the fields present', () => {
  const full = resolver.buildUserPrompt(
    { description: 'KS SPARK WAT', price: 4.99, unitPrice: 4.99, qty: 1, sku: '123' },
    { storeName: 'Costco' }
  );
  assert.match(full, /KS SPARK WAT/);
  assert.match(full, /Store: Costco/);
  assert.match(full, /Price paid: \$4\.99/);
  assert.match(full, /SKU\/item number: 123/);

  const bare = resolver.buildUserPrompt({ description: 'MILK' }, {});
  assert.match(bare, /MILK/);
  assert.doesNotMatch(bare, /Store:/);
  assert.doesNotMatch(bare, /Price paid:/);
});

test('buildTools toggles on webSearch and marks tools direct-callable', () => {
  const tools = resolver.buildTools(cfg({ webSearch: true }));
  assert.equal(tools.length, 2);
  // allowed_callers:['direct'] is required so Haiku (no programmatic tool
  // calling) can use the web tools — otherwise the API 400s.
  for (const t of tools) assert.deepEqual(t.allowed_callers, ['direct']);
  assert.equal(resolver.buildTools(cfg({ webSearch: false })).length, 0);
});

test('resolve parses product JSON and sends system prompt + web tools', async () => {
  const restore = stubFetch((url, opts) => {
    assert.match(url, /\/v1\/messages$/);
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'claude-haiku-4-5');
    assert.match(body.system, /product-research/i);
    assert.ok(Array.isArray(body.tools) && body.tools.some((t) => t.name === 'web_search'));
    assert.match(body.messages[0].content, /Store: Costco/);
    return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: PRODUCT_JSON }] });
  });
  try {
    const out = await resolver.resolve(
      { description: 'KS SPARK WAT', price: 4.99 },
      { storeName: 'Costco', config: cfg() }
    );
    assert.equal(out.productTitle, 'Kirkland Signature Sparkling Water');
    assert.equal(out.productUrl, 'https://www.costco.com/kirkland-sparkling-water.html');
    assert.equal(out.brand, 'Kirkland Signature');
    assert.equal(out.confidence, 0.82);
  } finally {
    restore();
  }
});

test('resolve omits tools when webSearch is off', async () => {
  const restore = stubFetch((url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.tools, undefined);
    return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: PRODUCT_JSON }] });
  });
  try {
    await resolver.resolve({ description: 'MILK' }, { config: cfg({ webSearch: false }) });
  } finally {
    restore();
  }
});

test('resolve resumes on pause_turn then returns the final answer', async () => {
  let n = 0;
  const restore = stubFetch(() => {
    n += 1;
    if (n === 1) return jsonResponse({ stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 't1' }] });
    return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: PRODUCT_JSON }] });
  });
  try {
    const out = await resolver.resolve({ description: 'KS SPARK WAT' }, { config: cfg() });
    assert.equal(n, 2, 're-sent after pause_turn');
    assert.equal(out.productTitle, 'Kirkland Signature Sparkling Water');
  } finally {
    restore();
  }
});

test('resolve returns null when the model returns no usable product', async () => {
  const restore = stubFetch(() =>
    jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry, not JSON' }] })
  );
  try {
    const out = await resolver.resolve({ description: '???' }, { config: cfg() });
    assert.equal(out, null);
  } finally {
    restore();
  }
});

test('resolve throws on a non-ok API response', async () => {
  const restore = stubFetch(() => textResponse('{"error":{"message":"bad"}}', { ok: false, status: 400 }));
  try {
    await assert.rejects(
      () => resolver.resolve({ description: 'x' }, { config: cfg() }),
      /Anthropic API 400/
    );
  } finally {
    restore();
  }
});

test('normalize returns null when title/description/url are all empty', () => {
  assert.equal(resolver.normalize({ brand: 'x', confidence: 0.1 }), null);
  assert.ok(resolver.normalize({ productTitle: 'X' }));
});

test('normalizeEmoji keeps a real emoji and rejects prose/placeholders', () => {
  assert.equal(resolver.normalizeEmoji('🥚'), '🥚');
  assert.equal(resolver.normalizeEmoji(' 🥛 '), '🥛'); // trims
  assert.equal(resolver.normalizeEmoji('👨‍🍳'), '👨‍🍳'); // ZWJ sequence kept
  assert.equal(resolver.normalizeEmoji('none'), null);
  assert.equal(resolver.normalizeEmoji('N/A'), null);
  assert.equal(resolver.normalizeEmoji('a long sentence with no emoji'), null);
  assert.equal(resolver.normalizeEmoji(''), null);
  assert.equal(resolver.normalizeEmoji(null), null);
  assert.equal(resolver.normalizeEmoji(42), null);
});

test('normalize carries a valid emoji through', () => {
  assert.equal(resolver.normalize({ productTitle: 'Eggs', emoji: '🥚' }).emoji, '🥚');
  assert.equal(resolver.normalize({ productTitle: 'Eggs', emoji: 'nope' }).emoji, null);
  assert.equal(resolver.normalize({ productTitle: 'Eggs' }).emoji, null);
});

test('buildSystem asks for an emoji only when the feature is enabled', () => {
  const on = resolver.buildSystem(cfg({ emoji: true }));
  assert.match(on, /"emoji"/);
  assert.match(on, /SINGLE emoji/);
  const off = resolver.buildSystem(cfg({ emoji: false }));
  assert.doesNotMatch(off, /emoji/i);
});

test('resolve returns the emoji when the feature is on', async () => {
  const restore = stubFetch((url, opts) => {
    const body = JSON.parse(opts.body);
    assert.match(body.system, /"emoji"/); // prompted for it
    return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: PRODUCT_JSON }] });
  });
  try {
    const out = await resolver.resolve({ description: 'KS SPARK WAT' }, { config: cfg({ emoji: true }) });
    assert.equal(out.emoji, '🥤');
  } finally {
    restore();
  }
});

test('resolve drops the emoji when the feature is off, even if volunteered', async () => {
  const restore = stubFetch((url, opts) => {
    const body = JSON.parse(opts.body);
    assert.doesNotMatch(body.system, /emoji/i); // not prompted for
    return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: PRODUCT_JSON }] });
  });
  try {
    const out = await resolver.resolve({ description: 'KS SPARK WAT' }, { config: cfg({ emoji: false }) });
    assert.equal(out.emoji, null);
  } finally {
    restore();
  }
});
