'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'src', 'config.js');
// Run probes from an EMPTY temp dir so config's dotenv.config() can't pick up a
// developer's real .env (which would skew the key-based provider selection).
// We therefore require config by absolute path rather than relative to cwd.
const EMPTY_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-test-'));

// Load src/config in a clean child process with a controlled environment, so
// each mode is evaluated from scratch (config is computed at module load time).
function loadConfig(env) {
  const base = { ...process.env };
  // Clear anything that would skew provider selection.
  for (const k of [
    'OCR_PROVIDER', 'VISION_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
    'TAVILY_API_KEY', 'ENRICH_ENABLED', 'PORT', 'PUBLIC_BASE_URL',
  ]) {
    delete base[k];
  }
  const script =
    `const c=require(${JSON.stringify(CONFIG_PATH)});` +
    'process.stdout.write(JSON.stringify({' +
    'ocrProvider:c.ocrProvider,' +
    'visionProvider:c.vision.provider,' +
    'enrichEnabled:c.enrich.enabled,' +
    'port:c.port,' +
    'publicBaseUrl:c.publicBaseUrl,' +
    'maxItems:c.enrich.maxItems}))';
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: EMPTY_CWD,
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('no keys -> Tesseract OCR, enrichment disabled', () => {
  const c = loadConfig({});
  assert.equal(c.ocrProvider, 'tesseract');
  assert.equal(c.enrichEnabled, false);
});

test('TAVILY key only -> still Tesseract, but enrichment enabled', () => {
  const c = loadConfig({ TAVILY_API_KEY: 'tvly-x' });
  assert.equal(c.ocrProvider, 'tesseract');
  assert.equal(c.enrichEnabled, true);
});

test('ANTHROPIC key (auto) -> vision extraction, enrichment off', () => {
  const c = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-x' });
  assert.equal(c.ocrProvider, 'vision');
  assert.equal(c.visionProvider, 'anthropic');
  assert.equal(c.enrichEnabled, false);
});

test('both keys -> vision extraction + enrichment', () => {
  const c = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-x', TAVILY_API_KEY: 'tvly-x' });
  assert.equal(c.ocrProvider, 'vision');
  assert.equal(c.enrichEnabled, true);
});

test('OpenAI provider selected when VISION_PROVIDER=openai + OPENAI key', () => {
  const c = loadConfig({ VISION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-openai-x' });
  assert.equal(c.ocrProvider, 'vision');
  assert.equal(c.visionProvider, 'openai');
});

test('an ANTHROPIC key is ignored when VISION_PROVIDER=openai (no OpenAI key)', () => {
  // Wrong-provider key shouldn't flip auto to vision.
  const c = loadConfig({ VISION_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'sk-ant-x' });
  assert.equal(c.ocrProvider, 'tesseract');
});

test('OCR_PROVIDER=tesseract forces Tesseract even with a vision key', () => {
  const c = loadConfig({ OCR_PROVIDER: 'tesseract', ANTHROPIC_API_KEY: 'sk-ant-x' });
  assert.equal(c.ocrProvider, 'tesseract');
});

test('defaults: port 8080 and a trailing-slash-free public base url', () => {
  const c = loadConfig({ PUBLIC_BASE_URL: 'http://example.com:8080/' });
  assert.equal(c.port, 8080);
  assert.equal(c.publicBaseUrl, 'http://example.com:8080', 'trailing slash trimmed');
  assert.equal(c.maxItems, 40);
});
