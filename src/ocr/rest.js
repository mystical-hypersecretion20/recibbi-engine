'use strict';

const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('../config');
const logger = require('../logger');
const { imagePathFor } = require('../store');

/**
 * POST a JSON body and read the full JSON/text response, bounded by a SINGLE
 * overall timeout. Deliberately uses the built-in http/https client rather than
 * global `fetch`: Node's fetch (undici) imposes a default 300s `headersTimeout`
 * that fires regardless of any AbortController, which a slow OCR backend
 * (PaddleOCR-VL is minutes/receipt) trips with an opaque "fetch failed" while
 * the backend is still working. http.request has no such hidden ceiling — the
 * only deadline is the one we set here.
 *
 * @returns {Promise<{ status: number, body: string }>}
 */
function postJson(endpoint, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    // Bound the WHOLE call (connect + inference + response). On expiry, destroy
    // the socket so the worker slot frees instead of pinning indefinitely.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Generic REST OCR client.
 *
 * Talks to a remote HTTP OCR backend instead of running an engine in-process.
 * This is the extension point for heavy OCR engines (e.g. PaddleOCR and its
 * multi-GB model blobs) that we deliberately keep OUT of the Node image: they
 * ship as their own optional containers and are selected with OCR_PROVIDER.
 *
 * The backend is resolved from config.ocr.rest[provider] (its base URL). We POST
 * the receipt image (base64 JSON) to `<url>/ocr` and expect back:
 *   { text: string, structured?: object|null, profile?, confidence?, runtimeMs? }
 * Most engines (PaddleOCR included) return plain text only, so `structured` is
 * usually null and the heuristic parser turns the text into line items — exactly
 * like the Tesseract path.
 *
 * @returns {Promise<{ rawText: string|null, structured: object|null }>}
 */
async function extract(record) {
  const provider = config.ocrProvider;
  const backend = config.ocr.rest[provider];
  if (!backend || !backend.url) {
    throw new Error(`OCR provider "${provider}" is not a known REST backend (no URL configured)`);
  }
  const endpoint = `${backend.url.replace(/\/$/, '')}/ocr`;

  const buf = await fsp.readFile(imagePathFor(record));
  let mimeType = record.image && record.image.mimeType;
  if (!/^image\//.test(mimeType || '')) mimeType = 'image/jpeg';

  // Bound the whole call (a VL inference legitimately runs minutes) so a stuck
  // backend fails THIS job instead of pinning a worker slot indefinitely. See
  // postJson for why this uses http.request rather than fetch.
  let res;
  try {
    res = await postJson(
      endpoint,
      { id: record.id, mimeType, imageBase64: buf.toString('base64') },
      config.ocr.restTimeoutMs
    );
  } catch (err) {
    throw new Error(`${provider} OCR request to ${endpoint} failed: ${(err && err.message) || String(err)}`);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${provider} OCR backend ${res.status}: ${(res.body || '').slice(0, 300)}`);
  }

  let payload;
  try {
    payload = JSON.parse(res.body);
  } catch (err) {
    throw new Error(`${provider} OCR backend returned non-JSON: ${err.message}`);
  }

  if (payload && payload.error) {
    throw new Error(`${provider} OCR backend error: ${payload.error}`);
  }

  const rawText = typeof payload.text === 'string' ? payload.text : null;
  const structured = payload.structured && typeof payload.structured === 'object' ? payload.structured : null;
  logger.debug(
    { id: record.id, provider, lineCount: payload.lineCount, runtimeMs: payload.runtimeMs, profile: payload.profile },
    'rest OCR complete'
  );
  return { rawText, structured };
}

module.exports = { extract };
